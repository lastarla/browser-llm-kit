import LLM from './llm/index.js';
import { buildAssetCacheName } from './llm/asset-cache.js';
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
  sidebarInstallStatus: document.querySelector('#sidebar-install-status'),
  sidebarInstallText: document.querySelector('#sidebar-install-text'),
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
  webLlmCacheSummary: document.querySelector('#web-llm-cache-summary'),
  webLlmCacheRefresh: document.querySelector('#web-llm-cache-refresh'),
  webLlmDiagnosticsToggle: document.querySelector('#web-llm-diagnostics-toggle'),
  webLlmDiagnosticsPanel: document.querySelector('#web-llm-diagnostics-panel'),
  webLlmCacheDetails: document.querySelector('#web-llm-cache-details'),
  webLlmInstallFacts: document.querySelector('#web-llm-install-facts'),
  webLlmAssetList: document.querySelector('#web-llm-asset-list'),
  webLlmProgressBar: document.querySelector('#web-llm-progress-bar'),
  webLlmInstallHint: document.querySelector('#web-llm-install-hint'),
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
let releaseInstallStateListener = null;
let webLlmDebugRefreshTimer = null;
let webLlmDiagnosticsExpanded = false;
let latestInstallSnapshot = null;
let installTelemetry = createInstallTelemetry();
let webLlmTaskState = {
  structuredTaskId: null,
  achievedTaskId: null,
};

ensureWebLlmInstallListeners();

function createInstallTelemetry() {
  return {
    startedAt: 0,
    lastBytes: null,
    lastTimestamp: 0,
    smoothedBytesPerSecond: null,
  };
}

function resetInstallTelemetry(snapshot = null) {
  installTelemetry = createInstallTelemetry();
  if (snapshot?.startedAt) {
    installTelemetry.startedAt = snapshot.startedAt;
  }
}

function updateInstallTelemetry(snapshot) {
  if (!snapshot) {
    return;
  }

  if (snapshot.startedAt !== installTelemetry.startedAt) {
    resetInstallTelemetry(snapshot);
  }

  const now = Date.now();
  const downloadedBytes = typeof snapshot.progress?.downloadedBytes === 'number'
    ? snapshot.progress.downloadedBytes
    : null;

  if (typeof downloadedBytes === 'number' && downloadedBytes >= 0) {
    if (typeof installTelemetry.lastBytes === 'number' && installTelemetry.lastTimestamp > 0) {
      const deltaBytes = downloadedBytes - installTelemetry.lastBytes;
      const deltaMs = now - installTelemetry.lastTimestamp;
      if (deltaBytes > 0 && deltaMs > 0) {
        const instantRate = deltaBytes / (deltaMs / 1000);
        installTelemetry.smoothedBytesPerSecond = installTelemetry.smoothedBytesPerSecond === null
          ? instantRate
          : (installTelemetry.smoothedBytesPerSecond * 0.7) + (instantRate * 0.3);
      }
    }

    installTelemetry.lastBytes = downloadedBytes;
    installTelemetry.lastTimestamp = now;
  }
}

function ensureWebLlmInstallListeners() {
  if (!releaseInstallStateListener) {
    releaseInstallStateListener = llm.onInstallStateChange(WEB_LLM_MODEL, (snapshot) => {
      applyWebLlmInstallState(snapshot);
      scheduleWebLlmCacheDebugRefresh(50);
    });
  }

  llm.onStatusChange(WEB_LLM_MODEL, (status) => {
    const progressMap = {
      '准备缓存': 10,
      '下载模型': 20,
      '初始化 WASM': 55,
      '创建推理实例': 85,
      '开始推理': 100,
    };
    const installProgress = typeof latestInstallSnapshot?.progress?.percent === 'number'
      ? latestInstallSnapshot.progress.percent
      : null;
    const mappedProgress = typeof status === 'string' && status.startsWith('缓存不可用')
      ? 10
      : progressMap[status] ?? null;
    const progress = mappedProgress !== null && installProgress !== null
      ? Math.max(mappedProgress, installProgress)
      : mappedProgress;
    setWebLlmModelStatus(status, progress);
  });
}

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

