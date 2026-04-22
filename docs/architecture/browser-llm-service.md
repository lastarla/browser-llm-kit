# Browser LLM Service Architecture

## Status

当前阶段已完成。当前仓库已经把浏览器端 LLM 主路径切到 `packages/* + OPFS + Worker` 架构，并完成了双宿主与真实浏览器验证。

本文定义 gemma4 当前浏览器端 LLM 能力的目标架构、边界、状态语义、分阶段迁移路径和开发验收标准。本文不是讨论稿，而是实现约束，也是当前实现的目标对照。

当前实现状态：

- `BrowserLLMService` 已作为默认 SDK 入口
- `Storage Worker` 已接管模型相关资源下载、校验和 `OPFS` 落盘
- `Inference Worker` 已接管模型加载和推理
- `CapabilityResolver` 已接入服务层
- `Service Worker` 与 `Cache Storage` 已从主路径删除
- MediaPipe runtime artifacts 已纳入 `OPFS` 安装计划，并通过 `blob URL + WasmFileset` 提供给运行时
- `packages/llm-core` / `packages/llm-browser` / `packages/llm-opfs` / `packages/llm-worker` / `packages/llm-mediapipe` 已形成当前包边界
- 第二宿主验证页 `sdk-host.html` 已可独立调用同一服务边界

## Goal

把当前页面内的 Web LLM 能力升级成独立的浏览器端 LLM 服务层。该服务只管理模型相关资源，负责模型安装、版本管理、推理执行、诊断和恢复，不与当前页面 UI、业务数据、测试样本页面耦合。

目标终局：

- 模型相关资源由 `OPFS` 管理
- 不依赖 `Service Worker`
- 不使用 `Cache Storage`
- 使用 `Worker` 承担下载、校验、存储和推理
- LLM 能力以可复用 SDK 形式输出
- 支持多个模型、多个版本、多个 runtime backend

## Non-goals

- 不把业务页面资源、HTML、CSS、普通静态资源迁入 `OPFS`
- 不把当前页面当作 LLM 服务的长期架构中心
- 不以当前 `MediaPipe` 接口限制作为最终架构边界
- 不承诺第一阶段解决所有模型格式的初始化内存峰值问题
- 不再通过浏览器缓存命中表达模型安装状态
- 不在第一阶段支持暂停安装、远端动态 manifest、跨浏览器完整兼容

## Final Decisions

以下结论已锁定，后续实现不得回退到旧思路：

- `OPFS` 是模型安装元数据和模型相关资源的唯一持久化后端
- 不再依赖 `Service Worker`
- 不再依赖 `Cache Storage`
- `localStorage`、IndexedDB 不得作为模型安装状态的第二持久化来源
- LLM 必须设计成独立浏览器端服务，而不是页面 helper 集合
- `MediaPipe` 只是 `RuntimeBackend` 插件，不是架构中心
- 安装能力只支持 `cancelInstall(taskId)`，不支持 `pause/resume`
- 状态模型分为“用户可见状态”和“系统恢复状态”
- `stored`、`loadable`、`ready` 是三个不同层级，不能混用
- `ensure()` 只允许由主线程协调层拥有，worker 不得自行扩展为隐式 ensure
- `uninstall()` 第一阶段采用严格互斥策略，模型 busy 时直接失败
- 断点续传建立在 `ledger + validator` 上，不以 `206` 作为充分条件
- 第一阶段只信任随应用构建发布的本地 manifest
- 第一阶段目标平台收敛为 Chromium desktop
- runtime artifacts 进入 `OPFS` 后，必须保留浏览器真机 smoke test 作为发布准入

## Current Context

当前仓库的现状：

- `packages/llm-browser`
- `packages/llm-core`
- `packages/llm-opfs`
- `packages/llm-worker`
- `packages/llm-mediapipe`

当前模型 artifact 约 `1.9GB`，模型与 runtime artifacts 定义在 `packages/llm-core/manifest/gemma4-e2b.json`。

