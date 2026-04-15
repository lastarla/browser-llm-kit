import { FilesetResolver, LlmInference } from '@mediapipe/tasks-genai';
import {
  DEFAULT_CACHE_PREFIX,
  DEFAULT_SERVICE_WORKER_URL,
  registerAssetCache,
} from './asset-cache.js';

const WASM_PATH = '/wasm';
const MODEL_ASSET_BASE_PATH = '/assets/llm';
const DEFAULT_CACHE_VERSION = 'v1';
const DEFAULT_WASM_CACHE_PATHS = [WASM_PATH];
const DEFAULT_WASM_PREFETCH_URLS = [
  '/wasm/genai_wasm_internal.js',
  '/wasm/genai_wasm_internal.wasm',
  '/wasm/genai_wasm_module_internal.js',
  '/wasm/genai_wasm_module_internal.wasm',
  '/wasm/genai_wasm_nosimd_internal.js',
  '/wasm/genai_wasm_nosimd_internal.wasm',
];

function buildTaskSnapshot(task) {
  if (!task) {
    return null;
  }

  return {
    id: task.id,
    model: task.model,
    status: task.status,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    error: task.error,
    cancelRequested: Boolean(task.cancelRequested),
  };
}

class LLM {
  constructor() {
    this.statusListeners = new Map();
    this.taskListeners = new Set();
    this.taskIdSeed = 0;
    this.models = {
      'gemma4:e2b': {
        state: 'unload',
        assetPath: `${MODEL_ASSET_BASE_PATH}/gemma-4-E2B-it-web.task`,
        cacheKey: 'gemma4:e2b',
        cacheVersion: DEFAULT_CACHE_VERSION,
        wasmCachePaths: DEFAULT_WASM_CACHE_PATHS,
        cacheReadyPromise: null,
        llmInference: null,
        loadPromise: null,
        tasks: new Map(),
        pendingTaskIds: [],
        runningTaskId: null,
        loader: this.gemma4e2bLoader.bind(this),
        handler: this.gemma4e2bHandler.bind(this),
      },
    };
  }

  setModelAssetPath(model, assetPath) {
    const config = this.models[model];
    if (!config) {
      throw new Error(`MODEL_NOT_SUPPORTED:${model}`);
    }

    config.assetPath = String(assetPath ?? '').trim();
  }

  onStatusChange(model, listener) {
    this.statusListeners.set(model, listener);
  }

  onTaskUpdate(listener) {
    this.taskListeners.add(listener);
    return () => {
      this.taskListeners.delete(listener);
    };
  }

  emitStatus(model, status) {
    const listener = this.statusListeners.get(model);
    if (listener) {
      listener(status);
    }
  }

  emitTaskUpdate(task) {
    const snapshot = buildTaskSnapshot(task);
    for (const listener of this.taskListeners) {
      listener(snapshot);
    }
  }

  getModelCacheConfig(model, version) {
    const config = this.models[model];
    if (!config) {
      throw new Error(`MODEL_NOT_SUPPORTED:${model}`);
    }

    const cacheVersion = String(version || config.cacheVersion || DEFAULT_CACHE_VERSION).trim();
    const includeUrls = [
      config.assetPath,
      ...(Array.isArray(config.wasmPrefetchUrls) ? config.wasmPrefetchUrls : DEFAULT_WASM_PREFETCH_URLS),
    ].filter(Boolean);

    return {
      serviceWorkerUrl: DEFAULT_SERVICE_WORKER_URL,
      cachePrefix: DEFAULT_CACHE_PREFIX,
      model: config.cacheKey || model,
      version: cacheVersion,
      includePathPrefixes: Array.isArray(config.wasmCachePaths) ? config.wasmCachePaths : DEFAULT_WASM_CACHE_PATHS,
      includeUrls,
    };
  }

