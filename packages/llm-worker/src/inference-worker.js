import { RuntimeAdapter } from '../../llm-mediapipe/src/runtime-adapter.js';
import { createOpfsRuntimeFileset } from '../../llm-mediapipe/src/opfs-runtime-fileset.js';
import { getArtifactFileName, getInstallArtifactsDirectory, getOpfsServiceRoot } from '../../llm-opfs/src/opfs-layout.js';

const runtimeAdapter = new RuntimeAdapter();
const loadedModels = new Map();
const activeGenerations = new Map();

function createError(code, message = code, detail = '') {
  return { code, message, detail };
}

function createTaskCancelledError(taskId) {
  const error = new Error(`TASK_CANCELLED:${taskId}`);
  error.code = 'TASK_CANCELLED';
  return error;
}

function emit(event) {
  self.postMessage({
    kind: 'event',
    event,
  });
}

function respond(requestId, ok, payload) {
  self.postMessage({
    kind: 'response',
    requestId,
    ok,
    ...(ok ? { result: payload } : { error: payload }),
  });
}

async function releaseModel(modelId) {
  const loaded = loadedModels.get(modelId);
  if (!loaded) {
    return;
  }

  try {
    await runtimeAdapter.destroy?.(loaded.instance);
  } catch {
    // Ignore destroy failures for current mediapipe adapter.
  }

  if (loaded.modelUrl) {
    URL.revokeObjectURL(loaded.modelUrl);
  }

  loaded.runtimeFileset?.revoke?.();
  loadedModels.delete(modelId);
}

async function buildModelUrl(definition, installState) {
  const modelAsset = (definition.assets || []).find((asset) => asset.type === 'model');
  if (!modelAsset) {
    throw new Error(`MODEL_ASSET_MISSING:${definition.modelId}`);
  }

  const root = await getOpfsServiceRoot({ create: true });
  const artifactsDir = await getInstallArtifactsDirectory(root, installState.installId, { create: false });
  const handle = await artifactsDir.getFileHandle(getArtifactFileName(modelAsset), { create: false });
  const file = await handle.getFile();
  return URL.createObjectURL(file);
}

async function handleLoad(request) {
  const existing = loadedModels.get(request.modelId);
  if (existing?.installId === request.installState.installId) {
    return {
      modelId: request.modelId,
      installId: existing.installId,
      state: 'ready',
    };
  }

  await releaseModel(request.modelId);
  emit({
    type: 'inference.state',
    modelId: request.modelId,
    installId: request.installState.installId,
    runtimeState: 'loading-model',
  });

  let modelUrl = '';
  let runtimeFileset = null;
  let instance = null;

  try {
    modelUrl = await buildModelUrl(request.definition, request.installState);
    runtimeFileset = await createOpfsRuntimeFileset({
      definition: request.definition,
      installState: request.installState,
    });
    instance = await runtimeAdapter.create({
      ...request.definition,
      runtime: {
        ...request.definition.runtime,
        entryModelPath: modelUrl,
        ...(runtimeFileset?.fileset ? { wasmFileset: runtimeFileset.fileset } : {}),
      },
    });
  } catch (error) {
    if (modelUrl) {
      URL.revokeObjectURL(modelUrl);
    }
    runtimeFileset?.revoke?.();
    throw error;
  }

  loadedModels.set(request.modelId, {
    installId: request.installState.installId,
    modelUrl,
    runtimeFileset,
    instance,
  });

  emit({
    type: 'inference.state',
    modelId: request.modelId,
    installId: request.installState.installId,
    runtimeState: 'ready',
  });

  return {
    modelId: request.modelId,
    installId: request.installState.installId,
    state: 'ready',
  };
}

async function handleGenerate(request) {
  const loaded = loadedModels.get(request.modelId);
  if (!loaded || loaded.installId !== request.installId) {
    throw new Error(`MODEL_NOT_LOADED:${request.modelId}`);
  }

  emit({
    type: 'inference.state',
    modelId: request.modelId,
    installId: request.installId,
    runtimeState: 'generating',
  });

  const generation = {
    cancelled: false,
    modelId: request.modelId,
    reject: null,
  };
  activeGenerations.set(request.taskId, generation);

  try {
    const output = await new Promise((resolve, reject) => {
      let combined = '';
      generation.reject = reject;

      try {
        const generationPromise = loaded.instance.generateResponse(request.query, (partialResult, done) => {
          if (generation.cancelled) {
            return;
          }

          if (partialResult) {
            combined += partialResult;
            emit({
              type: 'inference.token',
              taskId: request.taskId,
              text: partialResult,
            });
          }

          if (done) {
            resolve(combined);
          }
        });
        Promise.resolve(generationPromise).catch(reject);
      } catch (error) {
        reject(error);
      }
    });

    emit({
      type: 'inference.completed',
      taskId: request.taskId,
    });
    emit({
      type: 'inference.state',
      modelId: request.modelId,
      installId: request.installId,
      runtimeState: 'ready',
    });
    return { output };
  } catch (error) {
    emit({
      type: 'inference.state',
      modelId: request.modelId,
      installId: request.installId,
      runtimeState: 'ready',
    });
    throw error;
  } finally {
    activeGenerations.delete(request.taskId);
  }
}

async function handleCancel(request) {
  const active = activeGenerations.get(request.taskId);
  if (!active) {
    return { cancelled: false };
  }

  active.cancelled = true;
  const loaded = loadedModels.get(active.modelId);
  try {
    await runtimeAdapter.cancel?.(loaded?.instance);
  } catch {
    // Ignore backend cancellation failures and still reject the local task.
  }
  active.reject?.(createTaskCancelledError(request.taskId));
  emit({
    type: 'inference.state',
    modelId: active.modelId,
    taskId: request.taskId,
    runtimeState: 'cancelling',
  });
  return { cancelled: true };
}

async function handleUnload(request) {
  await releaseModel(request.modelId);
  emit({
    type: 'inference.state',
    modelId: request.modelId,
    installId: request.installId || '',
    runtimeState: 'idle',
  });
  return { unloaded: true };
}

async function handleDiagnostics() {
  return {
    loadedModelIds: Array.from(loadedModels.keys()),
    activeGenerationIds: Array.from(activeGenerations.keys()),
  };
}

self.addEventListener('message', async (event) => {
  const message = event.data;
  if (!message?.type || !message.requestId) {
    return;
  }

  try {
    switch (message.type) {
      case 'inference.load':
        respond(message.requestId, true, await handleLoad(message));
        return;
      case 'inference.generate':
        respond(message.requestId, true, await handleGenerate(message));
        return;
      case 'inference.cancel':
        respond(message.requestId, true, await handleCancel(message));
        return;
      case 'inference.unload':
        respond(message.requestId, true, await handleUnload(message));
        return;
      case 'inference.diagnostics':
        respond(message.requestId, true, await handleDiagnostics());
        return;
      default:
        respond(message.requestId, false, createError('INFERENCE_WORKER_UNKNOWN_REQUEST', message.type));
    }
  } catch (error) {
    respond(
      message.requestId,
      false,
      createError(
        error?.code || 'INFERENCE_WORKER_FAILED',
        error instanceof Error ? error.message : String(error),
        error?.detail || '',
      ),
    );
  }
});
