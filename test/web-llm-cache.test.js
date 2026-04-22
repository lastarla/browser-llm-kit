import test from 'node:test';
import assert from 'node:assert/strict';
import LLM from '../packages/llm-browser/index.js';
import BrowserLLMServiceFromPackage from '../packages/llm-browser/index.js';
import { AssetInstaller as AssetInstallerFromPackage } from '../packages/llm-opfs/index.js';
import {
  RuntimeAdapter as RuntimeAdapterFromPackage,
  RuntimeAdapter,
  selectRuntimeAssetPair,
} from '../packages/llm-mediapipe/index.js';
import { InferenceWorkerClient } from '../packages/llm-worker/index.js';
import { AssetInstaller } from '../packages/llm-opfs/index.js';
import { ModelRegistry } from '../packages/llm-core/index.js';

function serialTest(name, fn) {
  return test(name, { concurrency: false }, fn);
}

function installBrowserEnvironment(t, {
  secure = true,
  hasOpfs = true,
  quota = 4 * 1024 * 1024 * 1024,
  usage = 128,
  persistResult = true,
} = {}) {
  const originalWindow = globalThis.window;
  const originalNavigator = globalThis.navigator;
  const originalUrl = globalThis.URL;

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      isSecureContext: secure,
      location: {
        href: secure ? 'https://example.test/' : 'http://172.28.1.16:3001/',
      },
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    },
  });

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: 'Mozilla/5.0 AppleWebKit/537.36 Chrome/133.0.0.0 Safari/537.36',
      userAgentData: {
        brands: [{ brand: 'Chromium' }],
      },
      storage: hasOpfs ? {
        getDirectory: async () => ({}),
        estimate: async () => ({ quota, usage }),
        persist: async () => persistResult,
      } : {},
    },
  });

  Object.defineProperty(globalThis, 'URL', {
    configurable: true,
    writable: true,
    value: {
      createObjectURL(value) {
        return `blob:${value?.name || 'model'}`;
      },
      revokeObjectURL() {},
    },
  });

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
    Object.defineProperty(globalThis, 'URL', {
      configurable: true,
      writable: true,
      value: originalUrl,
    });
  });
}

function createMockStorageClient({
  snapshots = [],
  installResult = null,
  onInstall = null,
} = {}) {
  const listeners = new Set();
  const clearCalls = [];
  const cancelCalls = [];
  const installCalls = [];

  return {
    clearCalls,
    cancelCalls,
    installCalls,
    isAvailable() {
      return true;
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event) {
      for (const listener of listeners) {
        listener(event);
      }
    },
    async status() {
      return snapshots;
    },
    async install(payload) {
      installCalls.push(payload);
      if (onInstall) {
        return onInstall(payload, this);
      }
      return installResult;
    },
    async cancel(payload) {
      cancelCalls.push(payload);
      return { cancelled: true };
    },
    async clear(payload) {
      clearCalls.push(payload);
      return { cleared: true };
    },
  };
}

function createInstallSnapshot(overrides = {}) {
  return {
    modelId: 'gemma4:e2b',
    version: 'v1',
    runtime: 'mediapipe@0.10.27',
    installId: 'gemma4:e2b@v1#mediapipe@0.10.27',
    state: 'installed',
    userState: 'installed',
    systemState: 'committed',
    ready: false,
    stored: true,
    loadable: false,
    storageBackend: 'opfs',
    manifestVersion: 'v1',
    currentAsset: '/assets/llm/gemma-4-E2B-it-web.task',
    errorCode: '',
    errorDetail: '',
    retryCount: 0,
    startedAt: 10,
    completedAt: 20,
    durationMs: 10,
    verifiedAt: 20,
    integrityMode: 'size-only',
    assetRecords: [
      {
        url: '/assets/llm/gemma-4-E2B-it-web.task',
        type: 'model',
        required: true,
        installChannel: 'opfs',
        sizeBytes: 4096,
        status: 'stored',
        attempts: 1,
        verified: true,
        integrityVerified: false,
        verificationMethod: 'size-only',
        downloadedBytes: 4096,
        observedSizeBytes: 4096,
        expectedSizeBytes: 4096,
        observedSha256: '',
        expectedSha256: '',
        errorCode: '',
        errorDetail: '',
        etag: 'etag-1',
        lastModified: 'Mon, 20 Apr 2026 08:00:00 GMT',
      },
    ],
    progress: {
      totalFiles: 1,
      completedFiles: 1,
      totalBytes: 4096,
      downloadedBytes: 4096,
      percent: 100,
    },
    missingRequired: [],
    cachedUrls: [],
    updatedAt: 20,
    statusText: '模型资源已写入 OPFS',
    ...overrides,
  };
}

