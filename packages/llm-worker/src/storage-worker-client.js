function createWorker() {
  if (typeof Worker === 'undefined') {
    return null;
  }

  return new Worker(new URL('./storage-worker.js', import.meta.url), {
    type: 'module',
  });
}

export class StorageWorkerClient {
  constructor({ worker = createWorker() } = {}) {
    this.worker = worker;
    this.requestIdSeed = 0;
    this.pending = new Map();
    this.listeners = new Set();

    if (this.worker?.addEventListener) {
      this.worker.addEventListener('message', (event) => {
        this.handleMessage(event.data);
      });
    }
  }

  isAvailable() {
    return Boolean(this.worker);
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  handleMessage(message) {
    if (!message || typeof message !== 'object') {
      return;
    }

    if (message.kind === 'event') {
      for (const listener of this.listeners) {
        listener(message.event);
      }
      return;
    }

    if (message.kind !== 'response' || !message.requestId) {
      return;
    }

    const pending = this.pending.get(message.requestId);
    if (!pending) {
      return;
    }

    this.pending.delete(message.requestId);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }

    const error = new Error(message.error?.message || message.error?.code || 'STORAGE_WORKER_ERROR');
    error.code = message.error?.code || 'STORAGE_WORKER_ERROR';
    error.detail = message.error?.detail || '';
    pending.reject(error);
  }

  request(type, payload = {}) {
    if (!this.worker) {
      const error = new Error('STORAGE_WORKER_UNAVAILABLE');
      error.code = 'STORAGE_WORKER_UNAVAILABLE';
      return Promise.reject(error);
    }

    this.requestIdSeed += 1;
    const requestId = `storage:${this.requestIdSeed}`;
    const message = {
      requestId,
      type,
      ...payload,
    };

    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.postMessage(message);
    });
  }

  install(payload) {
    return this.request('storage.install', payload);
  }

  cancel(payload) {
    return this.request('storage.cancel', payload);
  }

  clear(payload) {
    return this.request('storage.clear', payload);
  }

  status(payload = {}) {
    return this.request('storage.status', payload);
  }

  diagnostics(payload = {}) {
    return this.request('storage.diagnostics', payload);
  }
}

export default StorageWorkerClient;
