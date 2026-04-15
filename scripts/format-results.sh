#!/bin/bash
set -euo pipefail

python3 <<'PY'
import json
import re
from pathlib import Path

TEST_FILE = Path.cwd() / 'config' / 'tests.json'

BUSINESS_FIELDS = {
    '沟通主题',
    '沟通时间',
    '参会人员',
    '客户背景与现状',
    '初步痛点与动机',
    '关键决策人/影响者信息',
    '项目的大致时间规划与预算范围',
    '任务内容及负责人、计划完成时间',
}

GROUP_TITLES = {
    '基础信息',
    '会议主要内容与决议',
    '会议主要内容与决议。',
    '行动项/待办事项清单',
}

def clean_heading(raw: str) -> str:
    heading = raw.strip()
    heading = re.sub(r'^\d+(?:\.\d+)*\.?\s*', '', heading)
    return heading.strip()


def normalize_json_object(obj):
    if not isinstance(obj, dict):
        return None
    if isinstance(obj.get('result'), dict):
        return obj['result']
    return {key: value for key, value in obj.items() if key != 'achieved_results'} or None


def parse_json_result(result: str):
    try:
        parsed = json.loads(result)
    except Exception:
        return None
    return normalize_json_object(parsed)


def sanitize_embedded_json_literals(text: str):
    text = text.replace('\\"checked\\": True', '\\"checked\\": true')
    text = text.replace('\\"checked\\": False', '\\"checked\\": false')
    text = text.replace('\\"checked\\": None', '\\"checked\\": null')
    return text


def flush_field(store, field_name, chunks):
    if not field_name:
        return
    value = '\n'.join(chunks).strip()
    store[field_name] = value


def parse_markdown_result(result: str):
    content = result.split('===JSON_START===', 1)[0]
    lines = content.splitlines()
    extracted = {}
    current_field = None
    buffer = []

    for line in lines:
        stripped = line.strip()
        if stripped.startswith('#### '):
            heading = clean_heading(stripped[5:])
            if heading in BUSINESS_FIELDS:
                flush_field(extracted, current_field, buffer)
                current_field = heading
                buffer = []
                continue
            if heading in GROUP_TITLES:
                flush_field(extracted, current_field, buffer)
                current_field = None
                buffer = []
                continue

        if current_field is not None:
            buffer.append(line.rstrip())

    flush_field(extracted, current_field, buffer)
    return extracted or None


def build_format_result(result):
    if not isinstance(result, str) or not result.strip():
        return None

    text = result.strip()
    parsed_json = parse_json_result(text)
    if parsed_json is not None:
        return parsed_json

    return parse_markdown_result(text)


source = TEST_FILE.read_text(encoding='utf-8')
body = sanitize_embedded_json_literals(source)
tests = json.loads(body)

for item in tests:
    item['format_result'] = build_format_result(item.get('result'))

serialized = json.dumps(tests, ensure_ascii=False, indent=2) + '\n'
TEST_FILE.write_text(serialized, encoding='utf-8')
PY
