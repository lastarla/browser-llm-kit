import { listCachedAssetUrls } from '../asset-cache.js';
import { formatInstallStateMessage, getInstallProgress } from '../diagnostics.js';
import { INSTALL_ERROR_CODES } from '../errors.js';
import { DownloadEngine } from './download-engine.js';
import { InstallStore } from './install-store.js';

function isControllerActive() {
  return Boolean(globalThis.navigator?.serviceWorker?.controller);
}

function isSecureInstallContext() {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.isSecureContext === true;
}

function toAbsoluteUrl(url) {
  if (typeof window === 'undefined') {
    return String(url ?? '').trim();
  }

  return new URL(String(url ?? '').trim(), window.location.href).href;
}

function createProgress(totalFiles, completedFiles) {
  const safeTotalFiles = Number.isFinite(totalFiles) ? Math.max(0, totalFiles) : 0;
  const safeCompletedFiles = Number.isFinite(completedFiles) ? Math.max(0, completedFiles) : 0;
  return {
    totalBytes: null,
    downloadedBytes: null,
    totalFiles: safeTotalFiles,
    completedFiles: Math.min(safeCompletedFiles, safeTotalFiles),
    percent: safeTotalFiles > 0
      ? Math.round((Math.min(safeCompletedFiles, safeTotalFiles) / safeTotalFiles) * 100)
      : 0,
  };
}

function summarizeByteProgress(records) {
  const totals = records
    .map((record) => (typeof record.expectedSizeBytes === 'number' ? record.expectedSizeBytes : null));
  const hasKnownTotals = totals.some((value) => typeof value === 'number');
  if (!hasKnownTotals) {
    return {
      totalBytes: null,
      downloadedBytes: null,
    };
  }

  const totalBytes = totals.reduce((sum, value) => sum + (value || 0), 0);
  const downloadedBytes = records.reduce((sum, record) => {
    if (record.verified) {
      return sum + (record.observedSizeBytes || record.expectedSizeBytes || 0);
    }
    return sum + (record.downloadedBytes || 0);
  }, 0);

  return {
    totalBytes,
    downloadedBytes,
  };
}

function buildProgress(records) {
  const completedFiles = countCompletedAssetRecords(records);
  const byteProgress = summarizeByteProgress(records);
  return {
    ...createProgress(records.length, completedFiles),
    totalBytes: byteProgress.totalBytes,
    downloadedBytes: byteProgress.downloadedBytes,
  };
}

function createIdleSnapshot(modelId, cacheName, persisted = null) {
  const snapshot = {
    modelId,
    manifestVersion: persisted?.manifestVersion || '',
    cacheName,
    state: persisted?.state || 'idle',
    ready: Boolean(persisted?.ready),
    controller: isControllerActive(),
    progress: persisted?.progress || createProgress(0, 0),
    currentAsset: persisted?.currentAsset || '',
    errorCode: persisted?.errorCode || '',
    errorDetail: persisted?.errorDetail || '',
    retryCount: persisted?.retryCount || 0,
    prefetchError: persisted?.prefetchError || '',
    swVersion: persisted?.swVersion || '',
    verifiedAt: persisted?.verifiedAt || 0,
    startedAt: persisted?.startedAt || 0,
    completedAt: persisted?.completedAt || 0,
    durationMs: persisted?.durationMs || 0,
    assetRecords: Array.isArray(persisted?.assetRecords) ? [...persisted.assetRecords] : [],
    missingRequired: Array.isArray(persisted?.missingRequired) ? [...persisted.missingRequired] : [],
    cachedUrls: Array.isArray(persisted?.cachedUrls) ? [...persisted.cachedUrls] : [],
    updatedAt: persisted?.updatedAt || 0,
    statusText: persisted?.statusText || '等待安装',
  };

  if (snapshot.ready && !snapshot.controller) {
    snapshot.ready = false;
    snapshot.state = 'partial';
    snapshot.errorCode = INSTALL_ERROR_CODES.CONTROL_REQUIRED;
    snapshot.statusText = formatInstallStateMessage(snapshot);
  }

  return snapshot;
}

