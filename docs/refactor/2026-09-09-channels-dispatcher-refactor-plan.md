# Channels Dispatcher（渠道消息调度器）Refactor（重构）Implementation Plan（实施计划）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 修复渠道回复在发送失败后仍污染历史的正确性缺陷，统一外部会话和绑定桌面对话的执行顺序，并把 ChannelDispatcher 收敛为职责清晰、依赖不可变的消息编排器。

**Architecture:** 保留 IncomingMessage、OutgoingMessage、MessageHandler 和 ChannelAdapter 的现有公共契约。ChannelDispatcher 在外部 session（会话）队列内解析绑定，再在绑定 conversation（桌面对话）队列内执行完整消息流程；它调用独立的限速、上下文、出站组装和传输模块，但继续通过函数注入复用现有 Agent（智能体）、日志、历史和桌面广播能力。

**Tech Stack:** TypeScript 5.6、Electron 43、Vitest 4、Node.js 标准库；不新增运行时依赖。

**Spec:** docs/refactor/2026-09-09-channels-dispatcher-refactor-plan.md#设计规格

## Global Constraints

- 不改变 src/main/channels/types.ts 中 IncomingMessage、OutgoingMessage、OutgoingPart、MessageHandler 和 ChannelAdapter.send 的现有签名。
- 不在本轮扩展 Adapter 发送结果；ok: true 只表示 Adapter 层的尽力确认，不保证全部片段严格送达。
- Adapter 明确返回 ok: false 或抛出异常时，不得提交 assistant 历史、出站日志、绑定桌面对话回复或 bot:outgoing 镜像。
- 同一外部 session 必须串行；多个外部 session 绑定同一桌面 conversation 时也必须串行；不同且无共享上下文的会话保持并行。
- 本轮仅保证外部渠道之间的执行顺序。桌面端与外部渠道同时运行同一 conversation 的全局互斥不在本计划范围内。
- buildAndRunAgent、broadcastChat、appendLog、appendHistory 和 appendBoundConversationMessage 保持函数注入，不为单一实现增加包装接口。
- 优先复用 proactive-delivery.ts 的“发送后提交”语义，以及 QQ、QQ Bot 已验证的 Promise（异步承诺）队列模式。
- 所有生产代码改动必须由失败测试驱动；每个任务完成后运行该任务测试和 channels 相关回归测试。
- 不修改用户当前 dist/renderer 下的未提交文件。

---

## 设计规格

### 1. 当前问题

src/main/channels/dispatcher.ts 当前同时负责：

- 用户和渠道限速；
- sessionId 生成与反查；
- 外部聊天观察和主动发送目标记录；
- 绑定桌面对话解析；
- 渠道历史与桌面历史加载；
- Agent 调用；
- 文本分段、TTS（文本转语音）、表情解析和渠道能力降级；
- 入站与出站日志；
- 渠道历史和绑定桌面对话持久化；
- 桌面消息镜像。

这带来三个已确认的正确性问题：

1. Dispatcher 在 ChannelManager 调用 adapter.send 之前就写入 assistant 历史和出站镜像。明确发送失败时，下一轮 Agent 仍会看到一条用户实际上没有收到的回复。
2. Dispatcher 的历史算法依赖“先加载旧历史，再追加本条消息”的顺序，但微信和飞书没有统一的会话级串行保障。
3. conversation-binding-store 允许多个外部 session 指向同一个 conversationId。仅按外部 sessionId 排队仍会让共享桌面对话并发读取同一份旧历史。

另外有两个需要同期收敛的问题：

- RateLimiter 先消费用户额度，再检查渠道额度，导致被渠道限额拒绝的消息仍消耗用户额度。
- TTS 文件使用同步文件写入、基于 Date.now 的文件名，且没有统一的临时文件清理边界。

### 2. 目标数据流

~~~text
Adapter
  -> ChannelManager.makeAdapterHandler
  -> ChannelDispatcher.handleIncoming
       -> external session queue
            -> resolve binding snapshot
            -> optional bound conversation queue
                 -> tryConsume rate limit
                 -> record incoming state
                 -> load prior context
                 -> append current user message
                 -> buildAndRunAgent
                 -> compose outgoing message
                 -> delivery.send
                 -> if adapter acknowledgement is ok
                      -> commit assistant history
                      -> commit outgoing log
                      -> commit bound conversation reply
                      -> broadcast bot:outgoing
                 -> finally remove transient files
~~~

入站消息一旦被系统接受，就可以在 Agent 或发送失败时继续保留入站日志和 user 历史。只有 assistant 侧状态受发送确认边界约束。

### 3. 两层执行键

不能在 external sessionId 和 bound conversationId 之间二选一，因为绑定变化可能让同一外部会话的相邻消息落到不同队列。Dispatcher 必须先持有外部 session 队列，再在其中解析绑定并可选进入桌面对话队列：

~~~ts
async handleIncoming(msg: IncomingMessage): Promise<OutgoingMessage | null> {
  const sessionId = makeSessionId(msg.channel, msg.chatId);

  return this.deps.queue.run(`external:${sessionId}`, async () => {
    const boundConversationId = this.deps.resolveBoundConversationId?.(sessionId) ?? null;
    const execute = () => this.processIncoming(msg, { sessionId, boundConversationId });

    return boundConversationId
      ? this.deps.queue.run(`conversation:${boundConversationId}`, execute)
      : execute();
  });
}
~~~

