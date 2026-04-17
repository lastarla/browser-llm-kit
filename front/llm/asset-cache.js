const DEFAULT_SERVICE_WORKER_URL = '/llm-asset-sw.js';
const DEFAULT_CACHE_PREFIX = 'llm-assets';
const CONTROLLER_WAIT_TIMEOUT_MS = 3000;
const MAX_HASH_BYTES = 64 * 1024 * 1024;
const EMPTY_CONFIG = Object.freeze({
  supported: false,
  registration: null,
  cacheName: '',
});

const registrationPromises = new Map();

function normalizeCacheSegment(value) {
  const normalized = String(value ?? '').trim().replace(/[^a-zA-Z0-9._-]+/g, '_');
  return normalized || 'default';
}

function normalizeIncludeUrls(urls) {
  if (!Array.isArray(urls)) {
    return [];
  }

  const normalizedUrls = [];
  const seen = new Set();

  for (const item of urls) {
    const raw = String(item ?? '').trim();
    if (!raw) {
      continue;
    }

    const normalized = typeof window === 'undefined'
      ? raw
      : new URL(raw, window.location.href).href;

    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    normalizedUrls.push(normalized);
  }

  return normalizedUrls;
}

export function buildAssetCacheName({
  model,
  version,
  cachePrefix = DEFAULT_CACHE_PREFIX,
}) {
  return `${normalizeCacheSegment(cachePrefix)}::${normalizeCacheSegment(model)}::${normalizeCacheSegment(version)}`;
}

function createRegistrationKey({ serviceWorkerUrl, cacheName }) {
  return `${serviceWorkerUrl}::${cacheName}`;
}

function resolveWorker(registration) {
  return registration?.active
    || navigator.serviceWorker.controller
    || registration?.waiting
    || registration?.installing
    || null;
}

function waitForController() {
  if (navigator.serviceWorker.controller) {
    return Promise.resolve(navigator.serviceWorker.controller);
  }

  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange);
      reject(new Error('SERVICE_WORKER_CONTROLLER_TIMEOUT'));
    }, CONTROLLER_WAIT_TIMEOUT_MS);

    const handleControllerChange = () => {
      if (!navigator.serviceWorker.controller) {
        return;
      }
      window.clearTimeout(timer);
      navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange);
      resolve(navigator.serviceWorker.controller);
    };

    navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange);
  });
}

async function ensureServiceWorkerController(registration) {
  if (navigator.serviceWorker.controller) {
    return navigator.serviceWorker.controller;
  }

  const worker = registration?.active || registration?.waiting || registration?.installing || null;
  if (!worker) {
    throw new Error('NO_SERVICE_WORKER');
  }

  return waitForController();
}

function sendWorkerMessage(worker, message, options = {}) {
  if (!worker) {
    return Promise.resolve({ ok: false, reason: 'NO_SERVICE_WORKER' });
  }

  const { onProgress = null, timeoutMs = 5000 } = options;
  const channel = new MessageChannel();
  return new Promise((resolve, reject) => {
    let timer = null;
    const scheduleTimeout = () => window.setTimeout(() => {
      channel.port1.onmessage = null;
      reject(new Error('SERVICE_WORKER_MESSAGE_TIMEOUT'));
    }, timeoutMs);
    const resetTimeout = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      timer = scheduleTimeout();
    };
    resetTimeout();

    channel.port1.onmessage = (event) => {
      resetTimeout();
      const data = event.data || { ok: false, reason: 'EMPTY_SERVICE_WORKER_RESPONSE' };
      if (data.kind === 'progress') {
        onProgress?.(data);
        return;
      }
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      resolve(data);
    };

    try {
      worker.postMessage(message, [channel.port2]);
    } catch (error) {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      reject(error);
    }
  });
}

function getObservedSizeBytes(response) {
  const headerValue = response?.headers?.get?.('content-length');
  if (headerValue === null || headerValue === undefined || headerValue === '') {
    return null;
  }
  const parsed = Number(headerValue);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }

  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }

  if (typeof btoa === 'function') {
    return btoa(binary);
  }

  throw new Error('BASE64_ENCODING_UNAVAILABLE');
}

