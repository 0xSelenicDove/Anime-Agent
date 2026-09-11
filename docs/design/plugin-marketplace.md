# 插件市场（在线拉取）实施方案 v2.1

目标：在聊天页侧边「插件」面板（PluginModePanel）内提供官方插件市场视图，从 Cyrene-Plugins 仓库在线拉取插件索引并一键安装，复用现有 ZIP 导入管线。

v2 变更：吸收外部 review，补齐身份绑定、来源标记、版本比较、事务串行四类契约。架构骨架不变。
v2.1 变更：来源标记移入宿主 metadata 并保证事务原子性；补齐低版本状态、builtin 契约、snapshot 失效规则、流式下载上限与下载超时；版本契约收窄为严格子集。

---

## 一、总体架构

```
插件面板（渲染端）
  └─ PluginModePanel（现有）
       └─ 新增视图切换：插件页 ⇄ 插件市场页（同一面板内切换，非新面板）
            └─ 市场页：拉取索引 → 卡片列表（下载量排序）→ 点安装
                         │ IPC（只传插件 id，不传任何 URL/版本/哈希）
                         ▼
主进程 marketplace-service（独立于 PluginManager，避免 God Object）
  ├─ listMarket(): 拉取 registry.json（raw 源 + jsdelivr 兜底），产出 validated snapshot
  ├─ installFromMarket(id): 查快照 → 下载 zip → sha256 校验 → installZip(expectedIdentity)
  └─ 常量: MARKET_REGISTRY_URLS（写死官方源，不做成设置项）
```

关键决策：

- **不监听不轮询**：仅用户切入市场页时拉取一次；每次切入刷新
- **不走 GitHub API**：索引与 zip 均为普通 HTTP GET，避免限流与国内可达性问题
- **源地址写死**：raw.githubusercontent.com 主源 + cdn.jsdelivr.net 兜底（索引文件）；zip 直接走 registry 中的 releases/download URL
- **Renderer 只传 id**：marketInstall("system-status")，绝不回传 URL/版本/哈希；主进程只信自己 validated snapshot 里的数据
- **安装安全管线不变**：sha256 校验 → 身份绑定断言（manifest 与 registry 一致）→ 现有 preparePluginZip 全套防护 → installZip() 原子安装（默认停用、opt-in 启用）

---

## 二、数据契约

### registry.json（插件仓库侧）

```json
{
  "apiVersion": 1,
  "updatedAt": "2026-09-07",
  "plugins": [
    {
      "id": "system-status",
      "name": "系统状态",
      "version": "0.1.0",
      "description": "…",
      "author": "Playa",
      "zip": "https://github.com/Playa-0v0/Cyrene-Plugins/releases/download/system-status-0.1.0/system-status-0.1.0.zip",
      "sha256": "443a…",
      "downloads": 0,
      "homepage": "…"
    }
  ]
}
```

校验规则（整体性规则任一不满足 → 该源判失败，尝试下一源）：

- `apiVersion` 必须严格等于 1；不等于视为协议不兼容，该源不可用（全部源不兼容时返回"插件市场版本不受当前客户端支持"）
- **重复 id → 整个 registry 判失败**（官方索引出现重复 id 属于构建产物错误，不做 first/last wins）

逐条目校验，单条失败仅丢弃该条并写主进程 logger（不进返回类型、不阻断列表）：

- `id`：非空，`^[a-z0-9][a-z0-9-]*$`
- `version`：必须是 **Cyrene 插件版本子集**（见下），比较统一用 shared 实现，禁止字符串比较
- `name`/`description`/`author`：非空字符串
- `zip`：https URL 且必须匹配白名单前缀 `https://github.com/Playa-0v0/Cyrene-Plugins/releases/download/`
- `sha256`：64 位十六进制
- `downloads`：有限整数且 >= 0（Number.isInteger）
- `homepage`：可选，存在时必须是 https URL；UI 打开时走宿主 external URL 策略，禁止 Renderer 直接 window.open
- **`deps` 字段 v1 删除**（无依赖安装语义就不占字段；插件仓库侧同步清理）

downloads 数据生产链已存在：Cyrene-Plugins 仓库每日聚合 Action 自动读 Release 下载计数回写 registry，客户端按 downloads 降序排序（同数按 name）。

