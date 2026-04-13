import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildAskPrompt, DEFAULT_MODEL, askOllama } from './services/generate-service.js';
import { ensureTestReady, runPipeline } from './services/test-pipeline.js';
import { scoreSample } from './services/score-service.js';
import defaultScorePrompt from '../prompt/score-prompt.js';
import { findTestIndex, loadTests, pickTests, updateTestFields } from '../test-store.js';

const PORT = Number(process.env.PORT ?? 3001);
const DIST_FRONT_DIR = new URL('../dist/front/', import.meta.url);
const staticFileCache = new Map();
const STATIC_CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('INVALID_JSON');
  }
}

function validateAskBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return '请求体必须是 JSON 对象';
  }

  if (typeof body.corpus !== 'string' || !body.corpus.trim()) {
    return 'corpus 为必填字符串';
  }

  if (body.achievedResults !== undefined && typeof body.achievedResults !== 'string' && !Array.isArray(body.achievedResults)) {
    return 'achievedResults 必须是字符串或数组';
  }

  if (body.user !== undefined) {
    if (!body.user || typeof body.user !== 'object' || Array.isArray(body.user)) {
      return 'user 必须是对象';
    }

    if (body.user.fullName !== undefined && typeof body.user.fullName !== 'string') {
      return 'user.fullName 必须是字符串';
    }

    if (body.user.position !== undefined && typeof body.user.position !== 'string') {
      return 'user.position 必须是字符串';
    }

    if (body.user.language !== undefined && typeof body.user.language !== 'string') {
      return 'user.language 必须是字符串';
    }
  }

  if (body.model !== undefined && typeof body.model !== 'string') {
    return 'model 必须是字符串';
  }

  if (body.currentDateTime !== undefined && typeof body.currentDateTime !== 'string') {
    return 'currentDateTime 必须是字符串';
  }

  return null;
}

function validateRunBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return '请求体必须是 JSON 对象';
  }

  if (body.model !== undefined && typeof body.model !== 'string') {
    return 'model 必须是字符串';
  }

  if (body.name !== undefined && typeof body.name !== 'string') {
    return 'name 必须是字符串';
  }

  if (body.index !== undefined && !Number.isInteger(body.index)) {
    return 'index 必须是整数';
  }

  if (body.runAll !== undefined && typeof body.runAll !== 'boolean') {
    return 'runAll 必须是布尔值';
  }

  if (body.forceRun !== undefined && typeof body.forceRun !== 'boolean') {
    return 'forceRun 必须是布尔值';
  }

  if (body.scorePrompt !== undefined && typeof body.scorePrompt !== 'string') {
    return 'scorePrompt 必须是字符串';
  }

  return null;
}

function resolveSelection(body) {
  return {
    name: body.name,
    index: body.index,
    runAll: body.runAll === true,
  };
}

function ensureSelection(tests, selection) {
  if (selection.runAll) {
    return null;
  }

  const index = findTestIndex(tests, selection);
  if (index === -2) {
    return '请提供 runAll=true，或通过 name/index 指定样本';
  }

  if (index === -1) {
    return '未找到对应样本';
  }

  return null;
}

function resolveStaticPath(urlPath) {
  const normalizedPath = urlPath === '/' ? '/index.html' : urlPath;
  const fileUrl = new URL(`.${normalizedPath}`, DIST_FRONT_DIR);

  if (!fileUrl.href.startsWith(DIST_FRONT_DIR.href)) {
    return null;
  }

  return fileUrl;
}

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (!extension && filePath === '/') {
    return STATIC_CONTENT_TYPES['.html'];
  }

  return STATIC_CONTENT_TYPES[extension] || 'application/octet-stream';
}

function shouldCacheStaticFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return extension === '.task' || extension === '.wasm';
}

function getCacheHeaders(filePath) {
  if (shouldCacheStaticFile(filePath)) {
    return {
      'Cache-Control': 'public, max-age=31536000, immutable',
    };
  }

  return {
    'Cache-Control': 'no-store',
  };
}

async function readStaticFile(urlPath) {
  const fileUrl = resolveStaticPath(urlPath);
  if (!fileUrl) {
    throw new Error('STATIC_PATH_INVALID');
  }

  const cacheKey = fileUrl.pathname;
  if (shouldCacheStaticFile(fileUrl.pathname) && staticFileCache.has(cacheKey)) {
    return staticFileCache.get(cacheKey);
  }

  const content = await readFile(fileUrl);
  if (shouldCacheStaticFile(fileUrl.pathname)) {
    staticFileCache.set(cacheKey, content);
  }
  return content;
}

async function handleGetTests(res) {
  const tests = await loadTests();
  sendJson(res, 200, tests.map((item, index) => ({
    index,
    name: item.name,
    hasResult: Boolean(item.result && item.result.trim()),
    hasScore: Boolean(item.score),
  })));
}