  async ensureAssetCache(model) {
    const config = this.models[model];
    if (!config) {
      throw new Error(`MODEL_NOT_SUPPORTED:${model}`);
    }

    if (config.cacheReadyPromise) {
      return config.cacheReadyPromise;
    }

    config.cacheReadyPromise = registerAssetCache(this.getModelCacheConfig(model))
      .then((result) => {
        if (!navigator.serviceWorker.controller) {
          this.emitStatus(model, '缓存将在下次页面导航后生效');
        }
        if (result?.prefetchError) {
          this.emitStatus(model, `模型预取失败：${result.prefetchError}`);
        }
        return result;
      })
      .catch((error) => {
        config.cacheReadyPromise = null;
        this.emitStatus(model, `缓存不可用：${error instanceof Error ? error.message : String(error)}`);
        return null;
      });

    return config.cacheReadyPromise;
  }

  getModelConfig(model) {
    const config = this.models[model];
    if (!config) {
      throw new Error(`MODEL_NOT_SUPPORTED:${model}`);
    }
    return config;
  }

  createTask({ model, query, options = {} }) {
    const { stream = true, callback } = options;
    this.taskIdSeed += 1;
    return {
      id: `${model}:${this.taskIdSeed}`,
      model,
      query,
      stream,
      callback,
      status: 'queued',
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: null,
      result: null,
      cancelRequested: false,
      resolve: null,
      reject: null,
    };
  }

  attachTaskPromise(task) {
    task.promise = new Promise((resolve, reject) => {
      task.resolve = resolve;
      task.reject = reject;
    });
    return task;
  }

  updateTaskStatus(task, status, extra = {}) {
    Object.assign(task, extra, { status });
    this.emitTaskUpdate(task);
  }

  removePendingTask(config, taskId) {
    config.pendingTaskIds = config.pendingTaskIds.filter((id) => id !== taskId);
  }

  getTask(taskId) {
    for (const config of Object.values(this.models)) {
      const task = config.tasks.get(taskId);
      if (task) {
        return buildTaskSnapshot(task);
      }
    }
    return null;
  }

  getQueue(model) {
    if (model) {
      const config = this.getModelConfig(model);
      return config.pendingTaskIds
        .map((taskId) => buildTaskSnapshot(config.tasks.get(taskId)))
        .filter(Boolean);
    }

    return Object.keys(this.models).flatMap((modelName) => this.getQueue(modelName));
  }

  queueLength(model) {
    return this.getQueue(model).length;
  }

  load(model) {
    const config = this.models[model];
    if (!config) {
      return Promise.reject(new Error(`MODEL_NOT_SUPPORTED:${model}`));
    }

    if (config.state === 'loaded' && config.llmInference) {
      return Promise.resolve(config.llmInference);
    }

    if (config.loadPromise) {
      return config.loadPromise;
    }

    const loader = config.loader;
    if (!loader) {
      return Promise.reject(new Error(`MODEL_LOADER_MISSING:${model}`));
    }

    config.loadPromise = Promise.resolve(loader(model)).finally(() => {
      config.loadPromise = null;
    });

    return config.loadPromise;
  }

  submit({ model, query, options = {} }) {
    const config = this.getModelConfig(model);
    const task = this.attachTaskPromise(this.createTask({ model, query, options }));
    config.tasks.set(task.id, task);
    config.pendingTaskIds.push(task.id);
    this.emitTaskUpdate(task);

    if (config.state === 'unload') {
      this.load(model).catch((error) => {
        this.flushQueueError(model, error);
      });
    } else if (config.state === 'loaded') {
      this.processQueue(model);
    }

    return task.id;
  }

  cancelTask(taskId) {
    for (const config of Object.values(this.models)) {
      const task = config.tasks.get(taskId);
      if (!task) {
        continue;
      }

      if (task.status === 'queued') {
        this.removePendingTask(config, taskId);
        this.updateTaskStatus(task, 'cancelled', { finishedAt: Date.now() });
        task.reject?.(new Error(`TASK_CANCELLED:${task.id}`));
        return true;
      }

      if (task.status === 'running') {
        task.cancelRequested = true;
        this.emitTaskUpdate(task);
        return true;
      }

      return false;
    }

    return false;
  }

  cancelLatest(model) {
    const config = this.getModelConfig(model);
    const latestPendingTaskId = config.pendingTaskIds[config.pendingTaskIds.length - 1];
    if (latestPendingTaskId) {
      return this.cancelTask(latestPendingTaskId);
    }

    if (config.runningTaskId) {
      return this.cancelTask(config.runningTaskId);
    }

    return false;
  }

