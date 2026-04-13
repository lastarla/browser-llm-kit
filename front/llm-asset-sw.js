const cacheRules = new Map();
const SW_VERSION = '2026-04-12-click-cache-v2';

function normalizePathPrefixes(prefixes) {
  return Array.isArray(prefixes)
    ? prefixes.map((item) => String(item ?? '').trim()).filter(Boolean)
    : [];
}

function normalizeUrls(urls) {
  return Array.isArray(urls)
    ? urls.map((item) => String(item ?? '').trim()).filter(Boolean)
    : [];
}

function buildRequest(url) {
  return new Request(url, {
    method: 'GET',
    credentials: 'same-origin',
  });
}

async function prefetchUrls(cacheName, urls) {
  const normalizedUrls = Array.isArray(urls)
    ? urls.map((item) => String(item ?? '').trim()).filter(Boolean)
    : [];

  if (normalizedUrls.length === 0) {
    return [];
  }

  const cache = await caches.open(cacheName);
  const cachedUrls = [];

  for (const url of normalizedUrls) {
    const request = buildRequest(url);
    const cachedResponse = await cache.match(request, { ignoreVary: true });
    if (cachedResponse) {
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

function shouldHandleRequest(url) {
  if (url.origin !== self.location.origin) {
    return null;
  }

  for (const [cacheName, rule] of cacheRules.entries()) {
    if (rule.includeUrls.has(url.href)) {
      return cacheName;
    }

    if (rule.includePathPrefixes.some((prefix) => url.pathname.startsWith(prefix))) {
      return cacheName;
    }
  }

  return null;
}

async function getCachedResponse(request, cacheName) {
  const cache = await caches.open(cacheName);
  return cache.match(buildRequest(request.url), { ignoreVary: true });
}

async function cacheResponse(request, response, cacheName) {
  if (!response.ok) {
    return;
  }

  try {
    const cache = await caches.open(cacheName);
    await cache.put(buildRequest(request.url), response.clone());
  } catch (error) {
    console.warn('llm-asset-sw cache.put failed', request.url, error);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames
        .filter((cacheName) => cacheName.startsWith('llm-assets::'))
        .map((cacheName) => {
          if (!cacheName.includes('::v1')) {
            return caches.delete(cacheName);
          }
          return Promise.resolve(false);
        }),
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const message = event.data || {};
  const port = event.ports?.[0];

  if (message.type === 'configure_asset_cache') {
    const cacheName = String(message.cacheName ?? '').trim();
    if (cacheName) {
      cacheRules.set(cacheName, {
        includePathPrefixes: normalizePathPrefixes(message.includePathPrefixes),
        includeUrls: new Set(normalizeUrls(message.includeUrls)),
      });
    }
    port?.postMessage({ ok: true, cacheName, version: SW_VERSION });
    return;
  }

  if (message.type === 'prefetch_asset_urls') {
    const cacheName = String(message.cacheName ?? '').trim();
    const urls = normalizeUrls(message.urls);
    event.waitUntil((async () => {
      try {
        const cachedUrls = await prefetchUrls(cacheName, urls);
        port?.postMessage({ ok: true, cacheName, cachedUrls, version: SW_VERSION });
      } catch (error) {
        port?.postMessage({
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
          cacheName,
          version: SW_VERSION,
        });
      }
    })());
    return;
  }

  port?.postMessage({ ok: false, reason: 'UNKNOWN_MESSAGE_TYPE' });
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);
  const cacheName = shouldHandleRequest(url);
  if (!cacheName) {
    return;
  }

  event.respondWith((async () => {
    const cachedResponse = await getCachedResponse(request, cacheName);
    if (cachedResponse) {
      return cachedResponse;
    }

    const response = await fetch(request);
    event.waitUntil(cacheResponse(request, response, cacheName));
    return response;
  })());
});
