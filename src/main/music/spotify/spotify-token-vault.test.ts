import { describe, it, expect, beforeEach } from "vitest";
import { SpotifyTokenVault, type SpotifyTokenBundlePayload } from "./spotify-token-vault";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { vi } from "vitest";

const safeStorageMock = {
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`)),
  decryptString: vi.fn((b: Buffer) => b.toString("utf8").replace(/^enc:/, "")),
};

const BUNDLE: SpotifyTokenBundlePayload = {
  accessToken: "at-1",
  refreshToken: "rt-1",
  expiresIn: 3_600,
  gotAt: 1_700_000_000_000,
  scope: "user-read-playback-state user-modify-playback-state",
};

let dir = "";
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "spotify-token-vault-"));
});

describe("SpotifyTokenVault", () => {
  it("persists and reads back a bundle atomically", async () => {
    const v = new SpotifyTokenVault(dir, safeStorageMock as never);
    expect(await v.persist(BUNDLE)).toBe(true);
    const blob = await v.load();
    expect(blob?.formatVersion).toBe(1);
    expect(blob?.provider).toBe("spotify");
    const restored = await v.decrypt(blob!);
    expect(restored).toEqual(BUNDLE);
  });

  it("returns null when no token file exists", async () => {
    const v = new SpotifyTokenVault(dir, safeStorageMock as never);
    expect(await v.load()).toBeNull();
  });

  it("rejects unsupported formatVersion / provider", async () => {
    await fs.writeFile(path.join(dir, "spotify-token.enc"), JSON.stringify({ formatVersion: 99, provider: "x" }));
    const v = new SpotifyTokenVault(dir, safeStorageMock as never);
    await expect(v.load()).rejects.toThrow(/E_SPOTIFY_TOKEN_BLOB_UNREADABLE/);
  });

  it("rejects decrypted payload missing accessToken", async () => {
    const v = new SpotifyTokenVault(dir, safeStorageMock as never);
    const blob = { formatVersion: 1 as const, provider: "spotify" as const, savedAt: 1, payload: Buffer.from("enc:" + JSON.stringify({ refreshToken: "r" })) };
    await expect(v.decrypt(blob)).rejects.toThrow(/E_SPOTIFY_TOKEN_BLOB_UNREADABLE/);
  });

  it("falls back to plaintext when safeStorage is unavailable", async () => {
    const noSafe = { ...safeStorageMock, isEncryptionAvailable: () => false };
    const v = new SpotifyTokenVault(dir, noSafe as never);
    expect(await v.persist(BUNDLE)).toBe(true);
    const blob = await v.load();
    expect(blob).not.toBeNull();
    const bundle = await v.decrypt(blob!);
    expect(bundle.accessToken).toBe(BUNDLE.accessToken);
  });

  it("delete() removes the file", async () => {
    const v = new SpotifyTokenVault(dir, safeStorageMock as never);
    await v.persist(BUNDLE);
    await v.delete();
    expect(await v.load()).toBeNull();
    await v.delete(); // idempotent
  });

  it("isFresh applies a 2-minute safety margin before expiry", () => {
    const v = new SpotifyTokenVault(dir, safeStorageMock as never);
    expect(v.isFresh(BUNDLE, BUNDLE.gotAt + 1_000)).toBe(true);
    // 还剩 1 分钟就过期：在 2 分钟安全边际内，视为"该刷新了"
    expect(v.isFresh(BUNDLE, BUNDLE.gotAt + BUNDLE.expiresIn * 1000 - 60_000)).toBe(false);
    expect(v.isFresh(BUNDLE, BUNDLE.gotAt + BUNDLE.expiresIn * 1000)).toBe(false);
  });
});
