import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScorePrompt,
  extractScoreDetails,
  parseScoreResponse,
} from '../server/services/score-service.js';

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