当前已不再依赖旧的 `Service Worker` 安装链路。模型 artifact 与 MediaPipe runtime artifacts 均由 `Storage Worker` 写入 `OPFS`，推理阶段由 `Inference Worker` 从 `OPFS` 生成模型 blob URL 和 runtime `WasmFileset`。

## Architecture Overview

采用独立 `Browser LLM Service` 架构。

```text
Host App
  |
  v
BrowserLLMService SDK
  |
  +-- ServiceCoordinator
  |     +-- ModelRegistry
  |     +-- CapabilityResolver
  |     +-- InstallStateStore (ephemeral memory mirror)
  |
  +-- StorageWorkerClient
  |
  +-- InferenceWorkerClient
  |
  v
Workers
  |
  +-- Storage Worker
  |     +-- Fetch transport
  |     +-- OPFS writer
  |     +-- ledger / recovery
  |     +-- verification
  |
  +-- Inference Worker
        +-- RuntimeBackend registry
        +-- MediaPipeBackend
        +-- model instance lifecycle
        +-- generation queue
  |
  v
OPFS
  |
  +-- registry
  +-- installs
  +-- models
  +-- runtimes
  +-- temp
```

### Core Principles

- 主线程只保留 facade、协调和事件分发能力，不直接操作 `OPFS`
- 存储和推理由两个 worker 分离，避免单 worker 同时承担大文件 IO 与 runtime 生命周期
- 所有可恢复状态都必须落在 `OPFS` 元数据中
- UI 只消费服务暴露的稳定 API 和状态事件
- runtime 通过插件化 backend 接入，避免服务架构与某个推理引擎绑定

## Support Matrix

### Phase 1 Target

第一阶段只承诺支持 Chromium desktop：

- Chrome desktop
- Edge desktop

### Non-target Platforms In Phase 1

以下平台不承诺闭环能力，只保留 capability detection 和明确的 unsupported 结果：

- Safari desktop
- Firefox desktop
- Android WebView
- iOS Safari
- iOS WebView

### Design Rule

架构必须为未来扩展保留接口，但第一阶段实现、测试和性能结论只以 Chromium desktop 为准。

## Domain Model

### Model

逻辑模型标识，例如：

- `gemma-4-e2b-it`
- `phi-3-mini`
- `qwen2.5-1.5b`

### Model Version

模型版本是不可变发布单元。版本发布后，artifact 集合、大小、hash 不允许变化。

### Runtime

推理引擎运行时，例如：

- `mediapipe@0.10.27`
- `webllm@x.y.z`
- `transformers-js@x.y.z`

runtime 本身也可拥有独立 artifact 集合，并且必须显式版本化。

### Artifact

可下载、可校验、可安装的资源单元。

artifact 类型示例：

- `model`
- `tokenizer`
- `runtime-loader`
- `runtime-wasm`
- `runtime-config`
- `adapter`

### InstallId

安装单元必须有显式主键，不能再使用 `modelId -> version` 的单维映射。

推荐格式：

```text
{modelId}@{version}#{runtimeId}@{runtimeVersion}
```

示例：

```text
gemma-4-e2b-it@v1#mediapipe@0.10.27
```

### Lifecycle Levels

必须区分以下三个层级：

- `stored`：artifact 已进入 `OPFS` 且校验通过
- `loadable`：当前 runtime backend 可以从存储层成功初始化
- `ready`：模型实例已加载到推理 worker，可立即生成

不得把这三个层级压缩成单个 `installed` 概念。

## Public SDK API

宿主项目只依赖稳定 API，不接触 `OPFS`、worker、`MediaPipe`。

