// Spotify 面板类型定义（renderer 侧镜像 main/music/spotify/*.ts 的公开形状）。

export type SpotifyBackendState = "disconnected" | "connecting" | "connected" | "error";

export interface SpotifyProfile {
  id: string;
  displayName: string;
  product: string;
}

export interface SpotifyStatusSnapshot {
  backendState: SpotifyBackendState;
  profile: SpotifyProfile | null;
  hasClientId: boolean;
  errorMessage?: string;
}

export interface SpotifyTrack {
  uri: string;
  name: string;
  artists: string[];
  album?: string;
  durationMs?: number;
  coverUrl?: string;
}

export type SpotifyIpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; errorCode: string; status: SpotifyStatusSnapshot };

export interface SpotifyApi {
  getStatus: () => Promise<{ ok: true; data: SpotifyStatusSnapshot }>;
  getConfig: () => Promise<SpotifyIpcResult<{ clientId: string } | null>>;
  saveConfig: (config: { clientId: string }) => Promise<SpotifyIpcResult<void>>;
  beginLogin: (clientId?: string) => Promise<SpotifyIpcResult<{ profile: SpotifyProfile }>>;
  cancelLogin: () => Promise<SpotifyIpcResult<void>>;
  logout: () => Promise<SpotifyIpcResult<void>>;
  search: (keyword: string, limit?: number) => Promise<SpotifyIpcResult<SpotifyTrack[]>>;
  getDevices: () => Promise<SpotifyIpcResult<unknown[]>>;
  playTrack: (uri: string, deviceId?: string) => Promise<SpotifyIpcResult<void>>;
  pause: () => Promise<SpotifyIpcResult<void>>;
  resume: () => Promise<SpotifyIpcResult<void>>;
  next: () => Promise<SpotifyIpcResult<void>>;
  previous: () => Promise<SpotifyIpcResult<void>>;
  onStateChanged: (h: (s: SpotifyStatusSnapshot) => void) => (() => void) | void;
}
