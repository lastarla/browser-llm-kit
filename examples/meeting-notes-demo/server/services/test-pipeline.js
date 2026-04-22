import defaultScorePrompt from '../../shared/prompts/score-prompt.js';
import { updateTestFields } from '../../shared/test-store.js';
import { DEFAULT_MODEL, runSample } from './generate-service.js';
import { formatSample } from './format-service.js';
import { scoreSample } from './score-service.js';

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

export function hasFormatResult(value) {
  return hasObject(value) || hasText(value);
}

export async function runPipeline(test, options = {}) {
  const model = options.model?.trim() || DEFAULT_MODEL;
  const scorePrompt = options.scorePrompt?.trim() || defaultScorePrompt;
  const includeScore = options.includeScore !== false;
  const forceRun = options.forceRun === true;

  const fields = {};
  let result = test.result;
  let formatResult = test.format_result;
  let score = test.score;
  let scoreMeta = null;
  let generateDurationMs = test.generate_duration_ms;

  if (forceRun || !hasText(result)) {
    const generated = await runSample(test, model);
    result = generated.result;
    generateDurationMs = generated.generate_duration_ms;
    fields.result = result;
    fields.generate_duration_ms = generateDurationMs;
  }

  if (forceRun || !hasFormatResult(formatResult)) {
    formatResult = hasText(result) ? formatSample(result) : null;
    fields.format_result = formatResult;
  }

  if (includeScore && (forceRun || !score)) {
    scoreMeta = await scoreSample({
      ...test,
      result,
      format_result: formatResult,
    }, scorePrompt);
    score = scoreMeta.scorePayload;
    fields.score = score;
  }

  return {
    fields,
    result,
    formatResult,
    score,
    scoreMeta,
    generateDurationMs,
  };
}

export async function ensureTestReady(test, index, options = {}) {
  const pipeline = await runPipeline(test, options);

  if (Object.keys(pipeline.fields).length === 0) {
    return test;
  }

  const updatedTests = await updateTestFields([{ index, fields: pipeline.fields }], options.tests);
  return updatedTests[index];
}