```ts
export interface BrowserLLMService {
  listModels(): Promise<ModelDescriptor[]>;
  listInstalledModels(): Promise<InstalledModel[]>;
  getModelStatus(request: ModelRef): Promise<ModelStatus>;
  getEligibility(request: ModelRef): Promise<EligibilityResult>;
  install(request: InstallRequest): Promise<InstallTask>;
  cancelInstall(taskId: string): Promise<void>;
  ensure(request: ModelRef): Promise<ReadyHandle>;
  generate(request: GenerateRequest): Promise<GenerateResult>;
  generateStream(request: GenerateRequest): AsyncIterable<GenerateEvent>;
  unload(request: ModelRef): Promise<void>;
  uninstall(request: ModelRef): Promise<void>;
  prune(policy?: PrunePolicy): Promise<PruneResult>;
  getDiagnostics(): Promise<DiagnosticsSnapshot>;
  subscribe(listener: LLMEventListener): () => void;
}
```

### API Semantics

- `install()` 返回任务对象，安装是异步任务，不等于模型已 `ready`
- `cancelInstall(taskId)` 只取消当前安装任务，不承诺删除全部临时进度
- `ensure()` 负责从 `stored/loadable` 推进到 `ready`
- `generate()` 对外可以隐式触发 `ensure()`，但这种语义只能存在于协调层
- `unload()` 只释放 runtime 实例，不删除持久化 artifact
- `uninstall()` 删除指定 `installId` 的持久化内容，若模型 busy 则失败

### Core Types

```ts
export type ModelRef = {
  modelId: string;
  version?: string;
  runtime?: string;
};

export type InstallRequest = ModelRef & {
  force?: boolean;
  integrityMode?: 'size-only' | 'sha256';
};

export type GenerateRequest = ModelRef & {
  input: string | ChatMessage[];
  parameters?: {
    maxTokens?: number;
    temperature?: number;
    topK?: number;
    seed?: number;
  };
};
```

## Internal Modules

### BrowserLLMService

主线程 facade，职责：

- 对宿主暴露公共 API
- 维护 worker clients
- 合并安装态与运行态
- 输出稳定错误码和事件
- 不直接操作 `OPFS`
- 不直接初始化 runtime

### ServiceCoordinator

统一拥有以下语义：

- `ModelRef` 解析为具体 `installId`
- `ensure()` 幂等控制
- busy 冲突判定
- install、load、generate、uninstall 的流程编排
- 主线程内存镜像刷新

协调层是唯一允许拥有“自动 ensure”语义的地方。

### ModelRegistry

职责：

- 加载随应用构建发布的 manifest
- 解析默认版本和默认 runtime
- 提供 artifact install plan
- 描述模型与 runtime 的声明式需求

第一阶段不接受远端动态 manifest 作为 source of truth。

### CapabilityResolver

必须作为独立模块存在，统一产出单一资格结论。

输入：

- 当前浏览器和 worker 能力
- runtime 要求
- 模型要求
- 平台黑名单或已知兼容性限制

输出：

```ts
type EligibilityResult = {
  eligible: boolean;
  platformSupported: boolean;
  opfsAvailable: boolean;
  workerOpfsAvailable: boolean;
  webGpuAvailable: boolean;
  simdAvailable: boolean;
  runtimeSupported: boolean;
  compatibilityCode?: string;
  reasons: string[];
};
```

安装、`ensure()`、诊断、UI 提示都必须消费同一份资格结论，禁止分散判断。

### StorageWorkerClient

职责：

- 发送安装、取消、卸载、清理、诊断请求
- 把 worker message 转成 Promise 和事件流

### InferenceWorkerClient

职责：

- 发送 load、generate、cancel、unload、诊断请求
- 管理推理任务 ID
- 处理 token stream 事件

### Storage Worker

职责：

- 下载模型相关 artifact
- 写入 `OPFS`
- 维护 ledger 和恢复信息
- 做 size 和 sha256 校验
- 提交安装结果
- 清理临时文件和旧版本

不负责推理。

### Inference Worker

职责：

