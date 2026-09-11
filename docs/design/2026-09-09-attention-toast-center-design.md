# 注意力 Toast 中心（Attention Toast Center）设计

> 状态：V1 设计稿 Rev 2（待评审，未开工）
> 来源：issue #82（定时任务主动提醒）讨论收敛后的轻量方案
> Rev 2：吸收外部 review，核心修正是确立「ToastService 为 Toast 生命周期唯一权威，渲染页只做表现层」原则，拆分可见状态与去重状态，补齐 plan/ask 分类互斥、显示器回退链、窗口高度协议
> 命名约定：主进程模块统一 `toast/` 目录 + `Toast*` 前缀；渲染页 `toast`；IPC 通道 `toast:*`

---

## 0. 决策记录（相对 issue #82 原方案的修正）

issue #82 提出的是「预生成文案 + TTS 缓存 + 语音播报」。讨论后放弃该路线，改为通用注意力出口，关键决策如下：

| # | 原方案（#82） | 决策 | 原因 |
|---|---|---|---|
| D1 | 任务创建时预生成 LLM 播报文案 | **不预生成，直接用 agent 实际输出** | 定时任务走完整 agent 循环（`scheduler-runner.ts:87-116`），最终消息是工具执行结果之后才生成的。带工具任务（"查天气再提醒带伞"）的预生成文案到点必然与实际输出脱节甚至相悖 |
| D2 | TTS 缓存落盘 + 语音播报 | **V1 不做，作为未来增强层** | TTS 合成、缓存管理、音色一致性的复杂度高；先用应用内音效（`<audio>` 短提示音）达成"可感知"，语音播报等地基稳定后再议 |
| D3 | 专用提醒弹窗（仅定时任务） | **通用注意力出口，五类事件共用** | 一次投入覆盖审批、选择卡、抽查、计划审批等待确认场景；#82 作者与评论区（yuxingyuzhong）的需求都被覆盖 |
| D4 | 弹窗走主窗口内渲染层组件 | **独立 toast BrowserWindow** | 用户关闭聊天窗口后应用驻留托盘（`application.ts:78` 的 `window-all-closed` 是 no-op），主窗口销毁后渲染层组件没有宿主。独立窗口在任意窗口状态下都能弹出，且音效/样式完全自控，不依赖 Windows 通知中心 |
| D5 | 需 scheduler 加"提前量"信号 | **不需要** | 没有预生成就没有文案过时与 API 沉没成本问题，scheduler 不加提前信号 |
| D6 | 任务记录加三个专属字段（文案/错误/生成时间） | **不需要** | toast 是纯瞬态通知，不往 ScheduledTask 持久化结构加字段，不碰 execution-spec 指纹 |
| D7 | 通知与聊天消息双通道 | **单一 toast 通道** | 不做"窗口可见时用应用内弹窗、不可见时走兜底"的双路径，只维护 toast 窗口一条通道，代码路径减半 |

### Rev 2 修订记录（外部 review 修正）

