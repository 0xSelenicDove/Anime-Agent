# 角色包（Character Pack）使用说明

Cyrene Agent 默认搭载的是"昔涟"这个角色，但名字、说话方式、头像、甚至 Live2D 立绘都可以整体换成别的角色——这就是**角色包**。换包不影响功能：工具、记忆、Moments、TTS 等一切照常工作，变的只是"陪你聊天的是谁"。

---

## 一、有哪几种角色包

打开 **设置 → 角色**，能看到一个卡片列表：

| 角色包 | id | 说明 |
| --- | --- | --- |
| 昔涟 | `cyrene` | 内置默认角色，Honkai: Star Rail 同人形象，自带 Live2D 模型 |
| 小助手 | `generic` | 内置的示例角色，不含任何 IP 背景，复用昔涟的 Live2D 形象 |
| （你导入的包） | 自定义 | 通过 zip 文件导入，见下文 |

点击卡片即可切换，改动会立刻应用到聊天窗口、桌宠、状态栏、通话窗口等所有界面。**如果新角色包带了自己的 Live2D 模型**，桌宠窗口会自动重新加载一次；只换名字/头像不会有这个动作。

---

## 二、自己做一个角色包

### 目录结构

一个角色包就是一个文件夹，压缩成 zip 后即可导入：

```
my-pack/
├── manifest.json          ← 必需，角色包的"身份证"
├── avatar.png              ← 必需，头像（正方形，建议 ≥256×256）
├── icon.png                 ← 可选，应用图标（暂未接入选择界面，预留字段）
├── prompts/                 ← 必需，完整的人设 prompt 文件集
│   ├── chat_system.md
│   ├── chat_identity.md
│   ├── soul.md
│   ├── canon_quotes.md
│   ├── cyrene_harness.md
│   ├── work_system.md
│   ├── work_identity.md
│   ├── work_remark.md
│   ├── canon_quotes_lite.md
│   ├── learn_system.md
│   ├── learn_identity.md
│   ├── code_system.md
│   ├── code_identity.md
│   ├── code_remark.md
│   ├── phone_system.md
│   └── phone_identity.md
└── model/                   ← 可选，自定义 Live2D 模型（不提供则复用内置昔涟形象）
    └── ...（Cubism 4 模型文件，与 .model3.json 入口）
```

打包时，`manifest.json` 必须在 zip **顶层**（不要多包一层 `my-pack/` 目录），否则会被判定为"缺少 manifest.json"。

### manifest.json 字段

