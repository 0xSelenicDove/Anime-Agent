// Spotify OAuth：Authorization Code + PKCE（RFC 7636），走本机回环 HTTP 服务器接收重定向。
//
// 为什么是 PKCE 而不是网易云那种扫码轮询：Spotify 官方 Web API 没有二维码登录，
// 标准桌面应用接入方式就是 Authorization Code with PKCE —— 不需要 client secret
// （Spotify Client ID 本身不是密钥，可以明文存），登录态由 refresh_token 维持。
//
// 回环端口固定为 61823（而不是随机可用端口）：Spotify 开发者后台的 Redirect URI
// 必须逐字匹配已注册值，不支持通配端口，所以这里用固定端口换取"设置里贴一次
// Redirect URI 就不用再改"的简单性。
import * as crypto from "node:crypto";
import * as http from "node:http";

export const SPOTIFY_LOOPBACK_PORT = 61823;
export const SPOTIFY_REDIRECT_URI = `http://127.0.0.1:${SPOTIFY_LOOPBACK_PORT}/callback`;
export const SPOTIFY_SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
].join(" ");

const AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";

export type SpotifyFetch = (url: string, init?: RequestInit) => Promise<Response>;

export class SpotifyAuthError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "SpotifyAuthError";
  }
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** code_verifier：43-128 位的 unreserved 字符集随机串；challenge = base64url(SHA256(verifier))。 */
export function generatePkcePair(): PkcePair {
  const verifier = crypto.randomBytes(64).toString("base64url"); // 86 chars，落在合法区间内
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function generateState(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function buildAuthorizeUrl(params: { clientId: string; codeChallenge: string; state: string }): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", SPOTIFY_REDIRECT_URI);
  url.searchParams.set("state", params.state);
  url.searchParams.set("scope", SPOTIFY_SCOPES);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", params.codeChallenge);
  return url.toString();
}

export interface SpotifyTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

export async function exchangeCodeForToken(
  params: { clientId: string; code: string; verifier: string },
  fetchFn: SpotifyFetch = (url, init) => fetch(url, init),
): Promise<SpotifyTokenResponse> {
  return requestToken(
    {
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: SPOTIFY_REDIRECT_URI,
      client_id: params.clientId,
      code_verifier: params.verifier,
    },
    fetchFn,
  );
}

export async function refreshAccessToken(
  params: { clientId: string; refreshToken: string },
  fetchFn: SpotifyFetch = (url, init) => fetch(url, init),
): Promise<SpotifyTokenResponse> {
  return requestToken(
    { grant_type: "refresh_token", refresh_token: params.refreshToken, client_id: params.clientId },
    fetchFn,
  );
}

async function requestToken(body: Record<string, string>, fetchFn: SpotifyFetch): Promise<SpotifyTokenResponse> {
  const res = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const data = (await res.json()) as { error?: string; error_description?: string };
      detail = data.error_description ? ` ${data.error_description}` : data.error ? ` ${data.error}` : "";
    } catch {
      // 非 JSON 错误体，忽略
    }
    throw new SpotifyAuthError(`Spotify token 请求失败 (HTTP ${res.status})${detail}`, "E_SPOTIFY_TOKEN_EXCHANGE_FAILED");
  }
  return (await res.json()) as SpotifyTokenResponse;
}

/** 本机回环 HTTP 服务器：只接受一次 /callback 请求，拿到 code 后立即关闭。
 *  端口默认固定为 SPOTIFY_LOOPBACK_PORT（生产用，必须与 Redirect URI 一致）；
 *  测试可传入不同端口，避免多个测试用例抢同一个端口、等前一个 server.close() 排水导致的竞态。 */
export class SpotifyLoopbackServer {
  private server: http.Server | null = null;

  constructor(private readonly port: number = SPOTIFY_LOOPBACK_PORT) {}

  /** 启动监听并等待回调；超时 / 用户拒绝 / state 不匹配都 reject。 */
  async waitForCallback(expectedState: string, timeoutMs = 5 * 60_000): Promise<{ code: string }> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
        if (url.pathname !== "/callback") {
          res.writeHead(404).end();
          return;
        }
        const error = url.searchParams.get("error");
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(callbackPage(error ? "failed" : "ok"));
        clearTimeout(timer);
        void this.stop();
        if (error) {
          reject(new SpotifyAuthError(`Spotify 授权被拒绝：${error}`, "E_SPOTIFY_AUTH_DENIED"));
        } else if (!code || state !== expectedState) {
          reject(new SpotifyAuthError("Spotify 回调缺少 code 或 state 不匹配", "E_SPOTIFY_AUTH_STATE_MISMATCH"));
        } else {
          resolve({ code });
        }
      });
      this.server = server;
      const timer = setTimeout(() => {
        void this.stop();
        reject(new SpotifyAuthError("等待 Spotify 授权超时", "E_SPOTIFY_AUTH_TIMEOUT"));
      }, timeoutMs);
      server.once("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (err.code === "EADDRINUSE") {
          reject(new SpotifyAuthError(
            `本地端口 ${this.port} 已被占用，无法接收 Spotify 授权回调；请关闭占用该端口的程序后重试`,
            "E_SPOTIFY_PORT_IN_USE",
          ));
        } else {
          reject(new SpotifyAuthError(err.message, "E_SPOTIFY_LOOPBACK_ERROR"));
        }
      });
      server.listen(this.port, "127.0.0.1");
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function callbackPage(status: "ok" | "failed"): string {
  const title = status === "ok" ? "Spotify connected" : "Spotify authorization failed";
  const body = status === "ok"
    ? "You can close this window and go back to Cyrene Agent."
    : "Authorization was cancelled or denied. You can close this window and try again.";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#121212;color:#fff}
main{text-align:center;max-width:360px}</style></head>
<body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
}
