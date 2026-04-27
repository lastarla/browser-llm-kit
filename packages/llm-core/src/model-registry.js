import gemma4E2bManifest from '../manifest/gemma4-e2b.json' with { type: 'json' };
import { buildInstallId, normalizeRuntime } from '../../llm-opfs/src/opfs-layout.js';

function cloneAsset(asset) {
  return { ...asset };
}

function cloneModelDefinition(model) {
  return {
    ...model,
    runtime: { ...(model.runtime || {}) },
    cache: { ...(model.cache || {}) },
    assets: Array.isArray(model.assets) ? model.assets.map(cloneAsset) : [],
  };
}

const DEFAULT_MODEL_DEFINITIONS = {
  'gemma4:e2b': gemma4E2bManifest,
};

export class ModelRegistry {
  constructor(definitions = DEFAULT_MODEL_DEFINITIONS) {
    this.models = new Map(
      Object.entries(definitions).map(([modelId, definition]) => [modelId, cloneModelDefinition(definition)]),
    );
  }

  assertModel(modelId) {
    const model = this.models.get(modelId);
    if (!model) {
      throw new Error(`MODEL_NOT_SUPPORTED:${modelId}`);
    }
    return model;
  }

  getModel(modelId) {
    return cloneModelDefinition(this.assertModel(modelId));
  }

  listModelIds() {
    return Array.from(this.models.keys());
  }

  getRuntime(modelId) {
    return normalizeRuntime(this.assertModel(modelId).runtime);
  }

  getWasmBasePath(modelId) {
    return this.assertModel(modelId).runtime.wasmBasePath;
  }

  getModelAssetPath(modelId) {
    return this.assertModel(modelId).runtime.entryModelPath;
  }

  setModelAssetPath(modelId, assetPath) {
    const model = this.assertModel(modelId);
    const normalizedAssetPath = String(assetPath ?? '').trim();
    if (!normalizedAssetPath) {
      throw new Error(`MODEL_ASSET_PATH_MISSING:${modelId}`);
    }

    model.runtime.entryModelPath = normalizedAssetPath;
    model.assets = model.assets.map((asset) => (
      asset.type === 'model'
        ? { ...asset, url: normalizedAssetPath }
        : asset
    ));
  }

  listAssets(modelId) {
    return this.assertModel(modelId).assets.map(cloneAsset);
  }

  listInstallAssets(modelId) {
    return this.assertModel(modelId).assets
      .filter((asset) => asset.installChannel === 'opfs')
      .map(cloneAsset);
  }

  listRuntimeAssets(modelId) {
    return this.assertModel(modelId).assets
      .filter((asset) => asset.type === 'runtime')
      .map(cloneAsset);
  }

  buildInstallPlan(modelId) {
    const model = this.assertModel(modelId);
    const runtime = normalizeRuntime(model.runtime);
    return {
      modelId: model.modelId,
      version: model.version,
      runtime,
      installId: buildInstallId({
        modelId: model.modelId,
        version: model.version,
        runtime,
      }),
      assets: this.listInstallAssets(modelId),
    };
  }

  buildStorageConfig(modelId) {
    const model = this.assertModel(modelId);
    return {
      storageBackend: 'opfs',
      model: model.modelId,
      version: model.version,
      installId: this.buildInstallPlan(modelId).installId,
      runtime: normalizeRuntime(model.runtime).label,
      installUrls: this.listInstallAssets(modelId).map((asset) => asset.url),
      runtimeUrls: this.listRuntimeAssets(modelId).map((asset) => asset.url),
    };
  }
}

export {
  DEFAULT_MODEL_DEFINITIONS,
};
