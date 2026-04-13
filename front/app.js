import LLM from './llm/index.js';
import buildStructuredRecordPrompt from '../prompt/structured-record-prompt.js';
import buildAchievedResultsPrompt, { buildDefaultAchievedResults } from '../prompt/achieved-results-prompt.js';

const WEB_LLM_MODEL = 'gemma4:e2b';
const DEFAULT_USER = {
  fullName: '未提供',
  position: '未提供',
  language: 'zh',
};

const elements = {
  list: document.querySelector('#test-list'),
  title: document.querySelector('#detail-title'),
  status: document.querySelector('#detail-status'),
  score: document.querySelector('#score-value'),
  reason: document.querySelector('#score-reason'),
  result: document.querySelector('#result-content'),
  expected: document.querySelector('#expected-content'),
  webLlmModal: document.querySelector('#web-llm-modal'),
  webLlmBackdrop: document.querySelector('#web-llm-backdrop'),
  webLlmClose: document.querySelector('#web-llm-close'),
  webLlmSubtitle: document.querySelector('#web-llm-subtitle'),
  webLlmModelStatus: document.querySelector('#web-llm-model-status'),
  webLlmProgressBar: document.querySelector('#web-llm-progress-bar'),
  webLlmResult: document.querySelector('#web-llm-result'),
  webLlmExpected: document.querySelector('#web-llm-expected'),
  webLlmResultStatus: document.querySelector('#web-llm-result-status'),
  webLlmScoreStatus: document.querySelector('#web-llm-score-status'),
  webLlmScoreValue: document.querySelector('#web-llm-score-value'),
  webLlmScoreReason: document.querySelector('#web-llm-score-reason'),
  webLlmScoreMeta: document.querySelector('#web-llm-score-meta'),
  webLlmAchieved: document.querySelector('#web-llm-achieved'),
  webLlmAchievedStatus: document.querySelector('#web-llm-achieved-status'),
  webLlmAchievedDebug: document.querySelector('#web-llm-achieved-debug'),
};

let tests = [];
let activeIndex = null;
let activeWebLlmIndex = null;
let webLlmRequestId = 0;
const listButtonMap = new Map();
const rerunningIndexes = new Set();
const llm = new LLM();
window.llm = llm;
let llmReadyPromise = null;
let webLlmTaskState = {
  structuredTaskId: null,
  achievedTaskId: null,
};

function getTestItem(index) {
  return tests.find((item) => item.index === index) || null;
}

function isItemRerunning(item) {
  return Boolean(item?.isRerunning) || rerunningIndexes.has(item?.index);
}

function isItemWebLlmActive(item) {
  return item?.index === activeWebLlmIndex;
}

function getScoreSummary(score) {
  if (!score) {
    return { value: '--', reason: '暂无评分' };
  }

  if (typeof score?.overall_score?.final_score === 'number') {
    return {
      value: String(score.overall_score.final_score),
      reason: score.overall_score.score_level_description || score.reason || '暂无原因',
    };
  }

  if (typeof score?.score === 'number') {
    return {
      value: String(score.score),
      reason: score.reason || '暂无原因',
    };
  }

  return { value: '--', reason: '暂无评分' };
}

function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
    return '展示完成';
  }

  if (ms < 1000) {
    return `耗时 ${ms}ms`;
  }

  return `耗时 ${(ms / 1000).toFixed(2)}s`;
}

function getItemStatus(item) {
  if (isItemRerunning(item)) {
    return '重测中';
  }

  if (item.hasResult && item.hasScore) {
    return '已完成';
  }

  if (item.hasResult) {
    return '待评分';
  }

  return '未生成';
}

function updateListButton(container, item) {
  const rerunning = isItemRerunning(item);

  container.className = `test-item${item.index === activeIndex ? ' active' : ''}`;
  container.querySelector('.test-badge').textContent = getItemStatus(item);

  const detailButton = container.querySelector('.test-detail-button');
  detailButton.setAttribute('aria-pressed', String(item.index === activeIndex));

  const webLlmButton = container.querySelector('.web-llm-button');
  webLlmButton.setAttribute('aria-pressed', String(isItemWebLlmActive(item)));
  webLlmButton.classList.toggle('active', isItemWebLlmActive(item));

  const redoButton = container.querySelector('.redo-button');
  redoButton.disabled = rerunning;
  redoButton.textContent = rerunning ? '重测中' : '重测';
}