- 从 `OPFS` 读取已安装模型
- 初始化 runtime backend
- 管理模型实例
- 执行推理队列
- 支持取消、卸载、诊断

不负责下载。

### RuntimeBackend

运行时插件接口：

```ts
export interface RuntimeBackend {
  id: string;
  version: string;
  canHandle(model: InstalledModel): boolean;
  load(context: RuntimeLoadContext): Promise<RuntimeModelHandle>;
  generate(handle: RuntimeModelHandle, request: InternalGenerateRequest): Promise<GenerateResult>;
  generateStream(handle: RuntimeModelHandle, request: InternalGenerateRequest): AsyncIterable<GenerateEvent>;
  unload(handle: RuntimeModelHandle): Promise<void>;
  getDiagnostics(handle?: RuntimeModelHandle): Promise<RuntimeDiagnostics>;
}
```

### MediaPipeBackend

`MediaPipe` 只是 backend 实现之一。需要承担：

- runtime artifact 定位
- `WasmFileset` 构造
- 模型文件 reader 适配
- `LlmInference` 初始化
- blob URL 生命周期管理

### MediaPipe Constraints

以下结论已经锁定：

- `MediaPipe` 允许通过手工构造 `WasmFileset` 指定 loader 和 wasm 路径
- 当前实现采用 `OPFS file -> blob URL -> WasmFileset` 桥接 runtime artifacts
- 当前实现采用 `OPFS file -> blob URL` 桥接 `.task` 模型 artifact
- 真机浏览器仍必须验证 loader 内部没有额外的隐藏相对路径依赖
- 若后续浏览器 smoke test 发现兼容性问题，允许临时回退为静态 runtime 引导，但不回退 `Cache Storage` / `Service Worker`

## Source Of Truth

模型安装元数据的唯一持久化来源是 `OPFS`。

允许：

- 主线程维护短生命周期内存镜像
- 启动后从 `OPFS` 重新 hydrate
- 以只读缓存方式服务 UI

禁止：

- `localStorage` 持久化安装状态
- IndexedDB 持久化第二份安装元数据
- 主线程与 worker 双写持久化恢复状态

## OPFS Layout

```text
/registry
  models.json
  runtimes.json
  installs.json

/installs
  /{installId}
    manifest.json
    state.json
    /artifacts
      model.task
      tokenizer.json

/runtimes
  /{runtimeId}
    /{runtimeVersion}
      manifest.json
      /artifacts
        ...

/temp
  /downloads
    /{taskId}
      ledger.json

/locks
  storage.lock
  inference.lock
```

说明：

- 模型安装目录按 `installId` 分片，避免 runtime 维度丢失
- `.part` 文件允许写在目标安装目录内，避免大文件 copy
- 原子可见性由 metadata 和 commit marker 决定，不依赖大文件物理移动

## Metadata

### `installs.json`

```json
{
  "schemaVersion": 1,
  "activeInstallIdByModel": {
    "gemma-4-e2b-it": "gemma-4-e2b-it@v1#mediapipe@0.10.27"
  },
  "installs": [
    {
      "installId": "gemma-4-e2b-it@v1#mediapipe@0.10.27",
      "modelId": "gemma-4-e2b-it",
      "version": "v1",
      "runtimeId": "mediapipe",
      "runtimeVersion": "0.10.27",
      "userState": "installed",
      "systemState": "committed",
      "stored": true,
      "loadable": false,
      "installedAt": 1776660000000,
      "verifiedAt": 1776660000000,
      "sizeBytes": 2003697664
    }
  ]
}
```

### `state.json`

```json
{
  "schemaVersion": 1,
  "installId": "gemma-4-e2b-it@v1#mediapipe@0.10.27",
  "userState": "installing",
  "systemState": "downloading-partial",
  "currentArtifactId": "model",
  "progress": {
    "downloadedBytes": 104857600,
    "totalBytes": 2003697664
  },
  "artifacts": {
    "model": {
      "path": "artifacts/model.task.part",
      "finalPath": "artifacts/model.task",
      "sizeBytes": 2003697664,
      "sha256": "2cbff161177a4d51c9d04360016185976f504517ba5758cd10c1564e5421c5a5",
      "verified": false
    }
  },
  "updatedAt": 1776660000000
}
```

