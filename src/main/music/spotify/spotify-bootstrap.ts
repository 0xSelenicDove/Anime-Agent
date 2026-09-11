import type { MusicPaths } from "../paths";
import { SpotifyService } from "./spotify-service";
import { registerSpotifyIpcHandlers } from "./spotify-ipc-handlers";
import { buildSpotifyMusicTools } from "../../orchestrator/tools/spotify-music-tools";
import { toolRegistry } from "../../orchestrator/tools/registry/tool-registry";

export interface SpotifyBootstrap {
  service: SpotifyService;
  shutdown(): Promise<void>;
}

export function bootstrapSpotifyService(paths: MusicPaths): SpotifyBootstrap {
  const service = new SpotifyService(paths);
  const ipcDisposer = registerSpotifyIpcHandlers(service);
  const tools = buildSpotifyMusicTools(service);
  for (const tool of tools) toolRegistry.register(tool);
  // 惰性恢复：只把已保存的 token 读进内存（不发网络请求），首次真正调用 API 时才刷新/报错。
  void service.restore();

  let shuttingDown = false;
  return {
    service,
    shutdown: async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      await service.cancelLogin();
      ipcDisposer();
      for (const t of tools) toolRegistry.unregister(t.id);
    },
  };
}
