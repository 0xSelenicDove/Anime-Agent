import { ipcMain, BrowserWindow } from "electron";
import { IPC } from "../../../shared/ipc-channels";
import { MusicInputError } from "../types";
import type { SpotifyService, SpotifyStatusSnapshot } from "./spotify-service";

export type SpotifyIpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; errorCode: string; status: SpotifyStatusSnapshot };

function wrap<T>(fn: () => Promise<T>, service: SpotifyService): Promise<SpotifyIpcResult<T>> {
  return fn().then(
    (data) => ({ ok: true as const, data }),
    (err: unknown) => {
      const errorCode = err instanceof MusicInputError ? err.code : "E_INTERNAL_ERROR";
      if (!(err instanceof MusicInputError)) console.error("[spotify] IPC handler failed", err);
      return { ok: false as const, errorCode, status: service.getStatus() };
    },
  );
}

export function registerSpotifyIpcHandlers(service: SpotifyService): () => void {
  const channels: string[] = [];
  const handle = <A extends unknown[]>(channel: string, fn: (...args: A) => Promise<unknown>) => {
    ipcMain.handle(channel, (_e, ...args: A) => fn(...args));
    channels.push(channel);
  };

  handle(IPC.SPOTIFY_GET_STATUS, async () => ({ ok: true as const, data: service.getStatus() }));
  handle(IPC.SPOTIFY_GET_CONFIG, () => wrap(() => service.getConfig(), service));
  handle(IPC.SPOTIFY_SAVE_CONFIG, (config: { clientId: string }) => wrap(() => service.saveConfig(config), service));
  handle(IPC.SPOTIFY_BEGIN_LOGIN, (clientId?: string) => wrap(() => service.beginLogin(clientId), service));
  handle(IPC.SPOTIFY_CANCEL_LOGIN, () => wrap(() => service.cancelLogin(), service));
  handle(IPC.SPOTIFY_LOGOUT, () => wrap(() => service.logout(), service));
  handle(IPC.SPOTIFY_SEARCH, (keyword: string, limit?: number) => wrap(() => service.search(keyword, limit), service));
  handle(IPC.SPOTIFY_GET_DEVICES, () => wrap(() => service.getDevices(), service));
  handle(IPC.SPOTIFY_GET_PLAYBACK_STATE, () => wrap(() => service.getPlaybackState(), service));
  handle(IPC.SPOTIFY_PLAY_TRACK, (uri: string, deviceId?: string) => wrap(() => service.playTrack(uri, deviceId), service));
  handle(IPC.SPOTIFY_PLAYBACK_PAUSE, () => wrap(() => service.pause(), service));
  handle(IPC.SPOTIFY_PLAYBACK_RESUME, () => wrap(() => service.resume(), service));
  handle(IPC.SPOTIFY_PLAYBACK_NEXT, () => wrap(() => service.next(), service));
  handle(IPC.SPOTIFY_PLAYBACK_PREV, () => wrap(() => service.previous(), service));
  handle(IPC.SPOTIFY_SET_VOLUME, (volumePercent: number) => wrap(() => service.setVolume(volumePercent), service));

  const unsubscribe = service.onStateChanged((state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send(IPC.SPOTIFY_STATE_CHANGED, state);
      } catch {
        // 窗口正在关闭时忽略
      }
    }
  });

  return () => {
    unsubscribe();
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}