function parseTestIndex(req) {
  const match = req.url?.match(/^\/tests\/(\d+)(?:\/(?:rerun|web-llm-score))?$/);
  const index = match ? Number(match[1]) : NaN;
  return Number.isInteger(index) ? index : NaN;
}

async function loadTestByIndex(index) {
  const tests = await loadTests();
  if (index < 0 || index >= tests.length) {
    return { tests, item: null };
  }

  return {
    tests,
    item: tests[index],
  };
}

async function handleGetTestDetail(req, res) {
  const index = parseTestIndex(req);

  if (!Number.isInteger(index)) {
    sendJson(res, 400, { error: 'index 必须是整数' });
    return;
  }

  const { tests, item } = await loadTestByIndex(index);
  if (!item) {
    sendJson(res, 404, { error: '未找到对应样本' });
    return;
  }

  try {
    const readyItem = await ensureTestReady(item, index, { tests });
    sendJson(res, 200, readyItem);
  } catch (error) {
    sendJson(res, 502, {
      error: '生成、格式化或评分失败',
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleRerunTest(req, res) {
  const index = parseTestIndex(req);

  if (!Number.isInteger(index)) {
    sendJson(res, 400, { error: 'index 必须是整数' });
    return;
  }

  const { tests, item } = await loadTestByIndex(index);
  if (!item) {
    sendJson(res, 404, { error: '未找到对应样本' });
    return;
  }

  try {
    const clearedTests = await updateTestFields([{
      index,
      fields: {
        result: '',
        format_result: null,
        score: null,
        generate_duration_ms: null,
      },
    }], tests);

    const pipeline = await runPipeline(clearedTests[index], {
      forceRun: true,
    });

    if (Object.keys(pipeline.fields).length > 0) {
      await updateTestFields([{ index, fields: pipeline.fields }], clearedTests);
    }

    sendJson(res, 200, { ok: true, index });
  } catch (error) {
    sendJson(res, 502, {
      error: '重测失败',
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleWebLlmScoreTest(req, res) {
  const index = parseTestIndex(req);

  if (!Number.isInteger(index)) {
    sendJson(res, 400, { error: 'index 必须是整数' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    if (error instanceof Error && error.message === 'INVALID_JSON') {
      sendJson(res, 400, { error: '请求体不是合法 JSON' });
      return;
    }

    sendJson(res, 500, { error: '读取请求体失败' });
    return;
  }

  if (typeof body.result !== 'string' || !body.result.trim()) {
    sendJson(res, 400, { error: 'result 为必填字符串' });
    return;
  }

  const { item } = await loadTestByIndex(index);
  if (!item) {
    sendJson(res, 404, { error: '未找到对应样本' });
    return;
  }

  try {
    const scoreMeta = await scoreSample({
      ...item,
      result: body.result.trim(),
      format_result: null,
    }, defaultScorePrompt);

    sendJson(res, 200, {
      index,
      model: 'gpt-5.4',
      source: 'server',
      score: scoreMeta.score,
      reason: scoreMeta.reason,
      scorePayload: scoreMeta.scorePayload,
    });
  } catch (error) {
    sendJson(res, 502, {
      error: '服务端评分失败',
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleAsk(body, res) {
  const validationError = validateAskBody(body);
  if (validationError) {
    sendJson(res, 400, { error: validationError });
    return;
  }

  const model = body.model?.trim() || DEFAULT_MODEL;
  const prompt = buildAskPrompt(body);

  try {
    const answer = await askOllama({ model, prompt });
    sendJson(res, 200, { model, answer, prompt });
  } catch (error) {
    sendJson(res, 502, {
      error: '调用 Ollama 失败',
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

async function executeSelectedTests(body, options) {
  const tests = await loadTests();
  const selection = resolveSelection(body);
  const selectionError = ensureSelection(tests, selection);
  if (selectionError) {
    return { error: selectionError, statusCode: 400 };
  }

  const chosen = pickTests(tests, selection);
  const updates = [];
  const results = [];
  let successCount = 0;
  let failedCount = 0;

  for (const { item, index } of chosen) {
    try {
      const pipeline = await runPipeline(item, options.getPipelineOptions(body));
      if (Object.keys(pipeline.fields).length > 0) {
        updates.push({ index, fields: pipeline.fields });
      }
      results.push(options.mapSuccess({ item, index, pipeline }));
      successCount += 1;
    } catch (error) {
      results.push({ index, name: item.name, ok: false, error: error instanceof Error ? error.message : String(error) });
      failedCount += 1;
    }
  }

  const updatedTests = updates.length > 0 ? await updateTestFields(updates, tests) : tests;
  return {
    selection,
    results,
    chosenCount: chosen.length,
    successCount,
    failedCount,
    updatedTests,
  };
}

function sendExecutionResult(res, execution) {
  if (execution.error) {
    sendJson(res, execution.statusCode ?? 400, { error: execution.error });
    return;
  }

  if (!execution.selection.runAll && execution.results[0]?.ok) {
    sendJson(res, 200, execution.updatedTests[execution.results[0].index]);
    return;
  }

  sendJson(res, 200, {
    total: execution.chosenCount,
    success: execution.successCount,
    failed: execution.failedCount,
    results: execution.results,
  });
}

async function handleRunTests(body, res) {
  const validationError = validateRunBody(body);
  if (validationError) {
    sendJson(res, 400, { error: validationError });
    return;
  }

  const execution = await executeSelectedTests(body, {
    getPipelineOptions: (payload) => ({
      model: payload.model,
      includeScore: false,
      forceRun: payload.forceRun === true,
    }),
    mapSuccess: ({ item, index, pipeline }) => ({
      index,
      name: item.name,
      ok: true,
      result: pipeline.result,
      format_result: pipeline.formatResult,
    }),
  });

  sendExecutionResult(res, execution);
}

async function handleScoreTests(body, res) {
  const validationError = validateRunBody(body);
  if (validationError) {
    sendJson(res, 400, { error: validationError });
    return;
  }

  const execution = await executeSelectedTests(body, {
    getPipelineOptions: (payload) => ({
      model: payload.model,
      scorePrompt: payload.scorePrompt || defaultScorePrompt,
      forceRun: payload.forceRun === true,
    }),
    mapSuccess: ({ item, index, pipeline }) => ({
      index,
      name: item.name,
      ok: true,
      score: pipeline.scoreMeta?.score,
      reason: pipeline.scoreMeta?.reason,
      scorePayload: pipeline.score,
      format_result: pipeline.formatResult,
    }),
  });

  sendExecutionResult(res, execution);
}

async function handleRunAndScoreTests(body, res) {
  const validationError = validateRunBody(body);
  if (validationError) {
    sendJson(res, 400, { error: validationError });
    return;
  }

  const execution = await executeSelectedTests(body, {
    getPipelineOptions: (payload) => ({
      model: payload.model,
      scorePrompt: payload.scorePrompt || defaultScorePrompt,
      forceRun: payload.forceRun === true,
    }),
    mapSuccess: ({ item, index, pipeline }) => ({
      index,
      name: item.name,
      ok: true,
      result: pipeline.result,
      format_result: pipeline.formatResult,
      score: pipeline.scoreMeta?.score,
      reason: pipeline.scoreMeta?.reason,
      scorePayload: pipeline.score,
    }),
  });

  sendExecutionResult(res, execution);
}

async function handleStaticRequest(req, res) {
  if (!req.url || !req.url.startsWith('/')) {
    return false;
  }

  try {
    const content = await readStaticFile(req.url);
    res.writeHead(200, {
      'Content-Type': getContentType(req.url),
      ...getCacheHeaders(req.url),
    });
    res.end(content);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'STATIC_PATH_INVALID' || message.includes('ENOENT')) {
      return false;
    }

    sendJson(res, 404, {
      error: '静态文件不存在',
      details: message,
    });
    return true;
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && req.url === '/tests') {
    await handleGetTests(res);
    return;
  }

  if (req.method === 'GET' && req.url?.match(/^\/tests\/\d+$/)) {
    await handleGetTestDetail(req, res);
    return;
  }

  if (req.method === 'POST' && req.url?.match(/^\/tests\/\d+\/rerun$/)) {
    await handleRerunTest(req, res);
    return;
  }

  if (req.method === 'POST' && req.url?.match(/^\/tests\/\d+\/web-llm-score$/)) {
    await handleWebLlmScoreTest(req, res);
    return;
  }

  if (req.method === 'GET') {
    const handled = await handleStaticRequest(req, res);
    if (handled) {
      return;
    }

    sendJson(res, 404, { error: '接口不存在' });
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: '仅支持 POST 请求' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    if (error instanceof Error && error.message === 'INVALID_JSON') {
      sendJson(res, 400, { error: '请求体不是合法 JSON' });
      return;
    }

    sendJson(res, 500, { error: '读取请求体失败' });
    return;
  }

  if (req.url === '/ask') {
    await handleAsk(body, res);
    return;
  }

  if (req.url === '/run-tests') {
    await handleRunTests(body, res);
    return;
  }

  if (req.url === '/run-and-score-tests') {
    await handleRunAndScoreTests(body, res);
    return;
  }

  if (req.url === '/score-tests') {
    await handleScoreTests(body, res);
    return;
  }

  sendJson(res, 404, { error: '接口不存在' });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
