import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { buildAskPrompt, DEFAULT_MODEL, askOllama } from './services/generate-service.js';
import { ensureTestReady, runPipeline } from './services/test-pipeline.js';
import { scoreSample } from './services/score-service.js';
import defaultScorePrompt from '../prompt/score-prompt.js';
import {
  findTestIndex,
  loadTests,
  pickTests,
  updateTestFields,
} from '../test-store.js';
import { readJsonBody, sendJson } from './lib/http-utils.js';
import { createStaticRequestHandler } from './lib/static-assets.js';
import { createTestsApi } from './lib/tests-api.js';

const DEFAULT_PORT = Number(process.env.PORT ?? 3001);
const DEFAULT_DIST_FRONT_DIR = new URL('../dist/front/', import.meta.url);
const DEFAULT_SOURCE_FRONT_DIR = new URL('../front/', import.meta.url);

const defaultTestStore = {
  loadTests,
  findTestIndex,
  pickTests,
  updateTestFields,
};

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

function isDirectExecution() {
  return Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;
}

export function createRequestHandler(options = {}) {
  const distFrontDir = options.distFrontDir ?? DEFAULT_DIST_FRONT_DIR;
  const sourceFrontDir = options.sourceFrontDir ?? DEFAULT_SOURCE_FRONT_DIR;
  const testStore = options.testStore ?? defaultTestStore;
  const scorePromptTemplate = options.defaultScorePrompt ?? defaultScorePrompt;

  const testsApi = createTestsApi({
    testStore,
    ensureTestReady: options.ensureTestReady ?? ensureTestReady,
    runPipeline: options.runPipeline ?? runPipeline,
    scoreSample: options.scoreSample ?? scoreSample,
    scorePromptTemplate,
    sendJson,
    readJsonBody,
  });

  const handleStaticRequest = createStaticRequestHandler({
    distFrontDir,
    sourceFrontDir,
    sendJson,
  });

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

  return async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && req.url === '/tests') {
      await testsApi.handleGetTests(res);
      return;
    }

    if (req.method === 'GET' && req.url?.match(/^\/tests\/\d+$/)) {
      await testsApi.handleGetTestDetail(req, res);
      return;
    }

    if (req.method === 'POST' && req.url?.match(/^\/tests\/\d+\/ensure$/)) {
      await testsApi.handleEnsureTest(req, res);
      return;
    }

    if (req.method === 'POST' && req.url?.match(/^\/tests\/\d+\/rerun$/)) {
      await testsApi.handleRerunTest(req, res);
      return;
    }

    if (req.method === 'POST' && req.url?.match(/^\/tests\/\d+\/web-llm-score$/)) {
      await testsApi.handleWebLlmScoreTest(req, res);
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
      await testsApi.handleRunTests(body, res);
      return;
    }

    if (req.url === '/run-and-score-tests') {
      await testsApi.handleRunAndScoreTests(body, res);
      return;
    }

    if (req.url === '/score-tests') {
      await testsApi.handleScoreTests(body, res);
      return;
    }

    sendJson(res, 404, { error: '接口不存在' });
  };
}

export function createServer(options = {}) {
  return http.createServer(createRequestHandler(options));
}

export function startServer(options = {}) {
  const port = Number(options.port ?? DEFAULT_PORT);
  const server = createServer({ ...options, port });

  server.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
  });

  return server;
}

if (isDirectExecution()) {
  startServer();
}
