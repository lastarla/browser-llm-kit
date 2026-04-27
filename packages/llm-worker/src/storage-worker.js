import {
  buildInstallId,
  encodePathSegment,
  getArtifactFileName,
  getFileSize,
  getInstallArtifactsDirectory,
  getInstallDirectory,
  getOpfsServiceRoot,
  normalizeRuntime,
  readJsonFile,
  removeEntryIfExists,
  writeJsonFile,
} from '../../llm-opfs/src/opfs-layout.js';
import { hashFileHandle } from '../../llm-opfs/src/sha256.js';

const REGISTRY_FILE = 'installs.json';
const STATE_FILE = 'state.json';
const MANIFEST_FILE = 'manifest.json';

const activeTasks = new Map();

function createError(code, message = code, detail = '') {
  return { code, message, detail };
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createAssetRecord(asset) {
  return {
    url: asset.url,
    type: asset.type,
    required: Boolean(asset.required),
    installChannel: asset.installChannel,
    sizeBytes: typeof asset.sizeBytes === 'number' ? asset.sizeBytes : null,
    expectedSha256: typeof asset.sha256 === 'string' ? asset.sha256 : '',
    status: 'pending',
    attempts: 0,
    verified: false,
    integrityVerified: false,
    verificationMethod: '',
    downloadedBytes: 0,
    observedSizeBytes: null,
    observedSha256: '',
    errorCode: '',
    errorDetail: '',
    etag: '',
    lastModified: '',
  };
}

function buildProgress(assetRecords) {
  const totalFiles = assetRecords.length;
  const completedFiles = assetRecords.filter((record) => record.verified).length;
  const totalBytes = assetRecords.reduce((sum, record) => sum + (record.sizeBytes || 0), 0);
  const downloadedBytes = assetRecords.reduce((sum, record) => (
    sum + (record.verified
      ? (record.observedSizeBytes || record.sizeBytes || 0)
      : (record.downloadedBytes || 0))
  ), 0);

  return {
    totalFiles,
    completedFiles,
    totalBytes: totalBytes || null,
    downloadedBytes: downloadedBytes || 0,
    percent: totalBytes > 0 ? Math.max(0, Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))) : 0,
  };
}

function createSnapshot(plan, assetRecords, partial = {}) {
  const progress = buildProgress(assetRecords);
  const userState = partial.userState || 'absent';
  const systemState = partial.systemState || 'idle';
  const stored = partial.stored === true || userState === 'installed';
  const runtimeDescriptor = normalizeRuntime(plan.runtime);
  return {
    modelId: plan.modelId,
    version: plan.version,
    runtime: runtimeDescriptor.label,
    installId: plan.installId || buildInstallId(plan),
    manifestVersion: plan.version,
    state: userState,
    userState,
    systemState,
    ready: Boolean(partial.ready),
    stored,
    loadable: Boolean(partial.loadable),
    currentAsset: partial.currentAsset || '',
    errorCode: partial.errorCode || '',
    errorDetail: partial.errorDetail || '',
    integrityMode: partial.integrityMode || 'size-only',
    assetRecords: clone(assetRecords),
    progress,
    startedAt: partial.startedAt || 0,
    completedAt: partial.completedAt || 0,
    durationMs: partial.durationMs || 0,
    retryCount: partial.retryCount || 0,
    verifiedAt: partial.verifiedAt || 0,
    updatedAt: Date.now(),
    storageBackend: 'opfs',
    missingRequired: assetRecords.filter((record) => record.required && !record.verified).map((record) => record.url),
    cachedUrls: [],
  };
}

async function readRegistry(root) {
  const registryDir = await root.getDirectoryHandle('registry', { create: true });
  return {
    registryDir,
    data: await readJsonFile(registryDir, REGISTRY_FILE, {
      schemaVersion: 1,
      activeInstallIdByModel: {},
      installs: [],
    }),
  };
}

async function writeRegistry(registryDir, data) {
  await writeJsonFile(registryDir, REGISTRY_FILE, data);
}

async function writeInstallState(root, installId, snapshot, plan) {
  const installDir = await getInstallDirectory(root, installId, { create: true });
  await writeJsonFile(installDir, STATE_FILE, snapshot);
  await writeJsonFile(installDir, MANIFEST_FILE, plan);
}

