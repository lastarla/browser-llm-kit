import { buildTemplateFieldTitles, normalizeHeadingTitle } from '../../template-fields.js';

const ACTION_TITLE = '任务内容及负责人、计划完成时间';
const TARGET_TITLES = new Set(buildTemplateFieldTitles());
const TITLE_ALIASES = new Map([
  ['行动项/待办事项清单', ACTION_TITLE],
]);

function normalizeLine(line) {
  return line.replace(/\s+$/g, '');
}

function trimBlock(lines) {
  const normalized = lines.map(normalizeLine);
  let start = 0;
  let end = normalized.length;

  while (start < end && !normalized[start].trim()) {
    start += 1;
  }

  while (end > start && !normalized[end - 1].trim()) {
    end -= 1;
  }

  return normalized.slice(start, end).join('\n').trim();
}

function extractMarkdownPart(result) {
  return String(result).split('===JSON_START===')[0] || '';
}

function parseHeading(line) {
  const match = line.match(/^(#{3,5})\s+(.+?)\s*$/);
  if (!match) {
    return null;
  }

  return normalizeHeadingTitle(match[2]);
}

function resolveTargetTitle(title) {
  if (TARGET_TITLES.has(title)) {
    return title;
  }

  return TITLE_ALIASES.get(title) || null;
}

function isTaskTitleLine(line) {
  return /^(?:#{3,5}\s+)?(?:[-*]\s*)?任务内容及负责人、计划完成时间\s*$/.test(line.trim());
}

function isListLine(line) {
  return /^\s*(?:[-*]|\d+[.、)])\s+/.test(line);
}

function isContinuationLine(line) {
  return /^\s{2,}\S/.test(line);
}

function sanitizeTaskBlock(lines) {
  const normalized = [];

  for (const rawLine of lines) {
    if (isTaskTitleLine(rawLine)) {
      continue;
    }

    const cleanedLine = rawLine.replace(/^\s*[-*]\s*任务内容及负责人、计划完成时间[:：]?\s*$/, '');
    normalized.push(cleanedLine);
  }

  const trimmed = trimBlock(normalized).split('\n');
  if (trimmed.length === 1 && !trimmed[0]) {
    return '';
  }

  const output = [];
  let seenTaskItem = false;

  for (const line of trimmed) {
    if (!line.trim()) {
      output.push(line);
      continue;
    }

    if (isListLine(line)) {
      seenTaskItem = true;
      output.push(line);
      continue;
    }

    if (!seenTaskItem) {
      output.push(line);
      continue;
    }

    if (isContinuationLine(line)) {
      output.push(line);
      continue;
    }

    break;
  }

  return trimBlock(output);
}

function sanitizeBlock(title, lines) {
  if (title === ACTION_TITLE) {
    return sanitizeTaskBlock(lines);
  }

  return trimBlock(lines);
}

export function formatSample(result) {
  const markdown = extractMarkdownPart(result);
  const lines = markdown.split(/\r?\n/);
  const output = {};
  let currentTitle = null;
  let buffer = [];
  let pendingActionBlock = false;

  function flush() {
    if (!currentTitle) {
      buffer = [];
      return;
    }

    const content = sanitizeBlock(currentTitle, buffer);
    if (content) {
      output[currentTitle] = content;
    }

    buffer = [];
  }

  for (const rawLine of lines) {
    const line = normalizeLine(rawLine);

    if (line.includes('===JSON_START===')) {
      break;
    }

    if (/^---+$/.test(line.trim())) {
      flush();
      currentTitle = null;
      pendingActionBlock = false;
      continue;
    }

    const heading = parseHeading(line);
    if (heading) {
      flush();
      currentTitle = resolveTargetTitle(heading);
      pendingActionBlock = heading === '行动项/待办事项清单';
      continue;
    }

    if (isTaskTitleLine(line)) {
      flush();
      currentTitle = ACTION_TITLE;
      pendingActionBlock = false;
      continue;
    }

    if (!currentTitle && pendingActionBlock && line.trim()) {
      currentTitle = ACTION_TITLE;
    }

    if (currentTitle) {
      buffer.push(rawLine);
    }
  }

  flush();
  return Object.keys(output).length > 0 ? output : null;
}