| # | Rev 1 问题 | 修正 |
|---|---|---|
| R1 | 可见状态与去重状态混用一张 Map，手动关闭后要么重播复活（关不掉）、要么主/渲染状态分裂 | **拆分 `activeToasts`（当前显示）与 `pendingSeen`（已提醒去重记忆）两个结构**，见 §6.1 状态机 |
| R2 | 通知档 10s 超时由渲染页计时删除，主进程不知情，状态失同步 | **ToastService 是生命周期唯一权威**：超时/结算/关闭都由主进程决策后发 `toast:remove`，渲染页只做退出动画 |
| R3 | 计划审批卡底层复用 `requestUserClarification`，也发 `cyrene.choice`（`agui-bridge.ts:238-244`），存在 plan-review + ask-choice 双弹风险 | **分类互斥规则**：`cyrene.plan.review` 先到即标记该 runId，同 runId 的 choice 卡归 plan-review，不进 ask-choice 路径，见 §7 |
| R4 | 窗口位置依赖聊天窗口存在，聊天窗口销毁后无 display 可查 | **四级回退链**：聊天窗口 → lastKnownChatDisplay → 鼠标所在 display → primaryDisplay，见 §6.4 |
| R5 | `ToastItem.target` 全 optional，可合法构造空对象，跳转契约不闭合 | **改可辨识联合 `ToastTarget`**（card / message / window 三型），禁止空目标 |
| R6 | 单窗口堆叠无高度协议：窗口过高挡鼠标、过矮裁卡片 | **固定宽 + ResizeObserver 上报 + 主进程 clamp + 最多 4 条**，见 §6.4 |
| R7 | 点击后 toast 消不消失未定义 | **点击即视觉消隐**（notify 连生命周期一起结束；action-pending 保留去重记忆等结算），见 §6.1 |
| R8 | "scheduler 零改动"写死了，但 `publishSchedulerFinished` 当前只带 `taskId/schedulerRunId/status/durationMs`（`scheduler-runner.ts:153-158`），无跳转目标 | 改为「优先零改动，施工前核对 payload」；V1 点击 task-finished 降级为打开任务窗口，见 §7 |
| R9 | IPC `toast:clicked` 若让渲染端反传 target，跳转逻辑分裂到两端 | **只传 toast id**，target 由主进程查 `activeToasts` 权威解析；并校验 sender 是 toast 窗口 |
| R10 | 多条 toast 并发到达（同时完成/完成+待确认）的行为未定义 | 新增 §6.6 并发与时序规则（分组排序、音效档位优先） |

---

## 1. 定位与验收标准

> **Toast 中心是 Cyrene 的统一注意力出口：凡是"有事在等用户看/等用户操作"的事件，都从右下角同一个窗口弹出，带应用自有音效，点击直达对应会话与卡片。**

一句话架构原则（Rev 2 确立）：

> **ToastService 是 Toast 生命周期的唯一权威所有者（authoritative owner）——创建、去重、抑制、超时、结算清退全部在主进程决策；toast 渲染页只负责显示、动画、音效和用户输入上报。**

不做什么：

- 不是通知历史中心（V1 不存历史，toast 消隐即结束）
- 不是消息通道（不承载完整内容流，只承载"注意 + 摘要 + 跳转"）
- 不替代聊天流（审批卡、选择卡、抽查卡仍在会话流内，toast 只是唤起入口）

一句话验收标准（V1 最小闭环）：

```text
用户把聊天窗口最小化，去干别的事
 → 昔涟跑到 write_plan，停在 PLAN_REVIEW 等批准
 → 右下角弹出 toast「计划已写好，等你批准」+ 应用内音效
 → 用户点击 toast → 聊天窗口激活并定位到该会话的审批卡，toast 消隐
 → 批准（结算事件）→ 去重记忆清除，若再发起可正常再弹
```

---

## 2. 提醒类型与分档

五类提醒，两档行为。分档依据：**agent 是否处于挂起等待状态**。

| 类型 | 档位 | 事件源（均现有） | agent 状态 |
|---|---|---|---|
| 一、定时任务完成 | 通知档 | `SCHEDULER_EVENT`（run 终态） | 已做完事 |
| 二、权限审批 | 等待操作档 | 审批 pending + `PERMISSION_APPROVAL_SETTLED` | 挂起等批准 |
| 三、ASK 工具（ask_user_choice） | 等待操作档 | `cyrene.choice` / `cyrene.choice.dismiss` | 挂起等选择 |
| 四、抽查工具（pop_quiz） | 等待操作档 | quiz 卡片推送 + 跳过/结算广播 | 挂起等作答 |
| 五、计划写好（write_plan → PLAN_REVIEW） | 等待操作档 | `cyrene.plan.review` + 计划审批卡 | 挂起等批准 |

两档的参数差异：