### `ledger.json`

```json
{
  "schemaVersion": 1,
  "taskId": "install-gemma4-v1-001",
  "installId": "gemma-4-e2b-it@v1#mediapipe@0.10.27",
  "artifactId": "model",
  "url": "/assets/llm/gemma-4-E2B-it-web.task",
  "tempPath": "/installs/gemma-4-e2b-it@v1#mediapipe@0.10.27/artifacts/model.task.part",
  "expectedSizeBytes": 2003697664,
  "downloadedBytes": 104857600,
  "etag": "\"abc123\"",
  "lastModified": "Mon, 20 Apr 2026 08:00:00 GMT",
  "contentLength": 2003697664,
  "manifestVersion": "v1",
  "manifestSha256": "manifest-sha",
  "rangeSupported": true,
  "integrityMode": "sha256",
  "updatedAt": 1776660000000
}
```

## State Model

### User-visible State

SDK 和 UI 只消费以下用户态：

- `absent`
- `installing`
- `installed`
- `failed`
- `uninstalling`
- `broken`
- `stale`

### System Recovery State

恢复和编排只使用以下系统态：

- `checking-storage`
- `recovering-ledger`
- `downloading-partial`
- `verifying-temp`
- `committing`
- `committed`
- `cancelled`
- `cleanup-pending`

### Mapping Rule

- 页面刷新、tab 关闭、worker 重建不会新增新的用户态
- 启动恢复时，系统态重新计算为稳定用户态
- `downloading-partial` 对外仍表现为 `installing`
- `cancelled` 只是任务结果，不是长期已安装状态

### Runtime State

运行态单独维护：

- `idle`
- `loading-runtime`
- `loading-model`
- `ready`
- `generating`
- `cancelling`
- `unloading`
- `failed`

## Worker Protocol

协议采用 request-response + event stream。

### Storage Requests

```ts
type StorageRequest =
  | { type: 'storage.install'; requestId: string; taskId: string; model: ModelRef; force?: boolean }
  | { type: 'storage.cancel'; requestId: string; taskId: string }
  | { type: 'storage.uninstall'; requestId: string; installId: string }
  | { type: 'storage.status'; requestId: string; installId?: string }
  | { type: 'storage.prune'; requestId: string; policy?: PrunePolicy }
  | { type: 'storage.diagnostics'; requestId: string };
```

### Storage Events

```ts
type StorageEvent =
  | { type: 'storage.progress'; taskId: string; downloadedBytes: number; totalBytes: number; artifactId: string }
  | { type: 'storage.state'; taskId: string; userState: string; systemState: string }
  | { type: 'storage.completed'; taskId: string; installId: string }
  | { type: 'storage.cancelled'; taskId: string; reason?: string }
  | { type: 'storage.failed'; taskId: string; error: LLMError };
```

### Inference Requests

```ts
type InferenceRequest =
  | { type: 'inference.load'; requestId: string; installId: string }
  | { type: 'inference.generate'; requestId: string; installId: string; request: GenerateRequest }
  | { type: 'inference.cancel'; requestId: string; taskId: string }
  | { type: 'inference.unload'; requestId: string; installId: string }
  | { type: 'inference.diagnostics'; requestId: string };
```

### Inference Events

```ts
type InferenceEvent =
  | { type: 'inference.state'; installId: string; runtimeState: string }
  | { type: 'inference.token'; taskId: string; text: string }
  | { type: 'inference.completed'; taskId: string; result: GenerateResult }
  | { type: 'inference.failed'; taskId: string; error: LLMError };
```

### Ownership Rules