### 版本契约（严格子集，不宣称完整 SemVer）

不引入 semver 依赖、不手搓完整 SemVer 解析器。v1 版本号只接受：

```
^\d+\.\d+\.\d+$     （纯三段数字，不允许前导零，不支持预发布号和 build 元数据）
```

比较规则即三段数字从左到右逐段比较。现有插件（0.1.0 等）全部符合。未来需要预发布号时再扩展契约并升 apiVersion。

```ts
// src/shared/version.ts（shared 层唯一实现，Renderer 不得自写）
export function isValidPluginVersion(v: string): boolean;
export function isNewerVersion(candidate: string, baseline: string): boolean;
```
### 共享类型（src/shared/plugin-management.ts 扩展）

```ts
export interface MarketPluginEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  downloads: number;
  homepage?: string;
}

export interface MarketListResult {
  ok: boolean;
  error?: string;
  plugins: MarketPluginEntry[];
}
// 校验失败条目只写主进程日志，不暴露给 UI（用户无需看到 schema 校验错误）

export type MarketInstallResult =
  | { ok: true; plugin: { id: string; name: string; version: string }; overview: PluginOverview }
  | { ok: false; error: string };
```

PluginListEntry 扩展来源标记（与现有 source 字段的分工写明）：

```ts
// 现有 source: "builtin" | "user" 保持不变，继续承担内置/用户插件的区分
// origin 只回答"这个用户插件从哪来"，内置插件 origin 恒为 "local"（无意义，UI 不会用到）
origin?: "local" | "market";
```

UI 联合判断：builtin 判断用现有 `source === "builtin"`；"更新 vs 替换安装"判断用 `origin === "market"`。

### 来源标记存放位置（宿主 metadata，不放插件目录）

插件目录是插件自己控制的数据，不能作为来源证明（本地 ZIP 可自带伪造标记文件）。市场来源记录放宿主管理区：

```
userData/plugin-install-metadata/<插件id>.json
{
  "origin": "market",
  "registryId": "cyrene-official",
  "installedVersion": "0.1.0",
  "installedAt": "…"
}
```

- `list()` 扫描时读 metadata 填充 origin；插件目录不存在时孤儿 metadata 忽略（无害）
- **事务原子性**：市场安装的提交顺序 = 先写 metadata → 再 rename 插件目录提交安装；rename 失败则删 metadata。本地 ZIP 导入（含替换已装市场插件）提交成功后删除该 id 的旧 metadata——本地覆盖即失去市场身份，语义正确
- uninstall 时同步清理对应 metadata

---

## 三、分层改动

### 1. 主进程：installZip 管线扩展（installer.ts / manager.ts）

- `installZip(zipPath, opts?: { expectedIdentity?: { id: string; version: string } })`
- 在 manifest 校验通过后、提交安装前断言：manifest.id 与 manifest.version 必须和 expectedIdentity 完全一致，不一致拒绝安装并报"插件包与市场登记信息不符"
- 不传 expectedIdentity 时行为与现状完全一致（本地导入路径零改动）
- 安装时若 ZIP 内含名为 cyrene-market.json 的文件（或其他宿主 metadata 保留名）直接拒装，防止插件包伪造宿主记录（纵深防御）
- 市场安装/本地导入/uninstall 按上文规则维护宿主 metadata

### 2. 主进程：src/main/plugin-marketplace.ts（新增）

依赖注入方式与 plugin-runtime.ts 一致：

```ts
createPluginMarketplaceService({
  registryUrls: [主源, jsdelivr 兜底],   // 写死常量
  installZip: manager.installZip,        // 复用 PluginManager
})
```

核心函数：