| 参数 | 等待操作档 | 通知档 |
|---|---|---|
| 自动消隐 | **否**（agent 在等，不能自己消失） | 是（10s，主进程定时器） |
| 音效 | 引起注意型（`toast-action.mp3`） | 轻提示型（`toast-notify.mp3`） |
| 手动关闭 | 允许（视觉消失，去重记忆保留到结算，见 §6.1） | 允许（即终局） |
| 点击动作 | 激活 + 定位卡片 + **toast 视觉消隐**（去重记忆保留） | 激活 + 定位 + toast 生命周期结束 |
| 聊天窗口聚焦时抑制 | **否**（长输出流里卡片易被滚没，弹有价值） | **是**（用户正看着现场，再弹是打扰，判定条件见 §6.2） |

补充：未来第六类「run 失败/超时」与任务完成同源（`finishRun` 统一终态），归通知档，V1 不做。

---

## 3. 与现有模块的边界

```text
src/main/
├── scheduler/          ← 优先零改动（施工前核对 SCHEDULER_EVENT 载荷，见 §7）
├── agui-bridge.ts      ← 零改动（choice/plan 事件已存在）
├── approval 相关        ← 零改动（10s 重播 + 结算广播已存在）
├── learn/ pop_quiz 相关 ← 零改动（卡片推送 + 结算广播已存在）
├── windows/window-manager.ts ← 扩展：新增 toast 窗口创建（与 call/music 窗口并列）
├── application/        ← 扩展：组合根装配 ToastService
└── toast/              ← 新增
    ├── toast-service.ts        生命周期权威：汇聚 + 归一化 + 去重 + 抑制 + 超时 + 结算清退
    ├── toast-window.ts         toast 窗口生命周期（单常驻窗口，显隐/定位/高度协议）
    └── types.ts                ToastItem / ToastTarget / ToastKind / ToastTier 等契约
```

**禁止事项**：`toast/` 不得 `import` ChatService / Harness / CyreneAgent / scheduler 内部模块。所有事件输入通过订阅既有 IPC 推送流或组合根注入的回调获得；窗口操作通过 window-manager 接口，不直接 `new BrowserWindow`。

---

## 4. 架构与数据流

```text
┌────────────────────────────── 主进程 ──────────────────────────────┐
│                                                                    │
│  事件源（全部既有）                                                  │
│  ├─ SCHEDULER_EVENT（任务终态）                                     │
│  ├─ 审批 pending 广播 + PERMISSION_APPROVAL_SETTLED                 │
│  ├─ cyrene.choice / cyrene.choice.dismiss（ASK + 计划审批卡）        │
│  ├─ pop_quiz 卡片推送 + 结算广播                                    │
│  └─ cyrene.plan.review                                             │
│         │                                                          │
│         ▼                                                          │
│  ToastService（新增，生命周期唯一权威）                               │
│  ├─ activeToasts: Map<toastId, ToastItem>   当前显示中的             │
│  ├─ pendingSeen: Set<kind+sourceId>         已提醒去重记忆（仅等待档）│
│  ├─ 归一化：事件 → ToastItem；plan.review 标记 runId 分类互斥（§7）   │
│  ├─ 去重：pendingSeen 命中即忽略（重播不重弹）                         │
│  ├─ 抑制：通知档「看着现场」判定（§6.2）                              │
│  ├─ 超时：通知档 10s 主进程定时器，到点主动 remove                     │
│  └─ 结算：settled → 清 pendingSeen + remove 可见的                   │
│         │                                                          │
│         ▼                                                          │
│  ToastWindow（新增，单常驻 BrowserWindow）                           │
│  ├─ activeToasts 空 → 整窗 hide（不销毁）                            │
│  └─ 非空 → 显示器回退链选屏（§6.4）→ 高度协议 setBounds → showInactive│
│         │  IPC: toast:*                                            │
│         ▼                                                           │
└────────────────────────────────────────────────────────────────────┘
┌────────────────────── toast 渲染页（新增，纯表现层） ────────────────┐
│  纵向堆叠的 toast 卡片列表（HTML 元素，非多窗口）                     │
│  ├─ 点击/关闭 → IPC 上报 toast id（不反传 target，§5.2）             │
│  ├─ 收 toast:remove → 播退出动画后从 DOM 移除                        │
│  ├─ ResizeObserver → 上报内容高度（高度协议，§6.4）                   │
│  └─ 进队时播音效（<audio>，按档位选文件，§6.3）                       │
└────────────────────────────────────────────────────────────────────┘
```