- `ensure()` 只存在于 `ServiceCoordinator`
- `inference.generate` 的前置条件是 install 已 `loadable` 或 `ready`
- worker 只做幂等 `load` 和纯粹 `generate`
- worker 不得自行串联 `load -> generate -> ensure`

## Storage Strategy

### Download

- 下载发生在 `Storage Worker`
- 优先使用 `Range`，但仅在 validator 校验通过时允许续传
- 下载窗口必须周期性刷新 `ledger.json`
- 未提交前的内容不得对外表现为已安装

### Resume Rule

续传前必须同时校验：

- `etag`
- `lastModified`
- `contentLength`
- `manifestVersion` 或 `manifestSha256`
- 服务端仍支持 `Range`

任一条件不满足：

- 丢弃当前 `.part`
- 删除旧 ledger
- 从零开始重新下载

### Commit Strategy

禁止以“大文件 copy/move 成功”作为原子提交前提。

采用以下策略：

1. 直接把数据写到目标安装目录下的 `.part` 文件
2. 校验 size 和 hash
3. 更新 `state.json`
4. 将 `.part` 提升为最终可见 artifact 或写入 commit marker
5. 更新 `installs.json`
6. 清理 ledger 和孤儿临时文件

原子性定义在 metadata 层，而不是大文件物理迁移层。

### Verification

支持两种校验模式：

- `size-only`
- `sha256`

默认策略：

- 对外 SDK 默认 `sha256`
- 仅在调用方显式选择时允许 `size-only`

信任边界：

- 第一阶段只接受随应用构建发布的本地 manifest
- `sha256` 只证明 artifact 匹配这份本地 manifest
- 远端 manifest、签名、信任链不属于第一阶段

### Storage Pressure

安装前必须：

- 调用 `navigator.storage.estimate()`
- 尝试 `navigator.storage.persist()`
- 进行空间预检

空间预算：

- 直接写 `.part` 到最终目录时，至少 `requiredBytes * 1.2`
- 若运行时存在不可避免的复制路径，必须按更高安全系数重新评估

## Inference Strategy

### Load Path

默认目标路径：

1. `ServiceCoordinator` 解析 `ModelRef`
2. 校验 `EligibilityResult`
3. 若 install 未达 `stored`，先拒绝或触发安装逻辑
4. 若 install 已 `stored` 但未 `ready`，协调层调用 `inference.load`
5. worker 完成 runtime 初始化和模型加载
6. 状态推进到 `ready`

### MediaPipe Model Reader Spike

在 Phase 3 前必须完成两个加载路径实验：

- 路径 A：`fileHandle.getFile().stream().getReader()`
- 路径 B：`createSyncAccessHandle()` + 自建 `ReadableStream`

对比指标至少包括：

- 初始化耗时
- worker 内峰值内存
- 首次推理成功率
- 是否出现不可接受的 `Blob/File` 包装峰值

默认优先 A，只有 A 暴露明显问题时才升级到 B。

### Runtime Artifact Spike

已完成实现，仍需在浏览器真机执行 smoke test：

- 从 `OPFS` 读取 `MediaPipe` runtime JS 和 wasm
- 为每个 artifact 创建 blob URL
- 手工构造 `WasmFileset`
- `LlmInference.createFromOptions()` 是否能完成初始化
- loader 内部是否仍有隐藏的相对路径 fetch

### Model Instance Lifecycle

第一阶段规则：

- 默认每个 `installId` 只允许一个 active instance
- `generate()` 可由协调层隐式触发 `ensure()`
- `unload()` 只释放 runtime 实例
- `uninstall()` 要求模型当前不 busy

### Uninstall Policy

以下状态视为 busy：

- `loading-model`
- `ready`
- `generating`
- 存在待执行 generation queue

当 install busy 时：

- `uninstall()` 直接失败
- 返回 `LLM_MODEL_BUSY`
- 不做自动 cancel
- 不做隐式 drain

