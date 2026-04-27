import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScorePrompt,
  extractScoreDetails,
  parseScoreResponse,
  scoreSample,
} from '../examples/meeting-notes-demo/server/services/score-service.js';

test('parseScoreResponse accepts fenced json content', () => {
  const parsed = parseScoreResponse('```json\n{"score": 96, "reason": "ok"}\n```');
  assert.deepEqual(parsed, { score: 96, reason: 'ok' });
});

test('extractScoreDetails prefers structured overall score and falls back to raw numbers', () => {
  assert.deepEqual(extractScoreDetails({
    overall_score: {
      final_score: 88.2,
      score_level_description: '整体较好',
    },
  }), {
    score: 88,
    reason: '整体较好',
  });

  assert.deepEqual(extractScoreDetails({
    raw_text: '模型返回 final score = 73.4',
  }), {
    score: 73,
    reason: '',
  });
});

test('buildScorePrompt replaces both expected placeholders', () => {
  const prompt = buildScorePrompt({
    scorePrompt: 'expected={{#1752227139319.expected_result#}} result={{#1757504587128.result#}}',
    expectedResult: 'A',
    result: 'B',
  });

  assert.equal(prompt, 'expected=A result=B');
});

test('scoreSample falls back to Ollama scoring when score API token is missing', async (t) => {
  const originalToken = process.env.SCORE_API_AUTH_TOKEN;
  const originalFetch = globalThis.fetch;

  process.env.SCORE_API_AUTH_TOKEN = '';
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'http://localhost:11434/api/generate');
    const payload = JSON.parse(String(options?.body || '{}'));
    assert.equal(payload.model, 'gemma4:e2b');
    return {
      ok: true,
      async json() {
        return {
          response: '{"score": 87, "reason": "fallback-ok"}',
        };
      },
    };
  };

  t.after(() => {
    process.env.SCORE_API_AUTH_TOKEN = originalToken;
    globalThis.fetch = originalFetch;
  });

  const result = await scoreSample({
    result: '结构化记录',
    format_result: null,
    expected_result: '预期结果',
  }, 'expected={{#1752227139319.expected_result#}} result={{#1757504587128.result#}}');

  assert.equal(result.source, 'ollama');
  assert.equal(result.model, 'gemma4:e2b');
  assert.equal(result.score, 87);
  assert.equal(result.reason, 'fallback-ok');
});