不变量：

- 相同 external key 永远不会并行；
- 相同 conversation key 永远不会并行；
- 绑定只解析一次，并作为本条消息的快照传入 processIncoming；
- processIncoming 不得再次查询绑定，以免队列键与实际读写目标不一致；
- key 必须包含 external: 或 conversation: 命名空间。

### 4. 发送后的提交边界

ChannelDeliveryService 只负责查找 Adapter、调用 send、捕获异常和归一化结果：

~~~ts
export type DeliveryResult =
  | { ok: true }
  | { ok: false; error: string };

export interface ChannelDeliveryService {
  send(message: OutgoingMessage): Promise<DeliveryResult>;
}
~~~

历史、日志和桌面镜像仍由 Dispatcher 编排：

~~~ts
const prepared = await this.deps.composeOutgoing(input);

try {
  const delivery = await this.deps.delivery.send(prepared.message);
  if (!delivery.ok) {
    this.recordDeliveryFailure(msg, delivery.error);
    return null;
  }

  await this.commitAssistantState(msg, context, prepared);
  return prepared.message;
} finally {
  await cleanupTransientFiles(prepared.transientFiles);
}
~~~

这里不是数据库式原子事务。现有 NapCat、QQ Bot 和微信 Adapter 在部分片段成功时可能返回 ok: true，因此本轮只修复“明确失败仍提交完整 assistant 状态”的错误。

### 5. 模块边界

计划完成后的文件职责：

| 文件 | 职责 |
| --- | --- |
| dispatcher.ts | 两层排队和消息流程编排；不直接导入 Electron、fs 或模块级 manager 单例 |
| keyed-queue.ts | 按 key 串行、不同 key 并行、积压上限和空队列清理 |
| rate-limiter.ts | 原子检查并消费用户与渠道额度；过期桶清理 |
| channel-context.ts | sessionId、历史迁移、绑定历史选择、user/assistant 上下文写入 |
| outgoing-composer.ts | 文本分段、TTS、表情解析、能力降级和临时文件声明 |
| delivery-service.ts | Adapter 查找、send 调用、异常归一化 |
| proactive-delivery.ts | 保留逐段发送和按实际 deliveredTexts 提交的业务语义，复用底层发送能力 |
| manager.ts | Adapter 注册和生命周期；不再重复执行 adapter.send |
| bootstrap.ts | 一次性构造 Dispatcher 和依赖，取代模块级可变 setter |

### 6. 最终核心类型

~~~ts
export interface KeyedQueue {
  run<T>(key: string, task: () => Promise<T>): Promise<T>;
}

export interface ChannelRateLimiter {
  tryConsume(channel: ChannelId, senderId: string): boolean;
  reconfigure(limits: { perUser: number; perChannel: number }): void;
  reset(): void;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content?: string;
}

export interface DispatchContext {
  sessionId: string;
  boundConversationId: string | null;
}

export interface PreparedOutgoing {
  message: OutgoingMessage;
  assistantText: string;
  stickerId?: string;
  transientFiles: string[];
}

export interface ComposeOutgoingInput {
  incoming: IncomingMessage;
  replyText: string;
  sticker: string | null;
  capability?: ChannelCapability;
  settings: Pick<ChannelsSettings, "ttsEnabled" | "stickerEnabled">;
  mobileMessageSegmentation?: MobileMessageSegmentationMode;
}

export interface OutgoingComposer {
  compose(input: ComposeOutgoingInput): Promise<PreparedOutgoing>;
  cleanupTransientFiles(files: readonly string[]): Promise<void>;
}

export interface ChannelContext {
  resolvePriorMessages(context: DispatchContext, limit: number): Promise<ChatMessage[]>;
  appendIncomingContext(msg: IncomingMessage, context: DispatchContext): Promise<void>;
  appendAssistantContext(
    msg: IncomingMessage,
    context: DispatchContext,
    prepared: PreparedOutgoing,
  ): Promise<void>;
}

export type DeliveryResult =
  | { ok: true }
  | { ok: false; error: string };

export interface ChannelDeliveryService {
  send(message: OutgoingMessage): Promise<DeliveryResult>;
}

export type BuildAndRunAgent = (
  msg: IncomingMessage,
  sessionId: string,
  priorMessages?: ChatMessage[],
) => Promise<{ text: string; sticker: string | null }>;

export type ObserveExternalChat = (sessionId: string, msg: IncomingMessage) => void;

export type BroadcastChannelMessage = (event: {
  type: "bot:incoming" | "bot:outgoing";
  channel: string;
  senderId: string;
  senderName?: string;
  chatId: string;
  text: string;
  at: number;
}) => void;
~~~

### 7. 错误策略