function normalizeSha256Hex(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return /^[0-9a-f]{64}$/u.test(normalized) ? normalized : '';
}

function sha256HexToSri(value) {
  const normalized = normalizeSha256Hex(value);
  if (!normalized) {
    return '';
  }

  const bytes = new Uint8Array(normalized.match(/.{2}/gu).map((part) => Number.parseInt(part, 16)));
  return `sha256-${bytesToBase64(bytes)}`;
}

function normalizeExpectedAssets(expectedAssets) {
  if (!Array.isArray(expectedAssets)) {
    return [];
  }

  const normalized = [];
  for (const item of expectedAssets) {
    const rawUrl = String(item?.url ?? '').trim();
    if (!rawUrl) {
      continue;
    }

    normalized.push({
      url: new URL(rawUrl, window.location.href).href,
      sha256: normalizeSha256Hex(item?.sha256),
    });
  }

  return normalized;
}

function buildExpectedAssetMap(expectedAssets) {
  return new Map(
    normalizeExpectedAssets(expectedAssets).map((item) => [item.url, item]),
  );
}

async function getObservedSha256(response, observedSizeBytes) {
  if (!response?.clone || !response?.arrayBuffer || observedSizeBytes === null || observedSizeBytes > MAX_HASH_BYTES) {
    return '';
  }

  const buffer = await response.clone().arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return bytesToHex(new Uint8Array(digest));
}

async function buildAssetReport(url, response, source, enableHash = true) {
  const observedSizeBytes = getObservedSizeBytes(response);
  const observedSha256 = enableHash
    ? await getObservedSha256(response, observedSizeBytes)
    : '';
  return {
    url,
    source,
    observedSizeBytes,
    observedSha256,
    integrityVerified: false,
    verificationMethod: observedSha256 ? 'subtle-digest' : '',
    contentType: response?.headers?.get?.('content-type') || '',
    etag: response?.headers?.get?.('etag') || '',
    lastModified: response?.headers?.get?.('last-modified') || '',
  };
}

export function normalizeAssetCacheConfig({
  serviceWorkerUrl = DEFAULT_SERVICE_WORKER_URL,
  cachePrefix = DEFAULT_CACHE_PREFIX,
  cacheName,
  model,
  version,
  includePathPrefixes = [],
  includeUrls = [],
  enabled = true,
}) {
  const normalizedModel = String(model ?? '').trim();
  const normalizedVersion = String(version ?? '').trim();
  const normalizedCacheName = String(cacheName || buildAssetCacheName({
    cachePrefix,
    model: normalizedModel,
    version: normalizedVersion,
  })).trim();

  return {
    enabled,
    serviceWorkerUrl: String(serviceWorkerUrl ?? '').trim() || DEFAULT_SERVICE_WORKER_URL,
    cachePrefix: String(cachePrefix ?? '').trim() || DEFAULT_CACHE_PREFIX,
    cacheName: normalizedCacheName,
    model: normalizedModel,
    version: normalizedVersion,
    includePathPrefixes: Array.from(new Set(includePathPrefixes.map((item) => String(item ?? '').trim()).filter(Boolean))),
    includeUrls: normalizeIncludeUrls(includeUrls),
  };
}

async function registerServiceWorker(serviceWorkerUrl) {
  const existingRegistration = await navigator.serviceWorker.getRegistration(serviceWorkerUrl);
  if (existingRegistration?.active) {
    await navigator.serviceWorker.ready;
    await ensureServiceWorkerController(existingRegistration).catch(() => existingRegistration.active);
    return existingRegistration;
  }

  const registration = await navigator.serviceWorker.register(serviceWorkerUrl, {
    scope: '/',
    updateViaCache: 'none',
  });
  await navigator.serviceWorker.ready;
  await ensureServiceWorkerController(registration).catch(() => registration.active);
  return registration;
}