function createListButton(item) {
  const container = document.createElement('div');
  const header = document.createElement('div');
  const detailButton = document.createElement('button');
  const name = document.createElement('span');
  const actions = document.createElement('div');
  const webLlmButton = document.createElement('button');
  const redoButton = document.createElement('button');
  const badge = document.createElement('span');

  container.className = 'test-item';
  header.className = 'test-item-header';
  detailButton.type = 'button';
  detailButton.className = 'test-detail-button';
  name.className = 'test-name';
  actions.className = 'test-item-actions';
  webLlmButton.type = 'button';
  webLlmButton.className = 'web-llm-button';
  redoButton.type = 'button';
  redoButton.className = 'redo-button';
  badge.className = 'test-badge';
  name.textContent = item.name;
  webLlmButton.textContent = 'Web LLM';
  redoButton.textContent = '重测';
  detailButton.append(name, badge);
  actions.append(webLlmButton, redoButton);
  header.append(detailButton, actions);
  container.append(header);
  detailButton.addEventListener('click', () => loadDetail(item.index));
  webLlmButton.addEventListener('click', async () => {
    await runWebLlm(item.index);
  });
  redoButton.addEventListener('click', async () => {
    await rerunTest(item.index);
  });

  updateListButton(container, item);
  return container;
}

function renderList() {
  const nextIndexes = new Set(tests.map((item) => item.index));

  for (const [index, button] of listButtonMap.entries()) {
    if (!nextIndexes.has(index)) {
      button.remove();
      listButtonMap.delete(index);
    }
  }

  tests.forEach((item, position) => {
    let button = listButtonMap.get(item.index);
    if (!button) {
      button = createListButton(item);
      listButtonMap.set(item.index, button);
    }

    updateListButton(button, item);
    const currentChild = elements.list.children[position];
    if (currentChild !== button) {
      elements.list.insertBefore(button, currentChild ?? null);
    }
  });
}

function updateTestSummary(index, detail) {
  const listItem = getTestItem(index);
  if (!listItem) {
    return;
  }

  listItem.hasResult = Boolean(detail.result && detail.result.trim());
  listItem.hasScore = Boolean(detail.score);
}

function setItemRerunning(index, value) {
  const listItem = getTestItem(index);
  if (listItem) {
    listItem.isRerunning = value;
  }

  if (value) {
    rerunningIndexes.add(index);
    return;
  }

  rerunningIndexes.delete(index);
}

function renderDetail(item) {
  const summary = getScoreSummary(item.score);
  elements.title.textContent = item.name || `样本 ${item.index}`;
  elements.status.textContent = formatDuration(item.generate_duration_ms);
  elements.score.textContent = summary.value;
  elements.reason.textContent = summary.reason;
  elements.result.textContent = item.result || '';
  elements.expected.textContent = item.expected_result || '';
}

function renderLoading(index) {
  const item = tests.find((test) => test.index === index);
  elements.title.textContent = item?.name || `样本 ${index}`;
  elements.status.textContent = '加载中，如缺少结果会自动生成、格式化并评分';
  elements.score.textContent = '--';
  elements.reason.textContent = '处理中';
  elements.result.textContent = '处理中...';
  elements.expected.textContent = '处理中...';
}

function renderError(message) {
  elements.status.textContent = '加载失败';
  elements.score.textContent = '--';
  elements.reason.textContent = message;
  elements.result.textContent = '';
  elements.expected.textContent = '';
}

function waitForNextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function setWebLlmModelStatus(text, progress = null) {
  elements.webLlmModelStatus.textContent = text;
  if (progress !== null) {
    elements.webLlmProgressBar.style.width = `${Math.max(0, Math.min(100, progress))}%`;
  }
}

function openWebLlmModal() {
  elements.webLlmModal.classList.remove('hidden');
  elements.webLlmModal.setAttribute('aria-hidden', 'false');
}

function closeWebLlmModal() {
  if (webLlmTaskState.structuredTaskId) {
    llm.cancelTask(webLlmTaskState.structuredTaskId);
  }
  if (webLlmTaskState.achievedTaskId) {
    llm.cancelTask(webLlmTaskState.achievedTaskId);
  }
  webLlmTaskState = {
    structuredTaskId: null,
    achievedTaskId: null,
  };
  elements.webLlmModal.classList.add('hidden');
  elements.webLlmModal.setAttribute('aria-hidden', 'true');
  activeWebLlmIndex = null;
  renderList();
}