| 阶段 | 行为 |
| --- | --- |
| 外部会话观察失败 | 警告并继续 |
| 绑定查询失败 | 使用 null 绑定快照，回退到渠道上下文 |
| 绑定历史加载失败 | 回退到渠道历史 |
| 入站日志或 user 历史写入失败 | 警告并继续 |
| Agent 调用失败 | 写 error 日志，返回 null |
| TTS 合成失败 | 降级为纯文本 |
| 表情解析失败 | 跳过表情，保留文本 |
| Adapter 缺失、返回 false 或抛异常 | 写 error 日志，不提交 assistant 状态 |
| assistant 提交中的非关键镜像失败 | 警告；已确认的发送结果不回滚 |
| 临时文件删除失败 | 警告，不改变发送结果 |

### 8. 明确不做的事项

- 不新增消息数据库或分布式队列。
- 不改变 Adapter 的部分成功语义。
- 不为每个函数依赖创建只有一个实现的 Service 接口。
- 不把桌面聊天运行路径纳入本轮队列；如果产品要求桌面和渠道共享严格顺序，应单独设计进程级 ConversationExecutionCoordinator。
- 不重写历史存储格式，不迁移现有 JSONL 文件。
- 不改变渠道回复文本、表情选择和 TTS 开关的用户可见行为。

---

## 实施计划

### Task 1: 用回归测试锁定发送确认边界

**Files:**
- Modify: src/main/channels/manager.test.ts
- Modify: src/main/channels/dispatcher.test.ts
- Modify: src/main/channels/manager.ts:16-17,126-157
- Modify: src/main/channels/dispatcher.ts:464-530

**Interfaces:**
- Consumes: 现有 ChannelAdapter.send、ChannelDispatcher.handleIncoming 和 DispatcherDeps 函数依赖。
- Produces: 明确失败不提交 assistant 状态；ChannelManager 不再二次发送 Dispatcher 已处理的消息。

- [ ] **Step 1: 添加 Manager 不发送返回值的失败测试**

在 manager.test.ts 增加：

同时把 Vitest 导入修改为：

~~~ts
import { describe, expect, it, vi } from "vitest";
~~~

~~~ts
it("delegates inbound processing without sending the returned message again", async () => {
  const mgr = new ChannelManager();
  const adapter = fakeAdapter("qq");
  const send = vi.spyOn(adapter, "send");
  mgr.register(adapter);
  mgr.setDispatcher(async () => ({
    channel: "qq",
    targetId: "chat-1",
    parts: [{ kind: "text", text: "已由 dispatcher 发送" }],
  }));
  await mgr.startOne("qq" as never);

  await adapter.onMessage?.({
    channel: "qq",
    chatId: "chat-1",
    senderId: "user-1",
    text: "你好",
    at: new Date(0),
  });

  expect(send).not.toHaveBeenCalled();
});
~~~

- [ ] **Step 2: 运行测试并确认它在旧实现上失败**

Run: npx vitest run src/main/channels/manager.test.ts

Expected: 新测试 FAIL，send 被调用一次。

- [ ] **Step 3: 将实际发送移动到 Dispatcher 的确认边界内**

此任务先复用现有 deps.manager.getAdapter，不提前引入临时 setter 或新抽象：

~~~ts
const adapter = this.deps.manager.getAdapter(outgoing.channel);
if (!adapter) {
  this.recordDeliveryFailure(msg, "adapter_not_found");
  return null;
}

let delivery: { ok: boolean; error?: string };
try {
  delivery = await adapter.send(outgoing);
} catch (error) {
  delivery = {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

if (!delivery.ok) {
  this.recordDeliveryFailure(msg, delivery.error ?? "send_failed");
  return null;
}
~~~

仅在 ok: true 后执行原有 bot:outgoing 广播、outgoing 日志、assistant 历史和绑定桌面对话写入。

从 ChannelManager.makeAdapterHandler 删除 adapter.send(outgoing) 分支，使 Manager 只调用 dispatchFn 并返回其结果。

- [ ] **Step 4: 添加明确发送失败不提交 assistant 状态的测试**

在 dispatcher.test.ts 增加：

~~~ts
it("does not commit assistant state when adapter delivery explicitly fails", async () => {
  const appendBoundConversationMessage = vi.fn();
  const broadcastChat = vi.fn();
  const send = vi.fn(async () => ({ ok: false, error: "offline" }));
  const dispatcher = new ChannelDispatcher({
    manager: {
      getAdapter: () => ({
        capability: {
          text: true,
          image: true,
          audio: false,
          file: false,
          video: false,
          markdown: false,
          card: false,
          sticker: false,
          maxTextLength: 4000,
        },
        send,
      }),
    } as any,
    resolveBoundConversationId: () => "conversation-1",
    loadBoundConversationHistory: vi.fn(async () => []),
    appendBoundConversationMessage,
    broadcastChat,
    buildAndRunAgent: vi.fn(async () => ({ text: "回复", sticker: null })),
  });

  const result = await dispatcher.handleIncoming(makeIncoming());

  expect(result).toBeNull();
  expect(send).toHaveBeenCalledOnce();
  expect(appendBoundConversationMessage).toHaveBeenCalledTimes(1);
  expect(appendBoundConversationMessage).toHaveBeenCalledWith(
    "conversation-1",
    "user",
    "你好",
    expect.anything(),
  );
  expect(broadcastChat).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "bot:outgoing" }),
  );
});
~~~

- [ ] **Step 5: 运行回归测试**