function createMockAssetInstaller({
  installState = createInstallSnapshot(),
  installBusy = false,
} = {}) {
  const listeners = new Map();

  return {
    getState() {
      return installState;
    },
    onStateChange(modelId, listener) {
      listeners.set(modelId, listener);
      listener(installState);
      return () => listeners.delete(modelId);
    },
    getDiagnostics() {
      return {
        install: installState,
        manifest: {
          modelId: 'gemma4:e2b',
          version: 'v1',
          runtime: 'mediapipe@0.10.27',
          requiredAssets: [
            {
              url: '/assets/llm/gemma-4-E2B-it-web.task',
              type: 'model',
              installChannel: 'opfs',
              sizeBytes: 4096,
            },
          ],
        },
      };
    },
    async install() {
      return installState;
    },
    async retryInstall() {
      return {
        ...installState,
        retryCount: installState.retryCount + 1,
      };
    },
    async clearModel() {
      return true;
    },
    async createModelObjectUrl() {
      return 'blob:gemma-model';
    },
    async createRuntimeFileset() {
      return null;
    },
    cancelInstall() {
      return true;
    },
    setIntegrityMode() {},
    getIntegrityMode() {
      return installState.integrityMode || 'size-only';
    },
    isInstallBusy() {
      return installBusy;
    },
  };
}

class MockRuntimeAdapter extends RuntimeAdapter {
  async create() {
    return {
      async generateResponse(query, callback) {
        const output = `mock:${query}`;
        if (typeof callback === 'function') {
          callback(output, true);
        }
        return output;
      },
    };
  }
}

serialTest('LLM exposes OPFS storage config and lets host override model asset path', (t) => {
  installBrowserEnvironment(t);
  const llm = new LLM();
  const defaultConfig = llm.getModelCacheConfig('gemma4:e2b');

  assert.equal(defaultConfig.storageBackend, 'opfs');
  assert.equal(defaultConfig.model, 'gemma4:e2b');
  assert.equal(defaultConfig.version, 'v1');
  assert.equal(defaultConfig.runtime, 'mediapipe@0.10.27');
  assert.equal(defaultConfig.installUrls[0], '/assets/llm/gemma-4-E2B-it-web.task');
  assert(defaultConfig.installUrls.includes('/wasm/genai_wasm_internal.wasm'));
  assert.equal(defaultConfig.runtimeUrls.length, 6);

  llm.setModelAssetPath('gemma4:e2b', '/assets/llm/custom-model.task');
  const updatedConfig = llm.getModelCacheConfig('gemma4:e2b');
  assert.equal(updatedConfig.installUrls[0], '/assets/llm/custom-model.task');
});

serialTest('package-style browser entry exports the reusable BrowserLLMService', (t) => {
  installBrowserEnvironment(t);
  const service = new BrowserLLMServiceFromPackage();
  const models = service.listModels();

  assert.equal(typeof service.getDiagnostics, 'function');
  assert.equal(models.length, 1);
  assert.equal(models[0].modelId, 'gemma4:e2b');
});

serialTest('package surfaces export opfs and mediapipe entry points', () => {
  const installer = new AssetInstallerFromPackage({
    modelRegistry: new ModelRegistry(),
    storageClient: createMockStorageClient(),
  });
  const runtimeAdapter = new RuntimeAdapterFromPackage();
  const inferenceClient = new InferenceWorkerClient({ worker: null });

  assert.equal(typeof installer.install, 'function');
  assert.equal(typeof runtimeAdapter.create, 'function');
  assert.equal(inferenceClient.isAvailable(), false);
});

