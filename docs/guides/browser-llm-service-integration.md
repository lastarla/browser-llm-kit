# Browser LLM Service Integration

## Status

当前仓库已经形成可复用的浏览器侧 LLM 包边界：

- `packages/llm-core`
- `packages/llm-browser`
- `packages/llm-opfs`
- `packages/llm-worker`
- `packages/llm-mediapipe`

当前宿主侧应只从 `packages/*` 入口接入。旧的 `front/llm/*` 兼容层已移除。

## Recommended Entry

```js
import BrowserLLMService from '../packages/llm-browser/index.js';

const service = new BrowserLLMService();
```

## Minimal Host Example

第二宿主验证页位于：

- [`examples/meeting-notes-demo/web/sdk-host.html`](../../examples/meeting-notes-demo/web/sdk-host.html)
- [`examples/meeting-notes-demo/web/sdk-host.js`](../../examples/meeting-notes-demo/web/sdk-host.js)

这个页面展示了最小接入方式：

1. 创建 `BrowserLLMService`
2. 调用 `listModels()`
3. 调用 `getEligibility({ modelId })`
4. 调用 `getModelStatus({ modelId })`
5. 调用 `getDiagnostics()`

## Package Surfaces

### `packages/llm-browser`

- `BrowserLLMService`
- `LLMCore`

### `packages/llm-core`

- `LLMCore`
- `CapabilityResolver`
- `ModelRegistry`

### `packages/llm-opfs`

- `AssetInstaller`
- `StorageWorkerClient`
- `opfs-layout` helpers
- `Sha256` / `hashFileHandle`

### `packages/llm-worker`

- `StorageWorkerClient`
- `InferenceWorkerClient`

### `packages/llm-mediapipe`

- `RuntimeAdapter`
- `LocalInferenceClient`
- `selectRuntimeAssetPair`
- `resolvePreferredRuntimeAssets`
- `createOpfsRuntimeFileset`

## Host Responsibilities

- 在安全上下文中运行：`HTTPS` 或 `localhost`
- 提供模型与 wasm 静态资源路径
- 允许 `Worker` 与 `OPFS`
- 对大模型安装过程展示用户可见状态，而不是假设瞬时完成

## Current Verification Evidence

- 主宿主页：`/`
- 第二宿主页：`/sdk-host.html`
- 单测：`npm test`
- 构建：`npm run build`
- 真实浏览器验证：两个宿主入口均可打开并调用同一服务边界
