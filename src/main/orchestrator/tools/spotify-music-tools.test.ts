import { describe, expect, it, vi } from "vitest";
import { buildSpotifyMusicTools } from "./spotify-music-tools";

const URI = "spotify:track:4uLU6hMCjMI75M1A2tKUQC";

function serviceDouble() {
  return {
    search: vi.fn(),
    getDevices: vi.fn(),
    getPlaybackState: vi.fn(),
    playTrack: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    next: vi.fn(),
    previous: vi.fn(),
    setVolume: vi.fn(),
  };
}

function tool(tools: ReturnType<typeof buildSpotifyMusicTools>, id: string) {
  const t = tools.find((x) => x.id === id);
  if (!t) throw new Error(`tool not found: ${id}`);
  return t;
}

describe("Spotify Agent tools", () => {
  it("declares 4 tools with stable capabilities", () => {
    const tools = buildSpotifyMusicTools(serviceDouble() as never);
    expect(tools).toHaveLength(4);
    const capabilities = Object.fromEntries(tools.map((t) => [t.id, t.capability]));
    expect(capabilities).toEqual({
      spotify_search: "spotify.search",
      spotify_play_track: "spotify.play_track",
      spotify_playback_control: "spotify.playback_control",
      spotify_get_playback_status: "spotify.playback_status",
    });
  });

  it("spotify_search returns normalized track fields as JSON", async () => {
    const service = serviceDouble();
    service.search.mockResolvedValue([
      { uri: URI, id: "4uLU6hMCjMI75M1A2tKUQC", name: "Song", artists: ["Artist"], album: "Album", durationMs: 200000, coverUrl: "https://img" },
    ]);
    const tools = buildSpotifyMusicTools(service as never);
    const result = await tool(tools, "spotify_search").execute({ keyword: "song", limit: 5 }, undefined as never);
    expect(service.search).toHaveBeenCalledWith("song", 5);
    expect(JSON.parse(result as string)).toMatchObject({ kind: "search", tracks: [{ uri: URI, name: "Song" }] });
  });

  it("spotify_play_track validates the uri format before dispatching", async () => {
    const service = serviceDouble();
    const tools = buildSpotifyMusicTools(service as never);
    await expect(tool(tools, "spotify_play_track").execute({ uri: "not-a-spotify-uri" }, undefined as never))
      .rejects.toThrow("E_INVALID_SPOTIFY_URI");
    expect(service.playTrack).not.toHaveBeenCalled();

    const result = await tool(tools, "spotify_play_track").execute({ uri: URI }, undefined as never);
    expect(service.playTrack).toHaveBeenCalledWith(URI);
    expect(JSON.parse(result as string)).toEqual({ kind: "playback", dispatched: true });
  });

  it("spotify_play_track surfaces the service's no-active-device error untouched", async () => {
    const service = serviceDouble();
    service.playTrack.mockRejectedValue(Object.assign(new Error("没有找到可用的 Spotify 设备"), { code: "E_SPOTIFY_NO_ACTIVE_DEVICE" }));
    const tools = buildSpotifyMusicTools(service as never);
    await expect(tool(tools, "spotify_play_track").execute({ uri: URI }, undefined as never))
      .rejects.toThrow("没有找到可用的 Spotify 设备");
  });

  it("spotify_playback_control dispatches to the matching service method per action", async () => {
    const service = serviceDouble();
    const tools = buildSpotifyMusicTools(service as never);
    const control = tool(tools, "spotify_playback_control");
    for (const action of ["pause", "resume", "next", "previous"] as const) {
      await control.execute({ action }, undefined as never);
    }
    expect(service.pause).toHaveBeenCalledTimes(1);
    expect(service.resume).toHaveBeenCalledTimes(1);
    expect(service.next).toHaveBeenCalledTimes(1);
    expect(service.previous).toHaveBeenCalledTimes(1);
    await expect(control.execute({ action: "shuffle" }, undefined as never)).rejects.toThrow("E_INVALID_PLAYBACK_ACTION");
  });

  it("spotify_get_playback_status normalizes a null (nothing playing) state", async () => {
    const service = serviceDouble();
    service.getPlaybackState.mockResolvedValue(null);
    const tools = buildSpotifyMusicTools(service as never);
    const result = await tool(tools, "spotify_get_playback_status").execute({}, undefined as never);
    expect(JSON.parse(result as string)).toEqual({ kind: "playback_status", isPlaying: false, positionMs: null, device: null, track: null });
  });

  it("spotify_get_playback_status surfaces the current track and device", async () => {
    const service = serviceDouble();
    service.getPlaybackState.mockResolvedValue({
      isPlaying: true,
      progressMs: 1234,
      device: { id: "d1", name: "Phone", type: "Smartphone", isActive: true, volumePercent: 60 },
      track: { uri: URI, id: "id", name: "Song", artists: ["Artist"], coverUrl: "https://img" },
    });
    const tools = buildSpotifyMusicTools(service as never);
    const result = await tool(tools, "spotify_get_playback_status").execute({}, undefined as never);
    expect(JSON.parse(result as string)).toMatchObject({
      isPlaying: true,
      positionMs: 1234,
      device: { name: "Phone", type: "Smartphone" },
      track: { uri: URI, name: "Song" },
    });
  });
});
