import test from 'node:test';
import assert from 'node:assert/strict';
import { getInstallProgress } from '../front/llm/diagnostics.js';

test('getInstallProgress prefers byte progress when totals are known', () => {
  const percent = getInstallProgress({
    state: 'downloading_model',
    progress: {
      totalBytes: 200,
      downloadedBytes: 50,
      percent: 0,
    },
  });

  assert.equal(percent, 25);
});

test('getInstallProgress falls back to explicit percent when byte totals are unavailable', () => {
  const percent = getInstallProgress({
    state: 'downloading_model',
    progress: {
      totalBytes: null,
      downloadedBytes: null,
      percent: 57,
    },
  });

  assert.equal(percent, 57);
});