async function readInstallState(root, installId) {
  const installDir = await getInstallDirectory(root, installId, { create: false }).catch(() => null);
  if (!installDir) {
    return null;
  }

  return readJsonFile(installDir, STATE_FILE, null);
}

async function getHeadMetadata(asset) {
  try {
    const response = await fetch(asset.url, {
      method: 'HEAD',
      cache: 'no-store',
    });

    if (!response.ok) {
      if (response.status === 405 || response.status === 501) {
        return {
          contentLength: asset.sizeBytes || null,
          etag: '',
          lastModified: '',
          acceptsRanges: false,
        };
      }
      throw new Error(`HEAD_REQUEST_FAILED:${asset.url}:${response.status}`);
    }

    return {
      contentLength: Number.parseInt(response.headers.get('content-length') || '', 10) || asset.sizeBytes || null,
      etag: response.headers.get('etag') || '',
      lastModified: response.headers.get('last-modified') || '',
      acceptsRanges: /bytes/i.test(response.headers.get('accept-ranges') || ''),
    };
  } catch (error) {
    if (error instanceof Error && /^HEAD_REQUEST_FAILED:/.test(error.message)) {
      throw error;
    }

    return {
      contentLength: asset.sizeBytes || null,
      etag: '',
      lastModified: '',
      acceptsRanges: false,
    };
  }
}

async function downloadAsset({
  taskId,
  asset,
  artifactsDir,
  snapshot,
  controller,
  integrityMode,
}) {
  const fileName = getArtifactFileName(asset);
  const fileHandle = await artifactsDir.getFileHandle(fileName, { create: true });
  const remoteHead = await getHeadMetadata(asset);
  const remoteSize = remoteHead.contentLength || asset.sizeBytes || null;
  const existingBytes = await getFileSize(fileHandle);
  const existingRecord = snapshot.assetRecords.find((record) => record.url === asset.url) || null;
  const validatorMatches = (
    (existingRecord?.etag && remoteHead.etag && existingRecord.etag === remoteHead.etag)
    || (existingRecord?.lastModified && remoteHead.lastModified && existingRecord.lastModified === remoteHead.lastModified)
  );
  const canResume = (
    existingBytes > 0
    && remoteHead.acceptsRanges
    && remoteSize !== null
    && existingBytes < remoteSize
    && validatorMatches
  );
  const shouldRestart = existingBytes > 0 && (!canResume || existingBytes > remoteSize);
  if (shouldRestart) {
    const resetWritable = await fileHandle.createWritable();
    await resetWritable.truncate(0);
    await resetWritable.close();
  }

  const startOffset = shouldRestart ? 0 : existingBytes;
  const requestHeaders = {};
  if (startOffset > 0) {
    requestHeaders.Range = `bytes=${startOffset}-`;
  }

  const response = await fetch(asset.url, {
    method: 'GET',
    headers: requestHeaders,
    cache: 'no-store',
    signal: controller.signal,
  });

  if (!(response.ok || response.status === 206) || !response.body) {
    throw new Error(`DOWNLOAD_FAILED:${asset.url}:${response.status}`);
  }

  const writer = await fileHandle.createWritable({ keepExistingData: startOffset > 0 });
  const reader = response.body.getReader();
  let position = startOffset;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (controller.signal.aborted) {
        throw new DOMException('Install cancelled', 'AbortError');
      }

      await writer.write({
        type: 'write',
        position,
        data: value,
      });
      position += value.byteLength;
      snapshot.currentAsset = asset.url;
      snapshot.assetRecords = snapshot.assetRecords.map((record) => (
        record.url === asset.url
          ? {
            ...record,
            status: 'downloading',
            attempts: (record.attempts || 0) + (position === value.byteLength ? 1 : 0),
            downloadedBytes: position,
            sizeBytes: remoteSize || record.sizeBytes,
            etag: remoteHead.etag,
            lastModified: remoteHead.lastModified,
          }
          : record
      ));
      snapshot.progress = buildProgress(snapshot.assetRecords);
      emit({
        type: 'storage.progress',
        taskId,
        downloadedBytes: snapshot.progress.downloadedBytes,
        totalBytes: snapshot.progress.totalBytes,
        artifactId: asset.type,
      });
      emit({
        type: 'storage.state',
        taskId,
        userState: snapshot.userState,
        systemState: snapshot.systemState,
        snapshot: clone(snapshot),
      });
    }
  } finally {
    await writer.close();
    reader.releaseLock();
  }

  const finalSize = await getFileSize(fileHandle);
  let observedSha256 = '';
  let integrityVerified = false;
  let verificationMethod = 'size-only';

  if (remoteSize !== null && finalSize !== remoteSize) {
    throw new Error(`SIZE_MISMATCH:${asset.url}:${remoteSize}:${finalSize}`);
  }

  if (integrityMode === 'full' && asset.sha256) {
    observedSha256 = await hashFileHandle(fileHandle);
    integrityVerified = observedSha256 === asset.sha256;
    verificationMethod = 'stream-sha256';
    if (!integrityVerified) {
      throw new Error(`HASH_MISMATCH:${asset.url}:${asset.sha256}:${observedSha256}`);
    }
  }

  snapshot.assetRecords = snapshot.assetRecords.map((record) => (
    record.url === asset.url
      ? {
        ...record,
        status: 'stored',
        verified: true,
        downloadedBytes: finalSize,
        observedSizeBytes: finalSize,
        observedSha256,
        integrityVerified,
        verificationMethod,
        etag: remoteHead.etag,
        lastModified: remoteHead.lastModified,
        errorCode: '',
        errorDetail: '',
      }
      : record
  ));
}

