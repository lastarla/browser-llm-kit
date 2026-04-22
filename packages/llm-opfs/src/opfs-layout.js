export const OPFS_SERVICE_ROOT = 'browser-llm-service';
export const OPFS_REGISTRY_DIR = 'registry';
export const OPFS_INSTALLS_DIR = 'installs';
export const OPFS_RUNTIME_DIR = 'runtimes';

export function normalizeRuntime(runtime = {}) {
  const id = String(runtime.id || runtime.name || 'mediapipe').trim();
  const version = String(runtime.version || '').trim();
  return {
    id,
    version,
    label: version ? `${id}@${version}` : id,
  };
}

export function buildInstallId({ modelId, version, runtime }) {
  const normalizedRuntime = normalizeRuntime(runtime);
  const safeVersion = String(version || 'v1').trim();
  return `${modelId}@${safeVersion}#${normalizedRuntime.label}`;
}

export function encodePathSegment(value) {
  return encodeURIComponent(String(value));
}

export function getArtifactFileName(asset) {
  const explicitPath = String(asset?.path || '').trim();
  if (explicitPath) {
    return explicitPath.split('/').filter(Boolean).pop();
  }

  try {
    return new URL(asset.url, 'https://local.invalid/').pathname.split('/').filter(Boolean).pop();
  } catch {
    return String(asset?.url || 'artifact.bin').split('/').filter(Boolean).pop() || 'artifact.bin';
  }
}

export function toAbsoluteUrl(url) {
  if (typeof window === 'undefined') {
    return String(url ?? '').trim();
  }

  return new URL(String(url ?? '').trim(), window.location.href).href;
}

export async function getOpfsServiceRoot({ create = true } = {}) {
  const getDirectory = globalThis.navigator?.storage?.getDirectory;
  if (typeof getDirectory !== 'function') {
    throw new Error('OPFS_UNAVAILABLE');
  }

  const originRoot = await getDirectory.call(globalThis.navigator.storage);
  return originRoot.getDirectoryHandle(OPFS_SERVICE_ROOT, { create });
}

export async function getOrCreateDirectory(parent, name, { create = true } = {}) {
  return parent.getDirectoryHandle(name, { create });
}

export async function getOptionalDirectory(parent, name) {
  try {
    return await parent.getDirectoryHandle(name, { create: false });
  } catch (error) {
    if (error?.name === 'NotFoundError') {
      return null;
    }
    return null;
  }
}

export async function getOptionalFile(parent, name) {
  try {
    return await parent.getFileHandle(name, { create: false });
  } catch (error) {
    if (error?.name === 'NotFoundError') {
      return null;
    }
    return null;
  }
}

export async function readJsonFile(parent, name, fallback = null) {
  const handle = await getOptionalFile(parent, name);
  if (!handle) {
    return fallback;
  }

  try {
    const file = await handle.getFile();
    return JSON.parse(await file.text());
  } catch {
    return fallback;
  }
}

export async function writeJsonFile(parent, name, value) {
  const handle = await parent.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(value, null, 2));
  await writable.close();
}

export async function getInstallDirectory(root, installId, { create = true } = {}) {
  const installsDir = await root.getDirectoryHandle(OPFS_INSTALLS_DIR, { create });
  return installsDir.getDirectoryHandle(encodePathSegment(installId), { create });
}

export async function getInstallArtifactsDirectory(root, installId, { create = true } = {}) {
  const installDir = await getInstallDirectory(root, installId, { create });
  return installDir.getDirectoryHandle('artifacts', { create });
}

export async function removeEntryIfExists(parent, name, options = {}) {
  try {
    await parent.removeEntry(name, options);
    return true;
  } catch {
    return false;
  }
}

export async function getFileSize(fileHandle) {
  const file = await fileHandle.getFile();
  return file.size;
}
