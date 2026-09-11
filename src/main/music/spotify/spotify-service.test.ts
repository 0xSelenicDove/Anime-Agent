import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const openExternal = vi.fn(async () => undefined);
vi.mock("electron", () => ({
  shell: { openExternal: (...args: unknown[]) => openExternal(...args) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString("utf8").replace(/^enc:/, ""),
  },
}));

const authState = vi.hoisted(() => ({
  waitForCallbackImpl: async (_state: string) => ({ code: "auth-code-1" }),
  stopped: 0,
}));

vi.mock("./spotify-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./spotify-auth")>();
  return {
    ...actual,
    generatePkcePair: () => ({ verifier: "verifier-1", challenge: "challenge-1" }),
    generateState: () => "state-1",
    buildAuthorizeUrl: (p: { clientId: string }) => `https://accounts.spotify.com/authorize?client_id=${p.clientId}`,
    exchangeCodeForToken: vi.fn(async () => ({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: "s", token_type: "Bearer" })),
    refreshAccessToken: vi.fn(async () => ({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600, scope: "s", token_type: "Bearer" })),
    SpotifyLoopbackServer: class {
      async waitForCallback(state: string) {
        return authState.waitForCallbackImpl(state);
      }
      async stop() {
        authState.stopped++;
      }
    },
  };
});

const clientState = vi.hoisted(() => ({
  devices: [] as Array<{ id: string | null; name: string; type: string; isActive: boolean; volumePercent: number | null }>,
  playCalls: [] as Array<{ deviceId?: string; uris?: string[] }>,
  profile: { id: "u1", displayName: "Test User", product: "premium" },
}));

vi.mock("./spotify-client", () => ({
  SpotifyApiClient: class {
    constructor(public getAccessToken: () => Promise<string>) {}
    async getMe() { await this.getAccessToken(); return clientState.profile; }
    async search() { await this.getAccessToken(); return []; }
    async getDevices() { await this.getAccessToken(); return clientState.devices; }
    async getPlaybackState() { await this.getAccessToken(); return null; }
    async play(opts: { deviceId?: string; uris?: string[] }) { await this.getAccessToken(); clientState.playCalls.push(opts); }
    async pause() { await this.getAccessToken(); }
    async next() { await this.getAccessToken(); }
    async previous() { await this.getAccessToken(); }
    async setVolume() { await this.getAccessToken(); }
  },
}));

import { SpotifyService } from "./spotify-service";
import { MusicInputError } from "../types";
import type { MusicPaths } from "../paths";

let dir = "";
async function makePaths(): Promise<MusicPaths> {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "spotify-service-"));
  return {
    runtimeDir: path.join(dir, "runtime"),
    accountPath: path.join(dir, "netease", "account.enc"),
    resourceBaseDir: dir,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  clientState.devices = [];
  clientState.playCalls = [];
  authState.waitForCallbackImpl = async () => ({ code: "auth-code-1" });
});

describe("SpotifyService.beginLogin", () => {
  it("throws when no Client ID has ever been configured", async () => {
    const service = new SpotifyService(await makePaths());
    await expect(service.beginLogin()).rejects.toThrow(MusicInputError);
    await expect(service.beginLogin()).rejects.toMatchObject({ code: "E_SPOTIFY_CLIENT_ID_MISSING" });
  });

  it("saves the Client ID, opens the system browser, exchanges the code, and reaches connected", async () => {
    const service = new SpotifyService(await makePaths());
    const { profile } = await service.beginLogin("client-abc");
    expect(profile.displayName).toBe("Test User");
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(String(openExternal.mock.calls[0][0])).toContain("client_id=client-abc");
    expect(service.getStatus()).toMatchObject({ backendState: "connected", hasClientId: true });
    expect((await service.getConfig())?.clientId).toBe("client-abc");
  });

  it("rejects a second concurrent login attempt", async () => {
    const service = new SpotifyService(await makePaths());
    let releaseFirst!: () => void;
    authState.waitForCallbackImpl = () => new Promise((resolve) => {
      releaseFirst = () => resolve({ code: "auth-code-1" });
    });
    const first = service.beginLogin("client-abc");
    await vi.waitFor(() => expect(service.getStatus().backendState).toBe("connecting"));
    await expect(service.beginLogin()).rejects.toMatchObject({ code: "E_SPOTIFY_LOGIN_ALREADY_ACTIVE" });
    releaseFirst();
    await first;
  });

  it("sets backendState=error and surfaces the message when the loopback rejects", async () => {
    authState.waitForCallbackImpl = async () => { throw new Error("Spotify 授权被拒绝：access_denied"); };
    const service = new SpotifyService(await makePaths());
    await expect(service.beginLogin("client-abc")).rejects.toThrow(/拒绝/);
    expect(service.getStatus().backendState).toBe("error");
  });
});

