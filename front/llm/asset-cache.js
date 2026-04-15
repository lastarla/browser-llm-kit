const DEFAULT_SERVICE_WORKER_URL = '/llm-asset-sw.js';
const DEFAULT_CACHE_PREFIX = 'llm-assets';
const CONTROLLER_WAIT_TIMEOUT_MS = 3000;
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

function sendWorkerMessage(worker, message) {
  if (!worker) {
    return Promise.resolve({ ok: false, reason: 'NO_SERVICE_WORKER' });
  }

  const channel = new MessageChannel();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      channel.port1.onmessage = null;
      reject(new Error('SERVICE_WORKER_MESSAGE_TIMEOUT'));
    }, 5000);

    channel.port1.onmessage = (event) => {
      window.clearTimeout(timer);
      resolve(event.data || { ok: false, reason: 'EMPTY_SERVICE_WORKER_RESPONSE' });
    };

    try {
      worker.postMessage(message, [channel.port2]);
    } catch (error) {
      window.clearTimeout(timer);
      reject(error);
    }
  });
}

async function prefetchUrlsFromPage(cacheName, urls) {
  if (!cacheName || !Array.isArray(urls) || urls.length === 0) {
    return [];
  }

  // Large model blobs (e.g. .task) can overwhelm renderer memory when prefetched from page context.
  // Keep page-context prefetch limited to smaller runtime assets (wasm/js/css/html/json).
  const safeUrls = urls.filter((url) => {
    try {
      const { pathname } = new URL(url, window.location.href);
      return !pathname.endsWith('.task') && !pathname.endsWith('.bin');
    } catch {
      return false;
    }
  });

  if (safeUrls.length === 0) {
    return [];
  }

  const cache = await caches.open(cacheName);
  const cachedUrls = [];

  for (const url of safeUrls) {
    const request = new Request(url, {
      method: 'GET',
      credentials: 'same-origin',
    });
    const hit = await cache.match(request, { ignoreVary: true });
    if (hit) {
      cachedUrls.push(url);
      continue;
    }

    const response = await fetch(request);
    if (!response.ok) {
      throw new Error(`ASSET_PREFETCH_FAILED:${response.status}:${url}`);
    }

    await cache.put(request, response.clone());
    cachedUrls.push(url);
  }

  return cachedUrls;
}

function normalizeConfig({
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

export async function registerAssetCache(options) {
  const config = normalizeConfig(options || {});
  if (!config.enabled || typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return EMPTY_CONFIG;
  }

  await registerServiceWorker(config.serviceWorkerUrl);

  const registrationKey = createRegistrationKey(config);
  const existingPromise = registrationPromises.get(registrationKey);
  if (existingPromise) {
    return existingPromise;
  }

  const registrationPromise = (async () => {
    const registration = await navigator.serviceWorker.getRegistration(config.serviceWorkerUrl)
      || await registerServiceWorker(config.serviceWorkerUrl);

    const worker = resolveWorker(registration);
    const result = await sendWorkerMessage(worker, {
      type: 'configure_asset_cache',
      cacheName: config.cacheName,
      includePathPrefixes: config.includePathPrefixes,
      includeUrls: config.includeUrls,
    });
    if (!result?.ok) {
      throw new Error(result?.reason || 'NO_SERVICE_WORKER');
    }

    let prefetchedUrls = [];
    let prefetchError = '';

    if (config.includeUrls.length > 0) {
      const prefetchResult = await sendWorkerMessage(worker, {
        type: 'prefetch_asset_urls',
        cacheName: config.cacheName,
        urls: config.includeUrls,
      });

      if (prefetchResult?.ok) {
        prefetchedUrls = Array.isArray(prefetchResult.cachedUrls) ? prefetchResult.cachedUrls : [];
      } else {
        prefetchError = prefetchResult?.reason || 'ASSET_PREFETCH_FAILED';
      }
    }

    // Fallback: when SW is not controlling the current page yet, warm cache directly from page context.
    if (config.includeUrls.length > 0 && (prefetchedUrls.length === 0 || prefetchError)) {
      try {
        const pagePrefetchedUrls = await prefetchUrlsFromPage(config.cacheName, config.includeUrls);
        if (pagePrefetchedUrls.length > 0) {
          prefetchedUrls = Array.from(new Set([...prefetchedUrls, ...pagePrefetchedUrls]));
          prefetchError = '';
        }
      } catch (error) {
        if (!prefetchError) {
          prefetchError = error instanceof Error ? error.message : String(error);
        }
      }
    }

    return {
      supported: true,
      registration,
      cacheName: config.cacheName,
      prefetchedUrls,
      prefetchError,
    };
  })().catch((error) => {
    registrationPromises.delete(registrationKey);
    throw error;
  });

  registrationPromises.set(registrationKey, registrationPromise);
  return registrationPromise;
}

export { DEFAULT_CACHE_PREFIX, DEFAULT_SERVICE_WORKER_URL };
