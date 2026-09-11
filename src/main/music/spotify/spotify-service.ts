// SpotifyService — orchestrates OAuth (PKCE + loopback redirect), token refresh,
// and Spotify Connect playback control (search catalog + remote-control an
// already-running official Spotify client). See spotify-client.ts for why this
// doesn't stream/cache audio like MusicService does for NetEase.
import { shell } from "electron";
import * as path from "node:path";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  generatePkcePair,
  generateState,
  refreshAccessToken,
  SpotifyLoopbackServer,
  type SpotifyTokenResponse,
} from "./spotify-auth";
import { SpotifyApiClient, type SpotifyDevice, type SpotifyPlaybackState, type SpotifyProfile, type SpotifyTrack } from "./spotify-client";
import { SpotifyConfigStore, type SpotifyConfig } from "./spotify-config";
import { SpotifyTokenVault, type SpotifyTokenBundlePayload } from "./spotify-token-vault";
import { MusicInputError } from "../types";
import type { MusicPaths } from "../paths";

export type SpotifyBackendState = "disconnected" | "connecting" | "connected" | "error";

export interface SpotifyStatusSnapshot {
  backendState: SpotifyBackendState;
  profile: SpotifyProfile | null;
  hasClientId: boolean;
  errorMessage?: string;
}

type StateListener = (state: SpotifyStatusSnapshot) => void;

export class SpotifyService {
  private backendState: SpotifyBackendState = "disconnected";
  private profile: SpotifyProfile | null = null;
  private errorMessage: string | undefined;
  private cachedClientId: string | null = null;
  private tokenBundle: SpotifyTokenBundlePayload | null = null;
  private inFlightServer: SpotifyLoopbackServer | null = null;
  private readonly listeners = new Set<StateListener>();

  private readonly configStore: SpotifyConfigStore;
  private readonly tokenVault: SpotifyTokenVault;
  readonly client: SpotifyApiClient;

  constructor(paths: MusicPaths) {
    const configDir = path.join(path.dirname(path.dirname(paths.accountPath)), "spotify");
    this.configStore = new SpotifyConfigStore(configDir);
    this.tokenVault = new SpotifyTokenVault(configDir);
    this.client = new SpotifyApiClient(() => this.ensureFreshAccessToken());
  }

