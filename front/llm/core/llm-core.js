import { formatInstallStateMessage } from '../diagnostics.js';
import { createLlmError, RUNTIME_ERROR_CODES } from '../errors.js';
import { AssetInstaller } from '../install/asset-installer.js';
import { ModelRegistry } from '../models/model-registry.js';
import { RuntimeAdapter } from '../runtime/runtime-adapter.js';

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

export class LLMCore {
  constructor({
    modelRegistry = new ModelRegistry(),
    assetInstaller = null,
    runtimeAdapter = new RuntimeAdapter(),
  } = {}) {
    this.statusListeners = new Map();
    this.installListeners = new Map();
    this.taskListeners = new Set();
    this.taskIdSeed = 0;
    this.modelRegistry = modelRegistry;
    this.runtimeAdapter = runtimeAdapter;
    this.assetInstaller = assetInstaller || new AssetInstaller({
      modelRegistry: this.modelRegistry,
    });
    this.models = Object.fromEntries(
      this.modelRegistry.listModelIds().map((modelId) => [modelId, this.createModelRuntimeConfig(modelId)]),
    );

    for (const modelId of this.modelRegistry.listModelIds()) {
      this.assetInstaller.onStateChange(modelId, (snapshot) => {
        const listeners = this.installListeners.get(modelId) || new Set();
        for (const listener of listeners) {
          listener(snapshot);
        }
        this.emitStatus(modelId, formatInstallStateMessage(snapshot));
      });
    }
  }

  createModelRuntimeConfig(modelId) {
    return {
      state: 'unload',
      llmInference: null,
      loadPromise: null,
      tasks: new Map(),
      pendingTaskIds: [],
      runningTaskId: null,
    };
  }

  setModelAssetPath(modelId, assetPath) {
    this.modelRegistry.setModelAssetPath(modelId, assetPath);
  }

  getModelCacheConfig(modelId, version) {
    return this.modelRegistry.buildCacheConfig(modelId, version);
  }

  getInstallState(modelId) {
    return this.assetInstaller.getState(modelId);
  }

  getDiagnosticsSnapshot(modelId) {
    const installDiagnostics = this.assetInstaller.getDiagnostics(modelId);
    const runtimeConfig = this.getModelConfig(modelId);
    return {
      ...installDiagnostics,
      runtime: {
        state: runtimeConfig.state,
        queueLength: runtimeConfig.pendingTaskIds.length,
        runningTaskId: runtimeConfig.runningTaskId,
      },
    };
  }

  isModelReady(modelId) {
    return this.getInstallState(modelId).ready;
  }

  setIntegrityMode(mode) {
    this.assetInstaller.setIntegrityMode(mode);
  }

  getIntegrityMode() {
    return this.assetInstaller.getIntegrityMode();
  }

  onInstallStateChange(modelId, listener) {
    const listeners = this.installListeners.get(modelId) || new Set();
    listeners.add(listener);
    this.installListeners.set(modelId, listeners);
    listener(this.getInstallState(modelId));

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.installListeners.delete(modelId);
      }
    };
  }

  prepare(modelId) {
    return this.assetInstaller.install(modelId);
  }

  retryInstall(modelId) {
    return this.assetInstaller.retryInstall(modelId);
  }

  cancelInstall(modelId) {
    return this.assetInstaller.cancelInstall(modelId);
  }

  clearModel(modelId) {
    const modelConfig = this.getModelConfig(modelId);
    modelConfig.state = 'unload';
    modelConfig.llmInference = null;
    modelConfig.loadPromise = null;
    modelConfig.runningTaskId = null;
    modelConfig.pendingTaskIds = [];
    modelConfig.tasks.clear();
    return this.assetInstaller.clearModel(modelId);
  }

  onStatusChange(modelId, listener) {
    this.statusListeners.set(modelId, listener);
  }

  onTaskUpdate(listener) {
    this.taskListeners.add(listener);
    return () => {
      this.taskListeners.delete(listener);
    };
  }

  emitStatus(modelId, status) {
    const listener = this.statusListeners.get(modelId);
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

  getModelConfig(modelId) {
    const config = this.models[modelId];
    if (!config) {
      throw new Error(`MODEL_NOT_SUPPORTED:${modelId}`);
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

  getQueue(modelId) {
    if (modelId) {
      const config = this.getModelConfig(modelId);
      return config.pendingTaskIds
        .map((taskId) => buildTaskSnapshot(config.tasks.get(taskId)))
        .filter(Boolean);
    }

    return Object.keys(this.models).flatMap((name) => this.getQueue(name));
  }

  queueLength(modelId) {
    return this.getQueue(modelId).length;
  }

  load(modelId) {
    const config = this.getModelConfig(modelId);
    if (config.state === 'loaded' && config.llmInference) {
      return Promise.resolve(config.llmInference);
    }

    if (config.loadPromise) {
      return config.loadPromise;
    }

    config.loadPromise = this.loadModelRuntime(modelId)
      .finally(() => {
        config.loadPromise = null;
      });

    return config.loadPromise;
  }

  async loadModelRuntime(modelId) {
    const modelConfig = this.getModelConfig(modelId);
    const modelDefinition = this.modelRegistry.getModel(modelId);

    modelConfig.state = 'loading';

    try {
      this.emitStatus(modelId, '准备缓存');
      const installState = await this.prepare(modelId);
      if (!installState.ready) {
        this.emitStatus(modelId, installState.statusText);
        throw createLlmError(
          RUNTIME_ERROR_CODES.MODEL_NOT_INSTALLED,
          `${RUNTIME_ERROR_CODES.MODEL_NOT_INSTALLED}:${installState.errorCode || installState.state}`,
          { installState },
        );
      }
      this.emitStatus(modelId, '初始化 WASM');
      let llmInference;
      try {
        llmInference = await this.runtimeAdapter.create(modelDefinition);
      } catch (error) {
        throw createLlmError(
          RUNTIME_ERROR_CODES.INIT_FAILED,
          error instanceof Error ? error.message : String(error),
          { cause: error },
        );
      }
      this.emitStatus(modelId, '创建推理实例');

      modelConfig.llmInference = llmInference;
      modelConfig.state = 'loaded';
      this.processQueue(modelId);
      return llmInference;
    } catch (error) {
      modelConfig.state = 'unload';
      modelConfig.llmInference = null;
      throw error;
    }
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

  cancelLatest(modelId) {
    const config = this.getModelConfig(modelId);
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

  flushQueueError(modelId, error) {
    const config = this.getModelConfig(modelId);
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

  async processQueue(modelId) {
    const config = this.getModelConfig(modelId);
    if (config.state !== 'loaded' || config.runningTaskId) {
      return;
    }

    const nextTaskId = config.pendingTaskIds.shift();
    if (!nextTaskId) {
      return;
    }

    const task = config.tasks.get(nextTaskId);
    if (!task || task.status !== 'queued') {
      await this.processQueue(modelId);
      return;
    }

    config.runningTaskId = task.id;
    this.updateTaskStatus(task, 'running', {
      startedAt: Date.now(),
    });

    try {
      const result = await this.runInference(task);
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
      this.processQueue(modelId);
    }
  }

  async runInference({ model, query, stream, callback }) {
    const config = this.getModelConfig(model);
    const llmInference = config.llmInference;
    if (!llmInference) {
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

  async generate({ model, query, options = {} }) {
    const taskId = this.submit({ model, query, options });
    return this.waitForTask(taskId);
  }
}

export default LLMCore;