function createAssetRecord(asset) {
  return {
    url: asset.url,
    type: asset.type,
    required: Boolean(asset.required),
    installChannel: asset.installChannel,
    sizeBytes: typeof asset.sizeBytes === 'number' ? asset.sizeBytes : null,
    status: 'pending',
    attempts: 0,
    verified: false,
    errorCode: '',
    errorDetail: '',
    verifiedAt: 0,
    verificationSource: '',
    observedSizeBytes: null,
    expectedSizeBytes: typeof asset.sizeBytes === 'number' ? asset.sizeBytes : null,
    sizeMismatch: false,
    observedSha256: '',
    expectedSha256: typeof asset.sha256 === 'string' ? asset.sha256 : '',
    hashMismatch: false,
    integrityVerified: false,
    verificationMethod: '',
    downloadedBytes: 0,
    contentType: '',
    etag: '',
    lastModified: '',
  };
}

function updateAssetRecord(records, asset, partial) {
  return records.map((record) => (
    record.url === asset.url
      ? { ...record, ...partial }
      : record
  ));
}

function mergeAssetResults(records, assetResults = []) {
  const resultMap = new Map(
    assetResults.map((result) => [result.asset.url, result]),
  );

  return records.map((record) => {
    const result = resultMap.get(record.url);
    if (!result) {
      return record;
    }

    return {
      ...record,
      status: result.status,
      attempts: result.attempts,
      verified: Boolean(result.verified),
      errorCode: result.errorCode || '',
      errorDetail: result.errorDetail || '',
      verifiedAt: result.verified ? Date.now() : record.verifiedAt,
      verificationSource: result.verification?.source || record.verificationSource,
      observedSizeBytes: typeof result.verification?.observedSizeBytes === 'number'
        ? result.verification.observedSizeBytes
        : record.observedSizeBytes,
      expectedSizeBytes: typeof result.verification?.expectedSizeBytes === 'number'
        ? result.verification.expectedSizeBytes
        : record.expectedSizeBytes,
      sizeMismatch: Boolean(result.verification?.sizeMismatch),
      observedSha256: result.verification?.observedSha256 || record.observedSha256,
      expectedSha256: result.verification?.expectedSha256 || record.expectedSha256,
      hashMismatch: Boolean(result.verification?.hashMismatch),
      integrityVerified: Boolean(result.verification?.integrityVerified),
      verificationMethod: result.verification?.verificationMethod || record.verificationMethod,
      downloadedBytes: result.verification?.observedSizeBytes || record.downloadedBytes,
      contentType: result.verification?.contentType || record.contentType,
      etag: result.verification?.etag || record.etag,
      lastModified: result.verification?.lastModified || record.lastModified,
    };
  });
}

function countCompletedAssetRecords(records) {
  return records.filter((record) => record.verified).length;
}

export class AssetInstaller {
  constructor({
    modelRegistry,
    installStore = new InstallStore(),
    downloadEngine = new DownloadEngine(),
    integrityMode = 'size-only',
  }) {
    this.modelRegistry = modelRegistry;
    this.installStore = installStore;
    this.downloadEngine = downloadEngine;
    this.integrityMode = integrityMode === 'size-only' ? 'size-only' : 'full';
    this.downloadEngine.setIntegrityMode(this.integrityMode);
    this.listeners = new Map();
    this.stateByModel = new Map();
    this.pendingInstalls = new Map();

    for (const modelId of this.modelRegistry.listModelIds()) {
      const cacheName = this.modelRegistry.buildCacheConfig(modelId).cacheName;
      const persisted = this.installStore.read(modelId);
      const initialSnapshot = createIdleSnapshot(modelId, cacheName, persisted);
      if (initialSnapshot.assetRecords.length === 0) {
        initialSnapshot.assetRecords = this.modelRegistry.listAssets(modelId).map(createAssetRecord);
        initialSnapshot.progress = buildProgress(initialSnapshot.assetRecords);
      }
      this.stateByModel.set(modelId, initialSnapshot);
    }
  }

