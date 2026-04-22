function hasWorkerSupport() {
  return typeof Worker !== 'undefined';
}

function hasOpfsSupport() {
  return typeof navigator?.storage?.getDirectory === 'function';
}

function hasSecureContext() {
  return typeof window !== 'undefined' && window.isSecureContext === true;
}

function hasWebAssemblySupport() {
  return typeof WebAssembly === 'object';
}

function hasWebGpuSupport() {
  return typeof navigator?.gpu !== 'undefined';
}

function inferPlatformSupport() {
  if (typeof navigator === 'undefined') {
    return false;
  }

  const brands = Array.isArray(navigator.userAgentData?.brands)
    ? navigator.userAgentData.brands.map((item) => String(item.brand || '').toLowerCase())
    : [];
  const agent = String(navigator.userAgent || '').toLowerCase();
  return brands.some((brand) => brand.includes('chrom'))
    || agent.includes('chrome')
    || agent.includes('edg/');
}

export class CapabilityResolver {
  constructor({
    workerAvailable = hasWorkerSupport,
    opfsAvailable = hasOpfsSupport,
    secureContextAvailable = hasSecureContext,
    webAssemblyAvailable = hasWebAssemblySupport,
    webGpuAvailable = hasWebGpuSupport,
    platformSupported = inferPlatformSupport,
  } = {}) {
    this.probes = {
      workerAvailable,
      opfsAvailable,
      secureContextAvailable,
      webAssemblyAvailable,
      webGpuAvailable,
      platformSupported,
    };
  }

  resolve(modelDefinition, {
    storageClientAvailable = true,
    inferenceClientAvailable = true,
    allowMainThreadInference = false,
  } = {}) {
    const secureContext = this.probes.secureContextAvailable();
    const workerAvailable = this.probes.workerAvailable();
    const opfsAvailable = this.probes.opfsAvailable();
    const webAssemblyAvailable = this.probes.webAssemblyAvailable();
    const webGpuAvailable = this.probes.webGpuAvailable();
    const platformSupported = this.probes.platformSupported();
    const reasons = [];

    if (!secureContext) {
      reasons.push('insecure-context');
    }
    if (!platformSupported) {
      reasons.push('platform-unsupported');
    }
    if (!workerAvailable && !allowMainThreadInference) {
      reasons.push('worker-unavailable');
    }
    if (!storageClientAvailable) {
      reasons.push('storage-worker-unavailable');
    }
    if (!inferenceClientAvailable) {
      reasons.push('inference-worker-unavailable');
    }
    if (!opfsAvailable) {
      reasons.push('opfs-unavailable');
    }
    if (!webAssemblyAvailable) {
      reasons.push('webassembly-unavailable');
    }

    const runtimeId = String(modelDefinition?.runtime?.id || 'mediapipe').trim();
    const runtimeSupported = runtimeId === 'mediapipe'
      ? webAssemblyAvailable
      : (webAssemblyAvailable || webGpuAvailable);

    if (!runtimeSupported) {
      reasons.push('runtime-unavailable');
    }

    let compatibilityCode = '';
    if (!secureContext) {
      compatibilityCode = 'LLM_INSECURE_CONTEXT';
    } else if (!platformSupported) {
      compatibilityCode = 'LLM_BROWSER_UNSUPPORTED';
    } else if (!workerAvailable && !allowMainThreadInference) {
      compatibilityCode = 'LLM_WORKER_UNAVAILABLE';
    } else if (!opfsAvailable) {
      compatibilityCode = 'LLM_OPFS_UNAVAILABLE';
    } else if (!runtimeSupported) {
      compatibilityCode = 'LLM_RUNTIME_UNAVAILABLE';
    }

    return {
      eligible: reasons.length === 0,
      platformSupported,
      secureContext,
      workerAvailable,
      storageWorkerAvailable: Boolean(storageClientAvailable),
      inferenceWorkerAvailable: Boolean(inferenceClientAvailable),
      opfsAvailable,
      workerOpfsAvailable: opfsAvailable && workerAvailable && storageClientAvailable,
      webGpuAvailable,
      simdAvailable: true,
      webAssemblyAvailable,
      runtimeSupported,
      compatibilityCode,
      reasons,
    };
  }
}

export default CapabilityResolver;
