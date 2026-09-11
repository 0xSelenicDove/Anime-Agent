import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/ipc-channels";

export function exposeSpotifyApi() {
  contextBridge.exposeInMainWorld("spotify", {
    getStatus: () => ipcRenderer.invoke(IPC.SPOTIFY_GET_STATUS),
    getConfig: () => ipcRenderer.invoke(IPC.SPOTIFY_GET_CONFIG),
    saveConfig: (config: { clientId: string }) => ipcRenderer.invoke(IPC.SPOTIFY_SAVE_CONFIG, config),
    beginLogin: (clientId?: string) => ipcRenderer.invoke(IPC.SPOTIFY_BEGIN_LOGIN, clientId),
    cancelLogin: () => ipcRenderer.invoke(IPC.SPOTIFY_CANCEL_LOGIN),
    logout: () => ipcRenderer.invoke(IPC.SPOTIFY_LOGOUT),
    search: (keyword: string, limit?: number) => ipcRenderer.invoke(IPC.SPOTIFY_SEARCH, keyword, limit),
    getDevices: () => ipcRenderer.invoke(IPC.SPOTIFY_GET_DEVICES),
    getPlaybackState: () => ipcRenderer.invoke(IPC.SPOTIFY_GET_PLAYBACK_STATE),
    playTrack: (uri: string, deviceId?: string) => ipcRenderer.invoke(IPC.SPOTIFY_PLAY_TRACK, uri, deviceId),
    pause: () => ipcRenderer.invoke(IPC.SPOTIFY_PLAYBACK_PAUSE),
    resume: () => ipcRenderer.invoke(IPC.SPOTIFY_PLAYBACK_RESUME),
    next: () => ipcRenderer.invoke(IPC.SPOTIFY_PLAYBACK_NEXT),
    previous: () => ipcRenderer.invoke(IPC.SPOTIFY_PLAYBACK_PREV),
    setVolume: (volumePercent: number) => ipcRenderer.invoke(IPC.SPOTIFY_SET_VOLUME, volumePercent),
    onStateChanged: (h: (s: unknown) => void) => {
      const listener = (_: unknown, s: unknown) => h(s);
      ipcRenderer.on(IPC.SPOTIFY_STATE_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC.SPOTIFY_STATE_CHANGED, listener);
    },
  });
}