describe("SpotifyService.cancelLogin / logout", () => {
  it("cancelLogin stops the in-flight loopback server and resets to disconnected", async () => {
    const service = new SpotifyService(await makePaths());
    let releaseFirst!: () => void;
    authState.waitForCallbackImpl = () => new Promise((resolve) => { releaseFirst = () => resolve({ code: "x" }); });
    const first = service.beginLogin("client-abc");
    await vi.waitFor(() => expect(service.getStatus().backendState).toBe("connecting"));
    await service.cancelLogin();
    expect(service.getStatus().backendState).toBe("disconnected");
    expect(authState.stopped).toBeGreaterThan(0);
    releaseFirst();
    await first.catch(() => undefined);
  });

  it("logout clears the persisted token and returns to disconnected", async () => {
    const service = new SpotifyService(await makePaths());
    await service.beginLogin("client-abc");
    expect(service.getStatus().backendState).toBe("connected");
    await service.logout();
    expect(service.getStatus()).toMatchObject({ backendState: "disconnected", profile: null });
    await expect(service.search("x")).rejects.toMatchObject({ code: "E_SPOTIFY_NOT_CONNECTED" });
  });
});

describe("SpotifyService connected-only guards", () => {
  it("rejects search/playTrack/playback controls before connecting", async () => {
    const service = new SpotifyService(await makePaths());
    await expect(service.search("x")).rejects.toMatchObject({ code: "E_SPOTIFY_NOT_CONNECTED" });
    await expect(service.playTrack("spotify:track:x")).rejects.toMatchObject({ code: "E_SPOTIFY_NOT_CONNECTED" });
    await expect(service.pause()).rejects.toMatchObject({ code: "E_SPOTIFY_NOT_CONNECTED" });
  });
});

describe("SpotifyService.playTrack device resolution", () => {
  it("targets the active device when no deviceId is given", async () => {
    const service = new SpotifyService(await makePaths());
    await service.beginLogin("client-abc");
    clientState.devices = [
      { id: "d1", name: "Phone", type: "Smartphone", isActive: false, volumePercent: 50 },
      { id: "d2", name: "Desktop", type: "Computer", isActive: true, volumePercent: 80 },
    ];
    await service.playTrack("spotify:track:abc");
    expect(clientState.playCalls[0]).toEqual({ deviceId: "d2", uris: ["spotify:track:abc"] });
  });

  it("throws a clear, actionable error when there is no available device at all", async () => {
    const service = new SpotifyService(await makePaths());
    await service.beginLogin("client-abc");
    clientState.devices = [];
    await expect(service.playTrack("spotify:track:abc")).rejects.toMatchObject({ code: "E_SPOTIFY_NO_ACTIVE_DEVICE" });
  });
});

describe("SpotifyService token refresh", () => {
  it("refreshes and persists a new token bundle once the cached one is stale", async () => {
    const service = new SpotifyService(await makePaths());
    await service.beginLogin("client-abc");
    // 手动把内存里的 token 标成"已过期"（gotAt 拨到很久以前），下一次 API 调用应触发刷新
    (service as unknown as { tokenBundle: { gotAt: number } }).tokenBundle.gotAt = 0;
    await service.search("anything");
    const { refreshAccessToken } = await import("./spotify-auth");
    expect(refreshAccessToken).toHaveBeenCalledWith({ clientId: "client-abc", refreshToken: "rt-1" });
  });
});