Run: npx vitest run src/main/channels/manager.test.ts src/main/channels/dispatcher.test.ts src/main/channels/dispatcher-capability.test.ts src/main/channels/proactive-delivery.test.ts

Expected: PASS。

- [ ] **Step 6: 提交独立正确性修复**

~~~bash
git add src/main/channels/manager.ts src/main/channels/manager.test.ts src/main/channels/dispatcher.ts src/main/channels/dispatcher.test.ts
git commit -m "fix(channels): commit assistant state only after delivery"
~~~

### Task 2: 抽取并修复原子限速器

**Files:**
- Create: src/main/channels/rate-limiter.ts
- Create: src/main/channels/rate-limiter.test.ts
- Modify: src/main/channels/dispatcher.ts:63-100,243-269,277-281

**Interfaces:**
- Consumes: ChannelId，以及 rateLimitPerUser、rateLimitPerChannel 设置值。
- Produces: createChannelRateLimiter、ChannelRateLimiter.tryConsume 和 reset。

- [ ] **Step 1: 编写渠道拒绝不消费用户额度的测试**

~~~ts
import { describe, expect, it } from "vitest";
import {
  createChannelRateLimiter,
  pruneExpiredRateLimitBuckets,
} from "./rate-limiter";

describe("ChannelRateLimiter", () => {
  it("渠道额度拒绝时不消费用户额度", () => {
    let now = 0;
    const limiter = createChannelRateLimiter({
      limits: { perUser: 2, perChannel: 2 },
      now: () => now,
    });

    expect(limiter.tryConsume("qq", "other-user-1")).toBe(true);
    now = 1;
    expect(limiter.tryConsume("qq", "other-user-2")).toBe(true);

    now = 59_000;
    expect(limiter.tryConsume("qq", "user-1")).toBe(false);

    now = 60_002;
    expect(limiter.tryConsume("qq", "user-1")).toBe(true);
    expect(limiter.tryConsume("qq", "user-1")).toBe(true);
  });

  it("清理全部过期桶并保留窗口内记录", () => {
    const buckets = new Map<string, number[]>([
      ["expired", [0]],
      ["mixed", [0, 30_001]],
      ["fresh", [30_002]],
    ]);

    pruneExpiredRateLimitBuckets(buckets, 60_001);

    expect(buckets).toEqual(new Map<string, number[]>([
      ["mixed", [30_001]],
      ["fresh", [30_002]],
    ]));
  });
});
~~~

- [ ] **Step 2: 运行测试并确认模块不存在**

Run: npx vitest run src/main/channels/rate-limiter.test.ts

Expected: FAIL，无法解析 ./rate-limiter。

- [ ] **Step 3: 实现先检查、后同时提交的 tryConsume**

实现要求：

~~~ts
export interface ChannelRateLimiter {
  tryConsume(channel: ChannelId, senderId: string): boolean;
  reconfigure(limits: { perUser: number; perChannel: number }): void;
  reset(): void;
}
~~~

每次调用先过滤所有桶中过期的时间戳；若用户或渠道任一桶达到上限，两个桶都不得写入 now；只有两个检查都通过时才同时追加。空桶必须从 Map 删除。reconfigure 更新限额并清空旧桶，避免设置更新后沿用基于旧限额累计的状态。

- [ ] **Step 4: 替换 Dispatcher 内嵌 RateLimiter**

Dispatcher 持有 createChannelRateLimiter 返回的实例；reloadSettings 时读取新限额并调用 limiter.reconfigure。调用点从 limiter.hit 改为 limiter.tryConsume。

- [ ] **Step 5: 运行测试和主进程类型检查**

Run: npx vitest run src/main/channels/rate-limiter.test.ts src/main/channels/dispatcher.test.ts

Run: npm run build:main

Expected: 全部 PASS。

- [ ] **Step 6: 提交限速修复**

~~~bash
git add src/main/channels/rate-limiter.ts src/main/channels/rate-limiter.test.ts src/main/channels/dispatcher.ts
git commit -m "fix(channels): consume rate limits atomically"
~~~

### Task 3: 引入外部 session 和绑定 conversation 两层队列

**Files:**
- Create: src/main/channels/keyed-queue.ts
- Create: src/main/channels/keyed-queue.test.ts
- Modify: src/main/channels/dispatcher.ts:277-531
- Modify: src/main/channels/dispatcher.test.ts

**Interfaces:**
- Consumes: Promise 任务和字符串执行键。
- Produces: KeyedQueue.run；Dispatcher 的 resolveDispatchContext 和 processIncoming 分界。

- [ ] **Step 1: 编写队列自身测试**

~~~ts
import { describe, expect, it } from "vitest";
import { createKeyedQueue } from "./keyed-queue";

