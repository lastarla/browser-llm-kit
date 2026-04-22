import template from './fixtures/template.js';

export function normalizeHeadingTitle(title) {
  return title
    .trim()
    .replace(/^\d+[.、)）]\s*/, '')
    .replace(/[：:。\s]+$/g, '');
}

export function buildTemplateFieldTitles() {
  const titles = [];
  const seen = new Set();

  for (const line of template.split(/\r?\n/)) {
    const match = line.match(/^#{4,5}\s+(.+)$/);
    if (!match) {
      continue;
    }

    const title = normalizeHeadingTitle(match[1]);
    if (!title || seen.has(title)) {
      continue;
    }

    seen.add(title);
    titles.push(title);
  }

  return titles;
}