  onStateChange(modelId, listener) {
    const listeners = this.listeners.get(modelId) || new Set();
    listeners.add(listener);
    this.listeners.set(modelId, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(modelId);
      }
    };
  }

  getState(modelId) {
    const snapshot = this.stateByModel.get(modelId);
    if (snapshot) {
      const controller = isControllerActive();
      const normalizedSnapshot = snapshot.ready && !controller
        ? {
          ...snapshot,
          ready: false,
          state: 'partial',
          controller: false,
          errorCode: INSTALL_ERROR_CODES.CONTROL_REQUIRED,
        }
        : {
          ...snapshot,
          controller,
        };
      return {
        ...normalizedSnapshot,
        statusText: formatInstallStateMessage(normalizedSnapshot),
        progress: { ...normalizedSnapshot.progress },
        assetRecords: [...normalizedSnapshot.assetRecords],
        missingRequired: [...normalizedSnapshot.missingRequired],
        cachedUrls: [...normalizedSnapshot.cachedUrls],
      };
    }

    const cacheName = this.modelRegistry.buildCacheConfig(modelId).cacheName;
    return createIdleSnapshot(modelId, cacheName);
  }

  emitState(modelId, partialSnapshot) {
    const previous = this.getState(modelId);
    const nextSnapshot = {
      ...previous,
      ...partialSnapshot,
      controller: partialSnapshot?.controller ?? isControllerActive(),
      progress: partialSnapshot?.progress
        ? { ...partialSnapshot.progress }
        : previous.progress,
      assetRecords: Array.isArray(partialSnapshot?.assetRecords)
        ? [...partialSnapshot.assetRecords]
        : previous.assetRecords,
      missingRequired: Array.isArray(partialSnapshot?.missingRequired)
        ? [...partialSnapshot.missingRequired]
        : previous.missingRequired,
      cachedUrls: Array.isArray(partialSnapshot?.cachedUrls)
        ? [...partialSnapshot.cachedUrls]
        : previous.cachedUrls,
      updatedAt: Date.now(),
    };
    nextSnapshot.statusText = formatInstallStateMessage(nextSnapshot);
    nextSnapshot.progress.percent = getInstallProgress(nextSnapshot) ?? nextSnapshot.progress.percent;

    this.stateByModel.set(modelId, nextSnapshot);
    this.installStore.write(modelId, nextSnapshot);

    for (const listener of this.listeners.get(modelId) || []) {
      listener(this.getState(modelId));
    }

    return this.getState(modelId);
  }

  async install(modelId, options = {}) {
    const { force = false } = options;
    const existing = this.pendingInstalls.get(modelId);
    if (existing && !force) {
      return existing;
    }

    const installPromise = this.runInstall(modelId, options)
      .finally(() => {
        if (this.pendingInstalls.get(modelId) === installPromise) {
          this.pendingInstalls.delete(modelId);
        }
      });

    this.pendingInstalls.set(modelId, installPromise);
    return installPromise;
  }

  async runInstall(modelId, options = {}) {
    const integrityMode = options.integrityMode || this.integrityMode;
    const cacheConfig = this.modelRegistry.buildCacheConfig(modelId);
    const assets = this.modelRegistry.listAssets(modelId);
    const requiredUrls = assets.filter((asset) => asset.required).map((asset) => toAbsoluteUrl(asset.url));
    const assetRecords = assets.map(createAssetRecord);
    const retryCount = Number.isInteger(options.retryCount) ? options.retryCount : this.getState(modelId).retryCount;
    const startedAt = Date.now();
    const buildTerminalTiming = () => {
      const completedAt = Date.now();
      return {
        completedAt,
        durationMs: Math.max(0, completedAt - startedAt),
      };
    };

    this.emitState(modelId, {
      manifestVersion: cacheConfig.version,
      cacheName: cacheConfig.cacheName,
      state: 'env_checking',
      ready: false,
      errorCode: '',
      errorDetail: '',
      prefetchError: '',
      missingRequired: [],
      cachedUrls: [],
      assetRecords,
      retryCount,
      integrityMode,
      startedAt,
      completedAt: 0,
      durationMs: 0,
      progress: buildProgress(assetRecords),
      controller: isControllerActive(),
    });

    if (typeof window === 'undefined' || !('serviceWorker' in navigator) || typeof caches === 'undefined') {
      const insecureContext = typeof window !== 'undefined' && !isSecureInstallContext();
      return this.emitState(modelId, {
        state: 'failed',
        ready: false,
        errorCode: insecureContext
          ? INSTALL_ERROR_CODES.INSECURE_CONTEXT
          : INSTALL_ERROR_CODES.BROWSER_UNSUPPORTED,
        errorDetail: insecureContext
          ? `INSECURE_CONTEXT:${window.location.href}`
          : '',
        progress: buildProgress(assetRecords),
      });
    }

    if (!navigator.serviceWorker.controller) {
      this.emitState(modelId, {
        state: 'control_waiting',
        ready: false,
        progress: buildProgress(this.getState(modelId).assetRecords),
      });
    }

    const controller = isControllerActive();
    this.emitState(modelId, {
      state: controller ? 'downloading_model' : 'control_waiting',
      ready: false,
      progress: buildProgress(assetRecords),
    });

    try {
      const installResult = await this.downloadEngine.downloadAssets({
        cacheConfig,
        assets,
        controller,
        integrityMode,
        onAssetProgress: ({ asset, downloadedBytes, totalBytes }) => {
          const currentRecords = this.getState(modelId).assetRecords;
          const nextAssetRecords = updateAssetRecord(currentRecords, asset, {
            downloadedBytes: typeof downloadedBytes === 'number' ? downloadedBytes : 0,
            expectedSizeBytes: typeof totalBytes === 'number'
              ? totalBytes
              : currentRecords.find((record) => record.url === asset.url)?.expectedSizeBytes ?? null,
          });
          this.emitState(modelId, {
            state: controller ? 'downloading_model' : 'control_waiting',
            currentAsset: asset.url,
            assetRecords: nextAssetRecords,
            progress: buildProgress(nextAssetRecords),
          });
        },
        onAssetUpdate: ({ asset, ...result }) => {
          const nextAssetRecords = updateAssetRecord(this.getState(modelId).assetRecords, asset, {
            status: result.status,
            attempts: result.attempts,
            verified: Boolean(result.verified),
            errorCode: result.errorCode || '',
            errorDetail: result.errorDetail || '',
            verifiedAt: result.verified ? Date.now() : 0,
            verificationSource: result.verification?.source || '',
            observedSizeBytes: typeof result.verification?.observedSizeBytes === 'number'
              ? result.verification.observedSizeBytes
              : null,
            expectedSizeBytes: typeof result.verification?.expectedSizeBytes === 'number'
              ? result.verification.expectedSizeBytes
              : null,
            sizeMismatch: Boolean(result.verification?.sizeMismatch),
            observedSha256: result.verification?.observedSha256 || '',
            expectedSha256: result.verification?.expectedSha256 || '',
            hashMismatch: Boolean(result.verification?.hashMismatch),
            integrityVerified: Boolean(result.verification?.integrityVerified),
            verificationMethod: result.verification?.verificationMethod || '',
            downloadedBytes: typeof result.verification?.observedSizeBytes === 'number'
              ? result.verification.observedSizeBytes
              : this.getState(modelId).assetRecords.find((record) => record.url === asset.url)?.downloadedBytes ?? 0,
            contentType: result.verification?.contentType || '',
            etag: result.verification?.etag || '',
            lastModified: result.verification?.lastModified || '',
          });
          this.emitState(modelId, {
            state: controller ? 'downloading_model' : 'control_waiting',
            currentAsset: asset.url,
            swVersion: result.version || this.getState(modelId).swVersion,
            assetRecords: nextAssetRecords,
            progress: buildProgress(nextAssetRecords),
          });
        },
      });
      const cachedUrls = installResult.cachedUrls || await listCachedAssetUrls(installResult.cacheName);
      const cachedUrlSet = new Set(cachedUrls);
      const missingRequired = requiredUrls.filter((url) => !cachedUrlSet.has(url));
      const currentState = this.getState(modelId);
      const settledAssetRecords = mergeAssetResults(currentState.assetRecords, installResult.assetResults);
      const integrityMismatch = settledAssetRecords.find((record) => record.required && (record.sizeMismatch || record.hashMismatch));
      const completedFiles = countCompletedAssetRecords(settledAssetRecords);

      if (!controller || missingRequired.length > 0 || integrityMismatch) {
        return this.emitState(modelId, {
          state: controller ? 'failed' : 'partial',
          ready: false,
          controller,
          errorCode: !controller
            ? INSTALL_ERROR_CODES.CONTROL_REQUIRED
            : integrityMismatch
              ? INSTALL_ERROR_CODES.INTEGRITY_MISMATCH
              : INSTALL_ERROR_CODES.ASSET_MISSING,
          errorDetail: installResult.prefetchError
            || integrityMismatch?.errorDetail
            || settledAssetRecords.find((record) => record.errorDetail)?.errorDetail
            || '',
          prefetchError: installResult.prefetchError || '',
          swVersion: installResult.swVersion || currentState.swVersion,
          assetRecords: settledAssetRecords,
          missingRequired,
          cachedUrls,
          ...buildTerminalTiming(),
          progress: buildProgress(settledAssetRecords),
        });
      }

      this.emitState(modelId, {
        state: 'verifying',
        ready: false,
        controller,
        cachedUrls,
        swVersion: installResult.swVersion || currentState.swVersion,
        assetRecords: settledAssetRecords,
        progress: buildProgress(settledAssetRecords),
      });

      return this.emitState(modelId, {
        state: 'ready',
        ready: true,
        controller,
        swVersion: installResult.swVersion || currentState.swVersion,
        verifiedAt: Date.now(),
        ...buildTerminalTiming(),
        cachedUrls,
        assetRecords: settledAssetRecords.map((record) => ({
          ...record,
          verified: record.verified || cachedUrlSet.has(toAbsoluteUrl(record.url)),
          status: cachedUrlSet.has(toAbsoluteUrl(record.url)) ? 'cached' : record.status,
          verifiedAt: cachedUrlSet.has(toAbsoluteUrl(record.url)) ? Date.now() : record.verifiedAt,
        })),
        missingRequired: [],
        errorCode: '',
        errorDetail: '',
        prefetchError: '',
        progress: buildProgress(settledAssetRecords.map((record) => ({
          ...record,
          downloadedBytes: record.observedSizeBytes || record.expectedSizeBytes || record.downloadedBytes,
        }))),
      });
    } catch (error) {
      return this.emitState(modelId, {
        state: 'failed',
        ready: false,
        errorCode: INSTALL_ERROR_CODES.NETWORK_ERROR,
        errorDetail: error instanceof Error ? error.message : String(error),
        ...buildTerminalTiming(),
        progress: buildProgress(this.getState(modelId).assetRecords),
      });
    }
  }

  async retryInstall(modelId) {
    const snapshot = this.getState(modelId);
    return this.install(modelId, {
      force: true,
      retryCount: snapshot.retryCount + 1,
      integrityMode: this.integrityMode,
    });
  }

  setIntegrityMode(mode) {
    this.integrityMode = mode === 'size-only' ? 'size-only' : 'full';
    this.downloadEngine.setIntegrityMode(this.integrityMode);
  }

  getIntegrityMode() {
    return this.integrityMode;
  }

  cancelInstall(modelId) {
    const current = this.getState(modelId);
    if (!this.pendingInstalls.has(modelId)) {
      return false;
    }

    this.emitState(modelId, {
      state: 'cancelled',
      ready: false,
      progress: current.progress,
    });
    return true;
  }

  async clearModel(modelId) {
    const cacheName = this.modelRegistry.buildCacheConfig(modelId).cacheName;

    try {
      if (typeof caches !== 'undefined') {
        await caches.delete(cacheName);
      }
      this.installStore.clear(modelId);
      this.stateByModel.set(modelId, createIdleSnapshot(modelId, cacheName));
      this.emitState(modelId, {
        manifestVersion: this.modelRegistry.buildCacheConfig(modelId).version,
        state: 'idle',
        ready: false,
        controller: isControllerActive(),
        assetRecords: this.modelRegistry.listAssets(modelId).map(createAssetRecord),
        progress: buildProgress(this.modelRegistry.listAssets(modelId).map(createAssetRecord)),
        missingRequired: [],
        cachedUrls: [],
        errorCode: '',
        errorDetail: '',
        prefetchError: '',
        swVersion: '',
        verifiedAt: 0,
        startedAt: 0,
        completedAt: 0,
        durationMs: 0,
      });
      return true;
    } catch (error) {
      this.emitState(modelId, {
        state: 'failed',
        ready: false,
        errorCode: INSTALL_ERROR_CODES.CLEAR_FAILED,
        errorDetail: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  getDiagnostics(modelId) {
    const snapshot = this.getState(modelId);
    const manifest = this.modelRegistry.getModel(modelId);
    return {
      install: snapshot,
      manifest: {
        modelId: manifest.modelId,
        version: manifest.version,
        cachePrefix: manifest.cache.prefix,
        serviceWorkerUrl: manifest.cache.serviceWorkerUrl,
        requiredAssets: manifest.assets
          .filter((asset) => asset.required)
          .map((asset) => ({
            url: asset.url,
            type: asset.type,
            installChannel: asset.installChannel,
            sizeBytes: typeof asset.sizeBytes === 'number' ? asset.sizeBytes : null,
          })),
      },
    };
  }
}