function setWebLlmTaskStatus(kind, task) {
  if (!task) {
    return;
  }

  if (kind === 'result') {
    if (task.status === 'queued') {
      setWebLlmCardState('result', '排队中', '前一个任务未完成，当前结构化记录任务排队中...');
      return;
    }
    if (task.status === 'running') {
      setWebLlmCardState('result', '生成中', '正在根据原始语料生成结构化记录...');
      return;
    }
    if (task.status === 'cancelled') {
      setWebLlmCardState('result', '已取消', '结构化记录任务已取消');
      return;
    }
    if (task.status === 'failed' && task.error) {
      setWebLlmCardState('result', '失败', task.error);
    }
    return;
  }

  if (task.status === 'queued') {
    setWebLlmCardState('achieved', '排队中', '前一个任务未完成，当前达成结果任务排队中...');
    return;
  }
  if (task.status === 'running') {
    setWebLlmCardState('achieved', '生成中', '正在根据结构化记录生成达成结果核对列表...');
    return;
  }
  if (task.status === 'cancelled') {
    setWebLlmCardState('achieved', '已取消', '达成结果任务已取消');
    return;
  }
  if (task.status === 'failed' && task.error) {
    setWebLlmCardState('achieved', '失败', task.error);
  }
}

function setWebLlmCardState(kind, statusText, contentText) {
  if (kind === 'result') {
    elements.webLlmResultStatus.textContent = statusText;
    if (contentText !== undefined) {
      elements.webLlmResult.textContent = contentText;
    }
    return;
  }

  elements.webLlmAchievedStatus.textContent = statusText;
  if (contentText !== undefined) {
    elements.webLlmAchieved.textContent = contentText;
  }
}

function setWebLlmScoreState(statusText, scoreValue = '--', reasonText = '暂无评分', metaText = '模型：gpt-5.4（服务端）') {
  elements.webLlmScoreStatus.textContent = statusText;
  elements.webLlmScoreValue.textContent = scoreValue;
  elements.webLlmScoreReason.textContent = reasonText;
  elements.webLlmScoreMeta.textContent = metaText;
}

function setAchievedDebugInfo(debugInfo) {
  elements.webLlmAchievedDebug.textContent = typeof debugInfo === 'string'
    ? debugInfo
    : JSON.stringify(debugInfo, null, 2);
}

llm.onTaskUpdate((task) => {
  if (!task || activeWebLlmIndex === null) {
    return;
  }

  if (task.id === webLlmTaskState.structuredTaskId) {
    setWebLlmTaskStatus('result', task);
  }

  if (task.id === webLlmTaskState.achievedTaskId) {
    setWebLlmTaskStatus('achieved', task);
  }
});

function buildPromptPayload(detail) {
  return {
    currentDateTime: new Date().toLocaleString('zh-CN', { hour12: false }),
    fullName: detail.user?.fullName || DEFAULT_USER.fullName,
    position: detail.user?.position || DEFAULT_USER.position,
    language: detail.user?.language || DEFAULT_USER.language,
    corpus: detail.corpus || '',
    achievedResults: detail.achievedResults ?? buildDefaultAchievedResults(),
  };
}

