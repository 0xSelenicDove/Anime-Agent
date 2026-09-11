import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscordChannelConfig } from "../../settings-store";

const mockedSettings = vi.hoisted(() => ({
  wechat: { enabled: false },
  feishu: { enabled: false },
  qq: {
    enabled: false,
    listenMode: "loopback" as const,
    port: 0,
    allowedPrivateUserIds: [],
    allowedGroupIds: [],
    groupRequireMention: true as const,
    groupReplyStyle: "reply-and-mention" as const,
    groupToolPolicy: "off" as const,
    groupMemoryPolicy: "shared-personal" as const,
  },
  qqbot: {
    enabled: false,
    allowAnyPrivate: false,
    allowedUserOpenids: [],
    allowedGroupOpenids: [],
  },
  discord: {
    enabled: true,
    botToken: "fake-bot-token",
    allowAnyDm: false,
    allowedUserIds: ["100000000000000001"],
    allowedGuildIds: ["200000000000000001"],
  } satisfies DiscordChannelConfig,
  inboundPort: 0,
  sharedSecret: "",
  rateLimitPerUser: 10,
  rateLimitPerChannel: 100,
  ttsEnabled: false,
  stickerEnabled: false,
  mirrorToDesktop: false,
  toolSandbox: "all" as const,
}));

vi.mock("electron", () => ({
  app: { getPath: () => process.env.TEMP ?? process.cwd() },
}));

vi.mock("../../settings-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../settings-store")>();
  return { ...actual, loadChannelsSettings: () => mockedSettings };
});

const apiState = vi.hoisted(() => ({
  sent: [] as Array<{ channelId: string; body: Record<string, unknown> }>,
}));

vi.mock("./discord-api-client", () => ({
  DiscordApiError: class extends Error {},
  DiscordApiClient: class {
    async getGatewayBotInfo(): Promise<{ url: string; shards: number }> {
      return { url: "wss://fake-gateway.discord.gg", shards: 1 };
    }
    async sendMessage(channelId: string, body: Record<string, unknown>): Promise<void> {
      apiState.sent.push({ channelId, body });
    }
  },
}));

const wsState = vi.hoisted(() => ({
  options: null as unknown as {
    onDispatch: (type: string, data: Record<string, unknown>) => void;
    onReadyChange: (ready: boolean) => void;
    onError: (error: Error) => void;
  },
}));

vi.mock("./discord-ws-client", () => ({
  DiscordWsClient: class {
    isReady = false;
    constructor(options: unknown) {
      wsState.options = options as typeof wsState.options;
    }
    async start(): Promise<void> {
      this.isReady = true;
      wsState.options.onReadyChange(true);
    }
    async stop(): Promise<void> {
      this.isReady = false;
      wsState.options.onReadyChange(false);
    }
  },
}));

import { DiscordAdapter, isDiscordEventAllowed, normalizeDiscordEvent } from "./discord-adapter";
import type { IncomingMessage, OutgoingMessage } from "../../types";

const adapters: DiscordAdapter[] = [];

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.stop();
  apiState.sent.length = 0;
});

function dmEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "msg-dm-001",
    channel_id: "300000000000000001",
    author: { id: "100000000000000001", username: "alice", global_name: "Alice" },
    content: "hello",
    timestamp: "2026-08-28T12:00:00.000Z",
    ...overrides,
  };
}

function guildEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "msg-guild-001",
    channel_id: "400000000000000001",
    guild_id: "200000000000000001",
    author: { id: "100000000000000002", username: "bob" },
    content: " are you there?",
    mentions: [{ id: "bot-self-id", username: "cyrene", bot: true }],
    timestamp: "2026-08-28T12:00:00.000Z",
    ...overrides,
  };
}

describe("normalizeDiscordEvent", () => {
  it("normalizes DM events to private messages", () => {
    const msg = normalizeDiscordEvent("MESSAGE_CREATE", dmEvent());
    expect(msg).not.toBeNull();
    expect(msg!.channel).toBe("discord");
    expect(msg!.chatType).toBe("private");
    expect(msg!.senderId).toBe("100000000000000001");
    expect(msg!.senderName).toBe("Alice");
    expect(msg!.chatId).toBe("300000000000000001");
    expect(msg!.text).toBe("hello");
    expect(msg!.at.getTime()).toBe(Date.parse("2026-08-28T12:00:00.000Z"));
  });

  it("normalizes guild events to group messages and trims content", () => {
    const msg = normalizeDiscordEvent("MESSAGE_CREATE", guildEvent());
    expect(msg!.chatType).toBe("group");
    expect(msg!.chatId).toBe("400000000000000001");
    expect(msg!.text).toBe("are you there?");
    expect(msg!.mentions).toHaveLength(1);
  });

  it("parses image attachments from CDN urls", () => {
    const msg = normalizeDiscordEvent("MESSAGE_CREATE", dmEvent({
      content: "",
      attachments: [{ id: "a1", content_type: "image/png", url: "https://cdn.discordapp.com/a.png", filename: "a.png" }],
    }));
    expect(msg!.attachments).toHaveLength(1);
    expect(msg!.attachments![0]).toMatchObject({ kind: "image", url: "https://cdn.discordapp.com/a.png", mime: "image/png" });
  });

  it("ignores bot authors and events without content/attachments", () => {
    expect(normalizeDiscordEvent("MESSAGE_CREATE", dmEvent({ author: { id: "1", bot: true } }))).toBeNull();
    expect(normalizeDiscordEvent("MESSAGE_CREATE", dmEvent({ content: "" }))).toBeNull();
    expect(normalizeDiscordEvent("READY", {})).toBeNull();
  });
});

