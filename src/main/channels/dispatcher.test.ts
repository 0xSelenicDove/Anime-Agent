// dispatcher 核心单元测试：sessionId hash + 限速
import * as os from "node:os";
import { describe, it, expect, vi } from "vitest";
import {
  ChannelDispatcher,
  makeSessionId,
  type DispatcherDeps,
} from "./dispatcher";
import { appendHistory, migrateHistory } from "./history-log";
import { appendLog, reloadLogFromDisk } from "./message-log";
import { createOutgoingComposer } from "./outgoing-composer";
import { createChannelContext, type ChannelContext } from "./channel-context";
import { createKeyedQueue } from "./keyed-queue";
import { createChannelRateLimiter } from "./rate-limiter";
import { createChannelDeliveryService } from "./delivery-service";
import type { ChannelsSettings } from "./settings-store";
import type { IncomingMessage } from "./types";

vi.mock("electron", () => ({
  app: {
    getPath: () => os.tmpdir(),
    getAppPath: () => process.cwd(),
    getName: () => "Cyrene",
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
  },
}));

vi.mock("./message-log", () => ({
  appendLog: vi.fn(),
  reloadLogFromDisk: vi.fn(),
}));

vi.mock("./history-log", () => ({
  appendHistory: vi.fn(),
  migrateHistory: vi.fn(),
}));

