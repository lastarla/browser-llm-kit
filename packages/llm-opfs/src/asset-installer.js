import { formatInstallStateMessage } from '../../llm-core/src/diagnostics.js';
import { INSTALL_ERROR_CODES } from '../../llm-core/src/errors.js';
import { StorageWorkerClient } from '../../llm-worker/src/storage-worker-client.js';
import { createOpfsRuntimeFileset, resolvePreferredRuntimeAssets } from '../../llm-mediapipe/src/opfs-runtime-fileset.js';
import {
  buildInstallId,
  getArtifactFileName,
  getInstallArtifactsDirectory,
  getOpfsServiceRoot,
  normalizeRuntime,
} from './opfs-layout.js';

function cloneSnapshot(snapshot) {
  return {
    ...snapshot,
    progress: { ...(snapshot.progress || {}) },
    assetRecords: Array.isArray(snapshot.assetRecords) ? snapshot.assetRecords.map((item) => ({ ...item })) : [],
    missingRequired: Array.isArray(snapshot.missingRequired) ? [...snapshot.missingRequired] : [],
    cachedUrls: Array.isArray(snapshot.cachedUrls) ? [...snapshot.cachedUrls] : [],
  };
}

function createAssetRecord(asset) {
  return {
    url: asset.url,
    type: asset.type,
    required: Boolean(asset.required),
    installChannel: asset.installChannel,
    sizeBytes: typeof asset.sizeBytes === 'number' ? asset.sizeBytes : null,
    status: asset.installChannel === 'static-url' ? 'external' : 'pending',
    attempts: 0,
    verified: asset.installChannel === 'static-url',
    integrityVerified: false,
    verificationMethod: asset.installChannel === 'static-url' ? 'static-url' : '',
    downloadedBytes: asset.installChannel === 'static-url' ? (asset.sizeBytes || 0) : 0,
    observedSizeBytes: asset.installChannel === 'static-url' ? (asset.sizeBytes || null) : null,
    expectedSizeBytes: typeof asset.sizeBytes === 'number' ? asset.sizeBytes : null,
    observedSha256: '',
    expectedSha256: typeof asset.sha256 === 'string' ? asset.sha256 : '',
    errorCode: '',
    errorDetail: '',
    etag: '',
    lastModified: '',
  };
}

function reconcileAssetRecords(expectedAssets, persistedAssetRecords = []) {
  const persistedByUrl = new Map(
    (Array.isArray(persistedAssetRecords) ? persistedAssetRecords : []).map((record) => [record.url, record]),
  );

  return expectedAssets.map((asset) => {
    const persisted = persistedByUrl.get(asset.url);
    const base = createAssetRecord(asset);
    if (!persisted) {
      return base;
    }

    return {
      ...base,
      ...persisted,
      url: asset.url,
      type: asset.type,
      required: Boolean(asset.required),
      installChannel: asset.installChannel,
      sizeBytes: typeof asset.sizeBytes === 'number' ? asset.sizeBytes : persisted.sizeBytes ?? null,
      expectedSizeBytes: typeof asset.sizeBytes === 'number' ? asset.sizeBytes : persisted.expectedSizeBytes ?? null,
      expectedSha256: typeof asset.sha256 === 'string' ? asset.sha256 : persisted.expectedSha256 ?? '',
    };
  });
}

function collectMissingRequired(opfsAssets, assetRecords) {
  const recordByUrl = new Map(assetRecords.map((record) => [record.url, record]));
  return opfsAssets
    .filter((asset) => asset.required && !recordByUrl.get(asset.url)?.verified)
    .map((asset) => asset.url);
}

