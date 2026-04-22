function createWorker() {
  if (typeof Worker === 'undefined') {
    return null;
  }

  return new Worker(new URL('./inference-worker.js', import.meta.url), {
    type: 'module',
  });
}

export class InferenceWorkerClient {
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

    const error = new Error(message.error?.message || message.error?.code || 'INFERENCE_WORKER_ERROR');
    error.code = message.error?.code || 'INFERENCE_WORKER_ERROR';
    error.detail = message.error?.detail || '';
    pending.reject(error);
  }

  request(type, payload = {}) {
    if (!this.worker) {
      const error = new Error('INFERENCE_WORKER_UNAVAILABLE');
      error.code = 'INFERENCE_WORKER_UNAVAILABLE';
      return Promise.reject(error);
    }

    this.requestIdSeed += 1;
    const requestId = `inference:${this.requestIdSeed}`;

    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.postMessage({
        requestId,
        type,
        ...payload,
      });
    });
  }

  load(payload) {
    return this.request('inference.load', payload);
  }

  generate(payload) {
    return this.request('inference.generate', payload);
  }

  cancel(payload) {
    return this.request('inference.cancel', payload);
  }

  unload(payload) {
    return this.request('inference.unload', payload);
  }

  diagnostics(payload = {}) {
    return this.request('inference.diagnostics', payload);
  }
}

export default InferenceWorkerClient;