function setSidebarInstallStatus(snapshot) {
  if (!snapshot) {
    elements.sidebarInstallStatus.classList.add('hidden');
    return;
  }

  const shouldShow = isInstallInFlight(snapshot)
    || snapshot.state === 'partial'
    || snapshot.state === 'failed';

  if (!shouldShow) {
    elements.sidebarInstallStatus.classList.add('hidden');
    return;
  }

  const summary = getInstallProgressSummary(snapshot);
  const currentAsset = snapshot.currentAsset ? formatCurrentAssetLabel(snapshot.currentAsset) : '';
  const text = [
    snapshot.statusText || '等待安装',
    isInstallInFlight(snapshot) ? summary.combinedText : '',
    currentAsset,
  ].filter(Boolean).join(' | ');

  elements.sidebarInstallText.textContent = text;
  elements.sidebarInstallStatus.classList.remove('hidden');
}

function setWebLlmModelStatus(text, progress = null) {
  elements.webLlmModelStatus.textContent = text;
  if (progress !== null) {
    elements.webLlmProgressBar.style.width = `${Math.max(0, Math.min(100, progress))}%`;
  }
  elements.webLlmInstallHint.textContent = formatInstallHint(latestInstallSnapshot);
}

function setWebLlmCacheDebug(summaryText, detailText) {
  elements.webLlmCacheSummary.textContent = summaryText;
  elements.webLlmCacheDetails.textContent = detailText;
}

function setWebLlmDiagnosticsExpanded(expanded) {
  webLlmDiagnosticsExpanded = Boolean(expanded);
  elements.webLlmDiagnosticsPanel.classList.toggle('is-collapsed', !webLlmDiagnosticsExpanded);
  elements.webLlmDiagnosticsToggle.textContent = webLlmDiagnosticsExpanded ? '收起诊断' : '展开诊断';
  elements.webLlmDiagnosticsToggle.setAttribute('aria-expanded', String(webLlmDiagnosticsExpanded));
}

function renderWebLlmInstallFacts(facts = []) {
  elements.webLlmInstallFacts.replaceChildren();

  for (const fact of facts) {
    const card = document.createElement('div');
    const label = document.createElement('div');
    const value = document.createElement('div');
    card.className = 'web-llm-fact-card';
    label.className = 'label';
    value.className = 'web-llm-fact-value';
    label.textContent = fact.label;
    value.textContent = fact.value;
    card.append(label, value);
    elements.webLlmInstallFacts.append(card);
  }
}

function renderWebLlmAssetList(assetRows = []) {
  elements.webLlmAssetList.replaceChildren();

  if (!assetRows.length) {
    const empty = document.createElement('div');
    empty.className = 'web-llm-asset-empty';
    empty.textContent = '等待安装诊断...';
    elements.webLlmAssetList.append(empty);
    return;
  }

  for (const rowData of assetRows) {
    const row = document.createElement('div');
    row.className = `web-llm-asset-row${rowData.failed ? ' is-failed' : ''}`;

    const path = document.createElement('div');
    path.className = 'web-llm-asset-path';
    path.textContent = rowData.path;

    const status = document.createElement('div');
    status.className = 'web-llm-asset-meta';
    status.textContent = `状态 ${rowData.status}`;

    const verify = document.createElement('div');
    verify.className = 'web-llm-asset-meta';
    verify.textContent = `校验 ${rowData.verificationMethod}`;

    const bytes = document.createElement('div');
    bytes.className = 'web-llm-asset-meta';
    bytes.textContent = `大小 ${rowData.sizeText}`;

    const attempts = document.createElement('div');
    attempts.className = 'web-llm-asset-meta';
    attempts.textContent = `尝试 ${rowData.attempts}`;

    const extra = document.createElement('div');
    extra.className = 'web-llm-asset-meta';
    extra.textContent = rowData.extra;

    row.append(path, status, verify, bytes, attempts, extra);
    elements.webLlmAssetList.append(row);
  }
}

function formatByteCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return '--';
  }

  if (value < 1024) {
    return `${value} B`;
  }

  const units = ['KiB', 'MiB', 'GiB'];
  let nextValue = value / 1024;
  let unitIndex = 0;
  while (nextValue >= 1024 && unitIndex < units.length - 1) {
    nextValue /= 1024;
    unitIndex += 1;
  }
  return `${nextValue.toFixed(nextValue >= 100 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatTransferRate(bytesPerSecond) {
  if (typeof bytesPerSecond !== 'number' || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return '--';
  }

  return `${formatByteCount(bytesPerSecond)}/s`;
}

function formatElapsedDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
    return '--';
  }
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  return `${(ms / 1000).toFixed(2)} s`;
}

function formatEta(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
    return '--';
  }

  const totalSeconds = Math.ceil(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds} 秒`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return `${minutes} 分 ${seconds} 秒`;
  }

  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return `${hours} 小时 ${remainMinutes} 分`;
}

function formatAssetDebugPath(url) {
  try {
    return new URL(url, window.location.href).pathname;
  } catch {
    return String(url || '');
  }
}

function formatCurrentAssetLabel(url) {
  const path = formatAssetDebugPath(url);
  if (!path) {
    return '等待调度';
  }

  const fileName = path.split('/').filter(Boolean).pop() || path;
  if (fileName.endsWith('.task')) {
    return `正在下载模型主文件 ${fileName}`;
  }

  return `正在下载 ${fileName}`;
}

function formatInstallHint(snapshot) {
  if (!snapshot) {
    return '提示：关闭当前浮层不会中断后台下载。';
  }

  if (snapshot.state === 'ready' || snapshot.ready) {
    return '提示：本地模型已就绪，后续样本会直接复用缓存。';
  }

  if (snapshot.state === 'control_waiting') {
    return '提示：当前页面尚未被 Service Worker 控制。关闭浮层不会中断下载；刷新页面后才能完成离线安装。';
  }

  if (snapshot.state === 'downloading_model') {
    return '提示：关闭当前浮层不会中断后台下载；如果关闭标签页、浏览器或网络/网关中断，未完成文件会重新下载。';
  }

  if (snapshot.state === 'verifying') {
    return '提示：文件已下载完成，正在校验和初始化。当前实现不支持断点续传。';
  }

  if (snapshot.state === 'failed' && ['INSTALL_NETWORK_ERROR', 'INSTALL_ASSET_MISSING'].includes(snapshot.errorCode)) {
    return '提示：下载已中断。当前实现不支持断点续传，重试会重新下载未完成文件。';
  }

  if (snapshot.state === 'partial' && snapshot.errorCode === 'INSTALL_CONTROL_REQUIRED') {
    return '提示：已完成基础下载，但需要刷新页面后才能完成离线安装。';
  }

  return '提示：关闭当前浮层不会中断后台下载。';
}

function isInstallInFlight(snapshot) {
  return ['env_checking', 'control_waiting', 'downloading_model', 'verifying'].includes(snapshot?.state);
}

function getInstallTransferMetrics(snapshot) {
  const downloadedBytes = snapshot?.progress?.downloadedBytes;
  const totalBytes = snapshot?.progress?.totalBytes;
  const elapsedMs = snapshot?.startedAt ? Math.max(0, Date.now() - snapshot.startedAt) : 0;
  const averageRate = typeof downloadedBytes === 'number' && downloadedBytes > 0 && elapsedMs > 0
    ? downloadedBytes / (elapsedMs / 1000)
    : null;
  const bytesPerSecond = installTelemetry.smoothedBytesPerSecond || averageRate;
  const remainingBytes = typeof totalBytes === 'number' && typeof downloadedBytes === 'number'
    ? Math.max(0, totalBytes - downloadedBytes)
    : null;
  const etaMs = bytesPerSecond && remainingBytes !== null
    ? (remainingBytes / bytesPerSecond) * 1000
    : null;

  return {
    downloadedBytes,
    totalBytes,
    bytesPerSecond,
    etaMs,
  };
}