describe("KeyedQueue", () => {
  it("serializes the same key and runs different keys concurrently", async () => {
    const queue = createKeyedQueue({ maxPendingPerKey: 20 });
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const first = queue.run("a", async () => {
      events.push("a1:start");
      await gate;
      events.push("a1:end");
    });
    const second = queue.run("a", async () => events.push("a2"));
    const parallel = queue.run("b", async () => events.push("b1"));

    await parallel;
    expect(events).toEqual(["a1:start", "b1"]);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["a1:start", "b1", "a1:end", "a2"]);
  });

  it("rejects work beyond the per-key pending limit", async () => {
    const queue = createKeyedQueue({ maxPendingPerKey: 1 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = queue.run("a", () => gate);
    await expect(queue.run("a", async () => undefined)).rejects.toThrow("queue_full");
    release();
    await first;
  });
});
~~~

- [ ] **Step 2: 运行测试并确认模块不存在**

Run: npx vitest run src/main/channels/keyed-queue.test.ts

Expected: FAIL，无法解析 ./keyed-queue。

- [ ] **Step 3: 实现 KeyedQueue**

复用 NapCatAdapter 和 QqBotAdapter 当前的 Map<string, { tail, pending }> Promise 链模式。run 必须返回当前任务的 Promise，任务异常不得破坏后续队列，pending 归零时删除 key。

- [ ] **Step 4: 编写共享绑定顺序测试**

在 dispatcher.test.ts 增加两个并发测试：

1. 两个不同 external session 解析到同一个 conversationId 时，第二个 buildAndRunAgent 必须在第一个发送和提交完成后才开始。
2. 两个 external session 解析到不同 conversationId 时，两个 buildAndRunAgent 可以同时开始。

测试使用可控 Promise gate，不使用 setTimeout 判断顺序。断言事件序列分别为：

~~~ts
["a:start", "a:delivered", "a:committed", "b:start"]
~~~

以及不同 conversation 的开始事件集合：

~~~ts
new Set(["a:start", "b:start"])
~~~

- [ ] **Step 5: 将 Dispatcher 拆成两层入口**

~~~ts
async handleIncoming(msg: IncomingMessage): Promise<OutgoingMessage | null> {
  const sessionId = makeSessionId(msg.channel, msg.chatId);
  return this.deps.queue.run(`external:${sessionId}`, async () => {
    const boundConversationId = this.safeResolveBinding(sessionId);
    const context = { sessionId, boundConversationId };
    const execute = () => this.processIncoming(msg, context);
    return boundConversationId
      ? this.deps.queue.run(`conversation:${boundConversationId}`, execute)
      : execute();
  });
}
~~~

绑定查询必须从 processIncoming 移出，确保队列 key 和历史读写目标来自同一个快照。

- [ ] **Step 6: 运行相关测试**

Run: npx vitest run src/main/channels/keyed-queue.test.ts src/main/channels/dispatcher.test.ts src/main/channels/adapters/qq/napcat-adapter.integration.test.ts src/main/channels/adapters/qqbot/qqbot-adapter.test.ts

Expected: PASS。

- [ ] **Step 7: 提交队列重构**

~~~bash
git add src/main/channels/keyed-queue.ts src/main/channels/keyed-queue.test.ts src/main/channels/dispatcher.ts src/main/channels/dispatcher.test.ts
git commit -m "refactor(channels): serialize shared conversation execution"
~~~

### Task 4: 抽取传输服务并复用于主动发送

**Files:**
- Create: src/main/channels/delivery-service.ts
- Create: src/main/channels/delivery-service.test.ts
- Modify: src/main/channels/dispatcher.ts
- Modify: src/main/channels/proactive-delivery.ts:72-123
- Modify: src/main/channels/proactive-delivery.test.ts

**Interfaces:**
- Consumes: Pick<ChannelManager, "getAdapter"> 和 OutgoingMessage。
- Produces: createChannelDeliveryService 和 ChannelDeliveryService.send。

- [ ] **Step 1: 编写 DeliveryService 契约测试**

~~~ts
import { describe, expect, it, vi } from "vitest";
import { createChannelDeliveryService } from "./delivery-service";

describe("ChannelDeliveryService", () => {
  const message = {
    channel: "qq" as const,
    targetId: "chat-1",
    parts: [{ kind: "text" as const, text: "回复" }],
  };

  it("normalizes a missing adapter", async () => {
    const service = createChannelDeliveryService({ getAdapter: () => undefined });
    await expect(service.send(message)).resolves.toEqual({
      ok: false,
      error: "adapter_not_found",
    });
  });

  it("normalizes a thrown adapter error", async () => {
    const service = createChannelDeliveryService({
      getAdapter: () => ({ send: vi.fn(async () => { throw new Error("offline"); }) }) as never,
    });
    await expect(service.send(message)).resolves.toEqual({ ok: false, error: "offline" });
  });

  it("returns the adapter acknowledgement unchanged", async () => {
    const service = createChannelDeliveryService({
      getAdapter: () => ({ send: vi.fn(async () => ({ ok: true })) }) as never,
    });
    await expect(service.send(message)).resolves.toEqual({ ok: true });
  });
});
~~~

- [ ] **Step 2: 运行测试并确认模块不存在**

Run: npx vitest run src/main/channels/delivery-service.test.ts

Expected: FAIL，无法解析 ./delivery-service。

- [ ] **Step 3: 实现纯传输边界**

delivery-service.ts 不得导入 history-log、message-log、Electron 或桌面广播模块。它只依赖 getAdapter，并将缺失 Adapter、false 结果和异常归一化为 DeliveryResult。

- [ ] **Step 4: 替换 Dispatcher 对 Manager 的直接发送依赖**

DispatcherDeps 增加 delivery: ChannelDeliveryService，并删除 Dispatcher 对 manager.getAdapter 和 adapter.send 的直接调用。Dispatcher 继续负责确认成功后的 assistant 提交。

- [ ] **Step 5: 让 proactive-delivery 复用传输服务**

proactive-delivery 仍逐个构造单 part OutgoingMessage 并调用 delivery.send。只有成功 part 加入 deliveredTexts；第一个失败后停止；历史和日志仍在 proactive-delivery.ts 内根据 deliveredTexts 提交。

- [ ] **Step 6: 运行回归测试**

Run: npx vitest run src/main/channels/delivery-service.test.ts src/main/channels/dispatcher.test.ts src/main/channels/proactive-delivery.test.ts

Expected: PASS，主动发送的 total failure 和 partial delivery 断言保持不变。

- [ ] **Step 7: 提交传输模块**

~~~bash
git add src/main/channels/delivery-service.ts src/main/channels/delivery-service.test.ts src/main/channels/dispatcher.ts src/main/channels/proactive-delivery.ts src/main/channels/proactive-delivery.test.ts
git commit -m "refactor(channels): share adapter delivery boundary"
~~~

### Task 5: 抽取出站组装并管理临时音频

**Files:**
- Create: src/main/channels/outgoing-composer.ts
- Create: src/main/channels/outgoing-composer.test.ts
- Modify: src/main/channels/dispatcher.ts:137-240,416-462,516-583
- Modify: src/main/channels/dispatcher-capability.test.ts

**Interfaces:**
- Consumes: IncomingMessage、ChannelCapability、渠道设置、通用设置、表情路径解析函数和 synthesizeTts 函数。
- Produces: PreparedOutgoing、composeOutgoing 和 cleanupTransientFiles。

- [ ] **Step 1: 迁移纯函数测试**

将 dispatcher-capability.test.ts 中以下测试迁移到 outgoing-composer.test.ts，断言保持不变：

- 文本分段开关；
- 微信禁用渠道 TTS；
- 文本最大长度；
- image、audio、file、video、card、sticker 能力降级；
- 输入对象不被修改。

- [ ] **Step 2: 添加临时文件声明和清理测试**

使用 mkdtemp 创建隔离目录，注入 writeFile、removeFile 和 createId：

~~~ts
it("returns generated audio as a transient file and removes it after cleanup", async () => {
  const files = new Map<string, Buffer>();
  const composer = createOutgoingComposer({
    audioDirectory: "C:/virtual/channels/audio",
    createId: () => "audio-1",
    writeFile: async (filePath, data) => { files.set(filePath, data); },
    removeFile: async (filePath) => { files.delete(filePath); },
    synthesizeTts: async () => Buffer.from("audio"),
    resolveStickerImagePath: () => null,
  });

  const prepared = await composer.compose(makeComposeInput({ audio: true }));
  expect(prepared.transientFiles).toHaveLength(1);
  expect(files.has(prepared.transientFiles[0])).toBe(true);

  await composer.cleanupTransientFiles(prepared.transientFiles);
  expect(files.size).toBe(0);
});
~~~

- [ ] **Step 3: 运行迁移后的测试并确认模块不存在**

Run: npx vitest run src/main/channels/outgoing-composer.test.ts

Expected: FAIL，无法解析 ./outgoing-composer。

- [ ] **Step 4: 实现 OutgoingComposer**

移动并保留现有行为：

- buildTextOutgoingParts；
- shouldAppendChannelTtsAudio；
- normalizeTtsResult；
- resolveStickerImagePath；
- downgradeToCapability。

音频写入改用 fs.promises.mkdir 和 fs.promises.writeFile；文件名使用 randomUUID；PreparedOutgoing.transientFiles 只包含本轮创建的音频，永久表情资源不得加入。

- [ ] **Step 5: Dispatcher 使用 PreparedOutgoing**

Dispatcher 调用 composer.compose，使用 prepared.message 发送，使用 prepared.assistantText 和 prepared.stickerId 提交，finally 调用 composer.cleanupTransientFiles。

- [ ] **Step 6: 运行测试和构建**

Run: npx vitest run src/main/channels/outgoing-composer.test.ts src/main/channels/dispatcher.test.ts src/main/channels/adapters/feishu/index.test.ts src/main/channels/adapters/wechat/ilink-bot-adapter.test.ts

Run: npm run build:main

Expected: PASS。

- [ ] **Step 7: 提交出站组装模块**

~~~bash
git add src/main/channels/outgoing-composer.ts src/main/channels/outgoing-composer.test.ts src/main/channels/dispatcher.ts src/main/channels/dispatcher-capability.test.ts
git commit -m "refactor(channels): extract outgoing composition"
~~~

### Task 6: 抽取上下文模块

**Files:**
- Create: src/main/channels/channel-context.ts
- Create: src/main/channels/channel-context.test.ts
- Modify: src/main/channels/dispatcher.ts:39-43,60-172,283-381,496-514
- Modify: src/main/channels/conversation-binding-api.test.ts

**Interfaces:**
- Consumes: 历史读写、历史迁移、绑定解析和绑定桌面对话读写函数。
- Produces: makeSessionId、formatChannelUserText、resolvePriorMessages、appendIncomingContext 和 appendAssistantContext。

- [ ] **Step 1: 迁移 sessionId 和群聊格式测试**

将 dispatcher.test.ts 中 makeSessionId、lookupOriginalSender 和 formatChannelUserText 测试迁移到 channel-context.test.ts，保持导出行为一致。

- [ ] **Step 2: 添加绑定历史失败回退测试**

~~~ts
it("falls back to channel history when bound history loading fails", async () => {
  const context = createChannelContext({
    loadBoundConversationHistory: async () => { throw new Error("deleted"); },
    loadRecentChannelHistory: async () => [{ role: "user", content: "渠道历史" }],
    appendChannelHistory: vi.fn(),
    appendBoundConversationMessage: vi.fn(),
    migrateHistory: vi.fn(),
  });

  await expect(context.resolvePriorMessages({
    sessionId: "channel:qq:abc",
    boundConversationId: "conversation-1",
  }, 16)).resolves.toEqual([{ role: "user", content: "渠道历史" }]);
});
~~~

- [ ] **Step 3: 运行测试并确认模块不存在**

Run: npx vitest run src/main/channels/channel-context.test.ts

Expected: FAIL，无法解析 ./channel-context。

- [ ] **Step 4: 实现 ChannelContext**

要求：

- resolvePriorMessages 只使用传入的 boundConversationId 快照；
- appendIncomingContext 始终写渠道 user 历史，存在有效绑定时额外写桌面 user 消息；
- appendAssistantContext 只由发送确认后的 Dispatcher 调用；
- 群聊 modelContext 保留发送者和引用信息，桌面可见 content 保持原始 msg.text；
- 继续兼容从 senderId 键迁移到 chatId 键的旧历史。

- [ ] **Step 5: 从 dispatcher.ts 重新导出兼容符号**

为避免一次性修改 conversation-binding-api.test.ts 等调用方，dispatcher.ts 暂时保留：

~~~ts
export {
  formatChannelUserText,
  lookupOriginalSender,
  makeSessionId,
} from "./channel-context";
~~~

- [ ] **Step 6: 运行上下文和 Dispatcher 测试**

Run: npx vitest run src/main/channels/channel-context.test.ts src/main/channels/dispatcher.test.ts src/main/channels/conversation-binding-api.test.ts src/main/channels/conversation-binding-store.test.ts

Expected: PASS。

- [ ] **Step 7: 提交上下文模块**

~~~bash
git add src/main/channels/channel-context.ts src/main/channels/channel-context.test.ts src/main/channels/dispatcher.ts src/main/channels/dispatcher.test.ts
git commit -m "refactor(channels): extract conversation context"
~~~

### Task 7: 用不可变构造替代模块级 setter

**Files:**
- Modify: src/main/channels/dispatcher.ts:174-221,242-269,585-665
- Modify: src/main/channels/bootstrap.ts:24-35,66-79,133-276
- Modify: src/main/channels/init.ts:19-20,70-84,146-155
- Modify: src/main/channels/bootstrap.test.ts
- Modify: src/main/channels/dispatcher.test.ts

**Interfaces:**
- Consumes: Tasks 2-6 产生的 queue、limiter、context、composer 和 delivery。
- Produces: createChannelDispatcher 或 new ChannelDispatcher 的完整只读依赖；initializeChannels 显式接收 handleIncoming 和 reloadSettings。

- [ ] **Step 1: 添加 Bootstrap 构造隔离测试**

在 bootstrap.test.ts 增加两个 createChannelsSubsystem 实例，分别注入不同的 agentRuntime 和窗口函数。调用各自捕获的 handleIncoming 后，断言不会调用另一实例的依赖。该测试应在模块级 channelDispatcher 和 setter 模型下失败或暴露最后写入覆盖前一个实例。

- [ ] **Step 2: 运行测试确认旧结构不满足实例隔离**

Run: npx vitest run src/main/channels/bootstrap.test.ts

Expected: 新增隔离测试 FAIL。

- [ ] **Step 3: 将 DispatcherDeps 改为只读完整依赖**

~~~ts
export interface DispatcherDeps {
  readonly queue: KeyedQueue;
  readonly limiter: ChannelRateLimiter;
  readonly context: ChannelContext;
  readonly composer: OutgoingComposer;
  readonly delivery: ChannelDeliveryService;
  readonly buildAndRunAgent: BuildAndRunAgent;
  readonly loadSettings: () => ChannelsSettings;
  readonly loadGeneralSettings: () => {
    mobileMessageSegmentation?: MobileMessageSegmentationMode;
  };
  readonly broadcastChat?: BroadcastChannelMessage;
  readonly observeExternalChat?: ObserveExternalChat;
}
~~~

ChannelDispatcher.deps 必须为 private readonly。删除 channelDispatcher 单例和所有 setDispatcher 开头的导出函数。reloadSettings 不替换 limiter 依赖，而是清除 Dispatcher 设置缓存并调用 limiter.reconfigure 更新限额。

- [ ] **Step 4: Bootstrap 成为唯一组合根**

createChannelsSubsystem 内构造所有依赖和 ChannelDispatcher 实例。initializeChannels 改为接收：

~~~ts
export interface InitializeChannelsOptions {
  ipc?: IpcScope;
  handleIncoming: MessageHandler;
  reloadDispatcherSettings: () => void;
}
~~~

registerChannelsIpc 通过 options.reloadDispatcherSettings 响应设置更新，不再导入 dispatcher 单例。

- [ ] **Step 5: 保证构造和启动阶段无网络副作用**

保留 createChannelsSubsystem 的现有生命周期：构造只完成对象接线；initialize 注册 Adapter 和 IPC；start 才启动 inbound server 和渠道网络连接。

- [ ] **Step 6: 运行全部 channels 测试和构建**

Run: npx vitest run src/main/channels

Run: npm run build:main

Expected: PASS。

- [ ] **Step 7: 提交不可变接线**

~~~bash
git add src/main/channels/dispatcher.ts src/main/channels/bootstrap.ts src/main/channels/init.ts src/main/channels/bootstrap.test.ts src/main/channels/dispatcher.test.ts
git commit -m "refactor(channels): replace mutable dispatcher wiring"
~~~

### Task 8: 删除重复队列并完成全量验证

**Files:**
- Modify: src/main/channels/adapters/qq/napcat-adapter.ts:111,177,282-307
- Modify: src/main/channels/adapters/qqbot/qqbot-adapter.ts:152,215,335-355
- Modify: src/main/channels/adapters/qq/napcat-adapter.integration.test.ts
- Modify: src/main/channels/adapters/qqbot/qqbot-adapter.test.ts
- Modify: src/main/channels/dispatcher.ts
- Modify: src/main/channels/types.ts:86,101,126-130

**Interfaces:**
- Consumes: Task 3 的 Dispatcher 两层队列。
- Produces: 所有 Adapter 共享一致的业务消息串行语义；Dispatcher 文件只保留编排职责。

- [ ] **Step 1: 调整 Adapter 队列测试归属**

删除 NapCat 集成测试中“同 chatId 的 onMessage 串行”断言，因为该责任已经由 Dispatcher 的 keyed-queue 测试覆盖。保留：

- WebSocket 事件去重；
- 不同消息归一化；
- 发送 payload 顺序；
- Adapter 自身协议限额和回复窗口。

- [ ] **Step 2: 删除 QQ 和 QQ Bot 的业务处理队列**

移除 queues 字段和 enqueue 方法。事件归一化、附件下载完成后直接 await 或 void 调用 onMessage，并保留现有错误日志。不得删除 Adapter 内与协议发送次序、msg_seq 或 WebSocket 请求关联有关的状态。

- [ ] **Step 3: 更新注释契约**

types.ts 和 adapters/base.ts 注释明确：

- Adapter 只负责协议收发和消息归一化；
- MessageHandler 内部完成 Agent 运行和响应发送；
- MessageHandler 返回 OutgoingMessage 仅用于观测和测试，Adapter 不得再次发送返回值。

- [ ] **Step 4: 运行全量验证**

Run: npx vitest run src/main/channels

Run: npm run build:main

Run: git diff --check

Expected: 所有命令退出码为 0。

- [ ] **Step 5: 检查最终依赖和文件职责**

Run: rg -n "setDispatcher|export const channelDispatcher|fs\.|from \"electron\"" src/main/channels/dispatcher.ts

Expected: 无匹配。

Run: rg -n "private queues|private enqueue" src/main/channels/adapters/qq/napcat-adapter.ts src/main/channels/adapters/qqbot/qqbot-adapter.ts

Expected: 无匹配。

- [ ] **Step 6: 提交收尾清理**

~~~bash
git add src/main/channels/adapters/qq/napcat-adapter.ts src/main/channels/adapters/qqbot/qqbot-adapter.ts src/main/channels/adapters/qq/napcat-adapter.integration.test.ts src/main/channels/adapters/qqbot/qqbot-adapter.test.ts src/main/channels/dispatcher.ts src/main/channels/types.ts
git commit -m "refactor(channels): centralize inbound sequencing"
~~~

---

## 最终验收清单

- [ ] Adapter 明确发送失败时，没有 assistant 渠道历史。
- [ ] Adapter 明确发送失败时，没有绑定桌面对话 assistant 消息。
- [ ] Adapter 明确发送失败时，没有 outgoing 日志和 bot:outgoing 镜像。
- [ ] Adapter 成功确认时，assistant 状态恰好提交一次。
- [ ] 相同外部 session 的消息严格串行。
- [ ] 不同外部 session 绑定同一 conversation 时严格串行。
- [ ] 不同且无共享上下文的会话可以并行。
- [ ] 渠道限额拒绝不消耗用户额度。
- [ ] 限速桶和空会话队列会被清理。
- [ ] TTS 临时文件在成功和失败路径都会被清理。
- [ ] proactive-delivery 的部分发送历史仍只包含实际成功片段。
- [ ] Dispatcher 不直接导入 Electron、fs 或 manager 单例。
- [ ] Dispatcher 依赖只在构造时设置，运行期不可变。
- [ ] src/main/channels 全部测试通过。
- [ ] npm run build:main 通过。
- [ ] git diff --check 通过。

## 推荐执行方式

本计划包含 8 个按依赖排序、可独立审查的任务。推荐逐任务执行，每个任务完成后先检查测试和 diff，再进入下一任务；不要把 8 个任务合并成一次大规模修改。
