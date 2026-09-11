import { describe, it, expect, vi } from "vitest";
import * as crypto from "node:crypto";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  generatePkcePair,
  generateState,
  refreshAccessToken,
  SpotifyAuthError,
  SpotifyLoopbackServer,
  SPOTIFY_LOOPBACK_PORT,
  SPOTIFY_REDIRECT_URI,
} from "./spotify-auth";

describe("generatePkcePair", () => {
  it("derives challenge as base64url(SHA256(verifier))", () => {
    const { verifier, challenge } = generatePkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toBe(crypto.createHash("sha256").update(verifier).digest("base64url"));
  });

  it("generates a fresh pair each call", () => {
    const a = generatePkcePair();
    const b = generatePkcePair();
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe("generateState", () => {
  it("returns a non-empty hex string that differs across calls", () => {
    const a = generateState();
    const b = generateState();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe("buildAuthorizeUrl", () => {
  it("includes PKCE S256 challenge, redirect_uri, and scopes", () => {
    const url = new URL(buildAuthorizeUrl({ clientId: "client-1", codeChallenge: "chal-1", state: "state-1" }));
    expect(url.origin + url.pathname).toBe("https://accounts.spotify.com/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("code_challenge")).toBe("chal-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("redirect_uri")).toBe(SPOTIFY_REDIRECT_URI);
    expect(url.searchParams.get("scope")).toContain("user-modify-playback-state");
  });
});

describe("exchangeCodeForToken / refreshAccessToken", () => {
  it("posts the authorization_code grant with the PKCE verifier (no client secret)", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: String(init?.body) });
      return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "s", token_type: "Bearer" }), { status: 200 });
    });
    const token = await exchangeCodeForToken({ clientId: "cid", code: "code-1", verifier: "verifier-1" }, fetchFn as never);
    expect(token.access_token).toBe("at");
    expect(calls[0].url).toBe("https://accounts.spotify.com/api/token");
    const params = new URLSearchParams(calls[0].body);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code")).toBe("code-1");
    expect(params.get("code_verifier")).toBe("verifier-1");
    expect(params.get("client_secret")).toBeNull();
  });

  it("posts the refresh_token grant", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "at2", expires_in: 3600, scope: "s", token_type: "Bearer" }), { status: 200 }));
    const token = await refreshAccessToken({ clientId: "cid", refreshToken: "rt-old" }, fetchFn as never);
    expect(token.access_token).toBe("at2");
    const params = new URLSearchParams(String((fetchFn.mock.calls[0][1] as RequestInit).body));
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("rt-old");
  });

  it("throws SpotifyAuthError with the server's error_description on failure", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "code expired" }), { status: 400 }));
    await expect(exchangeCodeForToken({ clientId: "cid", code: "c", verifier: "v" }, fetchFn as never))
      .rejects.toThrow(SpotifyAuthError);
  });
});

describe("SpotifyLoopbackServer", () => {
  // 每个用例用不同端口：production 里同一时间只会有一个登录流程，但测试里前一个
  // server.close() 排水（等 keep-alive 连接断开）是异步的，复用同一端口会造成竞态。
  let port = 61900;
  function nextPort(): number {
    port += 1;
    return port;
  }

  it("resolves with the code when the callback matches the expected state", async () => {
    const p = nextPort();
    const server = new SpotifyLoopbackServer(p);
    const pending = server.waitForCallback("state-abc", 5_000);
    await vi.waitFor(() => fetch(`http://127.0.0.1:${p}/`).then(() => true).catch(() => { throw new Error("not up"); }));
    await fetch(`http://127.0.0.1:${p}/callback?code=code-xyz&state=state-abc`);
    await expect(pending).resolves.toEqual({ code: "code-xyz" });
  });

  it("rejects when state doesn't match (CSRF guard)", async () => {
    const p = nextPort();
    const server = new SpotifyLoopbackServer(p);
    const pending = server.waitForCallback("expected-state", 5_000);
    pending.catch(() => undefined); // 避免 reject 早于下方 await 断言附加 handler 时被判定为 unhandled rejection
    await vi.waitFor(() => fetch(`http://127.0.0.1:${p}/`).then(() => true).catch(() => { throw new Error("not up"); }));
    await fetch(`http://127.0.0.1:${p}/callback?code=code-xyz&state=wrong-state`);
    await expect(pending).rejects.toThrow(/state/);
  });

  it("rejects when Spotify redirects back with an error param (user denied)", async () => {
    const p = nextPort();
    const server = new SpotifyLoopbackServer(p);
    const pending = server.waitForCallback("state-1", 5_000);
    pending.catch(() => undefined); // 同上：抑制提前 reject 触发的 unhandled rejection 噪音
    await vi.waitFor(() => fetch(`http://127.0.0.1:${p}/`).then(() => true).catch(() => { throw new Error("not up"); }));
    await fetch(`http://127.0.0.1:${p}/callback?error=access_denied&state=state-1`);
    await expect(pending).rejects.toThrow(/拒绝/);
  });

  it("rejects with a clear message on timeout", async () => {
    const server = new SpotifyLoopbackServer(nextPort());
    await expect(server.waitForCallback("state-1", 30)).rejects.toThrow(/超时/);
  });

  it("defaults to SPOTIFY_LOOPBACK_PORT when no port is given (production wiring)", () => {
    expect(new SpotifyLoopbackServer()).toBeInstanceOf(SpotifyLoopbackServer);
    expect(SPOTIFY_REDIRECT_URI).toContain(String(SPOTIFY_LOOPBACK_PORT));
  });
});
