import { FilesetResolver, LlmInference } from '@mediapipe/tasks-genai';

export class RuntimeAdapter {
  async create(modelDefinition) {
    const wasmBasePath = modelDefinition.runtime.wasmBasePath;
    const modelAssetPath = modelDefinition.runtime.entryModelPath;
    const modelAssetBuffer = modelDefinition.runtime.entryModelBuffer;
    const useModule = modelDefinition.runtime.useModule === true;
    const wasmFileset = modelDefinition.runtime.wasmFileset
      || await FilesetResolver.forGenAiTasks(wasmBasePath, useModule);

    return LlmInference.createFromOptions(wasmFileset, {
      baseOptions: {
        ...(modelAssetPath ? { modelAssetPath } : {}),
        ...(modelAssetBuffer ? { modelAssetBuffer } : {}),
      },
      maxTokens: 4096,
      topK: 1,
      temperature: 0.1,
      randomSeed: 101,
    });
  }

  async destroy(instance) {
    instance?.close?.();
  }

  async cancel(instance) {
    instance?.cancelProcessing?.();
  }
}

export default RuntimeAdapter;
