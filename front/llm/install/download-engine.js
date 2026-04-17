import {
  configureAssetCache,
  listCachedAssetUrls,
  prefetchAssetUrls,
} from '../asset-cache.js';
import { INSTALL_ERROR_CODES } from '../errors.js';

function sleep(ms) {
  if (!ms) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function resolveAbsoluteUrl(url) {
  return new URL(String(url ?? '').trim(), window.location.href).href;
}

function isModelAsset(asset) {
  return asset?.type === 'model' || String(asset?.url ?? '').trim().endsWith('.task');
}

export class DownloadEngine {
  constructor({
    maxRetries = 2,
    retryDelaysMs = [250, 500],
    integrityMode = 'size-only',
    maxConcurrentDownloads = 2,
  } = {}) {
    this.maxRetries = maxRetries;
    this.retryDelaysMs = retryDelaysMs;
    this.integrityMode = integrityMode;
    this.maxConcurrentDownloads = Math.max(1, Number.isFinite(maxConcurrentDownloads) ? Math.floor(maxConcurrentDownloads) : 2);
  }

  setIntegrityMode(mode) {
    this.integrityMode = mode === 'size-only' ? 'size-only' : 'full';
  }

  getIntegrityMode() {
    return this.integrityMode;
  }

  async configure(cacheConfig) {
    return configureAssetCache(cacheConfig);
  }

  async downloadAssets({
    cacheConfig,
    assets,
    controller,
    onAssetUpdate,
    onAssetProgress,
    integrityMode = this.integrityMode,
  }) {
    const configured = await this.configure(cacheConfig);
    let swVersion = configured.version || '';
    const assetResults = new Array(assets.length);
    const modelAssets = [];
    const runtimeAssets = [];

    assets.forEach((asset, index) => {
      if (!controller && asset.installChannel === 'service-worker') {
        const blockedResult = {
          asset,
          status: 'blocked',
          attempts: 0,
          errorCode: INSTALL_ERROR_CODES.CONTROL_REQUIRED,
          errorDetail: 'SERVICE_WORKER_CONTROL_REQUIRED',
          verified: false,
          version: swVersion,
        };
        assetResults[index] = blockedResult;
        onAssetUpdate?.(blockedResult);
        return;
      }

      if (isModelAsset(asset)) {
        modelAssets.push({ asset, index });
        return;
      }

      runtimeAssets.push({ asset, index });
    });

    const runAssetQueue = async (queue) => {
      for (const { asset, index } of queue) {
        const result = await this.downloadAsset({
          configured,
          cacheConfig,
          asset,
          integrityMode,
          onProgress: onAssetProgress
            ? (progress) => {
              onAssetProgress({
                asset,
                ...progress,
              });
            }
            : null,
        });
        swVersion = result.version || swVersion;
        const assetResult = {
          asset,
          ...result,
        };
        assetResults[index] = assetResult;
        onAssetUpdate?.(assetResult);
      }
    };

    const tasks = [];
    if (modelAssets.length > 0) {
      tasks.push(runAssetQueue(modelAssets));
    }
    if (runtimeAssets.length > 0) {
      tasks.push(runAssetQueue(runtimeAssets));
    }

    if (tasks.length > 0) {
      await Promise.all(tasks);
    }

    const cachedUrls = await listCachedAssetUrls(configured.cacheName);
    return {
      ...configured,
      swVersion,
      cachedUrls,
      assetResults,
    };
  }

  async downloadAsset({
    configured,
    cacheConfig,
    asset,
    integrityMode = this.integrityMode,
    onProgress = null,
  }) {
    const resolvedUrl = resolveAbsoluteUrl(asset.url);
    let attempts = 0;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      attempts += 1;
      const prefetchResult = await prefetchAssetUrls({
        config: cacheConfig,
        registration: configured.registration,
        worker: configured.worker,
        cacheName: configured.cacheName,
        urls: [asset.url],
        expectedAssets: [{
          url: asset.url,
          sha256: asset.sha256,
          sizeBytes: asset.sizeBytes,
        }],
        onProgress,
        enableHash: integrityMode === 'full' && Boolean(asset.sha256),
      });

      const cachedUrls = await listCachedAssetUrls(configured.cacheName);
      const verified = cachedUrls.includes(resolvedUrl);
      const assetReport = Array.isArray(prefetchResult.assetReports)
        ? prefetchResult.assetReports.find((report) => report.url === resolvedUrl)
        : null;
      const expectedSizeBytes = typeof asset.sizeBytes === 'number' ? asset.sizeBytes : null;
      const observedSizeBytes = typeof assetReport?.observedSizeBytes === 'number'
        ? assetReport.observedSizeBytes
        : null;
      const expectedSha256 = typeof asset.sha256 === 'string' && asset.sha256.trim()
        ? asset.sha256.trim()
        : '';
      const observedSha256 = typeof assetReport?.observedSha256 === 'string'
        ? assetReport.observedSha256
        : '';
      const sizeMismatch = expectedSizeBytes !== null
        && observedSizeBytes !== null
        && expectedSizeBytes !== observedSizeBytes;
      const hashMismatch = integrityMode === 'full'
        && Boolean(expectedSha256)
        && Boolean(observedSha256)
        && expectedSha256 !== observedSha256;

      if (verified && !sizeMismatch && !hashMismatch) {
        return {
          status: 'cached',
          attempts,
          errorCode: '',
          errorDetail: '',
          verified: true,
          verification: {
            source: assetReport?.source || '',
            observedSizeBytes,
            expectedSizeBytes,
            sizeMismatch: false,
            observedSha256,
            expectedSha256,
            hashMismatch: false,
            integrityMode,
            integrityVerified: Boolean(assetReport?.integrityVerified),
            verificationMethod: assetReport?.verificationMethod || '',
            contentType: assetReport?.contentType || '',
            etag: assetReport?.etag || '',
            lastModified: assetReport?.lastModified || '',
          },
          version: prefetchResult.version || configured.version || '',
        };
      }

      if (attempt < this.maxRetries) {
        await sleep(this.retryDelaysMs[attempt] ?? 0);
      } else {
        return {
          status: 'failed',
          attempts,
          errorCode: sizeMismatch || hashMismatch
            ? INSTALL_ERROR_CODES.INTEGRITY_MISMATCH
            : asset.installChannel === 'service-worker'
              ? INSTALL_ERROR_CODES.ASSET_MISSING
              : INSTALL_ERROR_CODES.NETWORK_ERROR,
          errorDetail: sizeMismatch
            ? `ASSET_SIZE_MISMATCH:${asset.url}:${expectedSizeBytes}:${observedSizeBytes}`
            : hashMismatch
              ? `ASSET_HASH_MISMATCH:${asset.url}:${expectedSha256}:${observedSha256}`
            : prefetchResult.prefetchError || 'ASSET_PREFETCH_FAILED',
          verified: false,
          verification: {
            source: assetReport?.source || '',
            observedSizeBytes,
            expectedSizeBytes,
            sizeMismatch,
            observedSha256,
            expectedSha256,
            hashMismatch,
            integrityMode,
            integrityVerified: Boolean(assetReport?.integrityVerified),
            verificationMethod: assetReport?.verificationMethod || '',
            contentType: assetReport?.contentType || '',
            etag: assetReport?.etag || '',
            lastModified: assetReport?.lastModified || '',
          },
          version: prefetchResult.version || configured.version || '',
        };
      }
    }

    return {
      status: 'failed',
      attempts,
      errorCode: INSTALL_ERROR_CODES.NETWORK_ERROR,
      errorDetail: 'ASSET_PREFETCH_FAILED',
      verified: false,
      verification: {
        source: '',
        observedSizeBytes: null,
        expectedSizeBytes: typeof asset.sizeBytes === 'number' ? asset.sizeBytes : null,
        sizeMismatch: false,
        observedSha256: '',
        expectedSha256: typeof asset.sha256 === 'string' ? asset.sha256 : '',
        hashMismatch: false,
        integrityMode,
        integrityVerified: false,
        verificationMethod: '',
        contentType: '',
        etag: '',
        lastModified: '',
      },
      version: configured.version || '',
    };
  }
}