关键设计：

- **单常驻窗口 + 内部堆叠**：多 toast 是同一窗口内的 HTML 元素纵向排列，避免反复创建销毁窗口的开销与闪烁
- **生命周期权威在主进程**：渲染页任何时刻都不知道"某 toast 是否还该存在"，只被动响应 push/remove
- **纯消费者**：ToastService 只订阅既有事件流，不向事件源回写任何东西

---

## 5. 核心契约

### 5.1 ToastItem 与 ToastTarget

```ts
/** 档位：等待操作（agent 挂起）/ 通知（事情已发生） */
export type ToastTier = "action-pending" | "notify";

/** 提醒类别：任务完成 / 权限审批 / ASK 选择 / 抽查 / 计划审批 */
export type ToastKind = "task-finished" | "approval" | "ask-choice" | "pop-quiz" | "plan-review";

/** 跳转目标：可辨识联合，禁止空对象。跳转由主进程解析（§5.2） */
export type ToastTarget =
  | { type: "card"; sessionId: string; anchor: string }         // 定位到会话内卡片（等待操作档）
  | { type: "message"; sessionId: string; messageId: string }   // 定位到会话内消息（通知档）
  | { type: "window"; window: "tasks" }                         // 无会话落点（任务窗口）

export interface ToastItem {
  id: string;              // toast 自身 id（nanoid）
  kind: ToastKind;
  tier: ToastTier;
  /** 去重与结算匹配的业务身份：审批 id / 选择卡 runId / quizId / schedulerRunId */
  sourceId: string;
  title: string;           // 如「昔涟在等你的批准」「计划已写好」
  summary?: string;        // 一行摘要（任务标题 / 卡片问题截断）
  target: ToastTarget;
  createdAt: number;
}
```

说明：`ToastTarget` 不复用 `WindowActivationRequest`（后者是窗口级激活请求，无卡片/消息锚点语义），但激活动作本身走既有 activation broker，anchor 定位由聊天渲染端处理——主进程只负责把 `{激活请求, anchor}` 转发过去。

### 5.2 IPC 通道（`src/shared/ipc-channels.ts` 新增）

```text
main → renderer(toast 窗口)：
  toast:push        推送/更新 ToastItem（同 id 覆盖）
  toast:remove      主进程已决定移除该 toast（手动关闭回执 / 点击消隐 / 通知档超时 / 结算清退）
renderer(toast 窗口) → main：
  toast:clicked     { id }   用户点击主体
  toast:dismissed   { id }   用户点关闭按钮
  toast:resize      { height }  内容区实际高度（高度协议）
```

契约硬规则：

- **renderer → main 只传 toast id，不反传 target**。主进程收到后查 `activeToasts` 拿权威 ToastItem，再解析跳转。渲染端永远不决定"跳哪里"
- **sender 校验**：所有 `toast:*` renderer→main 通道校验 `event.sender === toast 窗口的 webContents`，其他来源直接忽略
- `toast:remove` 到达渲染页后，渲染页播放退出动画（约 200ms）再从 DOM 移除；动画期间该 id 的新 push 按同 id 覆盖处理

---

## 6. 关键规则

### 6.1 状态机与去重分离（硬规则）

「屏幕上显示什么」和「哪些业务已提醒过」是两个独立问题，必须用两个结构：

```text
activeToasts: Map<toastId, ToastItem>   当前显示中的 toast（可见状态）
pendingSeen:  Set<kind + sourceId>      已提醒过的业务事件（去重记忆，仅等待操作档）
```

