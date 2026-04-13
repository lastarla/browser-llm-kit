import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';

const TEST_FILE_PATH = '/Users/starlee/code/demo/gemma4/config/test.js';

function serializeTests(tests) {
  return `const tests = ${JSON.stringify(tests, null, 2)};\n\nexport default tests;\n`;
}

export async function loadTests() {
  const moduleUrl = `${pathToFileURL(TEST_FILE_PATH).href}?t=${Date.now()}`;
  const { default: tests } = await import(moduleUrl);
  return tests;
}

export async function saveTests(tests) {
  await writeFile(TEST_FILE_PATH, serializeTests(tests), 'utf8');
}

export function findTestIndex(tests, { index, name, runAll } = {}) {
  if (runAll) {
    return -1;
  }

  if (Number.isInteger(index)) {
    return index >= 0 && index < tests.length ? index : -2;
  }

  if (typeof name === 'string' && name.trim()) {
    return tests.findIndex((item) => item.name === name.trim());
  }

  return -2;
}

export function pickTests(tests, selector = {}) {
  if (selector.runAll) {
    return tests.map((item, index) => ({ item, index }));
  }

  const index = findTestIndex(tests, selector);
  if (index < 0) {
    return [];
  }

  return [{ item: tests[index], index }];
}

export async function updateTestFields(updates, existingTests = null) {
  const tests = existingTests ? [...existingTests] : await loadTests();

  for (const update of updates) {
    if (!Number.isInteger(update.index) || update.index < 0 || update.index >= tests.length) {
      continue;
    }

    tests[update.index] = {
      ...tests[update.index],
      ...update.fields,
    };
  }

  await saveTests(tests);
  return tests;
}
