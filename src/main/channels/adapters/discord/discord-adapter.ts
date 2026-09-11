// Discord 机器人渠道适配器。
//
// 与 QQ 官方机器人（"qqbot"）的关键区别：
//   - Discord Bot 可随时主动发消息到已知 channel_id，没有被动回复时间窗 / 次数限制，
//     所以本 adapter 不需要 lastInbound 追踪表。
//   - 私信（DM）与服务器频道消息统一走 channel_id 发送；服务器消息固定要求 @ 机器人
//     （不看群主是否开启"全量消息"这类开关，简单可靠）。
//   - 富媒体：v1 只做文本 + embed 卡片；图片/文件/语音走 outgoing-composer 的能力降级
//     （capability 里全部声明 false），降级为纯文本占位，见 downgradeToCapability。
//
// 白名单模型：DM 对方 userId 事先不知道，所以提供两种方式——
//   allowAnyDm（默认关）：所有私信放行；
//   拒绝时把 userId 记入状态（UI 展示），用户复制进白名单即可放行。
import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import type { ChannelAdapter } from "../base";
import type {
  ChannelAttachment,
  ChannelCapability,
  ChannelReplyContext,
  ChannelStatus,
  IncomingMessage,
  MessageHandler,
  OutgoingMessage,
  OutgoingPart,
} from "../../types";
import { loadChannelsSettings, type DiscordChannelConfig } from "../../settings-store";
import { DiscordApiClient, DiscordApiError, type DiscordEmbed } from "./discord-api-client";
import { DiscordWsClient, type DiscordEventType } from "./discord-ws-client";
// 通用文本分段器（按标点/换行切段，避免硬切断句）。函数名带 Qq 前缀是历史遗留
// （QQ Bot 渠道也复用同一实现），逻辑与渠道无关，见 napcat-adapter.ts。
import { splitQqText } from "../qq/napcat-adapter";

const CAPABILITY: ChannelCapability = {
  text: true,
  image: false,
  audio: false,
  file: false,
  video: false,
  markdown: true,
  card: true,
  sticker: false,
  // 0 = 关闭 outgoing-composer 的截断降级；超长文本由本 adapter 自行分段为多条消息发送
  maxTextLength: 0,
};

/** Discord 单条消息文本上限（REST API 硬限制） */
const DISCORD_TEXT_LIMIT = 2000;
const DEDUPE_TTL_MS = 10 * 60_000;
/** 入站附件下载上限：8 MiB */
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/** 事件体 → 是否在白名单内（导出便于测试） */
export function isDiscordEventAllowed(
  data: { chatType: "private" | "group"; senderId: string; guildId?: string },
  config: DiscordChannelConfig,
): boolean {
  if (data.chatType === "private") {
    return config.allowAnyDm || config.allowedUserIds.includes(data.senderId);
  }
  return Boolean(data.guildId) && config.allowedGuildIds.includes(data.guildId!);
}

/** mentions 数组里是否包含指定用户 id（用于判断服务器消息是否 @ 了机器人） */
function mentionsInclude(raw: unknown, userId: string): boolean {
  if (!Array.isArray(raw) || !userId) return false;
  return raw.some((item) => String((item as { id?: unknown })?.id ?? "") === userId);
}

/** 事件体 → IncomingMessage（导出便于测试；attachments 由 adapter 侧下载后补 filePath） */
export function normalizeDiscordEvent(
  type: DiscordEventType,
  data: Record<string, unknown>,
): IncomingMessage | null {
  if (type !== "MESSAGE_CREATE") return null;
  const author = (data.author ?? {}) as Record<string, unknown>;
  if (author.bot === true) return null; // 忽略其他机器人（含自己）发出的消息，避免循环
  const senderId = String(author.id ?? "");
  const channelId = String(data.channel_id ?? "");
  if (!senderId || !channelId) return null;
  const content = String(data.content ?? "").trim();
  const attachments = parseAttachments(data.attachments);
  if (!content && attachments.length === 0) return null;
  const guildId = typeof data.guild_id === "string" ? data.guild_id : undefined;
  const senderName =
    (typeof author.global_name === "string" && author.global_name) ||
    (typeof author.username === "string" && author.username) ||
    undefined;
  return {
    channel: "discord",
    chatType: guildId ? "group" : "private",
    messageId: String(data.id ?? ""),
    senderId,
    senderName,
    chatId: channelId,
    text: content,
    attachments: attachments.length > 0 ? attachments : undefined,
    mentions: parseMentions(data.mentions),
    reply: parseReply(data.referenced_message),
    at: parseTimestamp(String(data.timestamp ?? "")),
    _raw: data,
  };
}

