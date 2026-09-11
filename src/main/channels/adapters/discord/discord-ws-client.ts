// Discord 机器人 Gateway WebSocket 客户端。
//
// 协议（官方 opcode 约定，参考 discord.com/developers/docs/events/gateway）：
//   op 10 Hello      —— 连上后第一条，d.heartbeat_interval(ms) 指定心跳周期
//   op 2  Identify   —— 客户端鉴权 {token, intents, properties}（token 裸值，不带 "Bot " 前缀）
//   op 0  Dispatch   —— 服务端事件推送 {t: 事件名, s: 序号, d: 事件体}
//   op 1  Heartbeat  —— 客户端心跳，d = 最近收到的 s
//   op 11 Heartbeat ACK
//   op 7  Reconnect  —— 服务端要求重连（优先 Resume，并改连 resume_gateway_url）
//   op 6  Resume     —— 断线恢复 {token, session_id, seq}
//   op 9  Invalid Session —— identify/resume 参数错，需重新 Identify（随机延时避免打满限流）
//
// QQ 官方机器人网关协议是 Discord Gateway 的镜像实现，opcode 编号完全一致，
// 故本客户端结构与 qqbot-ws-client.ts 保持同构，便于交叉维护。
import WebSocket from "ws";

/** GUILDS(1<<0) + GUILD_MESSAGES(1<<9) + DIRECT_MESSAGES(1<<12) + MESSAGE_CONTENT(1<<15，特权 intent，
 *  需在 Discord Developer Portal → Bot → Privileged Gateway Intents 手动开启）。 */
export const DISCORD_INTENT_DEFAULT = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

export type DiscordEventType = "MESSAGE_CREATE" | "READY" | "RESUMED";

export interface DiscordWsEvents {
  onDispatch: (type: DiscordEventType, data: Record<string, unknown>) => void;
  /** 连接状态变化（true = 已通过鉴权收到 READY/RESUMED） */
  onReadyChange: (ready: boolean) => void;
  onError: (error: Error) => void;
}

export interface DiscordWsClientOptions extends DiscordWsEvents {
  /** 网关地址（wss://gateway.discord.gg），来自 GET /gateway/bot */
  gatewayUrl: string;
  /** 裸 Bot Token（不带 "Bot " 前缀） */
  token: string;
  /** 只订阅的事件集合，默认 GUILDS + GUILD_MESSAGES + DIRECT_MESSAGES + MESSAGE_CONTENT */
  intents?: number;
  /** 重连退避上限（ms），测试可调小 */
  maxBackoffMs?: number;
  /** 测试注入 WebSocket 构造器 */
  websocketFactory?: (url: string) => WebSocket;
}

interface WsPayload {
  op?: number;
  s?: number;
  t?: string;
  d?: unknown;
}

const DEFAULT_MAX_BACKOFF_MS = 60_000;
const GATEWAY_QUERY = "?v=10&encoding=json";

export class DiscordWsClient {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private seq = 0;
  private sessionId = "";
  /** READY 事件里的 resume_gateway_url；断线重连（Resume）优先连它而不是初始网关地址。 */
  private resumeGatewayUrl = "";
  private ready = false;
  private backoffMs = 1_000;
  private heartbeatAcked = true;
  private lastError: Error | null = null;

  constructor(private readonly options: DiscordWsClientOptions) {}

  get isReady(): boolean {
    return this.ready;
  }

