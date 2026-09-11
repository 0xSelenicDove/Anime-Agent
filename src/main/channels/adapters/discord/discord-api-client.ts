// Discord 机器人 REST 客户端（Discord Developer Portal 创建的 Bot）。
//
// 职责：
//   1) 查询带分片建议的网关地址（GET /gateway/bot，需要 Bot Token 鉴权）
//   2) 发送频道消息（POST /channels/{channel.id}/messages）
//
// 协议要点（参考 discord.com/developers/docs）：
//   - 鉴权头：`Authorization: Bot <token>`（REST 与 Gateway IDENTIFY 的 token 字段不同：
//     Gateway IDENTIFY 的 token 字段是裸 token，不带 "Bot " 前缀）。
//   - Bot Token 长期有效（用户在开发者后台手动生成/吊销），无需像 QQ Bot 那样刷新 access_token。
//   - Discord 单条消息文本上限 2000 字符，超出需分段发送。
//   - 与 QQ 官方机器人不同：Discord Bot 可随时主动发消息到已知 channel_id，无被动回复时间窗限制。
const API_BASE = "https://discord.com/api/v10";

/** 可注入的 fetch（测试用）。签名与全局 fetch 一致。 */
export type DiscordFetch = (url: string, init?: RequestInit) => Promise<Response>;

export class DiscordApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: unknown,
  ) {
    super(message);
    this.name = "DiscordApiError";
  }
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
}

export class DiscordApiClient {
  constructor(
    private readonly botToken: string,
    private readonly fetchFn: DiscordFetch = (url, init) => fetch(url, init),
  ) {}

  /** 查询网关地址 + 建议分片数（用于校验 Token 有效性，也用于 testConnection）。 */
  async getGatewayBotInfo(): Promise<{ url: string; shards: number }> {
    const data = await this.request<{ url?: string; shards?: number }>("/gateway/bot");
    if (!data.url) throw new DiscordApiError("gateway/bot 响应缺少 url", 200);
    return { url: data.url, shards: typeof data.shards === "number" ? data.shards : 1 };
  }

  /** 发送一条频道消息（DM 和服务器频道统一走 channel_id，无需区分）。 */
  async sendMessage(channelId: string, body: { content?: string; embeds?: DiscordEmbed[] }): Promise<void> {
    await this.request(`/channels/${encodeURIComponent(channelId)}/messages`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchFn(`${API_BASE}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bot ${this.botToken}`,
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as { code?: unknown; message?: unknown };
        detail = body.message ? ` ${String(body.message)} (code ${String(body.code)})` : "";
      } catch {
        // 非 JSON 错误体，忽略
      }
      throw new DiscordApiError(`Discord API ${path} 失败 (HTTP ${res.status})${detail}`, res.status);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }
}