等待操作档状态机：

```text
业务 pending，事件首次到达
  → pendingSeen.add(key) + activeToasts.set(id) + toast:push + 播音效
  → 状态：VISIBLE

用户点关闭 或 点击主体（点击会先激活跳转）
  → activeToasts.delete(id) + toast:remove
  → pendingSeen 保留不动
  → 状态：DISMISSED（视觉消失，业务仍 pending）

DISMISSED 期间 10s 重播到达
  → pendingSeen 命中 → 忽略，不重弹（用户已知情，关不掉的弹窗=骚扰）

结算信号到达（批准/选择/作答/计划批准或超时）
  → pendingSeen.delete(key)
  → 若 activeToasts 还有对应项 → 一并 remove
  → 状态：DONE（此后同一业务重新 pending 会正常再弹）
```

通知档（无结算概念，简单得多）：

```text
事件到达（未命中抑制）→ activeToasts.set + toast:push + 播音效
  ├─ 10s 超时（主进程定时器）→ remove
  ├─ 用户点击 → 激活跳转 + remove（生命周期结束）
  └─ 用户关闭 → remove（生命周期结束）
通知档不进 pendingSeen —— schedulerRunId 每次运行唯一且无重播机制，
若进集合会随历史无限增长（Rev 2 修正）
```

### 6.2 焦点抑制（仅通知档）

抑制的准确语义是「用户正看着事件发生的现场」，而不是「聊天窗口开着」。用户可能开着聊天窗口但在别的会话、或在插件/设置等其他窗口，这些情况下都不构成"看着现场"，不该抑制：

- 通知档（任务完成）的抑制条件：**聊天窗口存在且聚焦，且当前激活会话 === 事件所属会话**，三者同时满足才跳过
- 当前激活会话取自既有机制：`activeChatTargetRegistry` / `getActiveChatSessionId()`（`chat-ui-ipc.ts:279`，渲染端切会话时已上报），ToastService 判断时查询即可
- 等待操作档不受此规则约束：即使聚焦在正确的会话上，长输出流里卡片也可能被滚没，弹仍有价值
- 用户在其他窗口（插件界面/设置窗/任务窗）时聊天窗口必然失焦，两档都正常弹，点击经 activation broker 拉回聊天窗口
- 判断时机：事件到达 ToastService 时检查，不做持续监听

### 6.3 音效

- 两档各一个音效，已就位（`src/renderer/react/assets/`，用户提供）：
  - `toast-notify.mp3`（原 down.mp3）→ 通知档（任务完成）
  - `toast-action.mp3`（原 review.mp3）→ 等待操作档（审批/ASK/抽查/计划）
- **并发合并规则**：300ms 合并窗口内多条 toast 同时进队，只播一次，取其中**档位最高**的音效（action-pending > notify）——重要提醒的音效优先，轻提示让路
- V1 不做音效库与用户自定义
- 音效随 toast 窗口渲染页播放（`<audio>`，Electron 无自动播放限制），不经过音乐播放器 / TTS 通道
- 设置页暴露一个总开关（默认开）；不提供分档开关（V1）

### 6.4 窗口行为

**显示位置——四级回退链**（聊天窗口可能已销毁，Rev 2 修正）：

```text
1. 聊天窗口存在            → 其所在 display 的右下角
2. lastKnownChatDisplay    → 聊天窗口每次移动/显示/聚焦时记录的最近 display
3. 鼠标所在 display        → screen.getCursorScreenPoint() 判断
4. primaryDisplay          → 最终兜底
```

用户最后一次把 Cyrene 放在哪块屏幕，toast 大概率也应该在那里出来，所以优先用 lastKnownChatDisplay 而非鼠标位置。

**高度协议（单窗口堆叠的必备行为）**：

```text
固定宽度（如 360px）
+ 渲染页 ResizeObserver 监听内容实际高度
+ toast:resize { height } 上报主进程
+ 主进程 clamp：min(内容高度, 所在 display 工作区高度 × 60%)
+ setBounds 调整窗口尺寸
```