describe("channels/dispatcher", () => {
  function makeIncoming(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
    return {
      channel: "qq",
      chatType: "private",
      senderId: "user-1",
      senderName: "测试用户",
      chatId: "chat-1",
      text: "你好",
      at: new Date(0),
      ...overrides,
    };
  }

  function makeManager(send = vi.fn(async () => ({ ok: true }))) {
    return {
      getAdapter: () => ({
        capability: { text: true, image: true, audio: false, file: false, video: false, markdown: false, card: false, sticker: false, maxTextLength: 4000 },
        send,
      }),
    } as any;
  }

  type TestDispatcherOptions = Partial<DispatcherDeps> & {
    manager?: ReturnType<typeof makeManager>;
    loadRecentChannelHistory?: Parameters<typeof createChannelContext>[0]["loadRecentChannelHistory"];
    resolveBoundConversationId?: Parameters<typeof createChannelContext>[0]["resolveBoundConversationId"];
    loadBoundConversationHistory?: Parameters<typeof createChannelContext>[0]["loadBoundConversationHistory"];
    appendBoundConversationMessage?: Parameters<typeof createChannelContext>[0]["appendBoundConversationMessage"];
  };

  function makeDispatcher(options: TestDispatcherOptions): ChannelDispatcher {
    const manager = options.manager ?? makeManager();
    const baseComposer = options.composer ?? createOutgoingComposer({
      resolveStickerImagePath: (stickerId) => stickerId === "OK" ? "C:/stickers/ok.png" : null,
    });
    return new ChannelDispatcher({
      queue: options.queue ?? createKeyedQueue({ maxPendingPerKey: 20 }),
      limiter: options.limiter ?? createChannelRateLimiter({
        limits: { perUser: 10, perChannel: 100 },
      }),
      context: options.context ?? createChannelContext({
        resolveBoundConversationId: options.resolveBoundConversationId,
        loadRecentChannelHistory: options.loadRecentChannelHistory,
        loadBoundConversationHistory: options.loadBoundConversationHistory,
        appendChannelHistory: appendHistory,
        appendBoundConversationMessage: options.appendBoundConversationMessage,
        migrateHistory,
      }),
      composer: {
        compose: (input) => baseComposer.compose({
          ...input,
          capability: manager.getAdapter(input.incoming.channel)?.capability,
        }),
        cleanupTransientFiles: (files) => baseComposer.cleanupTransientFiles(files),
      },
      delivery: options.delivery ?? createChannelDeliveryService(manager),
      buildAndRunAgent: options.buildAndRunAgent ?? (async (msg) => ({
        text: `[回声][${msg.channel}][${msg.senderId}] ${msg.text}`,
        sticker: null,
      })),
      loadSettings: options.loadSettings ?? (() => ({
        rateLimitPerUser: 10,
        rateLimitPerChannel: 100,
        ttsEnabled: true,
        stickerEnabled: true,
        mirrorToDesktop: true,
      } as ChannelsSettings)),
      loadGeneralSettings: options.loadGeneralSettings ?? (() => ({})),
      observeExternalChat: options.observeExternalChat,
      broadcastChat: options.broadcastChat,
    });
  }

  async function flushMicrotasks(rounds = 12): Promise<void> {
    for (let index = 0; index < rounds; index += 1) {
      await Promise.resolve();
    }
  }

  it("构造调度器时不读取消息日志", () => {
    vi.mocked(reloadLogFromDisk).mockClear();

    makeDispatcher({});

    expect(reloadLogFromDisk).not.toHaveBeenCalled();
  });

  it("uses channel history and channel session when the chat is unbound", async () => {
    const loadRecentChannelHistory = vi.fn(async () => [{ role: "user" as const, content: "渠道旧消息" }]);
    const buildAndRunAgent = vi.fn(async (_msg: IncomingMessage, sessionId: string, prior?: Array<{ role: string; content?: string }>) => {
      expect(sessionId).toBe(makeSessionId("qq", "chat-1"));
      expect(prior).toEqual([{ role: "user", content: "渠道旧消息" }]);
      return { text: "渠道回复", sticker: null };
    });
    const dispatcher = makeDispatcher({ manager: makeManager(), loadRecentChannelHistory, buildAndRunAgent });

    const result = await dispatcher.handleIncoming(makeIncoming());

    expect(result?.targetId).toBe("chat-1");
    expect(loadRecentChannelHistory).toHaveBeenCalledWith(makeSessionId("qq", "chat-1"), 16);
    expect(buildAndRunAgent).toHaveBeenCalledOnce();
  });

  it("通过注入的上下文模块读取和提交会话状态", async () => {
    const priorMessages = [{ role: "user" as const, content: "模块历史" }];
    const contextService: ChannelContext = {
      resolveDispatchContext: vi.fn((sessionId: string) => ({
        sessionId,
        boundConversationId: null,
      })),
      recordIncomingSession: vi.fn(),
      resolvePriorMessages: vi.fn(async () => priorMessages),
      appendIncomingContext: vi.fn(async () => undefined),
      appendAssistantContext: vi.fn(async () => undefined),
    };
    const buildAndRunAgent = vi.fn(async (
      _msg: IncomingMessage,
      _sessionId: string,
      prior?: Array<{ role: string; content?: string }>,
    ) => {
      expect(prior).toEqual(priorMessages);
      return { text: "模块回复", sticker: null };
    });
    const dispatcher = makeDispatcher({
      manager: makeManager(),
      context: contextService,
      buildAndRunAgent,
    });

    await dispatcher.handleIncoming(makeIncoming());

    expect(contextService.recordIncomingSession).toHaveBeenCalledOnce();
    expect(contextService.appendIncomingContext).toHaveBeenCalledOnce();
    expect(contextService.appendAssistantContext).toHaveBeenCalledOnce();
  });

  it.each(["qq", "wechat"] as const)("uses bound desktop history while keeping %s runtime identity separate", async (channel) => {
    const channelSessionId = makeSessionId(channel, "chat-1");
    const loadRecentChannelHistory = vi.fn(async () => [{ role: "user" as const, content: "不应读取" }]);
    const loadBoundConversationHistory = vi.fn(async (conversationId: string, limit: number) => {
      expect(conversationId).toBe("conversation-7");
      expect(limit).toBe(16);
      return [{ role: "user" as const, content: "桌面旧消息" }];
    });
    const appendBoundConversationMessage = vi.fn();
    const buildAndRunAgent = vi.fn(async (_msg: IncomingMessage, sessionId: string, prior?: Array<{ role: string; content?: string }>) => {
      expect(sessionId).toBe(channelSessionId);
      expect(prior).toEqual([{ role: "user", content: "桌面旧消息" }]);
      return { text: "共享回复", sticker: null };
    });
    const dispatcher = makeDispatcher({
      manager: makeManager(),
      loadRecentChannelHistory,
      loadBoundConversationHistory,
      resolveBoundConversationId: vi.fn((sessionId: string) => sessionId === channelSessionId ? "conversation-7" : null),
      appendBoundConversationMessage,
      buildAndRunAgent,
    });

    const result = await dispatcher.handleIncoming(makeIncoming({ channel }));

    expect(result?.targetId).toBe("chat-1");
    expect(loadRecentChannelHistory).not.toHaveBeenCalled();
    expect(loadBoundConversationHistory).toHaveBeenCalledWith("conversation-7", 16);
    expect(appendBoundConversationMessage).toHaveBeenNthCalledWith(1, "conversation-7", "user", "你好", {
      channel,
      chatType: "private",
      senderName: "测试用户",
      modelContext: undefined,
    });
    expect(appendBoundConversationMessage).toHaveBeenNthCalledWith(2, "conversation-7", "assistant", "共享回复", {
      channel,
      chatType: "private",
      senderName: "测试用户",
      modelContext: undefined,
    });
    expect(buildAndRunAgent).toHaveBeenCalledOnce();
  });

  it("keeps QQ group identity in model context without putting it in the visible bound message", async () => {
    const appendBoundConversationMessage = vi.fn();
    const dispatcher = makeDispatcher({
      manager: makeManager(),
      resolveBoundConversationId: () => "conversation-group",
      loadBoundConversationHistory: vi.fn(async () => []),
      appendBoundConversationMessage,
      buildAndRunAgent: vi.fn(async () => ({ text: "收到", sticker: null })),
    });

    await dispatcher.handleIncoming(makeIncoming({
      channel: "qq",
      chatType: "group",
      senderId: "10001",
      senderName: "小明",
      chatId: "20001",
      text: "大家好",
    }));

    expect(appendBoundConversationMessage).toHaveBeenNthCalledWith(1, "conversation-group", "user", "大家好", {
      channel: "qq",
      chatType: "group",
      senderName: "小明",
      modelContext: "[群聊发送者：小明 (10001)]\n大家好",
    });
  });

  it("persists the same selected built-in sticker in the bound desktop reply", async () => {
    const appendBoundConversationMessage = vi.fn();
    const dispatcher = makeDispatcher({
      manager: {
        getAdapter: () => ({
          capability: { text: true, image: true, audio: false, file: false, video: false, markdown: false, card: false, sticker: true, maxTextLength: 2048 },
          send: vi.fn(async () => ({ ok: true })),
        }),
      } as any,
      resolveBoundConversationId: () => "conversation-sticker",
      loadBoundConversationHistory: vi.fn(async () => []),
      appendBoundConversationMessage,
      buildAndRunAgent: vi.fn(async () => ({ text: "收到", sticker: "OK" })),
    });

    await dispatcher.handleIncoming(makeIncoming({ channel: "wechat" }));

    expect(appendBoundConversationMessage).toHaveBeenNthCalledWith(2, "conversation-sticker", "assistant", "收到", expect.objectContaining({
      channel: "wechat",
      sticker: "OK",
    }));
  });

  it("does not persist a selected sticker when the channel capability rejects stickers", async () => {
    const appendBoundConversationMessage = vi.fn();
    const dispatcher = makeDispatcher({
      manager: makeManager(),
      resolveBoundConversationId: () => "conversation-no-sticker",
      loadBoundConversationHistory: vi.fn(async () => []),
      appendBoundConversationMessage,
      buildAndRunAgent: vi.fn(async () => ({ text: "收到", sticker: "OK" })),
    });

    await dispatcher.handleIncoming(makeIncoming());

    expect(appendBoundConversationMessage.mock.calls[1]?.[3]).not.toHaveProperty("sticker");
  });

  it("falls back to channel history when bound desktop history cannot be loaded", async () => {
    const channelSessionId = makeSessionId("qq", "chat-1");
    const loadRecentChannelHistory = vi.fn(async () => [{ role: "user" as const, content: "渠道回退" }]);
    const loadBoundConversationHistory = vi.fn(async () => { throw new Error("桌面对话已删除"); });
    const buildAndRunAgent = vi.fn(async (_msg: IncomingMessage, sessionId: string, prior?: Array<{ role: string; content?: string }>) => {
      expect(sessionId).toBe(channelSessionId);
      expect(prior).toEqual([{ role: "user", content: "渠道回退" }]);
      return { text: "回复", sticker: null };
    });
    const dispatcher = makeDispatcher({
      manager: makeManager(),
      loadRecentChannelHistory,
      loadBoundConversationHistory,
      resolveBoundConversationId: () => "conversation-7",
      buildAndRunAgent,
    });

    await dispatcher.handleIncoming(makeIncoming());

    expect(loadRecentChannelHistory).toHaveBeenCalledWith(channelSessionId, 16);
    expect(buildAndRunAgent).toHaveBeenCalledWith(expect.anything(), channelSessionId, [{ role: "user", content: "渠道回退" }]);
  });

  it("falls back to the unbound channel path when binding lookup fails", async () => {
    const loadRecentChannelHistory = vi.fn(async () => [{ role: "user" as const, content: "渠道历史" }]);
    const buildAndRunAgent = vi.fn(async (_msg: IncomingMessage, sessionId: string, prior?: Array<{ role: string; content?: string }>) => {
      expect(sessionId).toBe(makeSessionId("qq", "chat-1"));
      expect(prior).toEqual([{ role: "user", content: "渠道历史" }]);
      return { text: "回复", sticker: null };
    });
    const dispatcher = makeDispatcher({
      manager: makeManager(),
      loadRecentChannelHistory,
      resolveBoundConversationId: () => { throw new Error("绑定存储暂不可用"); },
      buildAndRunAgent,
    });

    const result = await dispatcher.handleIncoming(makeIncoming());

    expect(result?.targetId).toBe("chat-1");
    expect(loadRecentChannelHistory).toHaveBeenCalledWith(makeSessionId("qq", "chat-1"), 16);
  });

  it("适配器明确发送失败时不提交助手状态", async () => {
    vi.mocked(appendHistory).mockClear();
    vi.mocked(appendLog).mockClear();
    const appendBoundConversationMessage = vi.fn();
    const broadcastChat = vi.fn();
    const send = vi.fn(async () => ({ ok: false, error: "offline" }));
    const dispatcher = makeDispatcher({
      manager: makeManager(send),
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
    expect(appendHistory).not.toHaveBeenCalledWith(
      makeSessionId("qq", "chat-1"),
      "assistant",
      expect.any(String),
    );
    expect(appendLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ dir: "outgoing" }),
    );
    expect(broadcastChat).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "bot:outgoing" }),
    );
  });

  it("通过注入的传输服务发送并在确认成功后提交", async () => {
    vi.mocked(appendHistory).mockClear();
    const dispatcher = makeDispatcher({
      manager: { getAdapter: () => undefined } as any,
      delivery: {
        send: vi.fn(async () => ({ ok: true })),
      },
      buildAndRunAgent: vi.fn(async () => ({ text: "传输成功", sticker: null })),
    });

    const result = await dispatcher.handleIncoming(makeIncoming());

    expect(result?.parts).toEqual([{ kind: "text", text: "传输成功" }]);
    expect(appendHistory).toHaveBeenCalledWith(
      makeSessionId("qq", "chat-1"),
      "assistant",
      "传输成功",
    );
  });

  it.each([
    ["发送成功", { ok: true } as const, false],
    ["发送失败", { ok: false, error: "offline" } as const, true],
  ])("%s后清理本轮生成的临时音频", async (_name, deliveryResult, expectsNull) => {
    const files = new Map<string, Buffer>();
    let filePresentDuringSend = false;
    const composer = createOutgoingComposer({
      audioDirectory: "C:/virtual/channels/audio",
      createId: () => "reply-audio",
      writeFile: async (filePath, data) => {
        files.set(filePath, data);
      },
      removeFile: async (filePath) => {
        files.delete(filePath);
      },
      synthesizeTts: async () => Buffer.from("audio"),
      resolveStickerImagePath: () => null,
    });
    const manager = {
      getAdapter: () => ({
        capability: {
          text: true,
          image: true,
          audio: true,
          file: true,
          video: true,
          markdown: true,
          card: true,
          sticker: true,
          maxTextLength: 4000,
        },
      }),
    } as any;
    const dispatcher = makeDispatcher({
      manager,
      composer,
      delivery: {
        send: async (message) => {
          const audio = message.parts.find((part) => part.kind === "audio");
          filePresentDuringSend = Boolean(
            audio?.kind === "audio" && files.has(audio.filePath),
          );
          return deliveryResult;
        },
      },
      buildAndRunAgent: vi.fn(async () => ({ text: "语音回复", sticker: null })),
    });

    const result = await dispatcher.handleIncoming(makeIncoming({ channel: "feishu" }));

    expect(filePresentDuringSend).toBe(true);
    expect(files.size).toBe(0);
    expect(result === null).toBe(expectsNull);
  });

  it("同一个外部会话的消息必须串行执行完整处理链", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let runCount = 0;
    const dispatcher = makeDispatcher({
      manager: makeManager(vi.fn(async (outgoing) => {
        events.push(`${outgoing.targetId}:sent`);
        return { ok: true };
      })),
      buildAndRunAgent: vi.fn(async (msg) => {
        runCount += 1;
        events.push(`${msg.text}:agent:start`);
        if (runCount === 1) {
          markFirstStarted();
          await firstGate;
        }
        events.push(`${msg.text}:agent:end`);
        return { text: `回复:${msg.text}`, sticker: null };
      }),
    });

    const first = dispatcher.handleIncoming(makeIncoming({ text: "第一条" }));
    await firstStarted;
    const second = dispatcher.handleIncoming(makeIncoming({ text: "第二条" }));
    await flushMicrotasks();

    try {
      expect(events).not.toContain("第二条:agent:start");
    } finally {
      releaseFirst();
      await Promise.all([first, second]);
    }
    expect(events.indexOf("第二条:agent:start"))
      .toBeGreaterThan(events.indexOf("chat-1:sent"));
  });

  it("不同外部会话绑定到同一桌面会话时必须串行", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const dispatcher = makeDispatcher({
      manager: makeManager(vi.fn(async (outgoing) => {
        events.push(`${outgoing.targetId}:sent`);
        return { ok: true };
      })),
      resolveBoundConversationId: () => "conversation-shared",
      loadBoundConversationHistory: vi.fn(async () => []),
      appendBoundConversationMessage: vi.fn(async (_conversationId, role, content) => {
        if (role === "assistant") events.push(`${content}:committed`);
      }),
      buildAndRunAgent: vi.fn(async (msg) => {
        events.push(`${msg.chatId}:agent:start`);
        if (msg.chatId === "chat-a") {
          markFirstStarted();
          await firstGate;
        }
        events.push(`${msg.chatId}:agent:end`);
        return { text: `回复:${msg.chatId}`, sticker: null };
      }),
    });

    const first = dispatcher.handleIncoming(makeIncoming({
      senderId: "user-a",
      chatId: "chat-a",
    }));
    await firstStarted;
    const second = dispatcher.handleIncoming(makeIncoming({
      senderId: "user-b",
      chatId: "chat-b",
    }));
    await flushMicrotasks();

    try {
      expect(events).not.toContain("chat-b:agent:start");
    } finally {
      releaseFirst();
      await Promise.all([first, second]);
    }
    expect(events.indexOf("chat-b:agent:start"))
      .toBeGreaterThan(events.indexOf("回复:chat-a:committed"));
  });

  it("不同桌面会话之间保持并行", async () => {
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sessionA = makeSessionId("qq", "chat-a");
    const dispatcher = makeDispatcher({
      manager: makeManager(),
      resolveBoundConversationId: (sessionId) => (
        sessionId === sessionA ? "conversation-a" : "conversation-b"
      ),
      loadBoundConversationHistory: vi.fn(async () => []),
      buildAndRunAgent: vi.fn(async (msg) => {
        events.push(`${msg.chatId}:agent:start`);
        await gate;
        return { text: `回复:${msg.chatId}`, sticker: null };
      }),
    });

    const first = dispatcher.handleIncoming(makeIncoming({
      senderId: "user-a",
      chatId: "chat-a",
    }));
    const second = dispatcher.handleIncoming(makeIncoming({
      senderId: "user-b",
      chatId: "chat-b",
    }));
    await flushMicrotasks();

    try {
      expect(new Set(events)).toEqual(new Set([
        "chat-a:agent:start",
        "chat-b:agent:start",
      ]));
    } finally {
      release();
      await Promise.all([first, second]);
    }
  });
});
