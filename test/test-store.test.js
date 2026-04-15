import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createTestStore } from '../test-store.js';

test('createTestStore updates a json-backed store in place', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gemma4-store-'));
  const storePath = path.join(tempDir, 'tests.json');

  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await writeFile(storePath, JSON.stringify([
    { name: '样本 A', result: '', score: null },
  ], null, 2));

  const store = createTestStore(storePath, { legacyPath: null });
  const updatedTests = await store.updateTestFields([{
    index: 0,
    fields: {
      result: '新结果',
      score: { overall_score: { final_score: 91 } },
    },
  }]);

  assert.equal(updatedTests[0].result, '新结果');
  const raw = await readFile(storePath, 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed[0].result, '新结果');
  assert.equal(parsed[0].score.overall_score.final_score, 91);
});

test('createTestStore falls back to the legacy js store when json is absent', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gemma4-legacy-store-'));
  const storePath = path.join(tempDir, 'missing.json');
  const legacyPath = path.join(tempDir, 'test.js');

  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await writeFile(legacyPath, 'const tests = [{"name":"legacy sample"}];\n\nexport default tests;\n', 'utf8');

  const store = createTestStore(storePath, { legacyPath });
  const tests = await store.loadTests();

  assert.equal(tests.length, 1);
  assert.equal(tests[0].name, 'legacy sample');
});
