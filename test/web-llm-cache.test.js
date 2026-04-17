import test from 'node:test';
import assert from 'node:assert/strict';
import LLM from '../front/llm/index.js';
import { buildAssetCacheName, registerAssetCache, resetAssetCacheStateForTests } from '../front/llm/asset-cache.js';

function serialTest(name, fn) {
  return test(name, { concurrency: false }, fn);
}

function createMockResponse({
  contentLength = null,
  contentType = '',
  etag = '',
  lastModified = '',
} = {}) {
  const headers = new Headers();
  if (contentLength !== null) {
    headers.set('content-length', String(contentLength));
  }
  if (contentType) {
    headers.set('content-type', contentType);
  }
  if (etag) {
    headers.set('etag', etag);
  }
  if (lastModified) {
    headers.set('last-modified', lastModified);
  }

  return {
    ok: true,
    headers,
    clone() {
      return this;
    },
  };
}

function getManifestAssetSizeForUrl(url) {
  if (url.endsWith('.task')) {
    return 2003697664;
  }
  if (url.endsWith('genai_wasm_internal.js')) {
    return 331776;
  }
  if (url.endsWith('genai_wasm_internal.wasm')) {
    return 26214400;
  }
  if (url.endsWith('genai_wasm_module_internal.js')) {
    return 331776;
  }
  if (url.endsWith('genai_wasm_module_internal.wasm')) {
    return 26214400;
  }
  if (url.endsWith('genai_wasm_nosimd_internal.js')) {
    return 331776;
  }
  if (url.endsWith('genai_wasm_nosimd_internal.wasm')) {
    return 26109542;
  }
  return null;
}

function installBrowserStubs(t, {
  workerHandler,
  fetchHandler,
  controller = null,
  seedCacheUrls = [],
  seedLocalStorage = {},
  userAgent = 'UnitTestBrowser/1.0',
  userAgentBrands = [],
  serviceWorkerSupported = true,
  cacheSupported = true,
  isSecureContext = true,
}) {
  resetAssetCacheStateForTests();
  const originalWindow = globalThis.window;
  const originalNavigator = globalThis.navigator;
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;
  const originalMessageChannel = globalThis.MessageChannel;
  const originalLocalStorage = globalThis.localStorage;

  const cacheEntries = new Map(
    seedCacheUrls.map((url) => [url, { ok: true, url }]),
  );
  const cacheWrites = [];
  const localStorageEntries = new Map(Object.entries(seedLocalStorage));
  const cache = {
    async match(request) {
      return cacheEntries.get(request.url) ?? null;
    },
    async put(request, response) {
      cacheEntries.set(request.url, response);
      cacheWrites.push(request.url);
    },
    async keys() {
      return Array.from(cacheEntries.keys()).map((url) => ({ url }));
    },
  };

  class MockMessageChannel {
    constructor() {
      this.port1 = { onmessage: null };
      this.port2 = {
        postMessage: (data) => {
          this.port1.onmessage?.({ data });
        },
      };
    }
  }

  const registration = {
    active: {
      postMessage(message, ports) {
        const wrappedPorts = ports.map((port) => ({
          ...port,
          postMessage(data) {
            if (data && typeof data === 'object' && !Array.isArray(data) && !('version' in data)) {
              port.postMessage({
                version: '2026-04-15-cache-prefetch-v3',
                ...data,
              });
              return;
            }
            port.postMessage(data);
          },
        }));
        workerHandler(message, wrappedPorts, { cacheEntries, cacheWrites });
      },
    },
    waiting: null,
    installing: null,
  };

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      location: {
        href: isSecureContext ? 'https://example.test/' : 'http://172.28.1.16:3001/',
      },
      isSecureContext,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    },
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent,
      userAgentData: {
        brands: userAgentBrands,
      },
      ...(serviceWorkerSupported ? {
        serviceWorker: {
          controller,
          ready: Promise.resolve(registration),
          async getRegistration() {
            return registration;
          },
          async register() {
            return registration;
          },
          addEventListener() {},
          removeEventListener() {},
        },
      } : {}),
    },
  });
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    writable: true,
    value: cacheSupported ? {
      async open() {
        return cache;
      },
      async delete(cacheName) {
        cacheEntries.clear();
        return Boolean(cacheName);
      },
    } : undefined,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem(key) {
        return localStorageEntries.has(key) ? localStorageEntries.get(key) : null;
      },
      setItem(key, value) {
        localStorageEntries.set(key, String(value));
      },
      removeItem(key) {
        localStorageEntries.delete(key);
      },
    },
  });
  globalThis.fetch = async (request) => fetchHandler(request);
  globalThis.MessageChannel = MockMessageChannel;

  t.after(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: originalWindow,
    });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      writable: true,
      value: originalCaches,
    });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: originalLocalStorage,
    });
    globalThis.fetch = originalFetch;
    globalThis.MessageChannel = originalMessageChannel;
  });

  return { cacheWrites, cacheEntries, localStorageEntries };
}

serialTest('registerAssetCache surfaces service-worker prefetch failures without page fallback', async (t) => {
  const fetchedUrls = [];
  const { cacheWrites } = installBrowserStubs(t, {
    workerHandler(message, ports) {
      const [port] = ports;
      if (message.type === 'configure_asset_cache') {
        port.postMessage({ ok: true });
        return;
      }
      if (message.type === 'prefetch_asset_urls') {
        port.postMessage({ ok: false, reason: 'SW_PREFETCH_UNAVAILABLE' });
        return;
      }
      port.postMessage({ ok: false, reason: 'UNKNOWN_MESSAGE' });
    },
    fetchHandler(request) {
      fetchedUrls.push(request.url);
      return Promise.resolve(createMockResponse({
        contentLength: 331776,
        contentType: 'application/javascript',
      }));
    },
  });

  const result = await registerAssetCache({
    serviceWorkerUrl: '/llm-asset-sw.js',
    cacheName: 'llm-assets::gemma4_e2b::v1',
    includeUrls: [
      '/wasm/genai_wasm_internal.js',
      '/assets/llm/gemma-4-E2B-it-web.task',
      '/assets/llm/gemma-4-E2B-it-web.bin',
    ],
  });

  assert.equal(result.supported, true);
  assert.deepEqual(result.prefetchedUrls, []);
  assert.equal(result.prefetchError, 'SW_PREFETCH_UNAVAILABLE');
  assert.deepEqual(fetchedUrls, []);
  assert.deepEqual(cacheWrites, []);
});