- 不预留大块透明区域（挡后面窗口的鼠标操作），也不裁切内容
- **最多同时显示 4 条**：等待操作档优先占位，超出部分容器内部滚动——等待操作档不会自动消失，不设上限理论上可无限堆

**其他**：

- 无边框、透明、置顶（`alwaysOnTop: screen-saver` 级，桌宠窗口已趟过此路径）、`showInactive`（绝不偷焦点）、`skipTaskbar: true`
- 队列空 → `hide()`；有新 toast → 走回退链选屏 → 高度协议 → `showInactive()`
- toast 窗口不计入 `window-all-closed` 语义（隐藏窗口不触发该事件，需在测试中验证确认）

### 6.5 应用启动与退出

- 启动时 toast 窗口**预创建但隐藏**（提前加载渲染页，首次弹出零延迟）
- 应用退出走既有 `before-quit` 受控清理，toast 窗口随进程销毁，无额外清理逻辑
- **重启恢复：V1 不做**。toast 是瞬态提醒，重启后审批/抽查卡有各自的 10s 重播机制兜底，会话流内卡片不丢

### 6.6 并发与时序（多 toast 同时到达）

多条 toast 并发到达是常态（两个会话同时完成任务、一个完成 + 一个待确认同时弹出），单窗口堆叠天然支持，规则如下：

**分组排序**：

```text
┌─────────────────────┐
│  上组：等待操作档      │ ← 稳定区，不自动消失，按 createdAt 排序
├─────────────────────┤
│  下组：通知档          │ ← 流动区，按 createdAt 排序，10s 流式消失
└─────────────────────┘
```

- 等待操作档固定在上组：通知档在下方进出消失时，不会把等待操作的卡片顶得跳动
- 同组内按创建时间排序，新的在后（更靠近屏幕角落）

**去重互不干扰**：去重键是 `(kind, sourceId)`，两个会话各自完成任务 = 两个不同 `schedulerRunId`，各自弹各自的；两个等待确认并存（如两个会话各有审批）时都保留、都常驻，用户逐个处理，结算一个清一个

**音效**：并发到达按 §6.3 合并规则，只播一次、取最高档位的音效

---

## 7. 五类事件的接入映射

| 事件源 | 触发时机 | kind / sourceId | 结算信号 |
|---|---|---|---|
| `SCHEDULER_EVENT` 终态 | run 到 success（失败不弹，V1） | `task-finished` / `schedulerRunId` | 无（通知档，主进程 10s 超时） |
| 审批 pending 广播 | 审批请求创建 | `approval` / 审批 id | `PERMISSION_APPROVAL_SETTLED` |
| `cyrene.choice`（ASK 选择卡） | ask_user_choice 卡片推送 | `ask-choice` / `runId + 卡片 id` | `cyrene.choice.dismiss` |
| pop_quiz 卡片推送 | 抽查出题 | `pop-quiz` / `quizId` | quiz 结算广播（提交/跳过/run 终态） |
| `cyrene.plan.review` + 审批卡 | write_plan 进 PLAN_REVIEW | `plan-review` / `runId` | 计划卡结算（批准/修改/超时） |

**plan-review 与 ask-choice 的分类互斥（硬规则，Rev 2 新增）**：

计划审批卡通过 `sendPlanCard` 发送时事件名同样是 `cyrene.choice`（`agui-bridge.ts:238-244`），不加规则必然双弹（「计划已写好」+「有个问题需要选择」同时出现）。规则：

1. `cyrene.plan.review` 总是先于计划审批卡到达（同一 `startPlanReviewFlow` 内先发 review 再发卡）
2. ToastService 收到 `cyrene.plan.review` 时，把该 `runId` 登记为 plan 流
3. 后续 `cyrene.choice` 若携带已登记的 `runId` → 归类 `plan-review`，**不进 ask-choice 路径**
4. 计划补充卡（revision 2）与审批卡同 `runId` → 命中 pendingSeen 去重，不重复弹（用户刚点完「我要修改」，正在流程中）
5. runId 登记随计划卡结算清除