function buildProgress(assetRecords) {
  const totalFiles = assetRecords.length;
  const completedFiles = assetRecords.filter((record) => record.verified || record.status === 'external').length;
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

function createInitialSnapshot(modelId, manifest, persisted = null) {
  const opfsAssets = manifest.assets.filter((asset) => asset.installChannel === 'opfs');
  const assetRecords = opfsAssets.map(createAssetRecord);
  const runtime = normalizeRuntime(manifest.runtime);
  const snapshot = {
    modelId,
    version: manifest.version,
    runtime: runtime.label,
    installId: buildInstallId({
      modelId,
      version: manifest.version,
      runtime: manifest.runtime,
    }),
    manifestVersion: manifest.version,
    state: 'absent',
    userState: 'absent',
    systemState: 'idle',
    ready: false,
    stored: false,
    loadable: false,
    storageBackend: 'opfs',
    errorCode: '',
    errorDetail: '',
    currentAsset: '',
    retryCount: 0,
    startedAt: 0,
    completedAt: 0,
    durationMs: 0,
    verifiedAt: 0,
    integrityMode: 'size-only',
    assetRecords,
    progress: buildProgress(assetRecords),
    missingRequired: opfsAssets.filter((asset) => asset.required).map((asset) => asset.url),
    cachedUrls: [],
    updatedAt: Date.now(),
  };

  if (!persisted) {
    snapshot.statusText = formatInstallStateMessage(snapshot);
    return snapshot;
  }

  const persistedState = persisted.state || persisted.userState || 'absent';
  const reconciledAssetRecords = reconcileAssetRecords(opfsAssets, persisted.assetRecords);
  const missingRequired = collectMissingRequired(opfsAssets, reconciledAssetRecords);
  const invalidInstalledSnapshot = (
    missingRequired.length > 0
    && (persistedState === 'installed' || persisted.stored === true || persisted.ready === true)
  );
  const hydrated = {
    ...snapshot,
    ...persisted,
    state: invalidInstalledSnapshot ? 'absent' : persistedState,
    userState: invalidInstalledSnapshot ? 'absent' : (persisted.userState || persistedState),
    systemState: invalidInstalledSnapshot ? 'upgrade-required' : (persisted.systemState || snapshot.systemState),
    stored: invalidInstalledSnapshot ? false : Boolean(persisted.stored),
    ready: false,
    loadable: false,
    assetRecords: reconciledAssetRecords,
    missingRequired,
  };
  hydrated.progress = buildProgress(hydrated.assetRecords);
  hydrated.statusText = formatInstallStateMessage(hydrated);
  return hydrated;
}

function isSecureInstallContext() {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.isSecureContext === true;
}

function getRequiredInstallBytes(plan) {
  const requiredBytes = (plan?.assets || []).reduce((sum, asset) => (
    sum + (typeof asset.sizeBytes === 'number' ? asset.sizeBytes : 0)
  ), 0);
  return Math.ceil(requiredBytes * 1.2);
}

export class AssetInstaller {
  constructor({
    modelRegistry,
    storageClient = new StorageWorkerClient(),
    integrityMode = 'size-only',
    preferredRuntimeAssetResolver = resolvePreferredRuntimeAssets,
  }) {
    this.modelRegistry = modelRegistry;
    this.storageClient = storageClient;
    this.integrityMode = integrityMode === 'full' ? 'full' : 'size-only';
    this.preferredRuntimeAssetResolver = preferredRuntimeAssetResolver;
    this.listeners = new Map();
    this.pendingInstalls = new Map();
    this.stateByModel = new Map();
    this.objectUrls = new Map();
    this.taskToModel = new Map();

    for (const modelId of this.modelRegistry.listModelIds()) {
      this.stateByModel.set(modelId, createInitialSnapshot(modelId, this.modelRegistry.getModel(modelId)));
    }

    this.storageClient.onEvent?.((event) => {
      this.handleWorkerEvent(event);
    });
    this.hydrateStates();
  }

  async hydrateStates() {
    if (!this.storageClient.isAvailable()) {
      return;
    }

    try {
      const snapshots = await this.storageClient.status();
      for (const snapshot of snapshots) {
        if (this.stateByModel.has(snapshot.modelId)) {
          this.stateByModel.set(
            snapshot.modelId,
            createInitialSnapshot(snapshot.modelId, this.modelRegistry.getModel(snapshot.modelId), snapshot),
          );
        }
      }
    } catch {
      // Ignore hydration failures and keep in-memory defaults.
    }
  }

  handleWorkerEvent(event) {
    if (!event || typeof event !== 'object') {
      return;
    }

    const modelId = this.taskToModel.get(event.taskId);
    if (!modelId) {
      return;
    }

    if (event.snapshot) {
      this.emitState(modelId, event.snapshot);
      return;
    }

    const current = this.getState(modelId);
    if (event.type === 'storage.progress') {
      this.emitState(modelId, {
        ...current,
        progress: {
          ...current.progress,
          downloadedBytes: event.downloadedBytes,
          totalBytes: event.totalBytes,
          percent: typeof event.totalBytes === 'number' && event.totalBytes > 0
            ? Math.round((event.downloadedBytes / event.totalBytes) * 100)
            : current.progress.percent,
        },
      });
    }
  }

  setIntegrityMode(mode) {
    this.integrityMode = mode === 'full' ? 'full' : 'size-only';
  }

  getIntegrityMode() {
    return this.integrityMode;
  }

  getState(modelId) {
    const snapshot = this.stateByModel.get(modelId);
    if (!snapshot) {
      return createInitialSnapshot(modelId, this.modelRegistry.getModel(modelId));
    }
    const cloned = cloneSnapshot(snapshot);
    cloned.statusText = formatInstallStateMessage(cloned);
    return cloned;
  }

  isInstallBusy(modelId) {
    const snapshot = this.stateByModel.get(modelId);
    return this.pendingInstalls.has(modelId) || snapshot?.userState === 'installing';
  }

  emitState(modelId, partialSnapshot) {
    const manifest = this.modelRegistry.getModel(modelId);
    const current = this.stateByModel.get(modelId) || createInitialSnapshot(modelId, manifest);
    const next = {
      ...current,
      ...partialSnapshot,
      assetRecords: Array.isArray(partialSnapshot?.assetRecords)
        ? partialSnapshot.assetRecords.map((item) => ({ ...item }))
        : current.assetRecords,
      progress: partialSnapshot?.progress ? { ...partialSnapshot.progress } : buildProgress(current.assetRecords),
      updatedAt: Date.now(),
    };
    next.statusText = formatInstallStateMessage(next);
    this.stateByModel.set(modelId, next);

    for (const listener of this.listeners.get(modelId) || []) {
      listener(this.getState(modelId));
    }

    return this.getState(modelId);
  }

  onStateChange(modelId, listener) {
    const listeners = this.listeners.get(modelId) || new Set();
    listeners.add(listener);
    this.listeners.set(modelId, listeners);
    listener(this.getState(modelId));

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(modelId);
      }
    };
  }

  buildEligibilityErrorSnapshot(modelId, errorCode, errorDetail = '') {
    return this.emitState(modelId, {
      state: 'failed',
      userState: 'failed',
      systemState: 'idle',
      ready: false,
      stored: false,
      errorCode,
      errorDetail,
    });
  }

  assertInstallEnvironment(modelId) {
    if (typeof window === 'undefined') {
      return this.buildEligibilityErrorSnapshot(modelId, INSTALL_ERROR_CODES.BROWSER_UNSUPPORTED);
    }

    if (!isSecureInstallContext()) {
      return this.buildEligibilityErrorSnapshot(
        modelId,
        INSTALL_ERROR_CODES.INSECURE_CONTEXT,
        `INSECURE_CONTEXT:${window.location.href}`,
      );
    }

    if (typeof navigator?.storage?.getDirectory !== 'function') {
      return this.buildEligibilityErrorSnapshot(modelId, INSTALL_ERROR_CODES.OPFS_UNAVAILABLE);
    }

    if (!this.storageClient.isAvailable()) {
      return this.buildEligibilityErrorSnapshot(modelId, INSTALL_ERROR_CODES.WORKER_UNAVAILABLE);
    }

    return null;
  }

  async ensureStorageBudget(modelId, plan) {
    const estimate = await navigator?.storage?.estimate?.();
    const currentSnapshot = this.getState(modelId);
    const persistedBytes = Number(currentSnapshot?.progress?.downloadedBytes) || 0;
    const requiredBytes = Math.max(0, getRequiredInstallBytes(plan) - persistedBytes);
    const quota = Number(estimate?.quota);
    const usage = Number(estimate?.usage);

    if (Number.isFinite(quota) && Number.isFinite(usage)) {
      const availableBytes = Math.max(0, quota - usage);
      if (availableBytes < requiredBytes) {
        return this.buildEligibilityErrorSnapshot(
          modelId,
          INSTALL_ERROR_CODES.STORAGE_QUOTA_INSUFFICIENT,
          `AVAILABLE_BYTES:${availableBytes};REQUIRED_BYTES:${requiredBytes}`,
        );
      }
    }

    try {
      await navigator?.storage?.persist?.();
    } catch {
      // Persistence is best-effort. Install can continue even if the request fails.
    }

    return null;
  }

  async install(modelId, options = {}) {
    const current = this.getState(modelId);
    if (current.stored && !options.force) {
      return current;
    }

    const existing = this.pendingInstalls.get(modelId);
    if (existing && !options.force) {
      return existing;
    }

    const installPromise = this.runInstall(modelId, options)
      .finally(() => {
        if (this.pendingInstalls.get(modelId) === installPromise) {
          this.pendingInstalls.delete(modelId);
        }
      });
    this.pendingInstalls.set(modelId, installPromise);
    return installPromise;
  }

  async runInstall(modelId, options = {}) {
    const environmentFailure = this.assertInstallEnvironment(modelId);
    if (environmentFailure) {
      return environmentFailure;
    }

    const manifest = this.modelRegistry.getModel(modelId);
    const basePlan = this.modelRegistry.buildInstallPlan(modelId);
    const preferredRuntimeAssets = await this.preferredRuntimeAssetResolver(manifest);
    const plan = {
      ...basePlan,
      assets: basePlan.assets
        .filter((asset) => asset.type !== 'runtime')
        .concat(Array.isArray(preferredRuntimeAssets) ? preferredRuntimeAssets : []),
    };
    const storageBudgetFailure = await this.ensureStorageBudget(modelId, plan);
    if (storageBudgetFailure) {
      return storageBudgetFailure;
    }
    const taskId = `${modelId}:${Date.now()}`;
    this.taskToModel.set(taskId, modelId);

    const retryCount = Number.isInteger(options.retryCount) ? options.retryCount : this.getState(modelId).retryCount;
    this.emitState(modelId, {
      ...createInitialSnapshot(modelId, manifest),
      state: 'installing',
      userState: 'installing',
      systemState: 'checking-storage',
      retryCount,
      integrityMode: options.integrityMode || this.integrityMode,
      startedAt: Date.now(),
    });

    try {
      const snapshot = await this.storageClient.install({
        taskId,
        plan,
        integrityMode: options.integrityMode || this.integrityMode,
      });
      return this.emitState(modelId, snapshot);
    } catch (error) {
      return this.emitState(modelId, {
        state: 'failed',
        userState: 'failed',
        systemState: 'idle',
        ready: false,
        stored: false,
        errorCode: error?.code || INSTALL_ERROR_CODES.NETWORK_ERROR,
        errorDetail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.taskToModel.delete(taskId);
    }
  }

  async retryInstall(modelId) {
    return this.install(modelId, {
      force: true,
      retryCount: this.getState(modelId).retryCount + 1,
      integrityMode: this.integrityMode,
    });
  }

  async cancelInstall(modelId) {
    for (const [taskId, taskModelId] of this.taskToModel.entries()) {
      if (taskModelId === modelId) {
        await this.storageClient.cancel({ taskId });
        this.emitState(modelId, {
          state: 'cancelled',
          userState: 'cancelled',
          systemState: 'cancelled',
          ready: false,
          stored: false,
          errorCode: INSTALL_ERROR_CODES.CANCELLED,
        });
        return true;
      }
    }
    return false;
  }

  async clearModel(modelId) {
    const snapshot = this.getState(modelId);
    const manifest = this.modelRegistry.getModel(modelId);
    const installId = snapshot.installId || buildInstallId({
      modelId: manifest.modelId,
      version: manifest.version,
      runtime: manifest.runtime,
    });

    try {
      if (installId) {
        await this.storageClient.clear({ installId });
      }
      await this.revokeModelObjectUrl(modelId);
      const resetSnapshot = createInitialSnapshot(modelId, this.modelRegistry.getModel(modelId));
      this.stateByModel.set(modelId, resetSnapshot);
      this.emitState(modelId, resetSnapshot);
      return true;
    } catch (error) {
      this.emitState(modelId, {
        ...snapshot,
        state: 'failed',
        userState: 'failed',
        errorCode: INSTALL_ERROR_CODES.CLEAR_FAILED,
        errorDetail: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  getDiagnostics(modelId) {
    const snapshot = this.getState(modelId);
    const manifest = this.modelRegistry.getModel(modelId);
    return {
      install: snapshot,
      manifest: {
        modelId: manifest.modelId,
        version: manifest.version,
        runtime: normalizeRuntime(manifest.runtime).label,
        requiredAssets: manifest.assets
          .filter((asset) => asset.required)
          .map((asset) => ({
            url: asset.url,
            type: asset.type,
            installChannel: asset.installChannel,
            sizeBytes: typeof asset.sizeBytes === 'number' ? asset.sizeBytes : null,
          })),
      },
    };
  }

  async revokeModelObjectUrl(modelId) {
    const current = this.objectUrls.get(modelId);
    if (current) {
      URL.revokeObjectURL(current.url);
      this.objectUrls.delete(modelId);
    }
  }

  async createModelObjectUrl(modelId) {
    const manifest = this.modelRegistry.getModel(modelId);
    const snapshot = this.getState(modelId);
    if (!snapshot.stored) {
      throw new Error(`MODEL_NOT_STORED:${modelId}`);
    }

    const modelAsset = manifest.assets.find((asset) => asset.type === 'model');
    if (!modelAsset) {
      throw new Error(`MODEL_ASSET_MISSING:${modelId}`);
    }

    await this.revokeModelObjectUrl(modelId);

    const root = await getOpfsServiceRoot({ create: true });
    const artifactsDir = await getInstallArtifactsDirectory(root, snapshot.installId, { create: false });
    const fileHandle = await artifactsDir.getFileHandle(getArtifactFileName(modelAsset), { create: false });
    const file = await fileHandle.getFile();
    const url = URL.createObjectURL(file);
    this.objectUrls.set(modelId, {
      installId: snapshot.installId,
      url,
    });
    return url;
  }

  async createRuntimeFileset({
    modelId,
    definition = null,
    installState = null,
  } = {}) {
    const resolvedModelId = modelId || definition?.modelId;
    if (!resolvedModelId) {
      throw new Error('MODEL_ID_REQUIRED');
    }

    return createOpfsRuntimeFileset({
      definition: definition || this.modelRegistry.getModel(resolvedModelId),
      installState: installState || this.getState(resolvedModelId),
    });
  }
}

export default AssetInstaller;