  async waitForTask(taskId) {
    for (const config of Object.values(this.models)) {
      const task = config.tasks.get(taskId);
      if (task) {
        return task.promise;
      }
    }
    throw new Error(`TASK_NOT_FOUND:${taskId}`);
  }

  flushQueueError(model, error) {
    const config = this.getModelConfig(model);
    const pendingIds = [...config.pendingTaskIds];
    config.pendingTaskIds = [];

    for (const taskId of pendingIds) {
      const task = config.tasks.get(taskId);
      if (!task) {
        continue;
      }
      this.updateTaskStatus(task, 'failed', {
        error: error instanceof Error ? error.message : String(error),
        finishedAt: Date.now(),
      });
      task.reject?.(error);
    }
  }

  async processQueue(model) {
    const config = this.getModelConfig(model);
    if (config.state !== 'loaded' || config.runningTaskId) {
      return;
    }

    const nextTaskId = config.pendingTaskIds.shift();
    if (!nextTaskId) {
      return;
    }

    const task = config.tasks.get(nextTaskId);
    if (!task || task.status !== 'queued') {
      await this.processQueue(model);
      return;
    }

    config.runningTaskId = task.id;
    this.updateTaskStatus(task, 'running', {
      startedAt: Date.now(),
    });

    try {
      const result = await config.handler(task);
      if (task.cancelRequested) {
        this.updateTaskStatus(task, 'cancelled', {
          result,
          finishedAt: Date.now(),
        });
        task.reject?.(new Error(`TASK_CANCELLED:${task.id}`));
      } else {
        this.updateTaskStatus(task, 'completed', {
          result,
          finishedAt: Date.now(),
        });
        task.resolve?.(result);
      }
    } catch (error) {
      this.updateTaskStatus(task, 'failed', {
        error: error instanceof Error ? error.message : String(error),
        finishedAt: Date.now(),
      });
      task.reject?.(error);
    } finally {
      if (config.runningTaskId === task.id) {
        config.runningTaskId = null;
      }
      this.processQueue(model);
    }
  }

  async generate({ model, query, options = {} }) {
    const taskId = this.submit({ model, query, options });
    return this.waitForTask(taskId);
  }

  async gemma4e2bLoader(model) {
    const config = this.models[model];
    if (!config) {
      throw new Error(`MODEL_NOT_SUPPORTED:${model}`);
    }

    if (config.state === 'loaded' && config.llmInference) {
      return config.llmInference;
    }

    if (!config.assetPath) {
      throw new Error(`MODEL_ASSET_PATH_MISSING:${model}`);
    }

    config.state = 'loading';

    try {
      this.emitStatus(model, '准备缓存');
      await this.ensureAssetCache(model);
      this.emitStatus(model, '下载模型');
      this.emitStatus(model, '初始化 WASM');
      const genai = await FilesetResolver.forGenAiTasks(WASM_PATH);
      this.emitStatus(model, '创建推理实例');
      const llmInference = await LlmInference.createFromOptions(genai, {
        baseOptions: {
          modelAssetPath: config.assetPath,
        },
        maxTokens: 4096,
        topK: 1,
        temperature: 0.1,
        randomSeed: 101,
      });

      config.llmInference = llmInference;
      config.state = 'loaded';
      this.processQueue(model);
      return llmInference;
    } catch (error) {
      config.state = 'unload';
      config.llmInference = null;
      throw error;
    }
  }

  async gemma4e2bHandler({ model, query, stream, callback }) {
    const config = this.models[model];
    const llmInference = config?.llmInference;
    if (!llmInference || !config) {
      throw new Error(`MODEL_NOT_READY:${model}`);
    }

    if (stream) {
      return new Promise((resolve, reject) => {
        let output = '';

        try {
          llmInference.generateResponse(query, (partialResult, done) => {
            output += partialResult ?? '';
            if (callback) {
              callback(output, Boolean(done));
            }
            if (done) {
              resolve(output);
            }
          });
        } catch (error) {
          reject(error);
        }
      });
    }

    const response = await llmInference.generateResponse(query);
    if (callback) {
      callback(response, true);
    }
    return response;
  }
}

export default LLM;