**task-finished 的跳转目标（Rev 2 修正）**：

`publishSchedulerFinished` 当前载荷只有 `taskId / schedulerRunId / status / durationMs`（`scheduler-runner.ts:153-158`），且调度执行无桌面会话（`threadId: scheduler-*`），结果落在任务历史而非聊天流。因此：

- V1 点击 task-finished → `ToastTarget { type: "window", window: "tasks" }`，激活任务窗口看历史
- 施工前核对聊天侧对 SCHEDULER_EVENT 的呈现：若存在会话化展示与消息锚点，升级为 `message` target——届时只扩展事件载荷，不侵入 scheduler 执行逻辑
- toast 内容取 `taskTitle`（事件已带）+ 结果摘要（`ScheduledTaskHistoryEntry.outputPreview` 已有 160 字预览）

---

## 8. 实现范围拆分（施工顺序建议）

| 步骤 | 内容 | 依赖 |
|---|---|---|
| C1 | `toast/types.ts` + IPC 通道定义 + `ToastItem`/`ToastTarget` 契约 | 无 |
| C2 | `ToastWindow`：窗口创建/显隐/四级回退定位/高度协议 + toast 渲染页（静态卡片、堆叠、退出动画） | C1 |
| C3 | `ToastService`：状态机（activeToasts/pendingSeen 分离）+ 事件汇聚 + plan/ask 分类互斥 + 结算清退，先只接「等待操作档」四类 | C1、C2 |
| C4 | 通知档接入（SCHEDULER_EVENT 终态）+ 焦点抑制 + 主进程超时定时器 + 音效 | C3 |
| C5 | 组合根装配 + 设置页音效开关 + 收尾测试 | C4 |

每步全量测试后单独 commit（沿用 C1→C7 施工约定）。

---

## 9. 测试要点

ToastService 单测：

- 去重状态机：action toast 手动关闭后，10s 重播不得重弹
- action toast 手动关闭后，settled 必须清 pendingSeen（此后重新 pending 可再弹）
- settled 到达时 toast 仍可见 → 必须同步 remove
- notify 10s 超时后 main 与 renderer 都不存在该项（主进程定时器为权威）
- PLAN_REVIEW 流程不得同时生成 plan-review + ask-choice 两张 toast
- 补充卡（revision 2）不重复弹
- 通知档焦点抑制三条件（窗口聚焦 + 会话一致才抑制）
- 并发：同时到达多条（两完成 / 完成+待确认 / 两待确认）分组排序正确、音效只播一次

ToastWindow 单测：

- 聊天窗口已销毁时仍可正确选择显示器（回退链逐级）
- 连续 5+ 条 toast 时窗口高度不越出 workArea 的 60%，不产生大块透明鼠标遮挡区
- 队列空隐藏/非空显示、showInactive 不夺焦点（mock BrowserWindow 断言调用）

IPC 集成测试：

- push/remove/clicked/dismissed/resize 往返；clicked/dismissed 只带 id；非 toast 窗口 sender 被拒

手工验收：

- 五类场景各一条：定时任务跑完、审批等待、ASK 卡、抽查卡、计划审批
- 回归确认：toast 窗口存在时 `window-all-closed` 不触发应用退出路径异常

---

## 10. 明确不做（V1 边界）

- TTS 语音播报（#82 作者的增强层，等 toast 地基合并后再议）
- 通知历史/通知中心
- 免打扰时段（设置页已有静音类开关体系时可顺势加，V1 只做音效总开关）
- 音效自定义/音效库
- Windows 系统通知兜底（独立窗口方案下无必要；若未来用户反馈"连 toast 窗口都不想看到"，再议）
- run 失败/超时提醒（第二期候选）
- 插件 API 暴露（无真实插件需求前不进 API v1 契约）
