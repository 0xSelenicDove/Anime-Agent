// Spotify Web API REST 客户端。
//
// 与网易云 OpenAPI 的关键区别：Spotify 官方 API 不提供可直接播放的音频流 URL——
// 第三方应用只能通过 Spotify Connect 遥控一个已经在跑官方客户端（手机 / 桌面 /
// 网页播放器）的设备来播放，这是 Spotify 服务条款允许的唯一集成方式。所以本客户端
// 只做"目录检索 + 遥控已有设备"，不做音频下载/本地播放（那部分是 mpv 播 NetEase
// 的路子，Spotify 没有等价物）。遥控播放需要 Spotify Premium 账号。
const API_BASE = "https://api.spotify.com/v1";

export type SpotifyFetch = (url: string, init?: RequestInit) => Promise<Response>;

export class SpotifyApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "SpotifyApiError";
  }
}

export interface SpotifyTrack {
  uri: string;
  id: string;
  name: string;
  artists: string[];
  album?: string;
  durationMs?: number;
  coverUrl?: string;
}

export interface SpotifyDevice {
  id: string | null;
  name: string;
  type: string;
  isActive: boolean;
  volumePercent: number | null;
}

export interface SpotifyPlaybackState {
  isPlaying: boolean;
  progressMs: number | null;
  device: SpotifyDevice | null;
  track: SpotifyTrack | null;
}

export interface SpotifyProfile {
  id: string;
  displayName: string;
  product: string;
}

export class SpotifyApiClient {
  constructor(
    private readonly getAccessToken: () => Promise<string>,
    private readonly fetchFn: SpotifyFetch = (url, init) => fetch(url, init),
  ) {}

  async getMe(): Promise<SpotifyProfile> {
    const data = await this.request<{ id: string; display_name?: string; product?: string }>("/me");
    return { id: data.id, displayName: data.display_name || data.id, product: data.product ?? "unknown" };
  }

  async search(query: string, limit = 10): Promise<SpotifyTrack[]> {
    const params = new URLSearchParams({ q: query, type: "track", limit: String(Math.min(Math.max(limit, 1), 50)) });
    const data = await this.request<{ tracks?: { items?: unknown[] } }>(`/search?${params.toString()}`);
    return (data.tracks?.items ?? []).map(normalizeTrack);
  }

  async getDevices(): Promise<SpotifyDevice[]> {
    const data = await this.request<{ devices?: unknown[] }>("/me/player/devices");
    return (data.devices ?? []).map(normalizeDevice);
  }

  /** 当前播放状态；未在任何设备上播放时 Spotify 返回 204，这里归一化成 null。 */
  async getPlaybackState(): Promise<SpotifyPlaybackState | null> {
    const data = await this.request<Record<string, unknown> | null>("/me/player");
    if (!data) return null;
    return {
      isPlaying: data.is_playing === true,
      progressMs: typeof data.progress_ms === "number" ? data.progress_ms : null,
      device: data.device ? normalizeDevice(data.device) : null,
      track: data.item ? normalizeTrack(data.item) : null,
    };
  }

  async play(options: { deviceId?: string; uris?: string[] }): Promise<void> {
    const qs = options.deviceId ? `?device_id=${encodeURIComponent(options.deviceId)}` : "";
    await this.request(`/me/player/play${qs}`, {
      method: "PUT",
      body: options.uris ? JSON.stringify({ uris: options.uris }) : undefined,
    });
  }

  async pause(deviceId?: string): Promise<void> {
    await this.request(`/me/player/pause${deviceQuery(deviceId)}`, { method: "PUT" });
  }

  async next(deviceId?: string): Promise<void> {
    await this.request(`/me/player/next${deviceQuery(deviceId)}`, { method: "POST" });
  }

  async previous(deviceId?: string): Promise<void> {
    await this.request(`/me/player/previous${deviceQuery(deviceId)}`, { method: "POST" });
  }

  async setVolume(volumePercent: number, deviceId?: string): Promise<void> {
    const clamped = Math.min(100, Math.max(0, Math.round(volumePercent)));
    const params = new URLSearchParams({ volume_percent: String(clamped) });
    if (deviceId) params.set("device_id", deviceId);
    await this.request(`/me/player/volume?${params.toString()}`, { method: "PUT" });
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await this.getAccessToken();
    const res = await this.fetchFn(`${API_BASE}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(init?.headers ?? {}),
      },
    });
    if (res.status === 204) return null as T;
    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as { error?: { message?: string; reason?: string } };
        detail = body.error?.message ? ` ${body.error.message}` : "";
        if (body.error?.reason === "PREMIUM_REQUIRED") detail += "（需要 Spotify Premium 账号）";
      } catch {
        // 非 JSON 错误体，忽略
      }
      throw new SpotifyApiError(`Spotify API ${path} 失败 (HTTP ${res.status})${detail}`, res.status);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }
}

function deviceQuery(deviceId?: string): string {
  return deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
}

function normalizeTrack(raw: unknown): SpotifyTrack {
  const t = (raw ?? {}) as Record<string, unknown>;
  const album = (t.album ?? {}) as Record<string, unknown>;
  const images = Array.isArray(album.images) ? (album.images as Array<Record<string, unknown>>) : [];
  const artists = Array.isArray(t.artists)
    ? (t.artists as Array<Record<string, unknown>>).map((a) => String(a.name ?? "")).filter(Boolean)
    : [];
  return {
    uri: String(t.uri ?? ""),
    id: String(t.id ?? ""),
    name: String(t.name ?? ""),
    artists,
    album: typeof album.name === "string" ? album.name : undefined,
    durationMs: typeof t.duration_ms === "number" ? t.duration_ms : undefined,
    coverUrl: images[0]?.url as string | undefined,
  };
}

function normalizeDevice(raw: unknown): SpotifyDevice {
  const d = (raw ?? {}) as Record<string, unknown>;
  return {
    id: typeof d.id === "string" ? d.id : null,
    name: String(d.name ?? "Unknown device"),
    type: String(d.type ?? "Unknown"),
    isActive: d.is_active === true,
    volumePercent: typeof d.volume_percent === "number" ? d.volume_percent : null,
  };
}