function getInstallProgressSummary(snapshot) {
  const { downloadedBytes, totalBytes, bytesPerSecond, etaMs } = getInstallTransferMetrics(snapshot);
  const progressText = `已下载 ${formatByteCount(downloadedBytes)} / ${formatByteCount(totalBytes)}`;
  const speedText = bytesPerSecond ? `速度 ${formatTransferRate(bytesPerSecond)}` : '速度 --';
  const etaText = etaMs !== null ? `预计 ${formatEta(etaMs)}` : '预计 --';

  return {
    progressText,
    speedText,
    etaText,
    combinedText: `${progressText} | ${speedText} | ${etaText}`,
  };
}

function summarizeVerificationMethods(assetRecords = []) {
  return Array.from(new Set(
    assetRecords
      .map((record) => record?.verificationMethod)
      .filter(Boolean),
  ));
}

function resolveVerificationLabel(record, fallbackMode = '') {
  if (record?.verificationMethod) {
    return record.verificationMethod;
  }
  if (record?.verified && fallbackMode === 'size-only') {
    return 'size-only';
  }
  if (record?.verified) {
    return '缓存命中';
  }
  return '未记录';
}

function buildWebLlmDiagnosticsSnapshot(cacheDebug) {
  const diagnostics = llm.getDiagnosticsSnapshot(WEB_LLM_MODEL);
  const install = diagnostics?.install || {};
  const progress = install?.progress || {};
  const assetRecords = Array.isArray(install?.assetRecords) ? install.assetRecords : [];
  const integrityMode = install.integrityMode || llm.getIntegrityMode();
  const transfer = getInstallProgressSummary(install);
  const verificationMethods = summarizeVerificationMethods(assetRecords);
  const failedAssets = assetRecords
    .filter((record) => record?.errorCode || record?.sizeMismatch || record?.hashMismatch)
    .map((record) => ({
      path: formatAssetDebugPath(record.url),
      status: record.status,
      errorCode: record.errorCode || '',
      errorDetail: record.errorDetail || '',
      sizeMismatch: Boolean(record.sizeMismatch),
      hashMismatch: Boolean(record.hashMismatch),
    }));

  const assetSummary = assetRecords.map((record) => ({
    path: formatAssetDebugPath(record.url),
    type: record.type,
    status: record.status,
    verified: Boolean(record.verified),
    attempts: record.attempts,
    verificationMethod: record.verificationMethod || '',
    integrityVerified: Boolean(record.integrityVerified),
    bytes: {
      downloaded: record.downloadedBytes ?? null,
      observed: record.observedSizeBytes ?? null,
      expected: record.expectedSizeBytes ?? null,
    },
    errorCode: record.errorCode || '',
  }));

  const installFacts = [
    {
      label: '安装状态',
      value: install.statusText || install.state || '等待安装',
    },
    {
      label: '完整性模式',
      value: integrityMode,
    },
    {
      label: '校验方式',
      value: verificationMethods.join(', ') || integrityMode,
    },
    {
      label: '当前资源',
      value: formatAssetDebugPath(install.currentAsset) || '等待调度',
    },
    {
      label: '文件进度',
      value: `${progress.completedFiles ?? 0}/${progress.totalFiles ?? assetRecords.length}`,
    },
    {
      label: '字节进度',
      value: `${formatByteCount(progress.downloadedBytes)} / ${formatByteCount(progress.totalBytes)}`,
    },
    {
      label: '传输速度',
      value: transfer.speedText.replace('速度 ', ''),
    },
    {
      label: '剩余预计',
      value: transfer.etaText.replace('预计 ', ''),
    },
    {
      label: '安装耗时',
      value: formatElapsedDuration(install.durationMs),
    },
    {
      label: '失败资源',
      value: failedAssets.length > 0 ? `${failedAssets.length} 个` : '无',
    },
  ];

  const assetRows = assetSummary.map((record) => {
    const failed = Boolean(record.errorCode);
    const displayedBytes = record.bytes.observed ?? record.bytes.downloaded ?? record.bytes.expected;
    const mismatchFlags = [
      record.integrityVerified ? 'hash-ok' : '',
      record.errorCode ? record.errorCode : '',
    ].filter(Boolean);
    return {
      path: record.path,
      status: record.verified ? '已校验' : (record.status || 'pending'),
      verificationMethod: resolveVerificationLabel(record, integrityMode),
      sizeText: `${formatByteCount(displayedBytes)} / ${formatByteCount(record.bytes.expected)}`,
      attempts: String(record.attempts ?? 0),
      extra: mismatchFlags.join(' | ') || (record.type || ''),
      failed,
    };
  });

  const summary = [
    `缓存：${cacheDebug.requestPaths.length} 条`,
    transfer.progressText,
    transfer.speedText,
    transfer.etaText,
  ].join(' | ');

  return {
    summary,
    installFacts,
    assetRows,
    detail: JSON.stringify({
      install: {
        state: install.state,
        statusText: install.statusText,
        ready: Boolean(install.ready),
        controller: Boolean(install.controller),
        integrityMode,
        currentAsset: formatAssetDebugPath(install.currentAsset),
        progress: {
          percent: progress.percent ?? null,
          completedFiles: progress.completedFiles ?? 0,
          totalFiles: progress.totalFiles ?? assetRecords.length,
          downloadedBytes: formatByteCount(progress.downloadedBytes),
          totalBytes: formatByteCount(progress.totalBytes),
        },
        startedAt: install.startedAt || 0,
        completedAt: install.completedAt || 0,
        durationMs: install.durationMs || 0,
        retryCount: install.retryCount || 0,
        errorCode: install.errorCode || '',
        errorDetail: install.errorDetail || '',
        prefetchError: install.prefetchError || '',
        swVersion: install.swVersion || '',
        verifiedAt: install.verifiedAt || 0,
      },
      runtime: diagnostics?.runtime || {},
      manifest: {
        modelId: diagnostics?.manifest?.modelId || WEB_LLM_MODEL,
        version: diagnostics?.manifest?.version || '',
        requiredAssetCount: Array.isArray(diagnostics?.manifest?.requiredAssets)
          ? diagnostics.manifest.requiredAssets.length
          : 0,
      },
      cache: {
        cacheName: cacheDebug.cacheName,
        controller: cacheDebug.controller,
        controllerNote: cacheDebug.controllerNote,
        registrations: cacheDebug.registrations,
        cacheKeys: cacheDebug.cacheKeys,
        cachedPaths: cacheDebug.requestPaths,
      },
      verificationMethods,
      failedAssets,
      assetSummary,
    }, null, 2),
  };
}