serialTest('ModelRegistry installs MediaPipe runtime artifacts through OPFS', () => {
  const registry = new ModelRegistry();
  const plan = registry.buildInstallPlan('gemma4:e2b');
  const runtimeAssets = plan.assets.filter((asset) => asset.type === 'runtime');

  assert.equal(plan.assets.length, 7);
  assert.equal(runtimeAssets.length, 6);
  assert(plan.assets.every((asset) => asset.installChannel === 'opfs'));
});

serialTest('AssetInstaller only installs the selected runtime variant pair', async (t) => {
  installBrowserEnvironment(t);
  const registry = new ModelRegistry();
  const storageClient = createMockStorageClient({
    installResult: createInstallSnapshot(),
  });
  const installer = new AssetInstaller({
    modelRegistry: registry,
    storageClient,
    preferredRuntimeAssetResolver: async (definition) => {
      const pair = selectRuntimeAssetPair(registry.listRuntimeAssets(definition.modelId), {
        simdSupported: true,
        useModule: false,
      });
      return [pair.loader, pair.binary];
    },
  });

  await installer.install('gemma4:e2b');
  const planAssets = storageClient.installCalls[0].plan.assets;
  const runtimeAssets = planAssets.filter((asset) => asset.type === 'runtime');

  assert.equal(planAssets.length, 3);
  assert.equal(runtimeAssets.length, 2);
  assert.deepEqual(
    runtimeAssets.map((asset) => asset.url),
    ['/wasm/genai_wasm_internal.js', '/wasm/genai_wasm_internal.wasm'],
  );
});

serialTest('runtime fileset selection follows MediaPipe SIMD and module variants', () => {
  const registry = new ModelRegistry();
  const assets = registry.listRuntimeAssets('gemma4:e2b');

  const simdPair = selectRuntimeAssetPair(assets, { simdSupported: true, useModule: false });
  assert.equal(simdPair.loader.url, '/wasm/genai_wasm_internal.js');
  assert.equal(simdPair.binary.url, '/wasm/genai_wasm_internal.wasm');

  const nosimdPair = selectRuntimeAssetPair(assets, { simdSupported: false, useModule: false });
  assert.equal(nosimdPair.loader.url, '/wasm/genai_wasm_nosimd_internal.js');
  assert.equal(nosimdPair.binary.url, '/wasm/genai_wasm_nosimd_internal.wasm');

  const modulePair = selectRuntimeAssetPair(assets, { simdSupported: true, useModule: true });
  assert.equal(modulePair.loader.url, '/wasm/genai_wasm_module_internal.js');
  assert.equal(modulePair.binary.url, '/wasm/genai_wasm_module_internal.wasm');
});

serialTest('AssetInstaller invalidates persisted installs missing new required OPFS assets', async (t) => {
  installBrowserEnvironment(t);
  const installer = new AssetInstaller({
    modelRegistry: new ModelRegistry(),
    storageClient: createMockStorageClient({
      snapshots: [createInstallSnapshot()],
    }),
  });

  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  const snapshot = installer.getState('gemma4:e2b');
  assert.equal(snapshot.state, 'absent');
  assert.equal(snapshot.stored, false);
  assert(snapshot.missingRequired.includes('/wasm/genai_wasm_internal.js'));
});

serialTest('AssetInstaller reports OPFS unavailability when browser storage API is missing', async (t) => {
  installBrowserEnvironment(t, { secure: true, hasOpfs: false });
  const installer = new AssetInstaller({
    modelRegistry: new ModelRegistry(),
    storageClient: createMockStorageClient(),
  });

  const snapshot = await installer.install('gemma4:e2b');
  assert.equal(snapshot.state, 'failed');
  assert.equal(snapshot.errorCode, 'INSTALL_OPFS_UNAVAILABLE');
});

serialTest('AssetInstaller rejects install when browser storage budget is insufficient', async (t) => {
  installBrowserEnvironment(t, {
    secure: true,
    hasOpfs: true,
    quota: 1024,
    usage: 512,
  });
  const installer = new AssetInstaller({
    modelRegistry: new ModelRegistry(),
    storageClient: createMockStorageClient(),
  });

  const snapshot = await installer.install('gemma4:e2b');
  assert.equal(snapshot.state, 'failed');
  assert.equal(snapshot.errorCode, 'INSTALL_STORAGE_QUOTA_INSUFFICIENT');
});