export async function configureAssetCache(options) {
  const config = normalizeAssetCacheConfig(options || {});
  if (!config.enabled || typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return EMPTY_CONFIG;
  }

  const registrationKey = createRegistrationKey(config);
  const existingPromise = registrationPromises.get(registrationKey);
  if (existingPromise) {
    return existingPromise;
  }

  const configurationPromise = (async () => {
    await registerServiceWorker(config.serviceWorkerUrl);
    const registration = await navigator.serviceWorker.getRegistration(config.serviceWorkerUrl)
      || await registerServiceWorker(config.serviceWorkerUrl);

    const worker = resolveWorker(registration);
    const configureResult = await sendWorkerMessage(worker, {
      type: 'configure_asset_cache',
      cacheName: config.cacheName,
      includePathPrefixes: config.includePathPrefixes,
      includeUrls: config.includeUrls,
    });
    if (!configureResult?.ok) {
      throw new Error(configureResult?.reason || 'NO_SERVICE_WORKER');
    }

    return {
      supported: true,
      registration,
      worker,
      config,
      cacheName: config.cacheName,
      version: configureResult?.version || '',
      prefetchedUrls: [],
      prefetchError: '',
    };
  })().catch((error) => {
    registrationPromises.delete(registrationKey);
    throw error;
  });

  registrationPromises.set(registrationKey, configurationPromise);
  return configurationPromise;
}

export async function prefetchAssetUrls({
  config,
  registration,
  worker,
  cacheName,
  urls,
  expectedAssets = [],
  onProgress = null,
  enableHash = true,
}) {
  const normalizedUrls = normalizeIncludeUrls(urls);
  const normalizedExpectedAssets = normalizeExpectedAssets(expectedAssets).filter(
    (item) => normalizedUrls.includes(item.url),
  );
  if (normalizedUrls.length === 0) {
    return {
      ok: true,
      cachedUrls: [],
      prefetchError: '',
      version: '',
    };
  }

  const targetCacheName = String(cacheName || config?.cacheName || '').trim();
  const activeWorker = worker || resolveWorker(registration);
  let prefetchedUrls = [];
  let assetReports = [];
  let prefetchError = '';
  let swVersion = '';

  const prefetchResult = await sendWorkerMessage(activeWorker, {
    type: 'prefetch_asset_urls',
    cacheName: targetCacheName,
    urls: normalizedUrls,
    expectedAssets: normalizedExpectedAssets,
    enableHash,
  }, {
    onProgress,
    timeoutMs: 30000,
  });

  if (prefetchResult?.ok) {
    prefetchedUrls = Array.isArray(prefetchResult.cachedUrls) ? prefetchResult.cachedUrls : [];
    assetReports = Array.isArray(prefetchResult.assetReports) ? prefetchResult.assetReports : [];
    swVersion = prefetchResult?.version || '';
  } else {
    prefetchError = prefetchResult?.reason || 'ASSET_PREFETCH_FAILED';
    swVersion = prefetchResult?.version || '';
  }

  return {
    ok: prefetchedUrls.length > 0 && !prefetchError,
    cachedUrls: prefetchedUrls,
    assetReports,
    prefetchError,
    version: swVersion,
  };
}

export async function listCachedAssetUrls(cacheName) {
  if (typeof caches === 'undefined' || !cacheName) {
    return [];
  }

  const cache = await caches.open(cacheName);
  const requests = await cache.keys();
  return requests.map((request) => request.url);
}

export async function registerAssetCache(options) {
  const config = normalizeAssetCacheConfig(options || {});
  const configured = await configureAssetCache(config);
  if (!configured.supported) {
    return configured;
  }

  const prefetchResult = await prefetchAssetUrls({
    config,
    registration: configured.registration,
    worker: configured.worker,
    cacheName: configured.cacheName,
    urls: config.includeUrls,
  });

  return {
    supported: true,
    registration: configured.registration,
    worker: configured.worker,
    config,
    cacheName: configured.cacheName,
    version: prefetchResult.version || configured.version || '',
    prefetchedUrls: prefetchResult.cachedUrls,
    assetReports: prefetchResult.assetReports,
    prefetchError: prefetchResult.prefetchError,
  };
}

export function resetAssetCacheStateForTests() {
  registrationPromises.clear();
}

export { DEFAULT_CACHE_PREFIX, DEFAULT_SERVICE_WORKER_URL };