function parseMentions(raw: unknown): IncomingMessage["mentions"] {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out = raw
    .map((item) => {
      const m = (item ?? {}) as Record<string, unknown>;
      const userId = String(m.id ?? "");
      if (!userId) return null;
      return {
        userId,
        name: typeof m.username === "string" ? m.username : undefined,
        isBot: m.bot === true,
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);
  return out.length > 0 ? out : undefined;
}

function parseReply(raw: unknown): ChannelReplyContext | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const ref = raw as Record<string, unknown>;
  const messageId = String(ref.id ?? "");
  if (!messageId) return undefined;
  const author = (ref.author ?? {}) as Record<string, unknown>;
  return {
    messageId,
    senderId: typeof author.id === "string" ? author.id : undefined,
    senderName: typeof author.username === "string" ? author.username : undefined,
    text: typeof ref.content === "string" ? ref.content : undefined,
  };
}

function parseAttachments(raw: unknown): ChannelAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: ChannelAttachment[] = [];
  for (const item of raw) {
    const a = (item ?? {}) as Record<string, unknown>;
    const url = String(a.url ?? "");
    if (!url) continue;
    const contentType = typeof a.content_type === "string" ? a.content_type : "";
    let kind: ChannelAttachment["kind"] = "file";
    if (contentType.startsWith("image/")) kind = "image";
    else if (contentType.startsWith("audio/")) kind = "audio";
    else if (contentType.startsWith("video/")) kind = "video";
    out.push({
      kind,
      url,
      mime: contentType || undefined,
      caption: typeof a.filename === "string" && a.filename ? a.filename : undefined,
    });
  }
  return out;
}

function parseTimestamp(value: string): Date {
  if (value) {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return new Date(t);
  }
  return new Date();
}

export class DiscordAdapter implements ChannelAdapter {
  readonly id = "discord" as const;
  readonly displayName = "Discord";
  readonly capability = CAPABILITY;
  onMessage: MessageHandler | null = null;

  private api: DiscordApiClient | null = null;
  private ws: DiscordWsClient | null = null;
  private status: ChannelStatus = { enabled: false, phase: "offline", message: "Not enabled" };
  private botUserId = "";
  private botUsername = "";
  private wsReady = false;
  private lastRejected: { userId: string; chatType: "private" | "group"; at: number } | null = null;
  private dedupe = new Map<string, number>();

  constructor(private readonly onStatusChanged?: () => void) {}

  async start(): Promise<void> {
    const config = loadChannelsSettings().discord;
    if (!config.enabled) {
      this.setStatus({ enabled: false, phase: "offline", message: "Not enabled" });
      return;
    }
    if (!config.botToken) {
      this.setStatus({
        enabled: true,
        phase: "config_missing",
        message: "Missing Bot Token — create an app at discord.com/developers/applications and paste its Bot Token",
      });
      return;
    }
    this.setStatus({ enabled: true, phase: "starting", message: "Connecting to the Discord gateway" });
    this.api = new DiscordApiClient(config.botToken);
    try {
      const { url } = await this.api.getGatewayBotInfo();
      this.ws = new DiscordWsClient({
        gatewayUrl: url,
        token: config.botToken,
        onDispatch: (type, data) => this.handleDispatch(type, data),
        onReadyChange: (ready) => {
          this.wsReady = ready;
          this.setStatus({
            enabled: true,
            phase: ready ? "running" : "starting",
            message: ready ? `Connected${this.botUsername ? ` as ${this.botUsername}` : ""}` : "Reconnecting",
            detail: this.statusDetail(),
          });
        },
        onError: (error) => {
          if (this.status.phase === "running" && !this.wsReady) return; // 重连过程中的已知错误不覆盖状态
          this.setStatus({
            enabled: true,
            phase: this.ws?.isReady ? "running" : "error",
            message: error.message,
            detail: this.statusDetail(),
          });
        },
      });
      await this.ws.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus({ enabled: true, phase: "error", message });
      throw error;
    }
  }

  async stop(): Promise<void> {
    await this.ws?.stop();
    this.ws = null;
    this.api = null;
    this.wsReady = false;
    this.botUserId = "";
    this.botUsername = "";
    this.lastRejected = null;
    this.dedupe.clear();
    this.setStatus({ enabled: false, phase: "offline", message: "Stopped" });
  }

  getStatus(): ChannelStatus {
    const config = loadChannelsSettings().discord;
    if (!config.enabled) return { enabled: false, phase: "offline", message: "Not enabled" };
    return this.status;
  }

  async testConnection(): Promise<{ ok: boolean; error?: string; detail?: Record<string, unknown> }> {
    const config = loadChannelsSettings().discord;
    if (!config.botToken) return { ok: false, error: "Bot Token not configured" };
    try {
      const api = new DiscordApiClient(config.botToken);
      const info = await api.getGatewayBotInfo();
      return { ok: true, detail: { shards: info.shards } };
    } catch (error) {
      const err = error instanceof DiscordApiError ? error : error instanceof Error ? error : new Error(String(error));
      return { ok: false, error: err.message };
    }
  }