  getLastError(): Error | null {
    return this.lastError;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect(false);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState <= WebSocket.OPEN) {
      ws.removeAllListeners();
      try {
        ws.close(1000, "client shutdown");
      } catch {
        // 已断开时 close 会抛错，忽略
      }
    }
    this.setReady(false);
  }

  private async connect(resume: boolean): Promise<void> {
    if (this.stopped) return;
    const base = resume && this.resumeGatewayUrl ? this.resumeGatewayUrl : this.options.gatewayUrl;
    const url = `${base}${GATEWAY_QUERY}`;
    const ws = this.options.websocketFactory ? this.options.websocketFactory(url) : new WebSocket(url);
    this.ws = ws;
    this.heartbeatAcked = true;

    ws.on("message", (raw: unknown) => {
      try {
        this.handlePayload(JSON.parse(String(raw)) as WsPayload, resume);
      } catch (error) {
        this.options.onError(error instanceof Error ? error : new Error(String(error)));
      }
    });
    ws.on("error", (error: Error) => {
      this.lastError = error;
      this.options.onError(error);
    });
    ws.on("close", () => {
      this.clearHeartbeat();
      if (this.stopped) return;
      // close 后统一走重连；是否可 Resume 由 connect 内决定
      this.setReady(false);
      this.scheduleReconnect();
    });
  }

  private handlePayload(payload: WsPayload, resume: boolean): void {
    switch (payload.op) {
      case 10: {
        // Hello：按服务端指定周期发心跳（首次带 jitter 避免惊群），然后鉴权
        const interval = Number(
          (payload.d as { heartbeat_interval?: number } | null)?.heartbeat_interval ?? 41_250,
        );
        this.startHeartbeat(interval);
        if (resume && this.sessionId && this.seq > 0) {
          this.send({ op: 6, d: { token: this.options.token, session_id: this.sessionId, seq: this.seq } });
        } else {
          this.sendIdentify();
        }
        break;
      }
      case 0: {
        // Dispatch：记录序号 + 抛事件
        if (typeof payload.s === "number") this.seq = payload.s;
        const type = (payload.t ?? "") as DiscordEventType;
        const data = (payload.d ?? {}) as Record<string, unknown>;
        if (type === "READY") {
          this.sessionId = String(data.session_id ?? "");
          this.resumeGatewayUrl = String(data.resume_gateway_url ?? "");
          this.backoffMs = 1_000;
          this.setReady(true);
          this.options.onDispatch(type, data);
        } else if (type === "RESUMED") {
          this.backoffMs = 1_000;
          this.setReady(true);
        } else if (type) {
          this.options.onDispatch(type, data);
        }
        break;
      }
      case 11:
        // Heartbeat ACK
        this.heartbeatAcked = true;
        break;
      case 7:
        // 服务端要求重连：优先 Resume（连 resume_gateway_url）
        if (this.ws) {
          try {
            this.ws.close(4000, "server requested reconnect");
          } catch {
            // 忽略
          }
        }
        break;
      case 9: {
        // Invalid Session：随机延时后重新 Identify（丢弃旧 session，避免顶着限流猛重试）
        this.sessionId = "";
        this.seq = 0;
        this.resumeGatewayUrl = "";
        const delay = 1_000 + Math.floor(Math.random() * 4_000);
        setTimeout(() => {
          if (!this.stopped) this.sendIdentify();
        }, delay);
        break;
      }
      default:
        break;
    }
  }

  private sendIdentify(): void {
    this.send({
      op: 2,
      d: {
        token: this.options.token,
        intents: this.options.intents ?? DISCORD_INTENT_DEFAULT,
        properties: { os: process.platform, browser: "cyrene", device: "cyrene" },
      },
    });
  }

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();
    this.heartbeatAcked = true;
    this.heartbeatTimer = setInterval(() => {
      if (!this.heartbeatAcked) {
        // 两次心跳没 ACK：连接假死，强制断开触发重连
        this.options.onError(new Error("Discord 心跳超时，重连"));
        try {
          this.ws?.terminate();
        } catch {
          // 忽略
        }
        return;
      }
      this.heartbeatAcked = false;
      this.send({ op: 1, d: this.seq > 0 ? this.seq : null });
    }, Math.max(1_000, intervalMs));
  }

  private send(payload: WsPayload): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch (error) {
      this.options.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS);
    const canResume = Boolean(this.sessionId) && this.seq > 0;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect(canResume);
    }, delay);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setReady(ready: boolean): void {
    if (this.ready === ready) return;
    this.ready = ready;
    this.options.onReadyChange(ready);
  }
}
