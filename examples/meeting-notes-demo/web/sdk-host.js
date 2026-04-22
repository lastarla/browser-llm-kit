import BrowserLLMService from '../../../packages/llm-browser/index.js';

const MODEL_ID = 'gemma4:e2b';

const elements = {
  refresh: document.querySelector('#sdk-refresh'),
  modelCount: document.querySelector('#sdk-model-count'),
  models: document.querySelector('#sdk-models'),
  eligibilityStatus: document.querySelector('#sdk-eligibility-status'),
  eligibility: document.querySelector('#sdk-eligibility'),
  modelStatusSummary: document.querySelector('#sdk-model-status-summary'),
  modelStatus: document.querySelector('#sdk-model-status'),
  diagnosticsStatus: document.querySelector('#sdk-diagnostics-status'),
  diagnostics: document.querySelector('#sdk-diagnostics'),
};

const service = new BrowserLLMService();
window.sdkHostService = service;

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

async function refreshSdkHostSnapshot() {
  elements.refresh.disabled = true;
  elements.refresh.textContent = '刷新中';
  try {
    const models = service.listModels();
    const eligibility = service.getEligibility({ modelId: MODEL_ID });
    const modelStatus = service.getModelStatus({ modelId: MODEL_ID });
    const diagnostics = await service.getDiagnostics();

    elements.modelCount.textContent = `${models.length} 个模型`;
    elements.models.textContent = formatJson(models);

    elements.eligibilityStatus.textContent = eligibility.eligible ? 'eligible' : (eligibility.compatibilityCode || 'ineligible');
    elements.eligibility.textContent = formatJson(eligibility);

    elements.modelStatusSummary.textContent = `${modelStatus.userState} / ready=${modelStatus.ready}`;
    elements.modelStatus.textContent = formatJson(modelStatus);

    elements.diagnosticsStatus.textContent = `models=${diagnostics.models.length}`;
    elements.diagnostics.textContent = formatJson(diagnostics);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    elements.modelCount.textContent = '失败';
    elements.models.textContent = message;
    elements.eligibilityStatus.textContent = '失败';
    elements.eligibility.textContent = message;
    elements.modelStatusSummary.textContent = '失败';
    elements.modelStatus.textContent = message;
    elements.diagnosticsStatus.textContent = '失败';
    elements.diagnostics.textContent = message;
  } finally {
    elements.refresh.disabled = false;
    elements.refresh.textContent = '刷新快照';
  }
}

elements.refresh.addEventListener('click', () => {
  refreshSdkHostSnapshot();
});

refreshSdkHostSnapshot();
