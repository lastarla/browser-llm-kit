import { FilesetResolver } from '@mediapipe/tasks-genai';
import { getArtifactFileName, getInstallArtifactsDirectory, getOpfsServiceRoot } from '../../llm-opfs/src/opfs-layout.js';

function getRuntimeAssets(definition) {
  return (definition?.assets || []).filter((asset) => asset.type === 'runtime' && asset.installChannel === 'opfs');
}

function classifyRuntimeAsset(asset) {
  const fileName = getArtifactFileName(asset);
  const isLoader = fileName.endsWith('.js');
  const isBinary = fileName.endsWith('.wasm');
  if (!isLoader && !isBinary) {
    return null;
  }

  const variant = fileName.includes('_module_')
    ? 'module'
    : fileName.includes('_nosimd_')
      ? 'nosimd'
      : 'simd';

  return {
    fileName,
    kind: isLoader ? 'loader' : 'binary',
    variant,
  };
}

export function selectRuntimeAssetPair(assets, {
  simdSupported = true,
  useModule = false,
} = {}) {
  const variant = useModule ? 'module' : simdSupported ? 'simd' : 'nosimd';
  const runtimeAssets = (assets || []).filter((asset) => asset.type === 'runtime' && asset.installChannel === 'opfs');
  let loader = null;
  let binary = null;

  for (const asset of runtimeAssets) {
    const classification = classifyRuntimeAsset(asset);
    if (!classification || classification.variant !== variant) {
      continue;
    }

    if (classification.kind === 'loader') {
      loader = asset;
    } else if (classification.kind === 'binary') {
      binary = asset;
    }
  }

  if (!loader || !binary) {
    throw new Error(`RUNTIME_OPFS_ASSET_PAIR_MISSING:${variant}`);
  }

  return {
    variant,
    loader,
    binary,
  };
}

export async function resolvePreferredRuntimeAssets(definition) {
  const runtimeAssets = getRuntimeAssets(definition);
  if (runtimeAssets.length <= 2) {
    return runtimeAssets;
  }

  const useModule = definition?.runtime?.useModule === true;
  try {
    const simdSupported = await FilesetResolver.isSimdSupported(useModule);
    const pair = selectRuntimeAssetPair(runtimeAssets, {
      simdSupported,
      useModule,
    });
    return [pair.loader, pair.binary];
  } catch {
    return runtimeAssets;
  }
}

async function createArtifactObjectUrl(artifactsDir, asset) {
  const handle = await artifactsDir.getFileHandle(getArtifactFileName(asset), { create: false });
  const file = await handle.getFile();
  return URL.createObjectURL(file);
}

export async function createOpfsRuntimeFileset({
  definition,
  installState,
} = {}) {
  const runtimeAssets = await resolvePreferredRuntimeAssets(definition);
  if (runtimeAssets.length === 0) {
    return null;
  }

  const installId = String(installState?.installId || '').trim();
  if (!installId) {
    throw new Error(`RUNTIME_INSTALL_ID_MISSING:${definition?.modelId || ''}`);
  }

  const useModule = definition?.runtime?.useModule === true;
  const simdSupported = !runtimeAssets.some((asset) => getArtifactFileName(asset).includes('_nosimd_'));
  const pair = selectRuntimeAssetPair(runtimeAssets, {
    simdSupported,
    useModule,
  });

  const urls = [];
  try {
    const root = await getOpfsServiceRoot({ create: true });
    const artifactsDir = await getInstallArtifactsDirectory(root, installId, { create: false });
    const wasmLoaderPath = await createArtifactObjectUrl(artifactsDir, pair.loader);
    urls.push(wasmLoaderPath);
    const wasmBinaryPath = await createArtifactObjectUrl(artifactsDir, pair.binary);
    urls.push(wasmBinaryPath);

    return {
      fileset: {
        wasmLoaderPath,
        wasmBinaryPath,
      },
      urls,
      runtimeVariant: pair.variant,
      simdSupported,
      useModule,
      revoke() {
        for (const url of urls) {
          URL.revokeObjectURL(url);
        }
        urls.length = 0;
      },
    };
  } catch (error) {
    for (const url of urls) {
      URL.revokeObjectURL(url);
    }
    throw error;
  }
}