- `listMarket(): Promise<MarketListResult>` — 逐源尝试拉取 registry.json（net.fetch，10s 超时，Chromium 网络栈尊重系统代理），按上文规则整体校验。**snapshot 失效规则：每次 listMarket 开始即进入新一轮，最终失败（全部源失败/校验失败）时清空 validated snapshot——只有当前 UI 成功获得的市场列表才对应可安装 snapshot**。快照为内存 Map（键 id，值 id/version/zip/sha256），仅成功时整体替换。列表请求做 latest-request-wins：并发请求时只认最后一次发起的结果，防止过期响应覆盖新快照。返回列表按 downloads 降序
- `installFromMarket(id): Promise<MarketInstallResult>` — **整个事务串行**（单一 in-flight Promise 互斥，覆盖"查快照 → 下载 → 哈希 → installZip → 清理"全程；并发 IPC 直接失败"已有安装任务进行中"）：
  1. 查 validated snapshot；**无快照直接失败："插件市场信息已失效，请刷新后重试"**——绝不重新信任 Renderer 传回的任何数据
  2. net.fetch 下载 zip 到 userData/plugin-market-cache/ 临时文件。**流式下载限制**：逐 chunk 累计 receivedBytes，超过 50MiB 立即 AbortController.abort() 并删临时文件（不依赖 Content-Length，也不先 arrayBuffer 全量进内存）；**下载设总超时 120s**（防 hang 死锁全局安装互斥）
  3. createHash 比对 sha256，不匹配报错
  4. installZip(tempPath, { expectedIdentity: { id, version } }) — 身份绑定由安装管线保证
  5. finally 删除临时文件（成功、失败、异常路径都清理）
  6. 内置插件 id 冲突等 installZip 既有错误原样透传
### 3. IPC + preload

src/shared/ipc-channels.ts 新增：

```ts
PLUGINS_MARKET_LIST: "plugins:market:list",
PLUGINS_MARKET_INSTALL: "plugins:market:install",
```

注册位置：plugin-runtime.ts 装配时注册（marketplace 是独立服务，不往 PluginManager 塞市场职责）。

preload pluginsApi 扩展：

```ts
marketList: () => ipcRenderer.invoke(IPC.PLUGINS_MARKET_LIST),
marketInstall: (id: string) => ipcRenderer.invoke(IPC.PLUGINS_MARKET_INSTALL, id),
```

PluginManagementApi（shared）同步补齐两个方法签名，测试 Mock 实现同步更新。

### 4. 渲染端：PluginModePanel 改造

状态新增：

```ts
const [view, setView] = useState<"installed" | "market">("installed");
const [marketState, setMarketState] = useState<{
  phase: "idle" | "loading" | "ready" | "error";
  plugins: MarketPluginEntry[];
  error?: string;
}>(…);
const [installing, setInstalling] = useState<string | null>(null);
```

头部：

- 操作区最左（刷新按钮左边）新增「插件市场」图标按钮，复用 plugin.png 小人图标（pluginIconUrl），34px 同规格
- 点击切换 view；激活态用现有 .is-accent 样式（粉色实心）
- 切到 market 时副标题/说明文字同步变化

列表区按 view 条件渲染：

- installed 视图：现有渲染逻辑原样保留
- market 视图（MarketPluginCard，复用 plugin-card-ui 结构），按钮逻辑：

| 已装情况 | 显示 |
|---|---|
| 未安装 | 「安装」粉色主按钮 |
| 同 id 且 origin 为 market，市场版本更新（isNewerVersion） | 「更新」主按钮 |
| 同 id 且 origin 为 market，版本相同 | 「已安装 vX」置灰 |
| 同 id 且 origin 为 market，**本地版本更高** | 「已安装 vX（本地版本更高）」置灰，不给降级按钮（第一版不做降级语义） |
| 同 id 且 source 为 builtin，或 origin 为 local | 「替换安装」普通按钮，文案注明"已存在同 ID 的本地插件"，走 confirmPluginReplace 确认 |
| 正在安装 | 转圈禁用 |

- 版本比较一律调 shared isNewerVersion，Renderer 不自写
- 元信息：作者 · N 次下载（下载量粉色强调）
- 安装成功：按钮变「已安装」+ 提示去插件页启用；失败显示错误 notice
- 每次切入 market 视图自动拉取（useEffect 依赖 view）；market 视图下隐藏搜索框

i18n：pluginPanel.market.* 词条补齐（中英）。

### 5. 测试

主进程 marketplace-service 单测（mock fetch）：

