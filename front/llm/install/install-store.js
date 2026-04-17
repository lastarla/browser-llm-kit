const INSTALL_STATE_STORAGE_PREFIX = 'llm-install-state';

function getStorage() {
  if (typeof localStorage === 'undefined') {
    return null;
  }
  return localStorage;
}

function buildStorageKey(modelId) {
  return `${INSTALL_STATE_STORAGE_PREFIX}:${modelId}`;
}

export class InstallStore {
  read(modelId) {
    const storage = getStorage();
    if (!storage) {
      return null;
    }

    const raw = storage.getItem(buildStorageKey(modelId));
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw);
    } catch {
      storage.removeItem(buildStorageKey(modelId));
      return null;
    }
  }

  write(modelId, snapshot) {
    const storage = getStorage();
    if (!storage) {
      return;
    }

    storage.setItem(buildStorageKey(modelId), JSON.stringify(snapshot));
  }

  clear(modelId) {
    const storage = getStorage();
    if (!storage) {
      return;
    }

    storage.removeItem(buildStorageKey(modelId));
  }
}