## Error Model

错误码必须稳定、可被宿主消费，并按层级区分。

### Platform Errors

- `LLM_BROWSER_UNSUPPORTED`

### Capability Errors

- `LLM_OPFS_UNAVAILABLE`
- `LLM_WORKER_OPFS_UNAVAILABLE`
- `LLM_WEBGPU_UNAVAILABLE`
- `LLM_SIMD_UNAVAILABLE`
- `LLM_STORAGE_QUOTA_INSUFFICIENT`
- `LLM_STORAGE_PERSIST_DENIED`

### Compatibility Errors

- `LLM_RUNTIME_UNAVAILABLE`
- `LLM_MODEL_RUNTIME_INCOMPATIBLE`
- `LLM_MANIFEST_UNTRUSTED`

### Operation Errors

- `LLM_MODEL_NOT_INSTALLED`
- `LLM_MODEL_BUSY`
- `LLM_DOWNLOAD_FAILED`
- `LLM_RANGE_RESUME_REJECTED`
- `LLM_INTEGRITY_MISMATCH`
- `LLM_RUNTIME_LOAD_FAILED`
- `LLM_MODEL_LOAD_FAILED`
- `LLM_GENERATION_FAILED`
- `LLM_CANCELLED`

每个错误对象至少包含：

- `code`
- `message`
- `detail`
- `modelId`
- `version`
- `runtime`
- `artifactId`
- `recoverable`

## Package Boundary

长期目标包结构：

```text
packages/
  llm-core/
    types
    state-machine
    registry
    capability-resolver
    service-coordinator

  llm-opfs/
    opfs-layout
    install-store
    ledger
    verification

  llm-worker/
    protocol
    storage-worker
    inference-worker
    clients

  llm-mediapipe/
    mediapipe-backend
    wasm-fileset-bridge
    model-reader-bridge

  llm-browser/
    browser-llm-service
    default-factory

  llm-devtools/
    diagnostics
    storage-inspector
```

仓库内当前落点：

- `packages/llm-browser`
- `packages/llm-core`
- `packages/llm-opfs`
- `packages/llm-worker`
- `packages/llm-mediapipe`

目录演进不能改变本文定义的服务边界。

## Migration Plan

### Phase 0: Design Lock

- 固化本文档
- 不修改现网行为
- 定义 API、状态模型、worker 协议、OPFS 布局

退出标准：

- 文档被视为实现约束
- 讨论稿痕迹已清理

### Phase 1: Service Facade

- 引入 `BrowserLLMService`
- 页面只调用 facade
- 旧实现暂时挂在 facade 背后

退出标准：

- 页面行为不变
- 入口从页面逻辑切换到服务入口

### Phase 2: OPFS Storage Backend

- 新增 `Storage Worker`
- 实现 `OPFS` 布局、ledger、校验、取消、恢复
- 首批仅迁移模型 artifact
- `Phase 2` 的成功语义只到 `stored`

退出标准：

- `1.9GB` 模型可安装到 `OPFS`
- 中断后可恢复下载
- 校验通过
- 状态准确表现为 `stored`，而不是 `ready`

### Phase 3: Inference Worker And OPFS Model Load

- 新增 `Inference Worker`
- 从 `OPFS` 加载模型
- 完成 model reader spike
- 接入 `MediaPipeBackend`

退出标准：

- `stored` 模型可变为 `loadable`
- 至少一次真实推理成功
- 记录加载耗时和内存结论

### Phase 4: Runtime Artifact Validation

- 完成 runtime artifact OPFS bridge
- 验证 runtime JS/wasm 可从 `OPFS` 驱动
- 验证 `blob URL + WasmFileset` 可初始化 `LlmInference`

退出标准：

- 形成明确结论：可迁入或不可迁入
- 文档与实现保持一致

### Phase 5: Remove SW And Cache Storage From LLM Path