function applyWebLlmInstallState(snapshot) {
  if (!snapshot) {
    return;
  }

  latestInstallSnapshot = snapshot;
  updateInstallTelemetry(snapshot);
  const statusText = snapshot.statusText || snapshot.state || '等待安装';
  const progress = typeof snapshot?.progress?.percent === 'number'
    ? snapshot.progress.percent
    : null;
  setWebLlmModelStatus(statusText, progress);
  setSidebarInstallStatus(snapshot);
}

function formatCacheRequestPath(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return String(url || '');
  }
}

async function collectWebLlmCacheDebug() {
  if (!('serviceWorker' in navigator) || !('caches' in window)) {
    const insecureContext = window.isSecureContext !== true;
    return {
      summary: insecureContext
        ? '缓存：当前地址不是安全上下文，Web LLM 安装不可用'
        : '缓存：当前浏览器不支持 Service Worker/Cache API',
      detail: insecureContext
        ? `当前页面地址不是安全上下文：${window.location.href}\n请改用 HTTPS 域名访问，或直接在本机使用 localhost。`
        : 'serviceWorker 或 caches API 不可用',
      cacheName: '',
      controller: false,
      controllerNote: insecureContext
        ? '当前地址不是安全上下文，请改用 HTTPS 或 localhost'
        : 'serviceWorker 或 caches API 不可用',
      registrations: 0,
      cacheKeys: [],
      requestPaths: [],
    };
  }

  const cacheConfig = llm.getModelCacheConfig(WEB_LLM_MODEL);
  const cacheName = cacheConfig.cacheName || buildAssetCacheName({
    cachePrefix: cacheConfig.cachePrefix,
    model: cacheConfig.model,
    version: cacheConfig.version,
  });
  const registrations = await navigator.serviceWorker.getRegistrations();
  const cacheKeys = await caches.keys();
  const hasTargetCache = cacheKeys.includes(cacheName);

  let requestPaths = [];
  if (hasTargetCache) {
    const cache = await caches.open(cacheName);
    const requests = await cache.keys();
    requestPaths = requests.map((request) => formatCacheRequestPath(request.url));
  }

  const modelCached = requestPaths.some((path) => path.endsWith('.task'));
  const wasmCachedCount = requestPaths.filter((path) => path.startsWith('/wasm/')).length;

  const summary = `缓存：${requestPaths.length} 条（模型 ${modelCached ? '已缓存' : '未缓存'}，WASM ${wasmCachedCount} 条）`;
  const controllerNote = navigator.serviceWorker.controller
    ? 'controller=true（当前页面已被 SW 控制）'
    : 'controller=false（当前页面尚未被 SW 控制，需要刷新后继续安装）';
  const detail = JSON.stringify({
    cacheName,
    controller: Boolean(navigator.serviceWorker.controller),
    controllerNote,
    registrations: registrations.length,
    cacheKeys,
    cachedPaths: requestPaths,
  }, null, 2);

  return {
    summary,
    detail,
    cacheName,
    controller: Boolean(navigator.serviceWorker.controller),
    controllerNote,
    registrations: registrations.length,
    cacheKeys,
    requestPaths,
  };
}