function normalizeSectionText(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*`\-\d.、()（）:：\[\]【】]/g, ' ')
    .replace(/\s+/g, '')
    .trim();
}

function inferAchievedResultsFromStructuredRecord(structuredRecord, expectedFieldNames = []) {
  const normalizedRecord = normalizeSectionText(structuredRecord);
  if (!normalizedRecord || !Array.isArray(expectedFieldNames) || expectedFieldNames.length === 0) {
    return '';
  }

  const inferredResults = expectedFieldNames.map((fieldName) => {
    const normalizedFieldName = normalizeSectionText(fieldName);
    return {
      field_name: fieldName,
      checked: Boolean(normalizedFieldName) && normalizedRecord.includes(normalizedFieldName),
    };
  });

  if (!inferredResults.some((item) => item.checked)) {
    return '';
  }

  return JSON.stringify({ achieved_results: inferredResults }, null, 2);
}

function mergeAchievedResultsJson(extractedJson, inferredJson, expectedFieldNames = []) {
  if (!extractedJson) {
    return inferredJson;
  }

  if (!inferredJson) {
    return extractedJson;
  }

  try {
    const extracted = JSON.parse(extractedJson);
    const inferred = JSON.parse(inferredJson);
    const inferredMap = new Map(
      Array.isArray(inferred?.achieved_results)
        ? inferred.achieved_results.map((item) => [item?.field_name, Boolean(item?.checked)])
        : [],
    );
    const mergedResults = (Array.isArray(extracted?.achieved_results) ? extracted.achieved_results : [])
      .map((item) => ({
        field_name: item?.field_name,
        checked: Boolean(item?.checked) || inferredMap.get(item?.field_name) === true,
      }));

    if (mergedResults.length !== expectedFieldNames.length) {
      return extractedJson;
    }

    return JSON.stringify({ achieved_results: mergedResults }, null, 2);
  } catch {
    return extractedJson;
  }
}

function extractAchievedResultsJson(output, expectedFieldNames = []) {
  const normalizedOutput = String(output || '').trim();
  if (!normalizedOutput) {
    return '';
  }

  const marker = '===JSON_START===';
  const markerIndex = normalizedOutput.lastIndexOf(marker);
  const jsonSection = markerIndex >= 0
    ? normalizedOutput.slice(markerIndex + marker.length).trim()
    : normalizedOutput;

  const jsonMatch = jsonSection.match(/\{[\s\S]*"achieved_results"[\s\S]*\}/);
  const candidate = (jsonMatch ? jsonMatch[0] : jsonSection).trim();
  if (candidate.startsWith('{') && candidate.includes('"achieved_results"')) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed?.achieved_results)) {
        return JSON.stringify({ achieved_results: parsed.achieved_results }, null, 2);
      }
    } catch {
      // fallback to heuristic repair below
    }
  }

  if (!Array.isArray(expectedFieldNames) || expectedFieldNames.length === 0) {
    return '';
  }

  const entryPattern = /"field_name"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"[\s\S]{0,120}?"checked"\s*:\s*(true|false)/g;
  const repairedMap = new Map();
  let match;
  while ((match = entryPattern.exec(normalizedOutput)) !== null) {
    const fieldName = JSON.parse(`"${match[1]}"`);
    repairedMap.set(fieldName, match[2] === 'true');
  }

  if (repairedMap.size === 0) {
    return '';
  }

  const repairedResults = [];
  for (const fieldName of expectedFieldNames) {
    if (!repairedMap.has(fieldName)) {
      return '';
    }
    repairedResults.push({
      field_name: fieldName,
      checked: repairedMap.get(fieldName),
    });
  }

  return JSON.stringify({ achieved_results: repairedResults }, null, 2);
}

async function fetchTestDetail(index) {
  const response = await fetch(`/tests/${index}`);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || data.details || '获取详情失败');
  }

  updateTestSummary(index, data);
  renderList();
  return data;
}

async function fetchWebLlmScore(index, result) {
  const response = await fetch(`/tests/${index}/web-llm-score`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ result }),
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || data.details || '服务端评分失败');
  }

  return data;
}

async function ensureWebLlmReady() {
  if (llmReadyPromise) {
    return llmReadyPromise;
  }

  llm.onStatusChange(WEB_LLM_MODEL, (status) => {
    const progressMap = {
      '准备缓存': 10,
      '下载模型': 20,
      '初始化 WASM': 55,
      '创建推理实例': 85,
      '开始推理': 100,
    };
    const progress = typeof status === 'string' && status.startsWith('缓存不可用')
      ? 10
      : progressMap[status] ?? null;
    setWebLlmModelStatus(status, progress);
  });

  setWebLlmModelStatus('下载模型', 20);
  llmReadyPromise = llm.load(WEB_LLM_MODEL)
    .then((result) => {
      return result;
    })
    .catch((error) => {
      llmReadyPromise = null;
      setWebLlmModelStatus(error instanceof Error ? error.message : String(error));
      throw error;
    });

  return llmReadyPromise;
}

async function loadTests() {
  const response = await fetch('/tests');
  if (!response.ok) {
    throw new Error('获取测试列表失败');
  }

  tests = await response.json();
  renderList();

  if (tests.length > 0) {
    await loadDetail(tests[0].index);
  }
}

async function loadDetail(index) {
  activeIndex = index;
  renderList();
  renderLoading(index);

  try {
    const data = await fetchTestDetail(index);
    renderDetail(data);
  } catch (error) {
    renderError(error instanceof Error ? error.message : String(error));
  }
}

async function runWebLlm(index) {
  if (webLlmTaskState.structuredTaskId) {
    llm.cancelTask(webLlmTaskState.structuredTaskId);
  }
  if (webLlmTaskState.achievedTaskId) {
    llm.cancelTask(webLlmTaskState.achievedTaskId);
  }

  webLlmTaskState = {
    structuredTaskId: null,
    achievedTaskId: null,
  };
  activeWebLlmIndex = index;
  renderList();
  openWebLlmModal();

  const currentRequestId = ++webLlmRequestId;
  const listItem = getTestItem(index);
  elements.webLlmSubtitle.textContent = listItem?.name || `样本 ${index}`;
  setWebLlmScoreState('准备中', '--', '正在准备服务端评分...', '模型：gpt-5.4（服务端）');
  setWebLlmCardState('result', '准备中', '正在准备模型与样本数据...');
  elements.webLlmExpected.textContent = '正在加载预期结果...';
  setWebLlmCardState('achieved', '准备中', '正在准备模型与样本数据...');
  setAchievedDebugInfo('等待 achieved 调试信息...');

  try {
    await ensureWebLlmReady();
    const detail = await fetchTestDetail(index);
    if (currentRequestId !== webLlmRequestId) {
      return;
    }
    elements.webLlmExpected.textContent = detail.expected_result || '暂无预期结果';
    const payload = buildPromptPayload(detail);
    const structuredPrompt = buildStructuredRecordPrompt(payload);
    const expectedFieldNames = (Array.isArray(payload.achievedResults) ? payload.achievedResults : buildDefaultAchievedResults())
      .map((item) => item?.field_name)
      .filter(Boolean);

    setWebLlmModelStatus('开始推理', 100);
    const structuredTaskId = llm.submit({
      model: WEB_LLM_MODEL,
      query: structuredPrompt,
      options: {
        stream: true,
        callback: (text) => {
          if (currentRequestId !== webLlmRequestId || structuredTaskId !== webLlmTaskState.structuredTaskId) {
            return;
          }
          if (text) {
            setWebLlmCardState('result', '生成中', text);
          }
        },
      },
    });
    webLlmTaskState.structuredTaskId = structuredTaskId;
    const structuredTask = llm.getTask(structuredTaskId);
    if (structuredTask) {
      setWebLlmTaskStatus('result', structuredTask);
    }
    setWebLlmCardState('achieved', '等待中', '等待结构化记录生成完成后继续...');

    const structuredOutput = await llm.waitForTask(structuredTaskId);

    if (currentRequestId !== webLlmRequestId || structuredTaskId !== webLlmTaskState.structuredTaskId) {
      return;
    }

    setWebLlmCardState('result', '已完成', structuredOutput || '');
    const achievedPrompt = buildAchievedResultsPrompt({
      ...payload,
      structuredRecord: structuredOutput || '',
    });
    setWebLlmScoreState('生成中', '--', '正在将浏览器生成的结构化记录提交到服务端评分...', '模型：gpt-5.4（服务端）');

    const scorePromise = fetchWebLlmScore(index, structuredOutput || '')
      .then((scoreData) => {
        if (currentRequestId !== webLlmRequestId || structuredTaskId !== webLlmTaskState.structuredTaskId) {
          return;
        }
        const summary = getScoreSummary(scoreData.scorePayload || {
          score: scoreData.score,
          reason: scoreData.reason,
        });
        setWebLlmScoreState(
          '已完成',
          summary.value,
          summary.reason,
          `模型：${scoreData.model || 'gpt-5.4'}（服务端）`,
        );
      })
      .catch((error) => {
        if (currentRequestId !== webLlmRequestId || structuredTaskId !== webLlmTaskState.structuredTaskId) {
          return;
        }
        setWebLlmScoreState('失败', '--', error instanceof Error ? error.message : String(error));
      });

    const achievedTaskId = llm.submit({
      model: WEB_LLM_MODEL,
      query: achievedPrompt,
      options: {
        stream: true,
        callback: () => {
          if (currentRequestId !== webLlmRequestId || achievedTaskId !== webLlmTaskState.achievedTaskId) {
            return;
          }
          setWebLlmCardState('achieved', '生成中', '正在根据结构化记录生成达成结果核对列表...');
        },
      },
    });
    webLlmTaskState.achievedTaskId = achievedTaskId;
    const achievedTask = llm.getTask(achievedTaskId);
    if (achievedTask) {
      setWebLlmTaskStatus('achieved', achievedTask);
    }

    const achievedOutput = await llm.waitForTask(achievedTaskId);

    if (currentRequestId !== webLlmRequestId || achievedTaskId !== webLlmTaskState.achievedTaskId) {
      return;
    }

    const extractedJson = extractAchievedResultsJson(achievedOutput, expectedFieldNames);
    const inferredJson = inferAchievedResultsFromStructuredRecord(structuredOutput, expectedFieldNames);
    const mergedJson = mergeAchievedResultsJson(extractedJson, inferredJson, expectedFieldNames);
    const finalAchievedJson = mergedJson || extractedJson || inferredJson;
    const rawOutput = String(achievedOutput || '');
    const markerPresent = rawOutput.includes('===JSON_START===');
    const usedFallbackExtraction = Boolean(extractedJson) && !markerPresent;
    const usedStructuredInference = Boolean(inferredJson) && finalAchievedJson === inferredJson;
    const usedMergedCorrection = Boolean(mergedJson) && mergedJson !== extractedJson && mergedJson !== inferredJson;
    const debugInfo = {
      structuredPromptLength: structuredPrompt.length,
      achievedPromptLength: achievedPrompt.length,
      markerPresent,
      usedFallbackExtraction,
      usedStructuredInference,
      usedMergedCorrection,
      rawOutputPreview: rawOutput.slice(0, 1200),
      extracted: Boolean(extractedJson),
      inferred: Boolean(inferredJson),
      finalPath: usedStructuredInference
        ? 'structured_record_inference'
        : usedMergedCorrection
          ? 'merged_with_structured_record'
          : usedFallbackExtraction
            ? 'fallback_extraction'
            : extractedJson
              ? 'direct_json'
              : 'raw_output',
    };

    setAchievedDebugInfo(debugInfo);
    setWebLlmCardState(
      'achieved',
      usedStructuredInference
        ? '已完成（结构化记录兜底）'
        : usedMergedCorrection
          ? '已完成（结构化记录纠偏）'
          : usedFallbackExtraction
            ? '已完成（兜底提取）'
            : extractedJson
              ? '已完成'
              : '已返回原文',
      finalAchievedJson || rawOutput,
    );
    await scorePromise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (currentRequestId !== webLlmRequestId) {
      return;
    }
    setWebLlmScoreState('失败', '--', message);
    setWebLlmCardState('result', '失败', message);
    setWebLlmCardState('achieved', '失败', message);
  }
}

async function rerunTest(index) {
  if (isItemRerunning(getTestItem(index))) {
    return;
  }

  setItemRerunning(index, true);
  renderList();

  if (activeIndex === index) {
    renderLoading(index);
    elements.result.textContent = '';
    elements.score.textContent = '--';
    elements.reason.textContent = '重测中';
    elements.expected.textContent = getTestItem(index)?.expected_result || elements.expected.textContent;
    elements.status.textContent = '重跑中，将重新生成、格式化并评分';
    await waitForNextPaint();
  }

  try {
    const response = await fetch(`/tests/${index}/rerun`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || data.details || '重测失败');
    }

    setItemRerunning(index, false);
    await loadDetail(index);
  } catch (error) {
    setItemRerunning(index, false);
    renderList();
    if (activeIndex === index) {
      renderError(error instanceof Error ? error.message : String(error));
    }
  }
}

elements.webLlmClose.addEventListener('click', closeWebLlmModal);
elements.webLlmBackdrop.addEventListener('click', closeWebLlmModal);
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !elements.webLlmModal.classList.contains('hidden')) {
    closeWebLlmModal();
  }
});

loadTests().catch((error) => {
  renderError(error instanceof Error ? error.message : String(error));
});