- 停止注册 `llm-asset-sw.js`
- 删除 `Cache Storage` 安装路径
- 以 `OPFS` 诊断替代缓存诊断

退出标准：

- LLM 路径不依赖 `navigator.serviceWorker`
- LLM 路径不依赖 `caches.open()`
- 模型相关资源管理切换到新服务

### Phase 6: SDK Boundary Extraction

- 稳定包出口
- 补齐最小集成文档
- 验证第二个页面或宿主可接入

退出标准：

- 当前项目以 SDK 入口接入
- 第二个宿主可复用同一服务边界

## Development Entry Checklist

进入实现前，必须接受以下约束：

- 不再引入任何新的旧式 SW/Cache Storage LLM 路径
- 不再新增 `Cache Storage` 依赖
- 不再新增安装状态写入 `localStorage` 或 IndexedDB
- 所有新接口以 `BrowserLLMService` 为入口
- 所有能力判断通过 `CapabilityResolver`
- 所有安装恢复状态必须可从 `OPFS` 重建

## Verification Matrix

### Storage

- fresh install 成功
- 网络中断后恢复成功
- 取消安装后任务终止且 ledger 可解释
- quota 不足时失败清晰
- hash mismatch 不激活损坏版本
- uninstall 仅删除目标 `installId`
- prune 只删除非活动安装

### Runtime

- `stored` 模型可成功推进到 `loadable`
- `loadable` 模型可推进到 `ready`
- unload 后 blob URL 被正确释放
- generate 成功
- cancel 在 backend 支持处有效

### Compatibility

- Chromium desktop 路径全量验证
- 非目标平台返回明确 eligibility 和错误码

### Regression

- 现有页面仍可通过 facade 使用 LLM
- 现有服务端接口不需要改动
- 业务页面资源不会被写入 `OPFS`

## Risks

### `.task` 加载峰值仍可能偏高

`OPFS` 解决的是持久化与下载治理，不自动保证零拷贝模型初始化。

缓解策略：

- 做 reader spike
- 保持 runtime backend 可替换
- 保留更换模型格式或 backend 的空间

### `MediaPipe` Runtime Bridge 仍有浏览器兼容风险

当前代码路径已经切到 `blob URL + WasmFileset`，但不同浏览器/驱动上的真实初始化行为仍需 smoke test 证明。

缓解策略：

- 发布前执行真实浏览器加载验证
- 若个别环境失败，仅回退 runtime 引导方式，不回退整体 `OPFS + Worker` 架构

### `OPFS` 仍受浏览器配额影响

缓解策略：

- 安装前做 quota 预检
- 尝试持久化权限
- 暴露诊断信息和清理建议

### 元数据损坏或孤儿临时文件

缓解策略：

- 启动时执行恢复扫描
- `.part` 和 ledger 必须可匹配
- 未提交内容不得对外可见

## Implementation Notes For Current Repo

当前模块到新架构的建议映射：

- `packages/llm-core/src/llm-core.js`：当前核心协调层实现
- `packages/llm-core/src/model-registry.js`：当前 `ModelRegistry` 实现
- `packages/llm-opfs`：承载安装、存储与 OPFS helper 边界
- `packages/llm-worker`：承载 worker client 边界
- `packages/llm-mediapipe`：承载 `MediaPipeBackend` 相关边界
- 旧的 `llm-asset-sw.js` 路径已删除，不再作为迁移目标的一部分

## Current Completion

当前仓库内已经完成：

1. 主宿主页切到 `BrowserLLMService`
2. `Storage Worker + Inference Worker + OPFS` 主路径落地
3. `MediaPipe` runtime artifact bridge 落地
4. 第二宿主 `sdk-host.html` 验证通过
5. 包边界与最小集成文档落地

后续如果继续，只属于进一步演进：

- 扩展更多宿主示例
- 增加更强的 E2E / 浏览器自动化验收
- 继续细化 package 内部组织