async function refreshWebLlmCacheDebug() {
  try {
    const cacheDebug = await collectWebLlmCacheDebug();
    const diagnosticsSnapshot = buildWebLlmDiagnosticsSnapshot(cacheDebug);
    setWebLlmCacheDebug(diagnosticsSnapshot.summary, diagnosticsSnapshot.detail);
    renderWebLlmInstallFacts(diagnosticsSnapshot.installFacts);
    renderWebLlmAssetList(diagnosticsSnapshot.assetRows);
  } catch (error) {
    setWebLlmCacheDebug(
      '缓存：检查失败',
      error instanceof Error ? error.message : String(error),
    );
    renderWebLlmInstallFacts([
      { label: '安装状态', value: '检查失败' },
      { label: '完整性模式', value: llm.getIntegrityMode() },
      { label: '校验方式', value: '未记录' },
      { label: '当前资源', value: '未知' },
      { label: '文件进度', value: '--' },
      { label: '字节进度', value: '--' },
      { label: '传输速度', value: '--' },
      { label: '剩余预计', value: '--' },
      { label: '安装耗时', value: '--' },
      { label: '失败资源', value: '未知' },
    ]);
    renderWebLlmAssetList([]);
  }
}

function scheduleWebLlmCacheDebugRefresh(delayMs = 0) {
  if (webLlmDebugRefreshTimer !== null) {
    window.clearTimeout(webLlmDebugRefreshTimer);
  }

  webLlmDebugRefreshTimer = window.setTimeout(() => {
    webLlmDebugRefreshTimer = null;
    refreshWebLlmCacheDebug();
  }, delayMs);
}

