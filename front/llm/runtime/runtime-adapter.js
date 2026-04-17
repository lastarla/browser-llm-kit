import { FilesetResolver, LlmInference } from '@mediapipe/tasks-genai';

export class RuntimeAdapter {
  async create(modelDefinition) {
    const wasmBasePath = modelDefinition.runtime.wasmBasePath;
    const modelAssetPath = modelDefinition.runtime.entryModelPath;

    const genai = await FilesetResolver.forGenAiTasks(wasmBasePath);
    return LlmInference.createFromOptions(genai, {
      baseOptions: {
        modelAssetPath,
      },
      maxTokens: 4096,
      topK: 1,
      temperature: 0.1,
      randomSeed: 101,
    });
  }
}
