// spotify-music-tools.ts — agent-facing tools for the Spotify Connect integration.
//
// Deliberately a small, separate tool set from music-tools.ts (NetEase): the two
// catalogs use different id schemes (Spotify URIs vs NetEase encrypted ids) and
// different playback models (remote-control an existing Spotify Connect device
// vs local mpv playback), so merging them behind one tool surface would blur
// which id format the model should produce. See spotify-service.ts for why
// playback here always targets an already-running official Spotify client.
import type { SpotifyService } from "../../music/spotify/spotify-service";
import type { ToolDefinition } from "./registry/tool-registry";

const SPOTIFY_URI_RE = /^spotify:track:[0-9A-Za-z]{22}$/;

export function buildSpotifyMusicTools(service: SpotifyService): ToolDefinition[] {
  return [
    {
      id: "spotify_search",
      capability: "spotify.search",
      name: "搜索 Spotify 歌曲",
      description: "按关键词搜索 Spotify 曲库。返回歌曲的 uri（形如 spotify:track:xxxx）、名称、歌手、专辑。用户说「用 Spotify 播放某歌」时，先用此工具搜索拿到 uri，再调 spotify_play_track。需要用户已连接 Spotify 账号。",
      enabled: true,
      modes: ["work", "learn"],
      risk: "safe",
      inputSchema: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "搜索关键词 (1-100 字)" },
          limit: { type: "number", description: "返回数量 (1-20)" },
        },
        required: ["keyword"],
      },
      needsContext: false,
      effectKind: "read" as const,
      verificationPolicy: "none" as const,
      execute: async (args) => {
        const tracks = await service.search(String(args.keyword ?? ""), args.limit as number | undefined);
        return JSON.stringify({
          kind: "search",
          tracks: tracks.map((t) => ({
            uri: t.uri,
            name: t.name,
            artists: t.artists,
            album: t.album,
            durationMs: t.durationMs,
            coverUrl: t.coverUrl,
          })),
        });
      },
    },
    {
      id: "spotify_play_track",
      capability: "spotify.play_track",
      name: "用 Spotify 播放歌曲",
      description: "通过 Spotify Connect 遥控用户当前活跃的 Spotify 设备播放一首歌曲。入参 uri 从 spotify_search 返回结果中获取。要求：用户已连接 Spotify 账号、账号是 Premium、且手机/电脑/网页上已经打开了 Spotify（Spotify 官方 API 不支持无设备的纯后台播放）。",
      enabled: true,
      modes: ["work", "learn"],
      risk: "input-control",
      inputSchema: {
        type: "object",
        properties: {
          uri: { type: "string", description: "Spotify 曲目 uri，形如 spotify:track:xxxxxxxxxxxxxxxxxxxxxx" },
        },
        required: ["uri"],
      },
      controlledInput: { uri: "tool_result" },
      needsContext: false,
      effectKind: "external_side_effect" as const,
      verificationPolicy: "none" as const,
      execute: async (args) => {
        const uri = String(args.uri ?? "");
        if (!SPOTIFY_URI_RE.test(uri)) throw new Error("E_INVALID_SPOTIFY_URI");
        await service.playTrack(uri);
        return JSON.stringify({ kind: "playback", dispatched: true });
      },
    },
    {
      id: "spotify_playback_control",
      capability: "spotify.playback_control",
      name: "控制 Spotify 播放",
      description: "暂停 / 继续 / 下一首 / 上一首，作用于用户当前活跃的 Spotify 设备。",
      enabled: true,
      modes: ["work", "learn"],
      risk: "input-control",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["pause", "resume", "next", "previous"], description: "播放控制动作" },
        },
        required: ["action"],
      },
      needsContext: false,
      effectKind: "external_side_effect" as const,
      verificationPolicy: "none" as const,
      execute: async (args) => {
        const action = String(args.action ?? "");
        if (action === "pause") await service.pause();
        else if (action === "resume") await service.resume();
        else if (action === "next") await service.next();
        else if (action === "previous") await service.previous();
        else throw new Error("E_INVALID_PLAYBACK_ACTION");
        return JSON.stringify({ kind: "playback_control", action });
      },
    },
    {
      id: "spotify_get_playback_status",
      capability: "spotify.playback_status",
      name: "获取 Spotify 播放状态",
      description: "查询用户当前活跃 Spotify 设备的播放状态：正在播放还是暂停、当前曲目、播放进度、设备名称。没在播放时 track 为 null。",
      enabled: true,
      modes: ["work", "learn"],
      risk: "safe",
      inputSchema: { type: "object", properties: {}, required: [] },
      needsContext: false,
      effectKind: "read" as const,
      verificationPolicy: "none" as const,
      execute: async () => {
        const state = await service.getPlaybackState();
        return JSON.stringify({
          kind: "playback_status",
          isPlaying: state?.isPlaying ?? false,
          positionMs: state?.progressMs ?? null,
          device: state?.device ? { name: state.device.name, type: state.device.type } : null,
          track: state?.track
            ? { uri: state.track.uri, name: state.track.name, artists: state.track.artists, coverUrl: state.track.coverUrl }
            : null,
        });
      },
    },
  ];
}