  onStateChanged(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getStatus(): SpotifyStatusSnapshot {
    return {
      backendState: this.backendState,
      profile: this.profile,
      hasClientId: this.cachedClientId !== null,
      errorMessage: this.errorMessage,
    };
  }

  async getConfig(): Promise<SpotifyConfig | null> {
    return this.configStore.load();
  }

  async saveConfig(config: SpotifyConfig): Promise<void> {
    await this.configStore.save(config);
    this.cachedClientId = config.clientId;
  }

  /** 应用启动/首次操作时把已保存的 token 拉进内存，恢复"已连接"状态展示（不发网络请求）。 */
  async restore(): Promise<void> {
    const cfg = await this.configStore.load();
    this.cachedClientId = cfg?.clientId ?? null;
    const blob = await this.tokenVault.load().catch(() => null);
    if (!blob) return;
    try {
      this.tokenBundle = await this.tokenVault.decrypt(blob);
      this.setState("connected");
      // 拉一次 profile（惰性；失败不阻塞启动，等真正调用 API 时再报错）
      this.client.getMe().then((p) => { this.profile = p; this.notify(); }).catch(() => undefined);
    } catch {
      // token 损坏：静默保持 disconnected，用户重新登录即可
    }
  }

  /** 打开系统浏览器走 Spotify 授权，等待本机回环服务器收到回调并换取 token。 */
  async beginLogin(clientIdOverride?: string): Promise<{ profile: SpotifyProfile }> {
    const clientId = clientIdOverride?.trim() || this.cachedClientId || (await this.configStore.load())?.clientId;
    if (!clientId) {
      throw new MusicInputError("E_SPOTIFY_CLIENT_ID_MISSING", "尚未填写 Spotify Client ID");
    }
    if (clientIdOverride?.trim()) {
      await this.saveConfig({ clientId: clientIdOverride.trim() });
    }
    if (this.inFlightServer) {
      throw new MusicInputError("E_SPOTIFY_LOGIN_ALREADY_ACTIVE", "已有一个 Spotify 登录流程正在进行");
    }
    this.setState("connecting");
    const { verifier, challenge } = generatePkcePair();
    const state = generateState();
    const authorizeUrl = buildAuthorizeUrl({ clientId, codeChallenge: challenge, state });
    const server = new SpotifyLoopbackServer();
    this.inFlightServer = server;
    try {
      await shell.openExternal(authorizeUrl);
      const { code } = await server.waitForCallback(state);
      const token = await exchangeCodeForToken({ clientId, code, verifier });
      await this.persistToken(token);
      const profile = await this.client.getMe();
      this.profile = profile;
      this.errorMessage = undefined;
      this.setState("connected");
      return { profile };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.errorMessage = message;
      this.setState("error");
      throw err;
    } finally {
      this.inFlightServer = null;
    }
  }

  async cancelLogin(): Promise<void> {
    const server = this.inFlightServer;
    this.inFlightServer = null;
    await server?.stop();
    if (this.backendState === "connecting") this.setState("disconnected");
  }

  async logout(): Promise<void> {
    await this.cancelLogin();
    await this.tokenVault.delete();
    this.tokenBundle = null;
    this.profile = null;
    this.errorMessage = undefined;
    this.setState("disconnected");
  }

  // ── Spotify Connect 遥控 + 目录检索（全部要求已连接） ──────────────

  async search(keyword: string, limit?: number): Promise<SpotifyTrack[]> {
    this.assertConnected();
    return this.client.search(keyword, limit);
  }

  async getDevices(): Promise<SpotifyDevice[]> {
    this.assertConnected();
    return this.client.getDevices();
  }

  async getPlaybackState(): Promise<SpotifyPlaybackState | null> {
    this.assertConnected();
    return this.client.getPlaybackState();
  }

  /** 播放一首曲目；不传 deviceId 时遥控当前活跃设备（没有活跃设备会报错，提示先在某个设备上打开 Spotify）。 */
  async playTrack(uri: string, deviceId?: string): Promise<void> {
    this.assertConnected();
    const targetDevice = deviceId ?? (await this.resolveActiveDeviceId());
    await this.client.play({ deviceId: targetDevice, uris: [uri] });
  }

  async pause(): Promise<void> {
    this.assertConnected();
    await this.client.pause();
  }

  async resume(): Promise<void> {
    this.assertConnected();
    const deviceId = await this.resolveActiveDeviceId();
    await this.client.play({ deviceId });
  }

  async next(): Promise<void> {
    this.assertConnected();
    await this.client.next();
  }

  async previous(): Promise<void> {
    this.assertConnected();
    await this.client.previous();
  }

  async setVolume(volumePercent: number): Promise<void> {
    this.assertConnected();
    await this.client.setVolume(volumePercent);
  }

  // ── internals ──────────────────────────────────────────────

  private async resolveActiveDeviceId(): Promise<string | undefined> {
    const devices = await this.client.getDevices();
    const active = devices.find((d) => d.isActive);
    if (!active && devices.length === 0) {
      throw new MusicInputError(
        "E_SPOTIFY_NO_ACTIVE_DEVICE",
        "没有找到可用的 Spotify 设备；请先在手机 / 电脑 / 网页上打开 Spotify 播放器（需要 Spotify Premium）",
      );
    }
    return active?.id ?? devices[0]?.id ?? undefined;
  }

  private assertConnected(): void {
    if (this.backendState !== "connected") {
      throw new MusicInputError("E_SPOTIFY_NOT_CONNECTED", "尚未连接 Spotify 账号");
    }
  }

  private async persistToken(token: SpotifyTokenResponse): Promise<void> {
    const bundle: SpotifyTokenBundlePayload = {
      accessToken: token.access_token,
      // 刷新响应有时不带新 refresh_token —— 沿用旧值
      refreshToken: token.refresh_token ?? this.tokenBundle?.refreshToken ?? "",
      expiresIn: token.expires_in,
      gotAt: Date.now(),
      scope: token.scope,
    };
    this.tokenBundle = bundle;
    await this.tokenVault.persist(bundle);
  }

  private async ensureFreshAccessToken(): Promise<string> {
    if (!this.tokenBundle) {
      const blob = await this.tokenVault.load();
      if (!blob) throw new MusicInputError("E_SPOTIFY_NOT_CONNECTED", "尚未连接 Spotify 账号");
      this.tokenBundle = await this.tokenVault.decrypt(blob);
    }
    if (this.tokenVault.isFresh(this.tokenBundle)) return this.tokenBundle.accessToken;
    const clientId = this.cachedClientId ?? (await this.configStore.load())?.clientId;
    if (!clientId) throw new MusicInputError("E_SPOTIFY_CLIENT_ID_MISSING", "尚未填写 Spotify Client ID");
    const refreshed = await refreshAccessToken({ clientId, refreshToken: this.tokenBundle.refreshToken });
    await this.persistToken(refreshed);
    return this.tokenBundle.accessToken;
  }

  private setState(state: SpotifyBackendState): void {
    this.backendState = state;
    this.notify();
  }

  private notify(): void {
    const snapshot = this.getStatus();
    for (const listener of this.listeners) listener(snapshot);
  }
}