describe("isDiscordEventAllowed", () => {
  const config = mockedSettings.discord;

  it("enforces the DM allowlist unless allowAnyDm", () => {
    expect(isDiscordEventAllowed({ chatType: "private", senderId: "100000000000000001" }, config)).toBe(true);
    expect(isDiscordEventAllowed({ chatType: "private", senderId: "999999999999999999" }, config)).toBe(false);
    expect(isDiscordEventAllowed(
      { chatType: "private", senderId: "999999999999999999" },
      { ...config, allowAnyDm: true },
    )).toBe(true);
  });

  it("enforces the guild allowlist", () => {
    expect(isDiscordEventAllowed({ chatType: "group", senderId: "u1", guildId: "200000000000000001" }, config)).toBe(true);
    expect(isDiscordEventAllowed({ chatType: "group", senderId: "u1", guildId: "999999999999999999" }, config)).toBe(false);
    expect(isDiscordEventAllowed({ chatType: "group", senderId: "u1" }, config)).toBe(false);
  });
});

describe("DiscordAdapter", () => {
  it("starts, records rejected userId, and reports it in status detail", async () => {
    const adapter = new DiscordAdapter();
    adapters.push(adapter);
    await adapter.start();
    expect(adapter.getStatus().phase).toBe("running");

    wsState.options.onDispatch("MESSAGE_CREATE", dmEvent({ id: "msg-stranger", author: { id: "999999999999999999" } }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(adapter.getStatus().detail?.lastRejectedUserId).toBe("999999999999999999");
  });

  it("delivers whitelisted DM messages to onMessage and can proactively send without waiting on a reply window", async () => {
    const adapter = new DiscordAdapter();
    adapters.push(adapter);
    await adapter.start();

    let captured: IncomingMessage | null = null;
    adapter.onMessage = async (msg) => {
      captured = msg;
      return null;
    };
    wsState.options.onDispatch("MESSAGE_CREATE", dmEvent());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(captured!.senderId).toBe("100000000000000001");

    // 与 QQ 官方机器人不同：无需先有入站消息也能发送（主动推送）
    const outgoing: OutgoingMessage = {
      channel: "discord",
      chatType: "private",
      targetId: "300000000000000001",
      parts: [{ kind: "text", text: "proactive hello" }],
    };
    const result = await adapter.send(outgoing);
    expect(result.ok).toBe(true);
    expect(apiState.sent).toHaveLength(1);
    expect(apiState.sent[0]).toMatchObject({
      channelId: "300000000000000001",
      body: { content: "proactive hello" },
    });
  });

  it("only responds to guild messages that mention the bot", async () => {
    const adapter = new DiscordAdapter();
    adapters.push(adapter);
    await adapter.start();
    // READY 先带上机器人自己的 id（后续 mention 判断依赖它）
    wsState.options.onDispatch("READY", { user: { id: "bot-self-id", username: "cyrene" } });

    const seen: IncomingMessage[] = [];
    adapter.onMessage = async (msg) => {
      seen.push(msg);
      return null;
    };

    // 未 @ 机器人：忽略
    wsState.options.onDispatch("MESSAGE_CREATE", guildEvent({ id: "no-mention", mentions: [] }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toHaveLength(0);

    // @ 了机器人：处理
    wsState.options.onDispatch("MESSAGE_CREATE", guildEvent({ id: "with-mention" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toHaveLength(1);
  });

  it("splits long text replies into multiple Discord messages", async () => {
    const adapter = new DiscordAdapter();
    adapters.push(adapter);
    await adapter.start();

    const longText = "a".repeat(2500);
    const result = await adapter.send({
      channel: "discord",
      chatType: "private",
      targetId: "300000000000000001",
      parts: [{ kind: "text", text: longText }],
    });
    expect(result.ok).toBe(true);
    expect(apiState.sent.length).toBeGreaterThan(1);
    for (const entry of apiState.sent) {
      expect((entry.body.content as string).length).toBeLessThanOrEqual(2000);
    }
  });

  it("deduplicates repeated event pushes", async () => {
    const adapter = new DiscordAdapter();
    adapters.push(adapter);
    await adapter.start();

    const seen: IncomingMessage[] = [];
    adapter.onMessage = async (msg) => {
      seen.push(msg);
      return null;
    };
    const event = dmEvent();
    wsState.options.onDispatch("MESSAGE_CREATE", event);
    wsState.options.onDispatch("MESSAGE_CREATE", event);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toHaveLength(1);
  });

  it("reports not-connected instead of throwing when the gateway isn't ready", async () => {
    const adapter = new DiscordAdapter();
    adapters.push(adapter);
    const result = await adapter.send({
      channel: "discord",
      chatType: "private",
      targetId: "300000000000000001",
      parts: [{ kind: "text", text: "hi" }],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not connected");
  });
});
