import {
  createBatchTestExecutor,
  createTestLookup,
  parseTestIndex,
  validateRunBody,
} from './tests-api-support.js';

export function createTestsApi({
  testStore,
  ensureTestReady,
  runPipeline,
  scoreSample,
  scorePromptTemplate,
  sendJson,
  readJsonBody,
}) {
  const loadTestByIndex = createTestLookup(testStore);
  const {
    executeSelectedTests,
    sendExecutionResult,
  } = createBatchTestExecutor({
    testStore,
    runPipeline,
    sendJson,
  });

  async function handleGetTests(res) {
    const tests = await testStore.loadTests();
    sendJson(res, 200, tests.map((item, index) => ({
      index,
      name: item.name,
      hasResult: Boolean(item.result && item.result.trim()),
      hasScore: Boolean(item.score),
    })));
  }

  async function handleGetTestDetail(req, res) {
    const index = parseTestIndex(req);

    if (!Number.isInteger(index)) {
      sendJson(res, 400, { error: 'index 必须是整数' });
      return;
    }

    const { item } = await loadTestByIndex(index);
    if (!item) {
      sendJson(res, 404, { error: '未找到对应样本' });
      return;
    }

    sendJson(res, 200, item);
  }

  async function handleEnsureTest(req, res) {
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
      const clearedTests = await testStore.updateTestFields([{
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
        await testStore.updateTestFields([{ index, fields: pipeline.fields }], clearedTests);
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
      }, scorePromptTemplate);

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
        scorePrompt: payload.scorePrompt || scorePromptTemplate,
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
        scorePrompt: payload.scorePrompt || scorePromptTemplate,
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

  return {
    handleGetTests,
    handleGetTestDetail,
    handleEnsureTest,
    handleRerunTest,
    handleWebLlmScoreTest,
    handleRunTests,
    handleScoreTests,
    handleRunAndScoreTests,
  };
}