async function handleInstall(request) {
  const root = await getOpfsServiceRoot({ create: true });
  const plan = {
    ...request.plan,
    installId: request.plan.installId || buildInstallId(request.plan),
  };
  const integrityMode = request.integrityMode === 'full' ? 'full' : 'size-only';
  const controller = new AbortController();
  activeTasks.set(request.taskId, {
    controller,
    installId: plan.installId,
  });

  const assetRecords = plan.assets.map(createAssetRecord);
  const startedAt = Date.now();
  let snapshot = createSnapshot(plan, assetRecords, {
    userState: 'installing',
    systemState: 'checking-storage',
    integrityMode,
    startedAt,
  });
  await writeInstallState(root, plan.installId, snapshot, plan);
  emit({
    type: 'storage.state',
    taskId: request.taskId,
    userState: snapshot.userState,
    systemState: snapshot.systemState,
    snapshot: clone(snapshot),
  });

  try {
    const artifactsDir = await getInstallArtifactsDirectory(root, plan.installId, { create: true });
    snapshot = {
      ...snapshot,
      systemState: 'downloading-partial',
    };
    await writeInstallState(root, plan.installId, snapshot, plan);
    emit({
      type: 'storage.state',
      taskId: request.taskId,
      userState: snapshot.userState,
      systemState: snapshot.systemState,
      snapshot: clone(snapshot),
    });

    for (const asset of plan.assets) {
      await downloadAsset({
        taskId: request.taskId,
        asset,
        artifactsDir,
        snapshot,
        controller,
        integrityMode,
      });
      await writeInstallState(root, plan.installId, snapshot, plan);
    }

    snapshot = {
      ...snapshot,
      systemState: 'verifying-temp',
    };
    snapshot.progress = buildProgress(snapshot.assetRecords);
    await writeInstallState(root, plan.installId, snapshot, plan);

    const completedAt = Date.now();
    snapshot = {
      ...snapshot,
      state: 'installed',
      userState: 'installed',
      systemState: 'committed',
      ready: false,
      stored: true,
      loadable: false,
      verifiedAt: completedAt,
      completedAt,
      durationMs: completedAt - startedAt,
      progress: buildProgress(snapshot.assetRecords),
      missingRequired: [],
    };
    await writeInstallState(root, plan.installId, snapshot, plan);

    const { registryDir, data } = await readRegistry(root);
    const installs = Array.isArray(data.installs) ? data.installs.filter((item) => item.installId !== plan.installId) : [];
    installs.push({
      installId: plan.installId,
      modelId: plan.modelId,
      version: plan.version,
      runtimeId: normalizeRuntime(plan.runtime).id,
      runtimeVersion: normalizeRuntime(plan.runtime).version,
      userState: snapshot.userState,
      systemState: snapshot.systemState,
      stored: true,
      loadable: false,
      installedAt: completedAt,
      verifiedAt: completedAt,
      sizeBytes: snapshot.progress.totalBytes,
    });
    data.installs = installs;
    data.activeInstallIdByModel = {
      ...(data.activeInstallIdByModel || {}),
      [plan.modelId]: plan.installId,
    };
    await writeRegistry(registryDir, data);

    emit({
      type: 'storage.completed',
      taskId: request.taskId,
      installId: plan.installId,
      snapshot: clone(snapshot),
    });
    return snapshot;
  } catch (error) {
    const isAbort = error?.name === 'AbortError';
    const completedAt = Date.now();
    snapshot = {
      ...snapshot,
      state: isAbort ? 'cancelled' : 'failed',
      userState: isAbort ? 'cancelled' : 'failed',
      systemState: isAbort ? 'cancelled' : 'cleanup-pending',
      errorCode: isAbort ? 'INSTALL_CANCELLED' : 'INSTALL_DOWNLOAD_FAILED',
      errorDetail: error instanceof Error ? error.message : String(error),
      completedAt,
      durationMs: completedAt - startedAt,
      progress: buildProgress(snapshot.assetRecords),
    };
    await writeInstallState(root, plan.installId, snapshot, plan);
    emit({
      type: isAbort ? 'storage.cancelled' : 'storage.failed',
      taskId: request.taskId,
      ...(isAbort ? { reason: 'cancelled', snapshot: clone(snapshot) } : { error: createError(snapshot.errorCode, snapshot.errorCode, snapshot.errorDetail), snapshot: clone(snapshot) }),
    });
    if (isAbort) {
      return snapshot;
    }
    throw error;
  } finally {
    activeTasks.delete(request.taskId);
  }
}

