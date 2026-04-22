# Web LLM Refactor Plan

## Status

已完成，原 `Service Worker + Cache Storage` 方案已退役。

当前仓库已经切换到以下实现：

- `BrowserLLMService` 作为默认前端 LLM 服务入口
- `OPFS` 作为模型安装持久化后端
- `Storage Worker` 负责下载、校验、落盘和元数据维护
- `Inference Worker` 负责 runtime 初始化、模型加载和推理
- `CapabilityResolver` 负责统一能力判定
- 页面 UI 只消费结构化安装状态和诊断快照
- 已形成 `packages/llm-core` / `packages/llm-browser` / `packages/llm-opfs` / `packages/llm-worker` / `packages/llm-mediapipe` 包边界
- 已有第二宿主验证页 `sdk-host.html`

## Superseded Design

以下旧设计不再是当前实现方向：

- `Service Worker` 驱动的模型安装
- `Cache Storage` 作为模型资源持久化后端
- `localStorage` 持久化安装状态
- 页面侧 fallback 下载 `.task/.bin`

## Current Source Of Truth

以 [`../architecture/browser-llm-service.md`](../architecture/browser-llm-service.md) 为准。
