# gemma4

用于本地调用 Ollama 生成结构化会议纪要，并对测试样本执行批量生成、评分与结果回写。

## 启动

```bash
npm start
```

默认监听 `http://localhost:3001`。

## 环境变量

- `PORT`：服务端口，默认 `3001`
- `OLLAMA_HOST`：本地 Ollama 地址，默认 `http://localhost:11434`
- `OLLAMA_MODEL`：生成模型，默认 `gemma4:e2b`
- `ANTHROPIC_BASE_URL`：评分接口基础地址，默认 `https://aihub.firstshare.cn`
- `ANTHROPIC_AUTH_TOKEN`：评分接口 Bearer Token

## 处理链路

- 生成：通过 Ollama `POST /api/generate`
- 评分：通过远端 `POST /v1/chat/completions`
  - 评分模型固定为 `gpt-5.4`
  - `POST /score-tests` 请求体里的 `model` 不参与评分
  - `POST /run-and-score-tests` 里的 `model` 只影响生成，不影响评分

## 接口列表

### 1. `GET /health`

健康检查。

**示例请求：**

```bash
curl http://localhost:3001/health
```

**示例返回：**

```json
{
  "ok": true
}
```

---

### 2. `POST /ask`

根据输入语料直接生成结构化结果，不写回测试文件。

**请求体字段：**

- `corpus`：必填，原始沟通内容字符串
- `achievedResults`：可选，字符串或数组
- `user`：可选对象
  - `fullName`：可选，姓名
  - `position`：可选，岗位
  - `language`：可选，语言，默认 `zh`
- `model`：可选，生成模型名，默认 `OLLAMA_MODEL`
- `currentDateTime`：可选，当前时间字符串

**示例请求：**

```bash
curl -X POST http://localhost:3001/ask \
  -H 'Content-Type: application/json' \
  -d '{
    "corpus": "今天和客户开了需求沟通会，重点讨论了预算、排期和接口对接。",
    "user": {
      "fullName": "张三",
      "position": "售前经理",
      "language": "zh"
    },
    "achievedResults": []
  }'
```

**示例返回：**

```json
{
  "model": "gemma4:e2b",
  "answer": "...模型输出...",
  "prompt": "...实际发送给模型的提示词..."
}
```

---

### 3. `POST /run-tests`

按样本执行生成，并把生成结果写回 `config/test.js` 的 `result` 字段。

**请求体字段：**

- `model`：可选，生成模型名
- `name`：可选，按样本名称执行
- `index`：可选，按样本下标执行
- `runAll`：可选，是否执行全部样本，传 `true` 时忽略 `name/index`

> `name`、`index`、`runAll=true` 三者至少要满足一种选择方式。

**单条示例：**

```bash
curl -X POST http://localhost:3001/run-tests \
  -H 'Content-Type: application/json' \
  -d '{
    "index": 0
  }'
```

**批量示例：**

```bash
curl -X POST http://localhost:3001/run-tests \
  -H 'Content-Type: application/json' \
  -d '{
    "runAll": true
  }'
```

**单条返回：**

直接返回更新后的样本对象。

**批量返回：**

```json
{
  "total": 10,
  "success": 10,
  "failed": 0,
  "results": [
    {
      "index": 0,
      "name": "高校智慧教学管理平台项目沟通会",
      "ok": true,
      "result": "...生成结果..."
    }
  ]
}
```

---

### 4. `POST /score-tests`

按样本对已有 `result` 进行评分，并把评分接口返回的完整结构化 JSON 写回 `config/test.js` 的 `score` 字段。

**请求体字段：**

- `name`：可选，按样本名称评分
- `index`：可选，按样本下标评分
- `runAll`：可选，是否评分全部样本
- `scorePrompt`：可选，自定义评分提示词模板
- `model`：可选但会被忽略，不影响评分

**单条示例：**

```bash
curl -X POST http://localhost:3001/score-tests \
  -H 'Content-Type: application/json' \
  -d '{
    "index": 0
  }'
```

**覆盖评分提示词示例：**

```bash
curl -X POST http://localhost:3001/score-tests \
  -H 'Content-Type: application/json' \
  -d '{
    "index": 0,
    "scorePrompt": "请比较 result 与 expected_result，并只输出 JSON。"
  }'
```

**单条返回：**

直接返回更新后的样本对象，其中 `score` 为评分接口原始结构化 JSON。

**批量返回：**

```json
{
  "total": 10,
  "success": 10,
  "failed": 0,
  "results": [
    {
      "index": 0,
      "name": "高校智慧教学管理平台项目沟通会",
      "ok": true,
      "score": 98,
      "reason": "结果完整，语义高度一致",
      "scorePayload": {
        "overall_score": {
          "final_score": 98,
          "score_level_description": "结果完整，语义高度一致"
        }
      }
    }
  ]
}
```

---

### 5. `POST /run-and-score-tests`

先执行生成，再立即评分，并把 `result` 与 `score` 一并写回 `config/test.js`。

**请求体字段：**

- `model`：可选，生成模型名
- `name`：可选，按样本名称执行
- `index`：可选，按样本下标执行
- `runAll`：可选，是否执行全部样本
- `scorePrompt`：可选，自定义评分提示词模板

**示例请求：**

```bash
curl -X POST http://localhost:3001/run-and-score-tests \
  -H 'Content-Type: application/json' \
  -d '{
    "index": 0,
    "model": "gemma4:e2b"
  }'
```

**单条返回：**

直接返回更新后的样本对象。

**批量返回：**

```json
{
  "total": 10,
  "success": 10,
  "failed": 0,
  "results": [
    {
      "index": 0,
      "name": "高校智慧教学管理平台项目沟通会",
      "ok": true,
      "result": "...生成结果...",
      "score": 98,
      "reason": "结果完整，语义高度一致",
      "scorePayload": {
        "overall_score": {
          "final_score": 98,
          "score_level_description": "结果完整，语义高度一致"
        }
      }
    }
  ]
}
```

## 测试数据回写说明

测试样本位于 [config/test.js](config/test.js)。

- `POST /run-tests`：更新 `result`
- `POST /score-tests`：更新 `score`
- `POST /run-and-score-tests`：同时更新 `result` 和 `score`

其中 `score` 字段保存的是评分接口返回的完整结构化 JSON；接口响应里的顶层 `score` / `reason` 只是便于快速查看的摘要。