async function handleCancel(request) {
  const activeTask = activeTasks.get(request.taskId);
  if (!activeTask) {
    return { cancelled: false };
  }

  activeTask.controller.abort();
  return { cancelled: true };
}

async function handleClear(request) {
  const root = await getOpfsServiceRoot({ create: true });
  const installId = request.installId;
  const installsDir = await root.getDirectoryHandle('installs', { create: true });
  await removeEntryIfExists(installsDir, encodePathSegment(installId), { recursive: true });

  const { registryDir, data } = await readRegistry(root);
  data.installs = (data.installs || []).filter((item) => item.installId !== installId);
  const activeInstallIdByModel = { ...(data.activeInstallIdByModel || {}) };
  for (const [modelId, activeInstallId] of Object.entries(activeInstallIdByModel)) {
    if (activeInstallId === installId) {
      delete activeInstallIdByModel[modelId];
    }
  }
  data.activeInstallIdByModel = activeInstallIdByModel;
  await writeRegistry(registryDir, data);
  return { cleared: true };
}

async function handleStatus() {
  const root = await getOpfsServiceRoot({ create: true });
  const { data } = await readRegistry(root);
  const installs = [];
  for (const item of data.installs || []) {
    const snapshot = await readInstallState(root, item.installId);
    if (snapshot) {
      installs.push(snapshot);
    }
  }
  return installs;
}

async function handleDiagnostics() {
  const root = await getOpfsServiceRoot({ create: true });
  const { data } = await readRegistry(root);
  return {
    storageBackend: 'opfs',
    installCount: Array.isArray(data.installs) ? data.installs.length : 0,
    activeInstallIdByModel: data.activeInstallIdByModel || {},
  };
}

self.addEventListener('message', async (event) => {
  const message = event.data;
  if (!message?.type || !message.requestId) {
    return;
  }

  try {
    switch (message.type) {
      case 'storage.install':
        respond(message.requestId, true, await handleInstall(message));
        return;
      case 'storage.cancel':
        respond(message.requestId, true, await handleCancel(message));
        return;
      case 'storage.clear':
        respond(message.requestId, true, await handleClear(message));
        return;
      case 'storage.status':
        respond(message.requestId, true, await handleStatus(message));
        return;
      case 'storage.diagnostics':
        respond(message.requestId, true, await handleDiagnostics(message));
        return;
      default:
        respond(message.requestId, false, createError('STORAGE_WORKER_UNKNOWN_REQUEST', message.type));
    }
  } catch (error) {
    respond(
      message.requestId,
      false,
      createError(
        error?.code || 'STORAGE_WORKER_FAILED',
        error instanceof Error ? error.message : String(error),
        error?.detail || '',
      ),
    );
  }
});
