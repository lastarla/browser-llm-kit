import path from 'node:path';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TEST_STORE_PATH = path.resolve(PROJECT_ROOT, 'fixtures/tests.json');

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadLegacyTests(filePath) {
  const moduleUrl = `${pathToFileURL(filePath).href}?t=${Date.now()}`;
  const { default: tests } = await import(moduleUrl);
  return tests;
}

function serializeTests(tests) {
  return `${JSON.stringify(tests, null, 2)}\n`;
}

function resolveTestStorePath() {
  const configuredPath = process.env.TEST_STORE_PATH?.trim();
  return configuredPath
    ? path.resolve(configuredPath)
    : DEFAULT_TEST_STORE_PATH;
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

export function createTestStore(filePath = resolveTestStorePath(), options = {}) {
  const resolvedPath = path.resolve(filePath);
  const legacyPath = options.legacyPath ?? null;

  async function loadTests() {
    if (await fileExists(resolvedPath)) {
      const raw = await readFile(resolvedPath, 'utf8');
      const tests = JSON.parse(raw);
      if (!Array.isArray(tests)) {
        throw new Error(`TEST_STORE_INVALID:${resolvedPath}`);
      }
      return tests;
    }

    if (legacyPath && await fileExists(legacyPath)) {
      return loadLegacyTests(legacyPath);
    }

    throw new Error(`TEST_STORE_NOT_FOUND:${resolvedPath}`);
  }

  async function saveTests(tests) {
    await mkdir(path.dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, serializeTests(tests), 'utf8');
  }

  async function updateTestFields(updates, existingTests = null) {
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

  return {
    filePath: resolvedPath,
    loadTests,
    saveTests,
    updateTestFields,
    findTestIndex,
    pickTests,
  };
}

const defaultTestStore = createTestStore();

export const TEST_FILE_PATH = defaultTestStore.filePath;
export const loadTests = defaultTestStore.loadTests;
export const saveTests = defaultTestStore.saveTests;
export const updateTestFields = defaultTestStore.updateTestFields;
