import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createRequestHandler, resolveServerRuntimeOptions } from '../server/index.js';

function createMemoryStore(seedTests) {
  let tests = structuredClone(seedTests);

  return {
    async loadTests() {
      return structuredClone(tests);
    },
    findTestIndex(allTests, selector) {
      if (selector.runAll) {
        return -1;
      }

      if (Number.isInteger(selector.index)) {
        return selector.index >= 0 && selector.index < allTests.length ? selector.index : -2;
      }

      if (typeof selector.name === 'string' && selector.name.trim()) {
        return allTests.findIndex((item) => item.name === selector.name.trim());
      }

      return -2;
    },
    pickTests(allTests, selector) {
      if (selector.runAll) {
        return allTests.map((item, index) => ({ item, index }));
      }

      const index = this.findTestIndex(allTests, selector);
      return index < 0 ? [] : [{ item: allTests[index], index }];
    },
    async updateTestFields(updates, existingTests = null) {
      const source = existingTests ? structuredClone(existingTests) : structuredClone(tests);

      for (const update of updates) {
        source[update.index] = {
          ...source[update.index],
          ...update.fields,
        };
      }

      tests = source;
      return structuredClone(tests);
    },
  };
}

async function performRequest(handler, { method, url, body = null }) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  req.method = method;
  req.url = url;
  req.headers = body ? { 'content-type': 'application/json' } : {};

  const chunks = [];
  let statusCode = 200;
  const headers = {};
  let finished = false;

  const res = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      callback();
    },
  });

  res.writeHead = (nextStatusCode, nextHeaders) => {
    statusCode = nextStatusCode;
    Object.assign(headers, nextHeaders);
    return res;
  };
  res.end = (chunk) => {
    if (chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    finished = true;
    res.emit('finish');
    return res;
  };
  res.destroy = (error) => {
    if (error) {
      throw error;
    }
    return res;
  };

  const finishPromise = once(res, 'finish');
  await handler(req, res);
  if (!finished) {
    await finishPromise;
  }

  return {
    statusCode,
    headers,
    body: Buffer.concat(chunks).toString('utf8'),
  };
}

test('GET /tests/:id stays read-only and POST /tests/:id/ensure performs the expensive path', async (t) => {
  const store = createMemoryStore([{
    name: '样本 1',
    corpus: 'hello',
    expected_result: 'world',
    result: '',
    score: null,
  }]);
  let ensureCalls = 0;

  const handler = createRequestHandler({
    testStore: store,
    ensureTestReady: async (item) => {
      ensureCalls += 1;
      return {
        ...item,
        result: 'generated',
        score: {
          overall_score: {
            final_score: 95,
          },
        },
      };
    },
  });

  const detailResponse = await performRequest(handler, {
    method: 'GET',
    url: '/tests/0',
  });
  const detail = JSON.parse(detailResponse.body);
  assert.equal(detailResponse.statusCode, 200);
  assert.equal(detail.result, '');
  assert.equal(ensureCalls, 0);

  const ensureResponse = await performRequest(handler, {
    method: 'POST',
    url: '/tests/0/ensure',
    body: {},
  });
  const ensured = JSON.parse(ensureResponse.body);

  assert.equal(ensureResponse.statusCode, 200);
  assert.equal(ensured.result, 'generated');
  assert.equal(ensured.score.overall_score.final_score, 95);
  assert.equal(ensureCalls, 1);
});

test('static asset requests fall back to front/assets when dist asset is absent', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gemma4-static-'));
  const distDir = path.join(tempDir, 'dist-front');
  const sourceDir = path.join(tempDir, 'front-src');
  const assetRelativePath = path.join('assets', 'llm', 'demo.task');

  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await mkdir(distDir, { recursive: true });
  await mkdir(path.join(sourceDir, 'assets', 'llm'), { recursive: true });
  await writeFile(path.join(sourceDir, assetRelativePath), 'model-bytes', 'utf8');

  const handler = createRequestHandler({
    distFrontDir: pathToFileURL(`${distDir}/`),
    sourceFrontDir: pathToFileURL(`${sourceDir}/`),
    testStore: createMemoryStore([]),
  });

  const response = await performRequest(handler, {
    method: 'GET',
    url: '/assets/llm/demo.task',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body, 'model-bytes');
  assert.equal(response.headers['Cache-Control'], 'public, max-age=31536000, immutable');
});

test('POST /tests/:id/web-llm-score returns score source and model from scoring backend', async () => {
  const store = createMemoryStore([{
    name: '样本 1',
    corpus: 'hello',
    expected_result: 'world',
    result: '',
    score: null,
  }]);

  const handler = createRequestHandler({
    testStore: store,
    scoreSample: async () => ({
      model: 'gemma4:e2b',
      source: 'ollama',
      score: 91,
      reason: 'fallback-ok',
      scorePayload: { score: 91, reason: 'fallback-ok' },
    }),
  });

  const response = await performRequest(handler, {
    method: 'POST',
    url: '/tests/0/web-llm-score',
    body: {
      result: '结构化记录',
    },
  });

  const parsed = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal(parsed.model, 'gemma4:e2b');
  assert.equal(parsed.source, 'ollama');
  assert.equal(parsed.score, 91);
  assert.equal(parsed.reason, 'fallback-ok');
});

test('resolveServerRuntimeOptions enables https when both cert paths are configured', () => {
  const runtimeOptions = resolveServerRuntimeOptions({
    port: 3443,
    httpsKeyFile: '/tmp/gemma4-preview.key',
    httpsCertFile: '/tmp/gemma4-preview.crt',
  });

  assert.equal(runtimeOptions.port, 3443);
  assert.equal(runtimeOptions.protocol, 'https');
  assert.equal(runtimeOptions.httpsKeyFile, '/tmp/gemma4-preview.key');
  assert.equal(runtimeOptions.httpsCertFile, '/tmp/gemma4-preview.crt');
});

test('resolveServerRuntimeOptions rejects incomplete https config', () => {
  assert.throws(
    () => resolveServerRuntimeOptions({
      httpsKeyFile: '/tmp/gemma4-preview.key',
    }),
    /HTTPS_CERT_CONFIG_INVALID/,
  );
});