  async send(msg: OutgoingMessage): Promise<{ ok: boolean; error?: string }> {
    const api = this.api;
    if (!api || !this.wsReady) return { ok: false, error: "Discord gateway not connected" };

    const messages: Array<{ content?: string; embeds?: DiscordEmbed[] }> = [];
    let lastError: string | undefined;
    for (const part of msg.parts) {
      try {
        messages.push(...this.partToMessages(part));
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    if (messages.length === 0) return { ok: false, error: lastError || "Nothing to send to Discord" };

    let sent = 0;
    for (const body of messages) {
      try {
        await api.sendMessage(msg.targetId, body);
        sent++;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    if (sent > 0 && lastError) {
      console.warn("[DiscordAdapter] Some messages failed to send:", lastError);
    }
    return sent > 0 ? { ok: true } : { ok: false, error: lastError || "Discord send failed" };
  }

  getConnectionInfo(): Record<string, unknown> {
    return this.statusDetail();
  }

  private handleDispatch(type: DiscordEventType, data: Record<string, unknown>): void {
    if (type === "READY") {
      const user = (data.user ?? {}) as Record<string, unknown>;
      this.botUserId = typeof user.id === "string" ? user.id : "";
      this.botUsername = typeof user.username === "string" ? user.username : "";
      return;
    }
    const incoming = normalizeDiscordEvent(type, data);
    if (!incoming) return;

    const guildId = typeof data.guild_id === "string" ? data.guild_id : undefined;
    const chatType = incoming.chatType ?? "private";
    const config = loadChannelsSettings().discord;
    if (!isDiscordEventAllowed({ chatType, senderId: incoming.senderId, guildId }, config)) {
      this.lastRejected = { userId: incoming.senderId, chatType, at: Date.now() };
      // 刷新状态快照，让 UI 能看到被拒的 userId（加白名单引导）
      this.setStatus({ ...this.status, detail: this.statusDetail() });
      return;
    }
    // 服务器（guild）消息固定要求 @ 机器人，避免响应频道里的每条闲聊
    if (chatType === "group" && this.botUserId && !mentionsInclude(data.mentions, this.botUserId)) {
      return;
    }

    const dedupeKey = incoming.messageId;
    if (dedupeKey) {
      const now = Date.now();
      for (const [key, expiresAt] of this.dedupe) if (expiresAt <= now) this.dedupe.delete(key);
      if (this.dedupe.has(dedupeKey)) return;
      this.dedupe.set(dedupeKey, now + DEDUPE_TTL_MS);
    }

    void this.deliverIncoming(incoming);
  }

  private async deliverIncoming(incoming: IncomingMessage): Promise<void> {
    try {
      await this.downloadAttachments(incoming);
      await this.onMessage?.(incoming);
    } catch (error) {
      console.warn("[DiscordAdapter] Failed to process message:", error instanceof Error ? error.message : String(error));
    }
  }

  private partToMessages(part: OutgoingPart): Array<{ content?: string; embeds?: DiscordEmbed[] }> {
    if (part.kind === "text") {
      return splitQqText(part.text, DISCORD_TEXT_LIMIT).map((chunk) => ({ content: chunk }));
    }
    if (part.kind === "card") {
      const embed: DiscordEmbed = {
        title: part.title,
        description: part.markdown,
        fields: (part.fields ?? []).map((f) => ({ name: f.key, value: f.value })),
      };
      return [{ embeds: [embed] }];
    }
    throw new Error(`Discord channel doesn't support sending ${part.kind} content yet`);
  }

  /** 入站附件流式下载到本地缓存（超 8 MiB 中止，避免无界内存）。 */
  private async downloadAttachments(msg: IncomingMessage): Promise<void> {
    if (!msg.attachments?.length) return;
    const dir = path.join(app.getPath("userData"), "channels", "cache", "discord");
    fs.mkdirSync(dir, { recursive: true });
    for (const attachment of msg.attachments) {
      if (!attachment.url) continue;
      try {
        const res = await fetch(attachment.url);
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_ATTACHMENT_BYTES) {
            await reader.cancel().catch(() => undefined);
            throw new Error("Attachment exceeds the 8 MiB limit");
          }
          chunks.push(value);
        }
        const ext = attachment.kind === "image"
          ? (attachment.mime?.split("/")[1] ?? "png")
          : attachment.kind === "audio" ? "mp3" : attachment.kind === "video" ? "mp4" : "bin";
        const filePath = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
        fs.writeFileSync(filePath, Buffer.concat(chunks));
        attachment.filePath = filePath;
        attachment.url = undefined;
      } catch (error) {
        console.warn("[DiscordAdapter] Attachment download failed (keeping URL placeholder):", error instanceof Error ? error.message : String(error));
      }
    }
  }

  private statusDetail(): Record<string, unknown> {
    return {
      botUsername: this.botUsername || undefined,
      wsReady: this.wsReady,
      lastRejectedUserId: this.lastRejected?.userId,
      lastRejectedChatType: this.lastRejected?.chatType,
      lastRejectedAt: this.lastRejected ? new Date(this.lastRejected.at).toISOString() : undefined,
    };
  }

  private setStatus(status: ChannelStatus): void {
    this.status = status;
    this.onStatusChanged?.();
  }
}
