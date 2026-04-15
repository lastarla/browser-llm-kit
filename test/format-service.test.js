import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSample } from '../server/services/format-service.js';

test('formatSample extracts template fields from markdown output', () => {
  const result = formatSample(`
### 1. 基础信息

#### 1. 沟通主题
智慧校园项目沟通会

#### 2. 沟通时间
2026/04/13 09:00

#### 3. 参会人员
客户方：李老师

### 2. 会议主要内容与决议。

#### 1. 客户背景与现状
学校希望升级现有系统。

#### 2. 初步痛点与动机
现有流程太分散。

#### 3. 关键决策人/影响者信息
信息中心主任参与决策。

#### 4. 项目的大致时间规划与预算范围
计划 6 月立项，预算待定。

### 3. 行动项/待办事项清单

- 任务内容及负责人、计划完成时间
  - 我方整理方案，负责人：张三，4 月底前完成。

===JSON_START===
{"ignored":true}
`);

  assert.deepEqual(result, {
    '沟通主题': '智慧校园项目沟通会',
    '沟通时间': '2026/04/13 09:00',
    '参会人员': '客户方：李老师',
    '客户背景与现状': '学校希望升级现有系统。',
    '初步痛点与动机': '现有流程太分散。',
    '关键决策人/影响者信息': '信息中心主任参与决策。',
    '项目的大致时间规划与预算范围': '计划 6 月立项，预算待定。',
    '任务内容及负责人、计划完成时间': '- 我方整理方案，负责人：张三，4 月底前完成。',
  });
});
