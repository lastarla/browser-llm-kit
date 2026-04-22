export class LocalInferenceClient {
  constructor({ runtimeAdapter, createModelObjectUrl, createRuntimeFileset = null }) {
    this.runtimeAdapter = runtimeAdapter;
    this.createModelObjectUrl = createModelObjectUrl;
    this.createRuntimeFileset = createRuntimeFileset;
    this.listeners = new Set();
    this.loadedModels = new Map();
    this.activeGenerations = new Map();
  }

  isAvailable() {
    return true;
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event) {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  async load({ modelId, definition, installState }) {
    const existing = this.loadedModels.get(modelId);
    if (existing?.installId === installState.installId) {
      return { state: 'ready', modelId, installId: installState.installId };
    }

    await this.unload({ modelId });

    this.emit({
      type: 'inference.state',
      modelId,
      installId: installState.installId,
      runtimeState: 'loading-model',
    });

    let modelObjectUrl = '';
    let runtimeFileset = null;
    let instance = null;

    try {
      modelObjectUrl = await this.createModelObjectUrl(modelId);
      runtimeFileset = await this.createRuntimeFileset?.({
        modelId,
        definition,
        installState,
      });
      instance = await this.runtimeAdapter.create({
        ...definition,
        runtime: {
          ...definition.runtime,
          entryModelPath: modelObjectUrl,
          ...(runtimeFileset?.fileset ? { wasmFileset: runtimeFileset.fileset } : {}),
        },
      });
    } catch (error) {
      if (modelObjectUrl) {
        URL.revokeObjectURL(modelObjectUrl);
      }
      runtimeFileset?.revoke?.();
      throw error;
    }

    this.loadedModels.set(modelId, {
      installId: installState.installId,
      modelObjectUrl,
      runtimeFileset,
      instance,
    });

    this.emit({
      type: 'inference.state',
      modelId,
      installId: installState.installId,
      runtimeState: 'ready',
    });

    return { state: 'ready', modelId, installId: installState.installId };
  }

  async generate({ modelId, taskId, query }) {
    const loaded = this.loadedModels.get(modelId);
    if (!loaded) {
      throw new Error(`MODEL_NOT_LOADED:${modelId}`);
    }

    this.emit({
      type: 'inference.state',
      modelId,
      installId: loaded.installId,
      runtimeState: 'generating',
    });

    try {
      const output = await new Promise((resolve, reject) => {
        let combined = '';
        this.activeGenerations.set(taskId, {
          modelId,
          reject,
        });
        try {
          const generationPromise = loaded.instance.generateResponse(query, (partialResult, done) => {
            if (!this.activeGenerations.has(taskId)) {
              return;
            }
            combined += partialResult ?? '';
            this.emit({
              type: 'inference.token',
              taskId,
              text: partialResult ?? '',
            });
            if (done) {
              resolve(combined);
            }
          });
          Promise.resolve(generationPromise).catch(reject);
        } catch (error) {
          reject(error);
        }
      });

      this.emit({
        type: 'inference.completed',
        taskId,
      });
      this.emit({
        type: 'inference.state',
        modelId,
        installId: loaded.installId,
        runtimeState: 'ready',
      });
      return { output };
    } finally {
      this.activeGenerations.delete(taskId);
    }
  }

  async cancel({ taskId, modelId }) {
    const active = this.activeGenerations.get(taskId);
    if (!active) {
      return { cancelled: false };
    }

    const loaded = this.loadedModels.get(modelId || active.modelId);
    try {
      await this.runtimeAdapter.cancel?.(loaded?.instance);
    } catch {
      // Ignore backend cancellation failures; still reject the task locally.
    }

    this.activeGenerations.delete(taskId);
    const error = new Error(`TASK_CANCELLED:${taskId}`);
    error.code = 'TASK_CANCELLED';
    active.reject?.(error);
    this.emit({
      type: 'inference.state',
      modelId: modelId || active.modelId,
      taskId,
      runtimeState: 'cancelling',
    });
    this.emit({
      type: 'inference.state',
      modelId: modelId || active.modelId,
      installId: loaded?.installId || '',
      runtimeState: 'ready',
    });
    return { cancelled: true };
  }

  async unload({ modelId }) {
    const loaded = this.loadedModels.get(modelId);
    if (!loaded) {
      return { unloaded: false };
    }

    if (loaded.modelObjectUrl) {
      URL.revokeObjectURL(loaded.modelObjectUrl);
    }
    loaded.runtimeFileset?.revoke?.();
    for (const [taskId, active] of this.activeGenerations.entries()) {
      if (active.modelId === modelId) {
        const error = new Error(`TASK_CANCELLED:${taskId}`);
        error.code = 'TASK_CANCELLED';
        active.reject?.(error);
        this.activeGenerations.delete(taskId);
      }
    }
    this.loadedModels.delete(modelId);
    this.emit({
      type: 'inference.state',
      modelId,
      installId: loaded.installId,
      runtimeState: 'idle',
    });
    return { unloaded: true };
  }

  async diagnostics() {
    return {
      loadedModelIds: Array.from(this.loadedModels.keys()),
      activeGenerationIds: [],
    };
  }
}

export default LocalInferenceClient;
