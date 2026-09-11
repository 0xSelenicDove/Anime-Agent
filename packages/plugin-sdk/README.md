# @playa0v0/cyrene-plugin-sdk

Cyrene 插件开发工具包。外部开发者不需要阅读 Cyrene 宿主源码即可完成插件开发。

## 安装

```bash
npm install @playa0v0/cyrene-plugin-sdk
```

## 用途

- **类型**：`import type { PluginContext, PluginTool, ... } from "@playa0v0/cyrene-plugin-sdk"` —— 全部公开契约类型。
- **常量**：`CURRENT_PLUGIN_API_VERSION`、`PLUGIN_CAPABILITIES`、`PLUGIN_HOST_ERROR_CODES`。
- **Manifest 校验**：`validateManifestData(data)` —— 用与宿主同一份 JSON Schema 校验 manifest.json。
- **测试工具**：`import { createMockPluginContext, assertPluginTool, assertValidManifest } from "@playa0v0/cyrene-plugin-sdk/testing"` —— 脱离宿主的 Mock Context 与契约断言。

SDK 只包含类型、常量与测试工具，不包含 Electron、React 或 Cyrene 宿主运行时；插件编译期依赖 SDK，打包后的插件目录不需要终端用户安装 SDK。

完整开发指南见 Cyrene 仓库 `docs/plugins/plugin-dev-guide.md`。

## 0.2.0

提示词 Provider 新增 `sources` 场景声明，并支持 `moments-post`：

- `sources` 可选值为 `conversation`、`scheduler`、`moments-post`。
- 未声明 `sources` 的现有 Provider 仍只参与会话与定时任务，无需迁移。
- 参与动态发帖必须显式声明 `sources: ["moments-post"]`。
- `moments-post` 不提供会话 `mode`；Provider 应按 `source` 收窄输入类型后再读取场景专属字段。
- 动态发帖输入包含可用的 `conversationId`、`channel`，`userText` 为发帖决策所依据的最近对话摘录快照。

```ts
ctx.registerPromptProvider({
  id: "memory-context",
  sources: ["conversation", "moments-post"],
  provide({ source, mode, userText }) {
    if (source === "moments-post") {
      return `动态发帖参考：${userText}`;
    }
    return `当前会话模式：${mode}`;
  },
});
```