serialTest('AssetInstaller installs through the storage client and updates progress snapshots', async (t) => {
  installBrowserEnvironment(t);
  const snapshots = [];
  const storageClient = createMockStorageClient({
    onInstall(payload, client) {
      client.emit({
        type: 'storage.progress',
        taskId: payload.taskId,
        downloadedBytes: 1024,
        totalBytes: 4096,
        artifactId: 'model',
      });
      client.emit({
        type: 'storage.state',
        taskId: payload.taskId,
        snapshot: createInstallSnapshot({
          state: 'installing',
          userState: 'installing',
          systemState: 'downloading-partial',
          stored: false,
          ready: false,
          progress: {
            totalFiles: 1,
            completedFiles: 0,
            totalBytes: 4096,
            downloadedBytes: 1024,
            percent: 25,
          },
          assetRecords: [
            {
              ...createInstallSnapshot().assetRecords[0],
              status: 'downloading',
              verified: false,
              downloadedBytes: 1024,
              observedSizeBytes: null,
            },
          ],
        }),
      });
      return Promise.resolve(createInstallSnapshot());
    },
  });
  const installer = new AssetInstaller({
    modelRegistry: new ModelRegistry(),
    storageClient,
  });

  installer.onStateChange('gemma4:e2b', (snapshot) => {
    snapshots.push(snapshot);
  });

  const result = await installer.install('gemma4:e2b');
  assert.equal(result.state, 'installed');
  assert.equal(result.stored, true);
  assert.equal(result.ready, false);
  assert(snapshots.some((snapshot) => snapshot.progress.downloadedBytes === 1024));
  assert.equal(storageClient.installCalls.length, 1);
});

serialTest('retryInstall increments retry count and clearModel resets install state', async (t) => {
  installBrowserEnvironment(t);
  const storageClient = createMockStorageClient({
    installResult: createInstallSnapshot({ retryCount: 1 }),
  });
  const installer = new AssetInstaller({
    modelRegistry: new ModelRegistry(),
    storageClient,
  });

  await installer.retryInstall('gemma4:e2b');
  assert.equal(installer.getState('gemma4:e2b').retryCount, 1);

  const cleared = await installer.clearModel('gemma4:e2b');
  assert.equal(cleared, true);
  assert.equal(installer.getState('gemma4:e2b').state, 'absent');
  assert.equal(storageClient.clearCalls.length, 1);
});

serialTest('LLM load rejects when install state is not stored', async (t) => {
  installBrowserEnvironment(t);
  const llm = new LLM({
    assetInstaller: createMockAssetInstaller({
      installState: createInstallSnapshot({
        state: 'failed',
        userState: 'failed',
        stored: false,
        ready: false,
        errorCode: 'INSTALL_NETWORK_ERROR',
        statusText: '网络异常，模型资源安装未完成',
      }),
    }),
  });

  await assert.rejects(() => llm.load('gemma4:e2b'), (error) => {
    assert.equal(error.code, 'MODEL_NOT_INSTALLED');
    return true;
  });
});

serialTest('LLM load and generate succeed after model asset URL is available', async (t) => {
  installBrowserEnvironment(t);
  const llm = new LLM({
    assetInstaller: createMockAssetInstaller(),
    runtimeAdapter: new MockRuntimeAdapter(),
  });

  const runtime = await llm.load('gemma4:e2b');
  assert(runtime);

  const output = await llm.generate({
    model: 'gemma4:e2b',
    query: 'hello world',
    options: {
      stream: false,
    },
  });
  assert.equal(output, 'mock:hello world');
});