serialTest('LLM exposes stable default cache config and lets host override model asset path', () => {
  const llm = new LLM();
  const defaultConfig = llm.getModelCacheConfig('gemma4:e2b');

  assert.equal(llm.getIntegrityMode(), 'size-only');
  assert.equal(defaultConfig.serviceWorkerUrl, '/llm-asset-sw.js');
  assert.equal(defaultConfig.cachePrefix, 'llm-assets');
  assert.equal(defaultConfig.model, 'gemma4:e2b');
  assert.equal(defaultConfig.version, 'v1');
  assert.deepEqual(defaultConfig.includePathPrefixes, ['/wasm']);
  assert.equal(defaultConfig.includeUrls[0], '/assets/llm/gemma-4-E2B-it-web.task');
  assert.equal(
    buildAssetCacheName(defaultConfig),
    'llm-assets::gemma4_e2b::v1',
  );

  llm.setModelAssetPath('gemma4:e2b', '/assets/llm/custom-model.task');

  const updatedConfig = llm.getModelCacheConfig('gemma4:e2b');
  assert.equal(updatedConfig.includeUrls[0], '/assets/llm/custom-model.task');
});

serialTest('LLM full integrity mode installs successfully in Chromium-family browsers', async (t) => {
  installBrowserStubs(t, {
    workerHandler(message, ports, context) {
      const [port] = ports;
      if (message.type === 'configure_asset_cache') {
        port.postMessage({ ok: true });
        return;
      }
      if (message.type === 'prefetch_asset_urls') {
        const resolvedUrls = message.urls.map((item) => new URL(item, 'https://example.test/').href);
        const assetReports = resolvedUrls.map((url) => {
          const expectedAsset = (message.expectedAssets || []).find(
            (item) => new URL(item.url, 'https://example.test/').href === url,
          );
          return {
            url,
            source: 'service-worker-network',
            observedSizeBytes: getManifestAssetSizeForUrl(url),
            observedSha256: expectedAsset?.sha256 || '',
            integrityVerified: Boolean(expectedAsset?.sha256),
            verificationMethod: expectedAsset?.sha256 ? 'stream-sha256' : '',
            contentType: '',
            etag: '',
            lastModified: '',
          };
        });
        for (const resolvedUrl of resolvedUrls) {
          context.cacheEntries.set(resolvedUrl, createMockResponse({
            contentLength: getManifestAssetSizeForUrl(resolvedUrl),
          }));
        }
        port.postMessage({ ok: true, cachedUrls: resolvedUrls, assetReports });
        return;
      }
      port.postMessage({ ok: false, reason: 'UNKNOWN_WORKER_MESSAGE' });
    },
    fetchHandler() {
      return Promise.resolve(createMockResponse());
    },
    controller: { state: 'controlled' },
    userAgent: 'Mozilla/5.0 AppleWebKit/537.36 Chrome/133.0.0.0 Safari/537.36',
    userAgentBrands: [{ brand: 'Chromium' }],
  });

  const llm = new LLM();
  llm.setIntegrityMode('full');
  const installState = await llm.prepare('gemma4:e2b');
  const modelAsset = installState.assetRecords.find((record) => record.url.endsWith('.task'));

  assert.equal(installState.ready, true);
  assert.equal(installState.state, 'ready');
  assert.equal(installState.errorCode, '');
  assert.equal(modelAsset?.integrityVerified, true);
  assert.equal(modelAsset?.verificationMethod, 'stream-sha256');
});

serialTest('LLM prepare reports partial install before service worker controls the page', async (t) => {
  installBrowserStubs(t, {
    workerHandler(message, ports) {
      const [port] = ports;
      if (message.type === 'configure_asset_cache') {
        port.postMessage({ ok: true });
        return;
      }
      if (message.type === 'prefetch_asset_urls') {
        port.postMessage({ ok: false, reason: 'SW_PREFETCH_UNAVAILABLE' });
        return;
      }
      port.postMessage({ ok: false, reason: 'UNKNOWN_MESSAGE' });
    },
    fetchHandler() {
      return Promise.resolve({
        ok: true,
        clone() {
          return this;
        },
      });
    },
    controller: null,
  });

  const llm = new LLM();
  const installState = await llm.prepare('gemma4:e2b');

  assert.equal(installState.state, 'partial');
  assert.equal(installState.ready, false);
  assert.equal(installState.errorCode, 'INSTALL_CONTROL_REQUIRED');
  assert.equal(installState.statusText, '需要刷新页面以完成模型安装');
  assert(installState.missingRequired.some((url) => url.includes('.task')));
});

