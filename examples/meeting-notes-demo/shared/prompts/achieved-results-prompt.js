import template from '../fixtures/template.js';

function normalizeHeadingTitle(title) {
  return title
    .trim()
    .replace(/^\d+[.、)）]\s*/, '')
    .replace(/[：:。\s]+$/g, '');
}

export function buildDefaultAchievedResults() {
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
    titles.push({
      field_name: title,
      description: `是否提及${title}`,
    });
  }

  return titles;
}

function normalizeFieldNames(achievedResults) {
  if (typeof achievedResults === 'string') {
    try {
      const parsed = JSON.parse(achievedResults);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => item?.field_name).filter(Boolean);
      }
    } catch {
      return [];
    }
  }

  const fields = Array.isArray(achievedResults) && achievedResults.length > 0
    ? achievedResults
    : buildDefaultAchievedResults();

  return fields
    .map((item) => item?.field_name)
    .filter(Boolean);
}

function normalizeAchievedResults(achievedResults) {
  if (typeof achievedResults === 'string') {
    return achievedResults;
  }

  const fields = Array.isArray(achievedResults) && achievedResults.length > 0
    ? achievedResults
    : buildDefaultAchievedResults();

  return JSON.stringify(fields, null, 2);
}

function buildAchievedResultsSkeleton(fieldNames) {
  return JSON.stringify({
    achieved_results: fieldNames.map((fieldName) => ({
      field_name: fieldName,
      checked: false,
    })),
  }, null, 2);
}

export default function buildAchievedResultsPrompt({ currentDateTime, fullName, position, structuredRecord, achievedResults }) {
  const fieldNames = normalizeFieldNames(achievedResults);
  const skeleton = buildAchievedResultsSkeleton(fieldNames);

  return `你要根据已经整理好的结构化记录，判断每个达成结果指标项是否已被覆盖。

输入信息：
- 当前时间：${currentDateTime}
- 姓名：${fullName}
- 职位：${position}

【结构化记录】
${structuredRecord}

【达成结果指标项】
${normalizeAchievedResults(achievedResults)}

判断规则：
1. 本任务只看【结构化记录】，不要回想原始语料，不要重新理解业务，只做“字段是否已覆盖”的核对。
2. 如果结构化记录中已经出现与 field_name 同名、同义或对应的小节/字段，并且该处内容不是“未提及”或空白，则 checked = true。
3. 如果该指标项在结构化记录中完全没有对应内容，或者只有“未提及”、空白、占位内容，则 checked = false。
4. 这些指标项本质上就是结构化记录里的字段名/小节名，例如：
   - “沟通主题”对应“沟通主题”小节
   - “客户背景与现状”对应“客户背景与现状”小节
   - “任务内容及负责人、计划完成时间”对应同名行动项小节
5. 只要对应小节里已经填写了实际内容，即使内容是概括性的，也必须输出 checked = true；不要因为内容不够详细就判 false。
6. field_name 必须原样保留，顺序必须一致。
7. 不要输出解释，不要输出摘要，不要输出代码块。
8. 第一行必须是 ===JSON_START===。
9. 第二行开始必须是一个合法 JSON 对象。
10. 严格照抄下面 JSON 结构，只能修改 checked 的 true/false。

错误示例：
- 结构化记录里已经有“沟通主题”内容，却输出 checked = false。
- 结构化记录里已经有“客户背景与现状”整段内容，却输出 checked = false。

===JSON_START===
${skeleton}`;
}
