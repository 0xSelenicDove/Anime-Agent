import { describe, it, expect, vi } from "vitest";
import { SpotifyApiClient, SpotifyApiError } from "./spotify-client";

function makeFetch(handler: (url: string, init?: RequestInit) => Response) {
  return vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
}

describe("SpotifyApiClient", () => {
  it("attaches a Bearer token from the injected getAccessToken getter", async () => {
    const calls: RequestInit[] = [];
    const fetchFn = makeFetch((url, init) => {
      calls.push(init!);
      return new Response(JSON.stringify({ id: "u1", display_name: "Alice", product: "premium" }), { status: 200 });
    });
    const client = new SpotifyApiClient(async () => "token-123", fetchFn as never);
    const me = await client.getMe();
    expect(me).toEqual({ id: "u1", displayName: "Alice", product: "premium" });
    expect((calls[0].headers as Record<string, string>).Authorization).toBe("Bearer token-123");
  });

  it("search() normalizes track results including artists and cover art", async () => {
    const fetchFn = makeFetch((url) => {
      expect(url).toContain("/search?");
      expect(url).toContain("type=track");
      return new Response(JSON.stringify({
        tracks: {
          items: [{
            uri: "spotify:track:abc", id: "abc", name: "Song A",
            artists: [{ name: "Artist 1" }, { name: "Artist 2" }],
            album: { name: "Album A", images: [{ url: "https://img/1.jpg" }] },
            duration_ms: 210000,
          }],
        },
      }), { status: 200 });
    });
    const client = new SpotifyApiClient(async () => "t", fetchFn as never);
    const tracks = await client.search("song a", 5);
    expect(tracks).toEqual([{
      uri: "spotify:track:abc", id: "abc", name: "Song A",
      artists: ["Artist 1", "Artist 2"], album: "Album A", durationMs: 210000, coverUrl: "https://img/1.jpg",
    }]);
  });

  it("getPlaybackState() normalizes a 204 (nothing playing) to null", async () => {
    const fetchFn = makeFetch(() => new Response(null, { status: 204 }));
    const client = new SpotifyApiClient(async () => "t", fetchFn as never);
    expect(await client.getPlaybackState()).toBeNull();
  });

  it("getPlaybackState() normalizes an active session", async () => {
    const fetchFn = makeFetch(() => new Response(JSON.stringify({
      is_playing: true,
      progress_ms: 5000,
      device: { id: "d1", name: "My Phone", type: "Smartphone", is_active: true, volume_percent: 80 },
      item: { uri: "spotify:track:xyz", id: "xyz", name: "Song B", artists: [{ name: "Artist" }] },
    }), { status: 200 }));
    const client = new SpotifyApiClient(async () => "t", fetchFn as never);
    const state = await client.getPlaybackState();
    expect(state?.isPlaying).toBe(true);
    expect(state?.device).toEqual({ id: "d1", name: "My Phone", type: "Smartphone", isActive: true, volumePercent: 80 });
    expect(state?.track?.name).toBe("Song B");
  });

  it("play() sends the device_id as a query param and uris in the body", async () => {
    const calls: Array<{ url: string; body?: string; method?: string }> = [];
    const fetchFn = makeFetch((url, init) => {
      calls.push({ url, body: init?.body as string, method: init?.method });
      return new Response(null, { status: 204 });
    });
    const client = new SpotifyApiClient(async () => "t", fetchFn as never);
    await client.play({ deviceId: "dev-1", uris: ["spotify:track:abc"] });
    expect(calls[0].url).toContain("/me/player/play?device_id=dev-1");
    expect(calls[0].method).toBe("PUT");
    expect(JSON.parse(calls[0].body!)).toEqual({ uris: ["spotify:track:abc"] });
  });

  it("next()/previous() issue POST with no body", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchFn = makeFetch((url, init) => {
      calls.push({ url, method: init?.method });
      return new Response(null, { status: 204 });
    });
    const client = new SpotifyApiClient(async () => "t", fetchFn as never);
    await client.next();
    await client.previous();
    expect(calls[0]).toMatchObject({ method: "POST" });
    expect(calls[0].url).toContain("/me/player/next");
    expect(calls[1].url).toContain("/me/player/previous");
  });

  it("setVolume() clamps to [0, 100] and rounds", async () => {
    const calls: string[] = [];
    const fetchFn = makeFetch((url) => { calls.push(url); return new Response(null, { status: 204 }); });
    const client = new SpotifyApiClient(async () => "t", fetchFn as never);
    await client.setVolume(150.7);
    await client.setVolume(-5);
    expect(calls[0]).toContain("volume_percent=100");
    expect(calls[1]).toContain("volume_percent=0");
  });

  it("surfaces a Premium-required hint on 403 PREMIUM_REQUIRED errors", async () => {
    const fetchFn = makeFetch(() => new Response(JSON.stringify({ error: { message: "Player command failed", reason: "PREMIUM_REQUIRED" } }), { status: 403 }));
    const client = new SpotifyApiClient(async () => "t", fetchFn as never);
    await expect(client.pause()).rejects.toThrow(/Premium/);
  });

  it("wraps non-2xx responses in SpotifyApiError with the HTTP status", async () => {
    const fetchFn = makeFetch(() => new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 }));
    const client = new SpotifyApiClient(async () => "t", fetchFn as never);
    await expect(client.getDevices()).rejects.toMatchObject({ status: 404 });
    await expect(client.getDevices()).rejects.toBeInstanceOf(SpotifyApiError);
  });
});