| 场景 | 预期 |
|---|---|
| 正常拉取 + 排序 | 成功，downloads 降序 |
| 主源失败切 jsdelivr 兜底 | 成功 |
| 全部源失败 / 超时 | ok:false |
| apiVersion 不等于 1 | 该源跳过；全不支持时明确"版本不受支持"报错 |
| JSON 损坏 / 重复 id | 该源整体判失败 |
| 单条目字段不合法（id/版本/zip 前缀/sha256/downloads/homepage） | 仅丢弃该条，列表其余正常 |
| registry 与 ZIP manifest 的 id 不一致 | 拒绝安装 |
| registry 与 ZIP manifest 的 version 不一致 | 拒绝安装 |
| sha256 不匹配 | 拒绝 + 临时文件已删 |
| 下载超 50MiB（流式累计触发） | 中止 + 临时文件已删 |
| 下载超时（120s） | 中止 + 临时文件已删 |
| 未成功 listMarket 就 install | 拒绝："市场信息已失效" |
| listMarket 成功后再失败 | snapshot 已清空，install 拒绝 |
| 并发 listMarket（后发先至） | 仅最后一次请求的结果生效 |
| installZip 抛异常 | 临时文件仍删除 |
| 两次并发 install | 第二个立即失败 |
| 本地 ZIP 内含伪造 cyrene-market.json | 拒装 |
| 市场安装后本地 ZIP 覆盖同 id | metadata 被清除，origin 回 local |
| 版本比较：1.10.0 大于 1.9.0；非法版本串校验 | 工具行为正确 |

PluginModePanel.test.ts 扩展：视图切换、按钮状态全表（含"本地版本更高"态）、marketList 失败错误提示。

现有测试全量回归。

---

## 四、施工顺序（每步全量测试 + 单独 commit）

| 步骤 | 内容 | 文件 |
|---|---|---|
| C1 | shared：市场类型 + IPC 常量 + 版本工具（含单测） | plugin-management.ts、ipc-channels.ts、version.ts |
| C2 | 主进程：installZip 扩展（expectedIdentity + 宿主 metadata + origin 字段 + 保留名拒装）+ 单测 | installer.ts、manager.ts |
| C3 | 主进程：marketplace 服务（快照失效/串行/流式下载/超时）+ 单测 | plugin-marketplace.ts |
| C4 | IPC 注册 + preload 扩展 | plugin-runtime.ts、preload/index.ts |
| C5 | 渲染端：视图切换 + 市场卡片 + 全状态按钮 + i18n + 单测 | PluginModePanel.tsx/.css/.test.ts |
| C6 | 手动验收（开发版）+ 全量回归；插件仓库侧删 registry deps 字段 | Cyrene-Plugins |

---

## 五、风险与边界

- **网络可达性**：索引双源兜底；zip 走 github.com（与应用更新同通道，已验证可行）
- **信任根**：sha256 与 registry 同源（同一仓库），真正信任根是官方仓库人工审核 + 安装管线防护 + 默认停用 opt-in；不做数字签名/证书链（当前规模属过度设计）
- **plugin takeover 防护**：来源记录在宿主 metadata 区，插件目录无法伪造（另有 ZIP 内保留名拒装纵深防御）；"更新"仅限市场同源插件，本地同 id 一律"替换安装"且必须过 confirmPluginReplace；本地覆盖自动清除市场身份
- **事务原子性**：metadata 写入与安装提交同事务（先 metadata 后 rename，失败回滚删 metadata），杜绝"已安装却被识别成 local"的中间态
- **并发**：整个市场安装事务互斥（覆盖下载+哈希+安装全程）；列表请求 latest-request-wins；下载有总超时，不会 hang 死全局互斥
- **磁盘**：临时 zip 成功/失败/异常路径均 finally 清理

---

## 六、不做的事

- 不做市场源地址设置项
- 不做自动更新已装插件（只提示，用户手动点）
- 不做降级安装（本地版本更高时只显示状态，不给按钮）
- 不做点赞/评论等社区功能（下载量排序已够用，生产链已有）
- 不做应用启动时预拉取
- 不做数字签名、证书链、账号系统、远程源配置、自动依赖解析、后台更新守护（过度设计）
- 不支持完整 SemVer（预发布号/build 元数据），版本契约严格收窄为三段数字，未来需要再扩展