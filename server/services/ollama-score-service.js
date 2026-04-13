import defaultScorePrompt from '../../prompt/score-prompt.js';
import { DEFAULT_MODEL, askOllama } from './generate-service.js';
import {
  buildScorePrompt,
  extractScoreDetails,
  parseScoreResponse,
  stringifyScoreInput,
} from './score-service.js';

export async function scoreSampleWithOllama(sample, options = {}) {
  if (!sample.result || !sample.result.trim()) {
    throw new Error('RESULT_EMPTY');
  }

  const model = options.model?.trim() || DEFAULT_MODEL;
  const scorePrompt = options.scorePrompt?.trim() || defaultScorePrompt;
  const prompt = buildScorePrompt({
    scorePrompt,
    expectedResult: sample.expected_result,
    result: stringifyScoreInput(sample),
  });

  const answer = await askOllama({ model, prompt });

  let scorePayload;
  try {
    scorePayload = parseScoreResponse(answer);
  } catch {
    scorePayload = { raw_text: answer };
  }

  return {
    model,
    source: 'ollama',
    scorePayload,
    ...extractScoreDetails(scorePayload),
  };
}