function openWebLlmModal() {
  elements.webLlmModal.classList.remove('hidden');
  elements.webLlmModal.setAttribute('aria-hidden', 'false');
  setWebLlmDiagnosticsExpanded(false);
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
  if (webLlmDebugRefreshTimer !== null) {
    window.clearTimeout(webLlmDebugRefreshTimer);
    webLlmDebugRefreshTimer = null;
  }
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

function formatWebLlmScoreMeta(scoreData) {
  const model = scoreData?.model || 'gpt-5.4';
  const sourceLabel = scoreData?.source === 'ollama'
    ? 'Ollama'
    : '服务端';
  return `模型：${model}（${sourceLabel}）`;
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

async function ensureTestDetail(index) {
  const response = await fetch(`/tests/${index}/ensure`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || data.details || '补全详情失败');
  }

  updateTestSummary(index, data);
  renderList();
  return data;
}

function needsPreparedDetail(index) {
  const item = getTestItem(index);
  return Boolean(item) && (!item.hasResult || !item.hasScore);
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

  ensureWebLlmInstallListeners();

  setWebLlmModelStatus('下载模型', 20);
  llmReadyPromise = llm.load(WEB_LLM_MODEL)
    .then((result) => {
      refreshWebLlmCacheDebug();
      return result;
    })
    .catch((error) => {
      llmReadyPromise = null;
      const installState = llm.getInstallState(WEB_LLM_MODEL);
      const message = error && typeof error === 'object' && 'code' in error && error.code === 'MODEL_NOT_INSTALLED'
        ? installState.statusText || (error instanceof Error ? error.message : String(error))
        : error instanceof Error
          ? error.message
          : String(error);
      setWebLlmModelStatus(message);
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
    const data = needsPreparedDetail(index)
      ? await ensureTestDetail(index)
      : await fetchTestDetail(index);
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
  setWebLlmCacheDebug('缓存：检查中', '正在读取 Service Worker 与 Cache Storage 状态...');
  renderWebLlmInstallFacts([
    { label: '安装状态', value: '准备中' },
    { label: '完整性模式', value: llm.getIntegrityMode() },
    { label: '校验方式', value: '等待安装' },
    { label: '当前资源', value: '等待调度' },
    { label: '文件进度', value: '--' },
    { label: '字节进度', value: '--' },
    { label: '传输速度', value: '--' },
    { label: '剩余预计', value: '--' },
    { label: '安装耗时', value: '--' },
    { label: '失败资源', value: '无' },
  ]);
  renderWebLlmAssetList([]);
  setWebLlmCardState('result', '准备中', '正在准备模型与样本数据...');
  elements.webLlmExpected.textContent = '正在加载预期结果...';
  setWebLlmCardState('achieved', '准备中', '正在准备模型与样本数据...');
  setAchievedDebugInfo('等待 achieved 调试信息...');

  try {
    await ensureWebLlmReady();
    await refreshWebLlmCacheDebug();
    scheduleWebLlmCacheDebugRefresh(2000);
    scheduleWebLlmCacheDebugRefresh(5000);
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
          formatWebLlmScoreMeta(scoreData),
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
    scheduleWebLlmCacheDebugRefresh(300);
    await scorePromise;
    scheduleWebLlmCacheDebugRefresh(300);
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
elements.webLlmDiagnosticsToggle.addEventListener('click', () => {
  setWebLlmDiagnosticsExpanded(!webLlmDiagnosticsExpanded);
});
elements.webLlmCacheRefresh.addEventListener('click', () => {
  refreshWebLlmCacheDebug();
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !elements.webLlmModal.classList.contains('hidden')) {
    closeWebLlmModal();
  }
});

loadTests().catch((error) => {
  renderError(error instanceof Error ? error.message : String(error));
});
