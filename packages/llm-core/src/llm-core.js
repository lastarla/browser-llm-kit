import { formatInstallStateMessage } from './diagnostics.js';
import { createLlmError, RUNTIME_ERROR_CODES } from './errors.js';
import { AssetInstaller } from '../../llm-opfs/src/asset-installer.js';
import { InferenceWorkerClient } from '../../llm-worker/src/inference-worker-client.js';
import { LocalInferenceClient } from '../../llm-mediapipe/src/local-inference-client.js';
import { RuntimeAdapter } from '../../llm-mediapipe/src/runtime-adapter.js';
import { CapabilityResolver } from './capability-resolver.js';
import { ModelRegistry } from './model-registry.js';

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

function createDefaultInferenceClient(assetInstaller, runtimeAdapter) {
  const workerClient = new InferenceWorkerClient();
  if (workerClient.isAvailable()) {
    return workerClient;
  }

  if (runtimeAdapter) {
    return new LocalInferenceClient({
      runtimeAdapter,
      createModelObjectUrl: (modelId) => assetInstaller.createModelObjectUrl(modelId),
      createRuntimeFileset: (payload) => assetInstaller.createRuntimeFileset(payload),
    });
  }

  return workerClient;
}

export class LLMCore {
  constructor({
    modelRegistry = new ModelRegistry(),
    assetInstaller = null,
    runtimeAdapter = new RuntimeAdapter(),
    inferenceClient = null,
    capabilityResolver = new CapabilityResolver(),
  } = {}) {
    this.statusListeners = new Map();
    this.installListeners = new Map();
    this.taskListeners = new Set();
    this.eventListeners = new Set();
    this.taskIdSeed = 0;
    this.modelRegistry = modelRegistry;
    this.assetInstaller = assetInstaller || new AssetInstaller({
      modelRegistry: this.modelRegistry,
    });
    this.inferenceClient = inferenceClient || createDefaultInferenceClient(this.assetInstaller, runtimeAdapter);
    this.capabilityResolver = capabilityResolver;
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
        this.emitEvent({ type: 'install.state', modelId, snapshot });
      });
    }

    this.inferenceClient.onEvent?.((event) => {
      this.handleInferenceEvent(event);
    });
  }

  createModelRuntimeConfig(modelId) {
    return {
      state: 'unload',
      loadPromise: null,
      installId: '',
      runtimeState: 'idle',
      tasks: new Map(),
      pendingTaskIds: [],
      runningTaskId: null,
    };
  }

  handleInferenceEvent(event) {
    if (!event || typeof event !== 'object') {
      return;
    }

    if (event.type === 'inference.state') {
      const config = this.models[event.modelId];
      if (config) {
        config.runtimeState = event.runtimeState;
        if (event.installId) {
          config.installId = event.installId;
        }
        if (event.runtimeState === 'ready') {
          config.state = 'loaded';
        } else if (event.runtimeState === 'idle') {
          config.state = 'unload';
        } else if (event.runtimeState === 'loading-model' || event.runtimeState === 'loading-runtime') {
          config.state = 'loading';
        }
      }
      this.emitEvent(event);
      return;
    }

    if (event.type === 'inference.token') {
      const task = this.findTaskById(event.taskId);
      if (task && event.text) {
        task.streamText = `${task.streamText || ''}${event.text}`;
      }
      if (task?.callback) {
        task.callback(task.streamText || '', false, event.text || '');
      }
      this.emitEvent(event);
      return;
    }

    this.emitEvent(event);
  }

  emitEvent(event) {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  subscribe(listener) {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  setModelAssetPath(modelId, assetPath) {
    this.modelRegistry.setModelAssetPath(modelId, assetPath);
  }

  getModelCacheConfig(modelId) {
    return this.modelRegistry.buildStorageConfig(modelId);
  }

  listModels() {
    return this.modelRegistry.listModelIds().map((modelId) => this.modelRegistry.getModel(modelId));
  }

  listInstalledModels() {
    return this.modelRegistry.listModelIds()
      .map((modelId) => this.getModelStatus({ modelId }))
      .filter((item) => item.stored);
  }

  getInstallState(modelId) {
    return this.assetInstaller.getState(modelId);
  }

  getEligibility(request) {
    const modelId = typeof request === 'string' ? request : request.modelId;
    const definition = this.modelRegistry.getModel(modelId);
    return this.capabilityResolver.resolve(definition, {
      storageClientAvailable: this.assetInstaller.storageClient?.isAvailable?.() ?? true,
      inferenceClientAvailable: this.inferenceClient.isAvailable?.() ?? true,
      allowMainThreadInference: this.inferenceClient instanceof LocalInferenceClient,
    });
  }

  getModelStatus(request) {
    const modelId = typeof request === 'string' ? request : request.modelId;
    const install = this.getInstallState(modelId);
    const config = this.getModelConfig(modelId);
    return {
      modelId,
      installId: install.installId || config.installId,
      userState: install.userState || install.state,
      systemState: install.systemState,
      stored: Boolean(install.stored),
      loadable: Boolean(install.stored && (config.state === 'loaded' || config.state === 'loading')),
      ready: config.state === 'loaded',
      runtimeState: config.runtimeState,
      queueLength: config.pendingTaskIds.length,
      runningTaskId: config.runningTaskId,
      errorCode: install.errorCode || '',
      eligibility: this.getEligibility({ modelId }),
    };
  }

  getDiagnosticsSnapshot(modelId) {
    const installDiagnostics = this.assetInstaller.getDiagnostics(modelId);
    const runtimeConfig = this.getModelConfig(modelId);
    return {
      ...installDiagnostics,
      eligibility: this.getEligibility({ modelId }),
      runtime: {
        state: runtimeConfig.state,
        runtimeState: runtimeConfig.runtimeState,
        queueLength: runtimeConfig.pendingTaskIds.length,
        runningTaskId: runtimeConfig.runningTaskId,
        installId: runtimeConfig.installId,
      },
    };
  }

  async getDiagnostics() {
    const models = this.modelRegistry.listModelIds().map((modelId) => this.getDiagnosticsSnapshot(modelId));
    const inference = await this.inferenceClient.diagnostics?.().catch(() => ({}));
    return {
      models,
      inference,
    };
  }

  isModelReady(modelId) {
    return this.getModelStatus({ modelId }).ready;
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
    return this.install({ modelId });
  }

  install(request) {
    return this.assetInstaller.install(request.modelId, request);
  }

  retryInstall(modelId) {
    return this.assetInstaller.retryInstall(modelId);
  }

  cancelInstall(modelId) {
    return this.assetInstaller.cancelInstall(modelId);
  }

  async clearModel(modelId) {
    const modelConfig = this.getModelConfig(modelId);
    await this.inferenceClient.unload?.({ modelId, installId: modelConfig.installId }).catch(() => {});
    modelConfig.state = 'unload';
    modelConfig.loadPromise = null;
    modelConfig.installId = '';
    modelConfig.runtimeState = 'idle';
    modelConfig.runningTaskId = null;
    modelConfig.pendingTaskIds = [];
    modelConfig.tasks.clear();
    return this.assetInstaller.clearModel(modelId);
  }

  async unload(request) {
    const modelId = typeof request === 'string' ? request : request.modelId;
    const config = this.getModelConfig(modelId);
    await this.inferenceClient.unload({
      modelId,
      installId: config.installId,
    });
    config.state = 'unload';
    config.runtimeState = 'idle';
    return true;
  }

  async uninstall(request) {
    const modelId = typeof request === 'string' ? request : request.modelId;
    const config = this.getModelConfig(modelId);
    if (
      config.state === 'loading'
      || config.state === 'loaded'
      || config.runningTaskId
      || config.pendingTaskIds.length > 0
      || this.assetInstaller.isInstallBusy?.(modelId)
    ) {
      throw createLlmError('LLM_MODEL_BUSY', 'LLM_MODEL_BUSY');
    }
    return this.clearModel(modelId);
  }

  async prune() {
    return {
      removedInstallIds: [],
      reclaimedBytes: 0,
    };
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
      streamText: '',
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

  findTaskById(taskId) {
    for (const config of Object.values(this.models)) {
      const task = config.tasks.get(taskId);
      if (task) {
        return task;
      }
    }
    return null;
  }

  getTask(taskId) {
    return buildTaskSnapshot(this.findTaskById(taskId));
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
    if (config.state === 'loaded') {
      return Promise.resolve({ ready: true, installId: config.installId });
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

  async ensure(request) {
    const modelId = typeof request === 'string' ? request : request.modelId;
    const eligibility = this.getEligibility({ modelId });
    if (!eligibility.eligible) {
      throw createLlmError(eligibility.compatibilityCode || 'LLM_RUNTIME_UNAVAILABLE', eligibility.compatibilityCode || 'LLM_RUNTIME_UNAVAILABLE', { eligibility });
    }
    return this.load(modelId);
  }

  async loadModelRuntime(modelId) {
    const modelConfig = this.getModelConfig(modelId);
    const modelDefinition = this.modelRegistry.getModel(modelId);
    const eligibility = this.getEligibility({ modelId });

    if (!eligibility.eligible) {
      throw createLlmError(eligibility.compatibilityCode || 'LLM_RUNTIME_UNAVAILABLE', eligibility.compatibilityCode || 'LLM_RUNTIME_UNAVAILABLE', { eligibility });
    }

    modelConfig.state = 'loading';
    modelConfig.runtimeState = 'loading-model';

    try {
      this.emitStatus(modelId, '准备模型安装');
      const installState = await this.prepare(modelId);
      if (!installState.stored) {
        this.emitStatus(modelId, installState.statusText);
        throw createLlmError(
          RUNTIME_ERROR_CODES.MODEL_NOT_INSTALLED,
          `${RUNTIME_ERROR_CODES.MODEL_NOT_INSTALLED}:${installState.errorCode || installState.state}`,
          { installState },
        );
      }

      this.emitStatus(modelId, '准备 OPFS 模型资源');
      this.emitStatus(modelId, '初始化 WASM');
      const loaded = await this.inferenceClient.load({
        modelId,
        definition: modelDefinition,
        installState,
      });
      this.emitStatus(modelId, '创建推理实例');

      modelConfig.installId = installState.installId;
      modelConfig.state = 'loaded';
      modelConfig.runtimeState = loaded.state || 'ready';
      this.processQueue(modelId);
      return loaded;
    } catch (error) {
      modelConfig.state = 'unload';
      modelConfig.runtimeState = 'idle';
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
    for (const [modelId, config] of Object.entries(this.models)) {
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
        this.inferenceClient.cancel?.({ taskId, modelId }).catch(() => {});
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
    const task = this.findTaskById(taskId);
    if (!task) {
      throw new Error(`TASK_NOT_FOUND:${taskId}`);
    }
    return task.promise;
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
      if (task.cancelRequested || error?.code === 'TASK_CANCELLED') {
        this.updateTaskStatus(task, 'cancelled', {
          error: error instanceof Error ? error.message : String(error),
          finishedAt: Date.now(),
        });
        task.reject?.(error);
      } else {
        this.updateTaskStatus(task, 'failed', {
          error: error instanceof Error ? error.message : String(error),
          finishedAt: Date.now(),
        });
        task.reject?.(error);
      }
    } finally {
      if (config.runningTaskId === task.id) {
        config.runningTaskId = null;
      }
      this.processQueue(modelId);
    }
  }

  async runInference({ model, id, query, callback }) {
    const config = this.getModelConfig(model);
    if (config.state !== 'loaded') {
      throw new Error(`MODEL_NOT_READY:${model}`);
    }

    const response = await this.inferenceClient.generate({
      modelId: model,
      installId: config.installId,
      taskId: id,
      query,
    });

    if (callback) {
      callback(response.output, true);
    }
    return response.output;
  }

  async generate({ model, query, options = {} }) {
    const taskId = this.submit({ model, query, options });
    return this.waitForTask(taskId);
  }

  async *generateStream({ model, query, options = {} }) {
    let lastText = '';
    const queue = [];
    let finished = false;
    let error = null;
    let taskId = '';

    const unsubscribe = this.subscribe((event) => {
      if (event.type === 'inference.token' && event.taskId === taskId) {
        queue.push({
          kind: 'delta',
          text: event.text,
        });
      }
    });

    taskId = this.submit({
      model,
      query,
      options: {
        ...options,
        stream: true,
      },
    });

    this.waitForTask(taskId)
      .then((result) => {
        queue.push({
          kind: 'final',
          text: result,
        });
        finished = true;
      })
      .catch((nextError) => {
        error = nextError;
        finished = true;
      });

    try {
      while (!finished || queue.length > 0) {
        while (queue.length > 0) {
          const next = queue.shift();
          if (next.kind === 'delta') {
            lastText += next.text;
            yield {
              taskId,
              text: lastText,
              delta: next.text,
            };
            continue;
          }

          if (next.text !== lastText) {
            lastText = next.text;
            yield {
              taskId,
              text: lastText,
              delta: '',
            };
          }
        }
        if (!finished) {
          await new Promise((resolve) => {
            setTimeout(resolve, 10);
          });
        }
      }

      if (error) {
        throw error;
      }
    } finally {
      unsubscribe();
    }
  }
}

export default LLMCore;