```json
{
  "schemaVersion": 1,
  "id": "my-pack",
  "displayName": "小明",
  "author": "你的名字（可选）",
  "description": "一句话介绍（可选）",
  "avatarFile": "avatar.png",
  "iconFile": "icon.png",
  "hasCustomModel": false,
  "modelEntryFile": "model/MyModel.model3.json"
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✅ | 只能是小写字母/数字/下划线/短横线，1–64 位；不能和内置包（`cyrene`、`generic`）同名 |
| `displayName` | ✅ | 界面上显示的名字，替换掉所有原来写死的"昔涟"/"Cyrene" |
| `avatarFile` | ✅ | 相对包目录的头像路径，必须是 png/jpg/jpeg/webp |
| `author` / `description` | ❌ | 纯展示用 |
| `iconFile` | ❌ | 预留字段，暂未接入应用图标选择界面 |
| `hasCustomModel` | ❌ | 为 `true` 时必须同时提供 `modelEntryFile`，否则复用内置昔涟 Live2D 形象 |
| `modelEntryFile` | 视情况 | `hasCustomModel: true` 时必填，指向 `.model3.json` 入口文件 |

### prompts/ 里必须写什么

上面列出的 16 个文件**一个都不能少**，且不能是空文件——少一个，那个场景就会静默用回内置的昔涟版本，出现"只换了一半人设"的诡异效果，所以导入时会直接拒绝，而不是悄悄降级。

不需要提供、会自动共用内置版本的：`tool_usage.md`、`cita_system.md`、`phone_style.md`、`styles/*.md`，以及 `worldbook/`、`moments_personas/`（这两个目录名是保留名，你的包里**不能**出现同名文件/文件夹，否则会意外遮蔽其他角色共享的内容）。

最省事的起点：直接照抄 [`prompts/characters/generic/`](../../prompts/characters/generic) 这套文件——它就是一个完整、能直接导入使用的最小示例，把里面的"小助手"改成你的角色名字和说话风格即可。

### 一个格式约定：MOMENTS_CUTOFF

`soul.md` 里如果有一段是"角色的外貌/服装/视觉形象描述"，建议在这段前面加一行：

```
<!-- MOMENTS_CUTOFF -->
```

朋友圈动态、主动消息这类纯文字场景会自动把这个标记之后的内容裁掉——不需要在文字场景里描述"我今天穿了什么"。不加这个标记也没问题，只是整份 `soul.md` 都会被带入文字场景。

---

## 三、导入

1. 打包：把 `manifest.json`、`avatar.png`、`prompts/`（以及可选的 `icon.png`、`model/`）压成一个 zip，`manifest.json` 在压缩包根目录。
2. 设置 → 角色 → **导入角色包（.zip）…**，选中 zip 文件。
3. 导入成功后会出现在卡片列表里，点击即可切换。
4. 如果 id 和已安装的包冲突，会提示是否覆盖——选"覆盖"会替换旧内容，选"取消"则本次导入作废。

### 常见导入失败原因

| 提示 | 原因 | 怎么修 |
| --- | --- | --- |
| 找不到 manifest.json | zip 里 `manifest.json` 不在顶层，或者压缩时多包了一层文件夹 | 重新打包，`manifest.json` 直接在 zip 根目录 |
| manifest.json 字段不合法 | `id` 格式不对，或和内置包（`cyrene`/`generic`）同名 | 检查 `id` 是否只含小写字母/数字/`_`/`-` |
| 缺少必需的人设 prompt 文件 | `prompts/` 下 16 个文件没写全，或者有空文件 | 对照上面的清单补全，可以先复制 `generic` 包再改 |
| prompts/ 下包含保留名称 | 出现了 `worldbook` 或 `moments_personas` 同名文件/文件夹 | 删掉或改名 |
| 找不到 manifest 里指定的头像文件 | `avatarFile` 路径写错，或文件根本没打进 zip | 确认路径拼写和大小写，确认文件确实在 zip 里 |
| 声明了自定义模型但模型入口文件不存在 | `hasCustomModel: true` 但 `modelEntryFile` 指向的文件缺失 | 检查路径，或者干脆把 `hasCustomModel` 设为 `false` 复用内置形象 |
| zip / 解压后体积过大 | 超过 200MB（zip）或 500MB（解压后） | 精简模型贴图体积，或去掉不必要的文件 |

---

## 四、目前还做不到的事

角色包能换的是**名字、说话方式、头像、（可选）Live2D 模型**，以下几样暂时换不了，都是已知的限制，不是 bug：

- **聊天窗口的欢迎插画**：默认的"昔涟"欢迎图是手绘立绘，画进了角色形象本身，无法靠改文字解决。非默认角色包会自动退化成"头像 + 文字"的简化欢迎语，不会显示错误的插画。
- **TTS 语音音色**：语音克隆/音色是每个用户自己在 TTS 设置里配置的账号资产，不属于角色包内容，换包不会跟着换声音。
- **Moments（朋友圈）里"cyrene"这个内部标识**：Moments 功能里，"cyrene"是一个固定的内部身份键（决定谁的动态走哪套调度逻辑），不会随角色包改变；只有**显示给用户看的名字**会跟着换成当前角色包的 `displayName`。
- **应用图标 / 窗口图标**：`iconFile` 字段目前只是预留，还没接入设置界面里的图标选择器。
