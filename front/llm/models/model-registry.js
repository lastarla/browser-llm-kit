import gemma4E2bManifest from './manifest/gemma4-e2b.json' with { type: 'json' };
import {
  DEFAULT_CACHE_PREFIX,
  DEFAULT_SERVICE_WORKER_URL,
  buildAssetCacheName,
} from '../asset-cache.js';

const DEFAULT_WASM_PATH = '/wasm';
const DEFAULT_CACHE_VERSION = 'v1';

function cloneAsset(asset) {
  return { ...asset };
}

function cloneModelDefinition(model) {
  return {
    ...model,
    runtime: { ...model.runtime },
    cache: { ...model.cache },
    assets: model.assets.map(cloneAsset),
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

  listRequiredAssetUrls(modelId) {
    return this.assertModel(modelId).assets
      .filter((asset) => asset.required)
      .map((asset) => asset.url);
  }

  buildCacheConfig(modelId, versionOverride) {
    const model = this.assertModel(modelId);
    const version = String(versionOverride || model.version || DEFAULT_CACHE_VERSION).trim();
    const cacheConfig = {
      serviceWorkerUrl: model.cache.serviceWorkerUrl || DEFAULT_SERVICE_WORKER_URL,
      cachePrefix: model.cache.prefix || DEFAULT_CACHE_PREFIX,
      model: model.modelId,
      version,
      includePathPrefixes: Array.isArray(model.cache.includePathPrefixes)
        ? [...model.cache.includePathPrefixes]
        : [DEFAULT_WASM_PATH],
      includeUrls: model.assets.map((asset) => asset.url),
    };

    return {
      ...cacheConfig,
      cacheName: buildAssetCacheName(cacheConfig),
    };
  }
}

export {
  DEFAULT_CACHE_VERSION,
  DEFAULT_MODEL_DEFINITIONS,
  DEFAULT_WASM_PATH,
};
