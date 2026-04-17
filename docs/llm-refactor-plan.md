# Web LLM Refactor Plan

## Goal

把 `front/llm` 从“页面内可用的一段逻辑”整理成“可被其他前端项目复用的模块”，同时补齐安装闭环：

- 安装状态机
- `ready` 判定规则
- 页面 fallback 退场条件
- 给宿主 UI 的统一状态文案与诊断信息

## Current Gaps

- `front/llm/index.js` 同时承担模型注册、缓存安装、MediaPipe runtime 初始化、队列调度。
- `ready` 目前等价于 `LlmInference` 创建成功，未显式表达“缓存安装是否完整”“当前页面是否已被 SW 控制”“是否处于降级路径”。
- 页面侧 fallback 已限制为小资源，但规则和退场条件仍散落在代码与讨论里。
- 状态文案是字符串直推，宿主无法稳定消费结构化状态。

## Refactor Steps

1. 用回归测试锁住现有行为：
   - cache fallback 仅允许小资源，禁止 `.task/.bin`
   - 默认模型 cache 配置稳定
2. 拆分 `front/llm`：
   - `model-registry.js`: 模型定义、资源路径、cache 配置
   - `asset-installer.js`: 安装状态机、fallback 策略、ready 前置条件
   - `runtime-adapter.js`: MediaPipe runtime 初始化
   - `diagnostics.js`: 面向 UI/宿主的状态文案与调试快照
3. 让 `front/app.js` 消费结构化安装状态，而不是猜字符串。
4. 回归执行 `npm test` 与 `npm run build`。

## Development Plan

### Phase 1: Module Boundaries

- `LLMCore` 承担推理队列与向后兼容 facade
- `AssetInstaller` 承担安装状态机
- `ModelRegistry` 作为模型与资源清单单一事实源
- `RuntimeAdapter` 只做 runtime 初始化

Status: completed

### Phase 2: Install Correctness

- `ready` 必须同时满足：
  - 当前页面 `controller=true`
  - required assets 已进入目标 cache
  - 安装记录与当前 manifest/version 对齐
- `load()` 必须依赖 `ready`，不能绕过安装门槛
- 页面 UI 消费结构化 install state，而不是猜字符串

Status: completed

### Phase 3: Persisted Safety And Diagnostics

- 持久化快照重建时，不能跨页面直接沿用旧 `ready`
- 持久化记录应包含 `manifestVersion/cacheName/swVersion/verifiedAt`
- 暴露 host 可消费的 diagnostics 快照，便于宿主独立判断

Status: completed

### Phase 4: Remaining Work After Testable State

- 字节级下载进度与文件级兜底
- 真正的重试退避与断点续传
- hash/size 完整性校验账本
- 独立 JSON manifest 与版本清理策略

Status: pending

### Phase 5: Remove Page Fallback

- 把 runtime 资源安装通道统一为 `service-worker`
- 删除页面侧预取分支与相关“safe runtime assets”规则
- 未受控页只保留 `control_required` / 刷新语义，不再尝试页面侧安装
- 用回归测试锁住三条路径：
  - SW 正常预取时全部资源 ready
  - 未受控页时直接停在 control required
  - SW 预取失败时直接 failed，不再退到页面 fetch

Status: completed

### Browser Verification Notes

- `VERIFY_SW_INTEGRITY_MODE=size-only` + 持久化 Chromium profile 已通过：
  - 首次 `prepare()` 返回 `INSTALL_CONTROL_REQUIRED`
  - 刷新后受控页二次 `prepare()` 进入 `ready`
  - 7 个资源全部进入 `llm-assets::gemma4_e2b::v1`
  - 2026-04-16 复跑结果：`prepareDurationMs=10025.35`，安装后 `install.ready=true`
- 真实浏览器验证中发现并修复一处尺寸判定 bug：
  - 缺失 `content-length` 头时不应被视为 `0`
- `VERIFY_SW_INTEGRITY_MODE=full` 已在真实 Chromium 中跑通：
  - 2026-04-16 复跑结果：`prepareDurationMs=40056.89`，安装后 `install.ready=true`
  - 校验方式已从不稳定的 `Request.integrity` 路径切换为 SW 流式 `SHA-256`
  - 相比同机 `size-only` 端到端安装耗时约 `3.99x`

Status: updated

## Ready Rules

`ready=true` 仅在以下条件全部满足时成立：

- 模型 runtime 已创建完成
- 安装流程未处于 `failed`
- 若涉及大资源（`.task/.bin`），其来源必须是 SW 安装链路，而不是页面 fallback

说明：

- `controller=false` 不再直接等价于失败，但会明确标记为 `degraded` 或 `needs_navigation`
- 页面 fallback 已移除；安装闭环统一走 SW 预取与缓存校验路径

## Fallback Exit Criteria

只有同时满足以下条件，才允许删除页面 fallback：

- 安装状态机闭环完成
- 安装与 ready 判定强制建立在 `controller=true` 语义上
- `.task/.bin` 全部由 SW 安装器负责下载、校验、落盘与状态上报
- 首次打开、刷新、二次访问三条路径均通过回归验证

Current status:

- 以上条件已满足
- 页面 fallback 已移除
- 单测、构建、真实 Chromium `size-only` / `full` 验证已通过