serialTest('LLM exposes structured eligibility and model status for hosts', async (t) => {
  installBrowserEnvironment(t);
  const llm = new LLM({
    assetInstaller: createMockAssetInstaller(),
    runtimeAdapter: new MockRuntimeAdapter(),
  });

  const eligibility = llm.getEligibility({ modelId: 'gemma4:e2b' });
  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.opfsAvailable, true);
  assert.equal(eligibility.runtimeSupported, true);

  const beforeLoad = llm.getModelStatus({ modelId: 'gemma4:e2b' });
  assert.equal(beforeLoad.stored, true);
  assert.equal(beforeLoad.ready, false);

  await llm.ensure({ modelId: 'gemma4:e2b' });
  const afterLoad = llm.getModelStatus({ modelId: 'gemma4:e2b' });
  assert.equal(afterLoad.loadable, true);
  assert.equal(afterLoad.ready, true);
});

serialTest('LLM uninstall rejects while install task is still in progress', async (t) => {
  installBrowserEnvironment(t);
  const llm = new LLM({
    assetInstaller: createMockAssetInstaller({
      installState: createInstallSnapshot({
        state: 'installing',
        userState: 'installing',
        systemState: 'downloading-partial',
        stored: false,
      }),
      installBusy: true,
    }),
    runtimeAdapter: new MockRuntimeAdapter(),
  });

  await assert.rejects(() => llm.uninstall({ modelId: 'gemma4:e2b' }), (error) => {
    assert.equal(error.code, 'LLM_MODEL_BUSY');
    return true;
  });
});

serialTest('LLM queue emits task snapshots and supports queued cancellation', async (t) => {
  installBrowserEnvironment(t);
  const llm = new LLM({
    assetInstaller: createMockAssetInstaller(),
    runtimeAdapter: new MockRuntimeAdapter(),
  });
  const taskUpdates = [];
  llm.onTaskUpdate((task) => {
    taskUpdates.push(task);
  });

  const firstTaskId = llm.submit({
    model: 'gemma4:e2b',
    query: 'first',
    options: {
      stream: false,
    },
  });
  const secondTaskId = llm.submit({
    model: 'gemma4:e2b',
    query: 'second',
    options: {
      stream: false,
    },
  });
  const secondTaskPromise = llm.waitForTask(secondTaskId);

  const cancelled = llm.cancelTask(secondTaskId);
  assert.equal(cancelled, true);
  await llm.waitForTask(firstTaskId);
  await assert.rejects(() => secondTaskPromise);
  assert(taskUpdates.some((task) => task?.id === secondTaskId && task.status === 'cancelled'));
});

serialTest('LLM stream callbacks receive aggregated text while token events stay delta-based', async (t) => {
  installBrowserEnvironment(t);

  class ChunkedRuntimeAdapter extends RuntimeAdapter {
    async create() {
      return {
        async generateResponse(_query, callback) {
          callback('hello ', false);
          callback('world', true);
          return 'hello world';
        },
      };
    }
  }

  const seen = [];
  const llm = new LLM({
    assetInstaller: createMockAssetInstaller(),
    runtimeAdapter: new ChunkedRuntimeAdapter(),
  });

  const taskId = llm.submit({
    model: 'gemma4:e2b',
    query: 'ignored',
    options: {
      stream: true,
      callback: (text, done, delta) => {
        seen.push({ text, done, delta });
      },
    },
  });

  const output = await llm.waitForTask(taskId);
  assert.equal(output, 'hello world');
  assert.deepEqual(seen, [
    { text: 'hello ', done: false, delta: 'hello ' },
    { text: 'hello world', done: false, delta: 'world' },
    { text: 'hello world', done: true, delta: undefined },
  ]);
});

serialTest('diagnostics snapshot exposes manifest and runtime state for hosts', async (t) => {
  installBrowserEnvironment(t);
  const llm = new LLM({
    assetInstaller: createMockAssetInstaller(),
    runtimeAdapter: new MockRuntimeAdapter(),
  });

  await llm.load('gemma4:e2b');
  const diagnostics = llm.getDiagnosticsSnapshot('gemma4:e2b');

  assert.equal(diagnostics.install.storageBackend, 'opfs');
  assert.equal(diagnostics.manifest.modelId, 'gemma4:e2b');
  assert.equal(diagnostics.runtime.state, 'loaded');
  assert.equal(diagnostics.runtime.installId, 'gemma4:e2b@v1#mediapipe@0.10.27');
  assert.equal(diagnostics.eligibility.eligible, true);
});
