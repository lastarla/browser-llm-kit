export function validateRunBody(body) {
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

export function parseTestIndex(req) {
  const match = req.url?.match(/^\/tests\/(\d+)(?:\/(?:ensure|rerun|web-llm-score))?$/);
  const index = match ? Number(match[1]) : NaN;
  return Number.isInteger(index) ? index : NaN;
}

function resolveSelection(body) {
  return {
    name: body.name,
    index: body.index,
    runAll: body.runAll === true,
  };
}

function ensureSelection(testStore, tests, selection) {
  if (selection.runAll) {
    return null;
  }

  const index = testStore.findTestIndex(tests, selection);
  if (index === -2) {
    return '请提供 runAll=true，或通过 name/index 指定样本';
  }

  if (index === -1) {
    return '未找到对应样本';
  }

  return null;
}

export function createTestLookup(testStore) {
  return async function loadTestByIndex(index) {
    const tests = await testStore.loadTests();
    if (index < 0 || index >= tests.length) {
      return { tests, item: null };
    }

    return {
      tests,
      item: tests[index],
    };
  };
}

export function createBatchTestExecutor({ testStore, runPipeline, sendJson }) {
  async function executeSelectedTests(body, executionOptions) {
    const tests = await testStore.loadTests();
    const selection = resolveSelection(body);
    const selectionError = ensureSelection(testStore, tests, selection);
    if (selectionError) {
      return { error: selectionError, statusCode: 400 };
    }

    const chosen = testStore.pickTests(tests, selection);
    const updates = [];
    const results = [];
    let successCount = 0;
    let failedCount = 0;

    for (const { item, index } of chosen) {
      try {
        const pipeline = await runPipeline(item, executionOptions.getPipelineOptions(body));
        if (Object.keys(pipeline.fields).length > 0) {
          updates.push({ index, fields: pipeline.fields });
        }
        results.push(executionOptions.mapSuccess({ item, index, pipeline }));
        successCount += 1;
      } catch (error) {
        results.push({ index, name: item.name, ok: false, error: error instanceof Error ? error.message : String(error) });
        failedCount += 1;
      }
    }

    const updatedTests = updates.length > 0 ? await testStore.updateTestFields(updates, tests) : tests;
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

  return {
    executeSelectedTests,
    sendExecutionResult,
  };
}