serialTest('LLM prepare reports insecure-context guidance on LAN http origin', async (t) => {
  installBrowserStubs(t, {
    workerHandler() {},
    fetchHandler() {
      return Promise.resolve(createMockResponse());
    },
    serviceWorkerSupported: false,
    cacheSupported: false,
    isSecureContext: false,
  });

  const llm = new LLM();
  const installState = await llm.prepare('gemma4:e2b');

  assert.equal(installState.state, 'failed');
  assert.equal(installState.ready, false);
  assert.equal(installState.errorCode, 'INSTALL_INSECURE_CONTEXT');
  assert.equal(installState.statusText, '当前地址不是安全上下文，请改用 HTTPS 或 localhost');
  assert.match(installState.errorDetail, /INSECURE_CONTEXT:http:\/\/172\.28\.1\.16:3001\//);
});

serialTest('LLM prepare reports ready when controller is active and required assets are cached', async (t) => {
  const requiredUrls = [
    'https://example.test/assets/llm/gemma-4-E2B-it-web.task',
    'https://example.test/wasm/genai_wasm_internal.js',
    'https://example.test/wasm/genai_wasm_internal.wasm',
    'https://example.test/wasm/genai_wasm_module_internal.js',
    'https://example.test/wasm/genai_wasm_module_internal.wasm',
    'https://example.test/wasm/genai_wasm_nosimd_internal.js',
    'https://example.test/wasm/genai_wasm_nosimd_internal.wasm',
  ];

  installBrowserStubs(t, {
    workerHandler(message, ports) {
      const [port] = ports;
      if (message.type === 'configure_asset_cache') {
        port.postMessage({ ok: true });
        return;
      }
      if (message.type === 'prefetch_asset_urls') {
        port.postMessage({ ok: true, cachedUrls: message.urls.map((url) => new URL(url, 'https://example.test/').href) });
        return;
      }
      port.postMessage({ ok: false, reason: 'UNKNOWN_MESSAGE' });
    },
    fetchHandler() {
      return Promise.resolve({
        ok: true,
        clone() {
          return this;
        },
      });
    },
    controller: { state: 'controlled' },
    seedCacheUrls: requiredUrls,
  });

  const llm = new LLM();
  const installState = await llm.prepare('gemma4:e2b');

  assert.equal(installState.state, 'ready');
  assert.equal(installState.ready, true);
  assert.equal(installState.errorCode, '');
  assert.equal(installState.missingRequired.length, 0);
  assert.equal(installState.statusText, '本地模型资源已就绪');
});

serialTest('LLM prepare records per-asset retries and completes progress when an asset succeeds on retry', async (t) => {
  const requiredUrls = [
    'https://example.test/assets/llm/gemma-4-E2B-it-web.task',
    'https://example.test/wasm/genai_wasm_internal.js',
    'https://example.test/wasm/genai_wasm_internal.wasm',
    'https://example.test/wasm/genai_wasm_module_internal.js',
    'https://example.test/wasm/genai_wasm_module_internal.wasm',
    'https://example.test/wasm/genai_wasm_nosimd_internal.js',
    'https://example.test/wasm/genai_wasm_nosimd_internal.wasm',
  ];
  const attemptsByUrl = new Map();

  installBrowserStubs(t, {
    workerHandler(message, ports, context) {
      const [port] = ports;
      if (message.type === 'configure_asset_cache') {
        port.postMessage({ ok: true });
        return;
      }
      if (message.type === 'prefetch_asset_urls') {
        const [url] = message.urls;
        const resolvedUrls = message.urls.map((item) => new URL(item, 'https://example.test/').href);
        const currentAttempts = (attemptsByUrl.get(url) || 0) + 1;
        attemptsByUrl.set(url, currentAttempts);

        if (url === 'https://example.test/assets/llm/gemma-4-E2B-it-web.task' && currentAttempts === 1) {
          port.postMessage({ ok: false, reason: 'TEMP_NETWORK_ERROR' });
          return;
        }

        for (const resolvedUrl of resolvedUrls) {
          context.cacheEntries.set(resolvedUrl, { ok: true, url: resolvedUrl });
        }
        port.postMessage({ ok: true, cachedUrls: resolvedUrls });
        return;
      }
      port.postMessage({ ok: false, reason: 'UNKNOWN_MESSAGE' });
    },
    fetchHandler() {
      return Promise.resolve({
        ok: true,
        clone() {
          return this;
        },
      });
    },
    controller: { state: 'controlled' },
    seedCacheUrls: requiredUrls.filter((url) => url !== 'https://example.test/assets/llm/gemma-4-E2B-it-web.task'),
  });

  const llm = new LLM();
  const installState = await llm.prepare('gemma4:e2b');
  const retriedAsset = installState.assetRecords.find((record) => record.url === '/assets/llm/gemma-4-E2B-it-web.task');

  assert.equal(installState.ready, true);
  assert.equal(installState.progress.completedFiles, 7);
  assert.equal(installState.progress.percent, 100);
  assert.equal(attemptsByUrl.get('https://example.test/assets/llm/gemma-4-E2B-it-web.task'), 2);
  assert.equal(retriedAsset?.verified, true);
});

serialTest('LLM prepare records verification metadata for cached assets when headers are available', async (t) => {
  installBrowserStubs(t, {
    workerHandler(message, ports, context) {
      const [port] = ports;
      if (message.type === 'configure_asset_cache') {
        port.postMessage({ ok: true });
        return;
      }
      if (message.type === 'prefetch_asset_urls') {
        const resolvedUrls = message.urls.map((item) => new URL(item, 'https://example.test/').href);
        const assetReports = resolvedUrls.map((url) => ({
          url,
          source: 'service-worker-network',
          observedSizeBytes: url.endsWith('genai_wasm_internal.js') ? 331776 : null,
          contentType: url.endsWith('genai_wasm_internal.js') ? 'application/javascript' : '',
          etag: url.endsWith('genai_wasm_internal.js') ? 'wasm-js-etag' : '',
          lastModified: '',
        }));
        for (const resolvedUrl of resolvedUrls) {
          context.cacheEntries.set(resolvedUrl, createMockResponse({
            contentLength: resolvedUrl.endsWith('genai_wasm_internal.js') ? 331776 : null,
            contentType: resolvedUrl.endsWith('genai_wasm_internal.js') ? 'application/javascript' : '',
            etag: resolvedUrl.endsWith('genai_wasm_internal.js') ? 'wasm-js-etag' : '',
          }));
        }
        port.postMessage({ ok: true, cachedUrls: resolvedUrls, assetReports });
        return;
      }
      port.postMessage({ ok: false, reason: 'UNKNOWN_MESSAGE' });
    },
    fetchHandler() {
      return Promise.resolve(createMockResponse());
    },
    controller: { state: 'controlled' },
  });

  const llm = new LLM();
  const installState = await llm.prepare('gemma4:e2b');
  const runtimeAsset = installState.assetRecords.find((record) => record.url === '/wasm/genai_wasm_internal.js');

  assert.equal(installState.ready, true);
  assert.equal(runtimeAsset?.verificationSource, 'service-worker-network');
  assert.equal(runtimeAsset?.observedSizeBytes, 331776);
  assert.equal(runtimeAsset?.contentType, 'application/javascript');
  assert.equal(runtimeAsset?.etag, 'wasm-js-etag');
});

serialTest('LLM install state captures byte progress from streaming worker events when available', async (t) => {
  const snapshots = [];

  installBrowserStubs(t, {
    workerHandler(message, ports, context) {
      const [port] = ports;
      if (message.type === 'configure_asset_cache') {
        port.postMessage({ ok: true });
        return;
      }
      if (message.type === 'prefetch_asset_urls') {
        const [resolvedUrl] = message.urls.map((item) => new URL(item, 'https://example.test/').href);
        if (resolvedUrl.endsWith('gemma-4-E2B-it-web.task')) {
          port.postMessage({
            kind: 'progress',
            url: resolvedUrl,
            downloadedBytes: 1024,
            totalBytes: 4096,
            source: 'service-worker-network',
          });
        }
        const assetReports = message.urls.map((item) => {
          const url = new URL(item, 'https://example.test/').href;
          return {
            url,
            source: 'service-worker-network',
            observedSizeBytes: url.endsWith('gemma-4-E2B-it-web.task') ? 4096 : 331776,
            observedSha256: '',
            contentType: '',
            etag: '',
            lastModified: '',
          };
        });
        for (const report of assetReports) {
          context.cacheEntries.set(report.url, createMockResponse({
            contentLength: report.observedSizeBytes,
          }));
        }
        port.postMessage({
          ok: true,
          cachedUrls: assetReports.map((report) => report.url),
          assetReports,
        });
        return;
      }
      port.postMessage({ ok: false, reason: 'UNKNOWN_MESSAGE' });
    },
    fetchHandler() {
      return Promise.resolve(createMockResponse());
    },
    controller: { state: 'controlled' },
  });

  const llm = new LLM();
  llm.onInstallStateChange('gemma4:e2b', (snapshot) => {
    snapshots.push(snapshot);
  });

  await llm.prepare('gemma4:e2b');

  assert(snapshots.some((snapshot) => snapshot.progress.downloadedBytes === 1024));
  assert(snapshots.some((snapshot) => snapshot.progress.totalBytes === 2083231334));
});

serialTest('LLM prepare downloads assets with limited concurrency instead of fully serial order', async (t) => {
  let inFlight = 0;
  let maxInFlight = 0;
  let runtimeInFlight = 0;
  let maxRuntimeInFlight = 0;

  installBrowserStubs(t, {
    workerHandler(message, ports, context) {
      const [port] = ports;
      if (message.type === 'configure_asset_cache') {
        port.postMessage({ ok: true });
        return;
      }
      if (message.type === 'prefetch_asset_urls') {
        const [resolvedUrl] = message.urls.map((item) => new URL(item, 'https://example.test/').href);
        const isRuntimeAsset = !resolvedUrl.endsWith('.task');
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (isRuntimeAsset) {
          runtimeInFlight += 1;
          maxRuntimeInFlight = Math.max(maxRuntimeInFlight, runtimeInFlight);
        }
        setTimeout(() => {
          const assetReport = {
            url: resolvedUrl,
            source: 'service-worker-network',
            observedSizeBytes: getManifestAssetSizeForUrl(resolvedUrl),
            observedSha256: '',
            contentType: '',
            etag: '',
            lastModified: '',
          };
          context.cacheEntries.set(resolvedUrl, createMockResponse({
            contentLength: assetReport.observedSizeBytes,
          }));
          inFlight -= 1;
          if (isRuntimeAsset) {
            runtimeInFlight -= 1;
          }
          port.postMessage({
            ok: true,
            cachedUrls: [resolvedUrl],
            assetReports: [assetReport],
          });
        }, 20);
        return;
      }
      port.postMessage({ ok: false, reason: 'UNKNOWN_MESSAGE' });
    },
    fetchHandler() {
      return Promise.resolve(createMockResponse());
    },
    controller: { state: 'controlled' },
  });

  const llm = new LLM();
  const installState = await llm.prepare('gemma4:e2b');

  assert.equal(installState.ready, true);
  assert.equal(maxInFlight, 2);
  assert.equal(maxRuntimeInFlight, 1);
});

serialTest('LLM prepare fails integrity verification when observed asset size mismatches manifest', async (t) => {
  const requiredUrls = [
    'https://example.test/assets/llm/gemma-4-E2B-it-web.task',
    'https://example.test/wasm/genai_wasm_internal.js',
    'https://example.test/wasm/genai_wasm_internal.wasm',
    'https://example.test/wasm/genai_wasm_module_internal.js',
    'https://example.test/wasm/genai_wasm_module_internal.wasm',
    'https://example.test/wasm/genai_wasm_nosimd_internal.js',
    'https://example.test/wasm/genai_wasm_nosimd_internal.wasm',
  ];

  installBrowserStubs(t, {
    workerHandler(message, ports, context) {
      const [port] = ports;
      if (message.type === 'configure_asset_cache') {
        port.postMessage({ ok: true });
        return;
      }
      if (message.type === 'prefetch_asset_urls') {
        const resolvedUrls = message.urls.map((item) => new URL(item, 'https://example.test/').href);
        const assetReports = resolvedUrls.map((url) => ({
          url,
          source: 'service-worker-network',
          observedSizeBytes: url.endsWith('genai_wasm_internal.js') ? 1 : null,
          contentType: '',
          etag: '',
          lastModified: '',
        }));
        for (const resolvedUrl of resolvedUrls) {
          context.cacheEntries.set(resolvedUrl, createMockResponse({
            contentLength: resolvedUrl.endsWith('genai_wasm_internal.js') ? 1 : null,
          }));
        }
        port.postMessage({ ok: true, cachedUrls: resolvedUrls, assetReports });
        return;
      }
      port.postMessage({ ok: false, reason: 'UNKNOWN_MESSAGE' });
    },
    fetchHandler() {
      return Promise.resolve(createMockResponse());
    },
    controller: { state: 'controlled' },
    seedCacheUrls: requiredUrls.filter((url) => url !== 'https://example.test/wasm/genai_wasm_internal.js'),
  });

  const llm = new LLM();
  llm.setIntegrityMode('full');
  const installState = await llm.prepare('gemma4:e2b');
  const badAsset = installState.assetRecords.find((record) => record.url === '/wasm/genai_wasm_internal.js');

  assert.equal(installState.ready, false);
  assert.equal(installState.state, 'failed');
  assert.equal(installState.errorCode, 'INSTALL_INTEGRITY_MISMATCH');
  assert.equal(badAsset?.sizeMismatch, true);
  assert.equal(badAsset?.observedSizeBytes, 1);
  assert.equal(badAsset?.expectedSizeBytes, 331776);
});

serialTest('LLM prepare fails integrity verification when observed asset hash mismatches manifest', async (t) => {
  const requiredUrls = [
    'https://example.test/assets/llm/gemma-4-E2B-it-web.task',
    'https://example.test/wasm/genai_wasm_internal.js',
    'https://example.test/wasm/genai_wasm_internal.wasm',
    'https://example.test/wasm/genai_wasm_module_internal.js',
    'https://example.test/wasm/genai_wasm_module_internal.wasm',
    'https://example.test/wasm/genai_wasm_nosimd_internal.js',
    'https://example.test/wasm/genai_wasm_nosimd_internal.wasm',
  ];

  installBrowserStubs(t, {
    workerHandler(message, ports, context) {
      const [port] = ports;
      if (message.type === 'configure_asset_cache') {
        port.postMessage({ ok: true });
        return;
      }
      if (message.type === 'prefetch_asset_urls') {
        const resolvedUrls = message.urls.map((item) => new URL(item, 'https://example.test/').href);
        const assetReports = resolvedUrls.map((url) => ({
          url,
          source: 'service-worker-network',
          observedSizeBytes: url.endsWith('genai_wasm_internal.js') ? 331776 : null,
          observedSha256: url.endsWith('genai_wasm_internal.js') ? 'deadbeef' : '',
          contentType: '',
          etag: '',
          lastModified: '',
        }));
        for (const resolvedUrl of resolvedUrls) {
          context.cacheEntries.set(resolvedUrl, createMockResponse({
            contentLength: resolvedUrl.endsWith('genai_wasm_internal.js') ? 331776 : null,
          }));
        }
        port.postMessage({ ok: true, cachedUrls: resolvedUrls, assetReports });
        return;
      }
      port.postMessage({ ok: false, reason: 'UNKNOWN_MESSAGE' });
    },
    fetchHandler() {
      return Promise.resolve(createMockResponse());
    },
    controller: { state: 'controlled' },
    seedCacheUrls: requiredUrls.filter((url) => url !== 'https://example.test/wasm/genai_wasm_internal.js'),
  });

  const llm = new LLM();
  llm.setIntegrityMode('full');
  const installState = await llm.prepare('gemma4:e2b');
  const badAsset = installState.assetRecords.find((record) => record.url === '/wasm/genai_wasm_internal.js');

  assert.equal(installState.ready, false);
  assert.equal(installState.state, 'failed');
  assert.equal(installState.errorCode, 'INSTALL_INTEGRITY_MISMATCH');
  assert.equal(badAsset?.hashMismatch, true);
  assert.equal(badAsset?.observedSha256, 'deadbeef');
  assert.equal(badAsset?.expectedSha256, '531d78c48eb45ecd1e167cc0fcd604673d8748677061386d947f6d22e53454d2');
});

serialTest('LLM prepare forwards manifest sha256 to service worker and records streamed integrity verification', async (t) => {
  let modelPrefetchMessage = null;
  const requiredUrls = [
    'https://example.test/assets/llm/gemma-4-E2B-it-web.task',
    'https://example.test/wasm/genai_wasm_internal.js',
    'https://example.test/wasm/genai_wasm_internal.wasm',
    'https://example.test/wasm/genai_wasm_module_internal.js',
    'https://example.test/wasm/genai_wasm_module_internal.wasm',
    'https://example.test/wasm/genai_wasm_nosimd_internal.js',
    'https://example.test/wasm/genai_wasm_nosimd_internal.wasm',
  ];

  installBrowserStubs(t, {
    workerHandler(message, ports, context) {
      const [port] = ports;
      if (message.type === 'configure_asset_cache') {
        port.postMessage({ ok: true });
        return;
      }
      if (message.type === 'prefetch_asset_urls') {
        const resolvedUrls = message.urls.map((item) => new URL(item, 'https://example.test/').href);
        if (resolvedUrls.some((url) => url.endsWith('.task'))) {
          modelPrefetchMessage = message;
        }
        const assetReports = resolvedUrls.map((url) => {
          const expectedAsset = Array.isArray(message.expectedAssets)
            ? message.expectedAssets.find((item) => new URL(item.url, 'https://example.test/').href === url)
            : null;
          return {
            url,
            source: 'service-worker-network',
            observedSizeBytes: getManifestAssetSizeForUrl(url),
            observedSha256: expectedAsset?.sha256 || '',
            integrityVerified: Boolean(expectedAsset?.sha256),
            verificationMethod: expectedAsset?.sha256 ? 'stream-sha256' : '',
            contentType: '',
            etag: '',
            lastModified: '',
          };
        });
        for (const resolvedUrl of resolvedUrls) {
          context.cacheEntries.set(resolvedUrl, createMockResponse({
            contentLength: getManifestAssetSizeForUrl(resolvedUrl),
          }));
        }
        port.postMessage({ ok: true, cachedUrls: resolvedUrls, assetReports });
        return;
      }
      port.postMessage({ ok: false, reason: 'UNKNOWN_MESSAGE' });
    },
    fetchHandler() {
      return Promise.resolve(createMockResponse());
    },
    controller: { state: 'controlled' },
    seedCacheUrls: requiredUrls.filter((url) => !url.endsWith('.task')),
  });

  const llm = new LLM();
  llm.setIntegrityMode('full');
  const installState = await llm.prepare('gemma4:e2b');
  const modelAsset = installState.assetRecords.find((record) => record.url.endsWith('.task'));

  assert.equal(installState.ready, true);
  assert.equal(
    modelPrefetchMessage?.expectedAssets?.[0]?.sha256,
    '2cbff161177a4d51c9d04360016185976f504517ba5758cd10c1564e5421c5a5',
  );
  assert.equal(modelAsset?.integrityVerified, true);
  assert.equal(modelAsset?.verificationMethod, 'stream-sha256');
});

serialTest('LLM prepare forwards runtime asset sha256 to service worker requests', async (t) => {
  const runtimeExpectedAssets = [];

  installBrowserStubs(t, {
    workerHandler(message, ports, context) {
      const [port] = ports;
      if (message.type === 'configure_asset_cache') {
        port.postMessage({ ok: true });
        return;
      }
      if (message.type === 'prefetch_asset_urls') {
        const resolvedUrls = message.urls.map((item) => new URL(item, 'https://example.test/').href);
        if (resolvedUrls.some((url) => url.endsWith('.task'))) {
          for (const resolvedUrl of resolvedUrls) {
            context.cacheEntries.set(resolvedUrl, createMockResponse({
              contentLength: getManifestAssetSizeForUrl(resolvedUrl),
            }));
          }
          port.postMessage({
            ok: true,
            cachedUrls: resolvedUrls,
            assetReports: resolvedUrls.map((url) => ({
              url,
              source: 'service-worker-network',
              observedSizeBytes: getManifestAssetSizeForUrl(url),
              observedSha256: '2cbff161177a4d51c9d04360016185976f504517ba5758cd10c1564e5421c5a5',
              integrityVerified: true,
              verificationMethod: 'stream-sha256',
              contentType: '',
              etag: '',
              lastModified: '',
            })),
          });
          return;
        }
        runtimeExpectedAssets.push(...(message.expectedAssets || []));
        for (const resolvedUrl of resolvedUrls) {
          context.cacheEntries.set(resolvedUrl, createMockResponse({
            contentLength: getManifestAssetSizeForUrl(resolvedUrl),
          }));
        }
        port.postMessage({
          ok: true,
          cachedUrls: resolvedUrls,
          assetReports: resolvedUrls.map((url) => {
            const expectedAsset = (message.expectedAssets || []).find(
              (item) => new URL(item.url, 'https://example.test/').href === url,
            );
            return {
              url,
              source: 'service-worker-network',
              observedSizeBytes: getManifestAssetSizeForUrl(url),
              observedSha256: expectedAsset?.sha256 || '',
              integrityVerified: Boolean(expectedAsset?.sha256),
              verificationMethod: expectedAsset?.sha256 ? 'stream-sha256' : '',
              contentType: '',
              etag: '',
              lastModified: '',
            };
          }),
        });
        return;
      }
      port.postMessage({ ok: false, reason: 'UNKNOWN_MESSAGE' });
    },
    fetchHandler(request) {
      return Promise.resolve(createMockResponse({
        contentLength: getManifestAssetSizeForUrl(request.url),
        contentType: 'application/javascript',
      }));
    },
    controller: { state: 'controlled' },
  });

  const llm = new LLM();
  llm.setIntegrityMode('full');
  const installState = await llm.prepare('gemma4:e2b');
  const runtimeExpectedAsset = runtimeExpectedAssets.find(
    (asset) => asset.url.endsWith('/wasm/genai_wasm_internal.js'),
  );

  assert.equal(installState.ready, true);
  assert.equal(
    runtimeExpectedAsset?.sha256,
    '531d78c48eb45ecd1e167cc0fcd604673d8748677061386d947f6d22e53454d2',
  );
});

serialTest('LLM size-only integrity mode ignores hash mismatch but still enforces size checks', async (t) => {
  const requiredUrls = [
    'https://example.test/assets/llm/gemma-4-E2B-it-web.task',
    'https://example.test/wasm/genai_wasm_internal.js',
    'https://example.test/wasm/genai_wasm_internal.wasm',
    'https://example.test/wasm/genai_wasm_module_internal.js',
    'https://example.test/wasm/genai_wasm_module_internal.wasm',
    'https://example.test/wasm/genai_wasm_nosimd_internal.js',
    'https://example.test/wasm/genai_wasm_nosimd_internal.wasm',
  ];

  installBrowserStubs(t, {
    workerHandler(message, ports, context) {
      const [port] = ports;
      if (message.type === 'configure_asset_cache') {
        port.postMessage({ ok: true });
        return;
      }
      if (message.type === 'prefetch_asset_urls') {
        const resolvedUrls = message.urls.map((item) => new URL(item, 'https://example.test/').href);
        const assetReports = resolvedUrls.map((url) => ({
          url,
          source: 'service-worker-network',
          observedSizeBytes: url.endsWith('genai_wasm_internal.js') ? 331776 : null,
          observedSha256: url.endsWith('genai_wasm_internal.js') ? 'deadbeef' : '',
          contentType: '',
          etag: '',
          lastModified: '',
        }));
        for (const resolvedUrl of resolvedUrls) {
          context.cacheEntries.set(resolvedUrl, createMockResponse({
            contentLength: resolvedUrl.endsWith('genai_wasm_internal.js') ? 331776 : null,
          }));
        }
        port.postMessage({ ok: true, cachedUrls: resolvedUrls, assetReports });
        return;
      }
      port.postMessage({ ok: false, reason: 'UNKNOWN_MESSAGE' });
    },
    fetchHandler() {
      return Promise.resolve(createMockResponse());
    },
    controller: { state: 'controlled' },
    seedCacheUrls: requiredUrls.filter((url) => url !== 'https://example.test/wasm/genai_wasm_internal.js'),
  });

  const llm = new LLM();
  llm.setIntegrityMode('size-only');
  const installState = await llm.prepare('gemma4:e2b');
  const asset = installState.assetRecords.find((record) => record.url === '/wasm/genai_wasm_internal.js');

  assert.equal(llm.getIntegrityMode(), 'size-only');
  assert.equal(installState.ready, true);
  assert.equal(asset?.hashMismatch, false);
  assert.equal(asset?.verified, true);
});

serialTest('LLM load rejects until install state reaches ready', async (t) => {
  installBrowserStubs(t, {
    workerHandler(message, ports) {
      const [port] = ports;
      if (message.type === 'configure_asset_cache') {
        port.postMessage({ ok: true });
        return;
      }
      if (message.type === 'prefetch_asset_urls') {
        port.postMessage({ ok: false, reason: 'SW_PREFETCH_UNAVAILABLE' });
        return;
      }
      port.postMessage({ ok: false, reason: 'UNKNOWN_MESSAGE' });
    },
    fetchHandler() {
      return Promise.resolve({
        ok: true,
        clone() {
          return this;
        },
      });
    },
    controller: null,
  });

  const llm = new LLM({
    runtimeAdapter: {
      async create() {
        throw new Error('runtime should not start before ready');
      },
    },
  });

  await assert.rejects(
    llm.load('gemma4:e2b'),
    (error) => {
      assert.equal(error.code, 'MODEL_NOT_INSTALLED');
      assert.equal(error.installState?.state, 'partial');
      assert.equal(error.installState?.errorCode, 'INSTALL_CONTROL_REQUIRED');
      return true;
    },
  );
});

serialTest('LLM load and generate succeed after install state reaches ready', async (t) => {
  const requiredUrls = [
    'https://example.test/assets/llm/gemma-4-E2B-it-web.task',
    'https://example.test/wasm/genai_wasm_internal.js',
    'https://example.test/wasm/genai_wasm_internal.wasm',
    'https://example.test/wasm/genai_wasm_module_internal.js',
    'https://example.test/wasm/genai_wasm_module_internal.wasm',
    'https://example.test/wasm/genai_wasm_nosimd_internal.js',
    'https://example.test/wasm/genai_wasm_nosimd_internal.wasm',
  ];

  installBrowserStubs(t, {
    workerHandler(message, ports) {
      const [port] = ports;
      if (message.type === 'configure_asset_cache') {
        port.postMessage({ ok: true });
        return;
      }
      if (message.type === 'prefetch_asset_urls') {
        port.postMessage({ ok: true, cachedUrls: message.urls.map((url) => new URL(url, 'https://example.test/').href) });
        return;
      }
      port.postMessage({ ok: false, reason: 'UNKNOWN_MESSAGE' });
    },
    fetchHandler() {
      return Promise.resolve({
        ok: true,
        clone() {
          return this;
        },
      });
    },
    controller: { state: 'controlled' },
    seedCacheUrls: requiredUrls,
  });

  const runtime = {
    async generateResponse(query, callback) {
      if (callback) {
        callback(`reply:${query}`, true);
        return;
      }
      return `reply:${query}`;
    },
  };
  const llm = new LLM({
    runtimeAdapter: {
      async create() {
        return runtime;
      },
    },
  });

  const loadedRuntime = await llm.load('gemma4:e2b');
  const output = await llm.generate({
    model: 'gemma4:e2b',
    query: 'hello',
    options: { stream: false },
  });

  assert.equal(loadedRuntime, runtime);
  assert.equal(output, 'reply:hello');
});

serialTest('persisted ready state downgrades when current page is not SW-controlled', (t) => {
  installBrowserStubs(t, {
    workerHandler() {},
    fetchHandler() {
      return Promise.resolve({
        ok: true,
        clone() {
          return this;
        },
      });
    },
    controller: null,
    seedLocalStorage: {
      'llm-install-state:gemma4:e2b': JSON.stringify({
        modelId: 'gemma4:e2b',
        manifestVersion: 'v1',
        cacheName: 'llm-assets::gemma4_e2b::v1',
        state: 'ready',
        ready: true,
        controller: true,
        progress: {
          totalBytes: null,
          downloadedBytes: null,
          totalFiles: 7,
          completedFiles: 7,
          percent: 100,
        },
        errorCode: '',
        errorDetail: '',
        retryCount: 0,
        prefetchError: '',
        swVersion: '2026-04-15-cache-prefetch-v3',
        verifiedAt: 123,
        missingRequired: [],
        cachedUrls: ['https://example.test/assets/llm/gemma-4-E2B-it-web.task'],
        updatedAt: 123,
        statusText: '本地模型资源已就绪',
      }),
    },
  });

  const llm = new LLM();
  const installState = llm.getInstallState('gemma4:e2b');

  assert.equal(installState.ready, false);
  assert.equal(installState.state, 'partial');
  assert.equal(installState.errorCode, 'INSTALL_CONTROL_REQUIRED');
});

serialTest('retryInstall increments retry count and clearModel resets install state', async (t) => {
  const requiredUrls = [
    'https://example.test/assets/llm/gemma-4-E2B-it-web.task',
    'https://example.test/wasm/genai_wasm_internal.js',
    'https://example.test/wasm/genai_wasm_internal.wasm',
    'https://example.test/wasm/genai_wasm_module_internal.js',
    'https://example.test/wasm/genai_wasm_module_internal.wasm',
    'https://example.test/wasm/genai_wasm_nosimd_internal.js',
    'https://example.test/wasm/genai_wasm_nosimd_internal.wasm',
  ];

  const { localStorageEntries } = installBrowserStubs(t, {
    workerHandler(message, ports) {
      const [port] = ports;
      if (message.type === 'configure_asset_cache') {
        port.postMessage({ ok: true });
        return;
      }
      if (message.type === 'prefetch_asset_urls') {
        port.postMessage({ ok: true, cachedUrls: message.urls.map((url) => new URL(url, 'https://example.test/').href) });
        return;
      }
      port.postMessage({ ok: false, reason: 'UNKNOWN_MESSAGE' });
    },
    fetchHandler() {
      return Promise.resolve({
        ok: true,
        clone() {
          return this;
        },
      });
    },
    controller: { state: 'controlled' },
    seedCacheUrls: requiredUrls,
  });

  const llm = new LLM();
  await llm.retryInstall('gemma4:e2b');
  const readyState = llm.getInstallState('gemma4:e2b');
  assert.equal(readyState.retryCount, 1);
  assert.equal(readyState.ready, true);
  assert.equal(typeof readyState.verifiedAt, 'number');
  assert.equal(readyState.swVersion, '2026-04-15-cache-prefetch-v3');
  assert(localStorageEntries.has('llm-install-state:gemma4:e2b'));

  const cleared = await llm.clearModel('gemma4:e2b');
  const clearedState = llm.getInstallState('gemma4:e2b');
  assert.equal(cleared, true);
  assert.equal(clearedState.state, 'idle');
  assert.equal(clearedState.ready, false);
  assert.equal(clearedState.retryCount, 0);
  assert.equal(clearedState.verifiedAt, 0);
});

serialTest('diagnostics snapshot exposes manifest and runtime state for hosts', async (t) => {
  const requiredUrls = [
    'https://example.test/assets/llm/gemma-4-E2B-it-web.task',
    'https://example.test/wasm/genai_wasm_internal.js',
    'https://example.test/wasm/genai_wasm_internal.wasm',
    'https://example.test/wasm/genai_wasm_module_internal.js',
    'https://example.test/wasm/genai_wasm_module_internal.wasm',
    'https://example.test/wasm/genai_wasm_nosimd_internal.js',
    'https://example.test/wasm/genai_wasm_nosimd_internal.wasm',
  ];

  installBrowserStubs(t, {
    workerHandler(message, ports) {
      const [port] = ports;
      if (message.type === 'configure_asset_cache') {
        port.postMessage({ ok: true });
        return;
      }
      if (message.type === 'prefetch_asset_urls') {
        port.postMessage({ ok: true, cachedUrls: message.urls.map((url) => new URL(url, 'https://example.test/').href) });
        return;
      }
      port.postMessage({ ok: false, reason: 'UNKNOWN_MESSAGE' });
    },
    fetchHandler() {
      return Promise.resolve({
        ok: true,
        clone() {
          return this;
        },
      });
    },
    controller: { state: 'controlled' },
    seedCacheUrls: requiredUrls,
  });

  const llm = new LLM();
  await llm.prepare('gemma4:e2b');
  const diagnostics = llm.getDiagnosticsSnapshot('gemma4:e2b');

  assert.equal(diagnostics.install.ready, true);
  assert.equal(diagnostics.install.integrityMode, 'size-only');
  assert.equal(diagnostics.manifest.modelId, 'gemma4:e2b');
  assert.equal(diagnostics.manifest.requiredAssets.length, 7);
  assert.equal(diagnostics.install.assetRecords.length, 7);
  assert.equal(typeof diagnostics.install.startedAt, 'number');
  assert.equal(typeof diagnostics.install.completedAt, 'number');
  assert.equal(typeof diagnostics.install.durationMs, 'number');
  assert(diagnostics.install.startedAt > 0);
  assert(diagnostics.install.completedAt >= diagnostics.install.startedAt);
  assert(diagnostics.install.durationMs >= 0);
  assert.equal(diagnostics.manifest.requiredAssets[0].installChannel, 'service-worker');
  assert.equal(typeof diagnostics.manifest.requiredAssets[1].sizeBytes, 'number');
  assert.equal(diagnostics.runtime.state, 'unload');
  assert.equal(diagnostics.runtime.queueLength, 0);
});
