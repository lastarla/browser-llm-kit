import buildPrompt from '../../prompt/generate-prompt.js';

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
const DEFAULT_MODEL = process.env.OLLAMA_MODEL ?? 'gemma4:e2b';

export { DEFAULT_MODEL };

export async function askOllama({ model, prompt }) {
  const response = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`OLLAMA_HTTP_${response.status}:${message}`);
  }

  const data = await response.json();
  if (!data || typeof data.response !== 'string') {
    throw new Error('OLLAMA_INVALID_RESPONSE');
  }

  return data.response;
}

function buildPromptPayload({
  currentDateTime,
  fullName,
  position,
  language,
  corpus,
  achievedResults,
}) {
  return {
    currentDateTime: currentDateTime?.trim() || new Date().toLocaleString('zh-CN', { hour12: false }),
    fullName: fullName?.trim() || '未提供',
    position: position?.trim() || '未提供',
    language: language?.trim() || 'zh',
    corpus,
    achievedResults,
  };
}

export function buildAskPrompt(body) {
  return buildPrompt(buildPromptPayload({
    currentDateTime: body.currentDateTime,
    fullName: body.user?.fullName,
    position: body.user?.position,
    language: body.user?.language,
    corpus: body.corpus,
    achievedResults: body.achievedResults,
  }));
}

export async function runSample(sample, model = DEFAULT_MODEL) {
  const prompt = buildPrompt(buildPromptPayload({
    fullName: '测试执行器',
    position: '系统',
    language: 'zh',
    corpus: sample.corpus,
    achievedResults: sample.achievedResults,
  }));
  const startedAt = Date.now();
  const result = await askOllama({ model, prompt });

  return {
    result,
    generate_duration_ms: Date.now() - startedAt,
  };
}
