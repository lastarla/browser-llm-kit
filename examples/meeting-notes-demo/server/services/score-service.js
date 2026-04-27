import { DEFAULT_MODEL, askOllama } from './generate-service.js';

function getScoreApiBaseUrl() {
  return (
    process.env.SCORE_API_BASE_URL?.trim()
    || process.env.ANTHROPIC_BASE_URL?.trim()
    || 'https://api.openai.com'
  );
}

function getScoreApiToken() {
  return process.env.SCORE_API_AUTH_TOKEN?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim() || '';
}

function getScoreModel() {
  return process.env.SCORE_API_MODEL?.trim() || 'gpt-5.4';
}

export function extractTextFromScoreResponse(data) {
  const messageContent = data?.choices?.[0]?.message?.content;
  if (typeof messageContent === 'string' && messageContent.trim()) {
    return messageContent;
  }

  if (Array.isArray(messageContent)) {
    const text = messageContent
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }

        if (typeof item?.text === 'string') {
          return item.text;
        }

        return '';
      })
      .join('')
      .trim();

    if (text) {
      return text;
    }
  }

  const choiceText = data?.choices?.[0]?.text;
  if (typeof choiceText === 'string' && choiceText.trim()) {
    return choiceText;
  }

  const deltaContent = data?.choices?.[0]?.delta?.content;
  if (typeof deltaContent === 'string' && deltaContent.trim()) {
    return deltaContent;
  }

  const content = data?.content;
  if (typeof content === 'string' && content.trim()) {
    return content;
  }

  if (Array.isArray(content)) {
    const text = content
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }

        if (typeof item?.text === 'string') {
          return item.text;
        }

        return '';
      })
      .join('')
      .trim();

    if (text) {
      return text;
    }
  }

  return null;
}

export async function readScoreStream(response) {
  if (!response.body) {
    throw new Error('SCORE_STREAM_MISSING');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });

    while (true) {
      const separatorIndex = buffer.indexOf('\n\n');
      if (separatorIndex === -1) {
        break;
      }

      const eventBlock = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);

      const dataLines = eventBlock
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .filter(Boolean);

      for (const dataLine of dataLines) {
        if (dataLine === '[DONE]') {
          return fullText.trim();
        }

        try {
          const payload = JSON.parse(dataLine);
          const text = extractTextFromScoreResponse(payload);
          if (text) {
            fullText += text;
          }
        } catch {
        }
      }
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const dataLines = buffer
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);

    for (const dataLine of dataLines) {
      if (dataLine === '[DONE]') {
        break;
      }

      try {
        const payload = JSON.parse(dataLine);
        const text = extractTextFromScoreResponse(payload);
        if (text) {
          fullText += text;
        }
      } catch {
      }
    }
  }

  if (!fullText.trim()) {
    throw new Error('SCORE_STREAM_EMPTY');
  }

  return fullText.trim();
}

export async function askScoreModel(prompt) {
  const apiToken = getScoreApiToken();
  if (!apiToken) {
    throw new Error('SCORE_API_TOKEN_MISSING');
  }

  const normalizedBaseUrl = getScoreApiBaseUrl().replace(/\/$/, '');
  const scoreModel = getScoreModel();

  async function sendScoreRequest(useStreaming) {
    const requestBody = {
      model: scoreModel,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0,
    };

    if (useStreaming) {
      requestBody.stream = true;
    } else {
      requestBody.response_format = {
        type: 'json_object',
      };
    }

    const response = await fetch(`${normalizedBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const message = await response.text();
      return { ok: false, message };
    }

    if (useStreaming) {
      return { ok: true, content: await readScoreStream(response) };
    }

    const data = await response.json();
    const content = extractTextFromScoreResponse(data);
    if (!content) {
      throw new Error(`SCORE_INVALID_RESPONSE:${JSON.stringify(data).slice(0, 1000)}`);
    }

    return { ok: true, content };
  }

  const preferredStreaming = normalizedBaseUrl.includes('api-vip.codex-for.me');
  const firstAttempt = await sendScoreRequest(preferredStreaming);
  if (firstAttempt.ok) {
    return firstAttempt.content;
  }

  if (!preferredStreaming && firstAttempt.message.includes('Stream must be set to true')) {
    const fallbackAttempt = await sendScoreRequest(true);
    if (fallbackAttempt.ok) {
      return fallbackAttempt.content;
    }
    throw new Error(`SCORE_HTTP_400:${fallbackAttempt.message}`);
  }

  throw new Error(`SCORE_HTTP_400:${firstAttempt.message}`);
}

export function stringifyScoreInput(sample) {
  if (sample.format_result && typeof sample.format_result === 'object') {
    return JSON.stringify(sample.format_result, null, 2);
  }

  if (typeof sample.format_result === 'string' && sample.format_result.trim()) {
    return sample.format_result;
  }

  return sample.result;
}

export function buildScorePrompt({ scorePrompt, expectedResult, result }) {
  return scorePrompt
    .replaceAll('{{#1757504587128.result#}}', result)
    .replaceAll('{{#1752227139319.expected_result#}}', expectedResult);
}

export function normalizeScoreValue(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value))));
}

export function parseScoreResponse(text) {
  const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(cleaned);
}

export function extractScoreDetails(scorePayload) {
  if (typeof scorePayload?.score === 'number') {
    return {
      score: normalizeScoreValue(scorePayload.score),
      reason: typeof scorePayload.reason === 'string' ? scorePayload.reason : '',
    };
  }

  if (typeof scorePayload?.overall_score?.final_score === 'number') {
    return {
      score: normalizeScoreValue(scorePayload.overall_score.final_score),
      reason: typeof scorePayload?.overall_score?.score_level_description === 'string'
        ? scorePayload.overall_score.score_level_description
        : '',
    };
  }

  const serialized = JSON.stringify(scorePayload);
  const match = serialized.match(/\b(100|[1-9]?\d)(?:\.\d+)?\b/);
  if (!match) {
    throw new Error('SCORE_PARSE_FAILED');
  }

  return {
    score: normalizeScoreValue(match[1]),
    reason: '',
  };
}

export async function scoreSample(sample, scorePrompt) {
  if (!sample.result || !sample.result.trim()) {
    throw new Error('RESULT_EMPTY');
  }

  const prompt = buildScorePrompt({
    scorePrompt,
    expectedResult: sample.expected_result,
    result: stringifyScoreInput(sample),
  });

  let answer;
  let model = getScoreModel();
  let source = 'server';

  try {
    answer = await askScoreModel(prompt);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'SCORE_API_TOKEN_MISSING') {
      throw error;
    }

    answer = await askOllama({
      model: DEFAULT_MODEL,
      prompt,
    });
    model = DEFAULT_MODEL;
    source = 'ollama';
  }

  let scorePayload;
  try {
    scorePayload = parseScoreResponse(answer);
  } catch {
    scorePayload = { raw_text: answer };
  }

  return {
    model,
    source,
    scorePayload,
    ...extractScoreDetails(scorePayload),
  };
}
