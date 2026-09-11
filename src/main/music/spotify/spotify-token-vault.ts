// Spotify OAuth token vault — same encrypted-at-rest pattern as ./token-vault.ts
// (NetEase OpenAPI), adapted for Spotify's authorization-code + PKCE token shape.
import { safeStorage } from "electron";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface SpotifyTokenBundlePayload {
  accessToken: string;
  refreshToken: string;
  /** Validity in seconds since `gotAt` (Spotify: typically 3600). */
  expiresIn: number;
  /** Epoch ms when the bundle was obtained (or last refreshed). */
  gotAt: number;
  scope: string;
}

export interface EncryptedSpotifyTokenBlob {
  formatVersion: 1;
  provider: "spotify";
  savedAt: number;
  payload: Buffer;
}

const FORMAT_VERSION = 1 as const;
const PROVIDER = "spotify" as const;
const FILENAME = "spotify-token.enc";

export class SpotifyTokenVault {
  constructor(
    private readonly userDataMusicDir: string,
    private readonly storage: Pick<typeof safeStorage, "isEncryptionAvailable" | "encryptString" | "decryptString"> = safeStorage,
  ) {}

  private get tokenPath(): string {
    return path.join(this.userDataMusicDir, FILENAME);
  }

  async persist(payload: SpotifyTokenBundlePayload): Promise<boolean> {
    const encrypted = this.storage.isEncryptionAvailable();
    if (!encrypted) {
      console.warn("[spotify] safeStorage 不可用，token 将以明文保存（不安全，仅 dev 用）");
    }
    const payloadJson = JSON.stringify(payload);
    const blob: EncryptedSpotifyTokenBlob = {
      formatVersion: FORMAT_VERSION,
      provider: PROVIDER,
      savedAt: Date.now(),
      payload: encrypted
        ? this.storage.encryptString(payloadJson)
        : Buffer.from(payloadJson, "utf8"),
    };
    try {
      await fs.mkdir(this.userDataMusicDir, { recursive: true });
      const tmp = this.tokenPath + ".tmp";
      await fs.writeFile(tmp, this._serialize(blob));
      await fs.rename(tmp, this.tokenPath);
      return true;
    } catch (err) {
      console.error("[spotify] token 保存失败：", err instanceof Error ? err.message : err);
      return false;
    }
  }

  async load(): Promise<EncryptedSpotifyTokenBlob | null> {
    let raw: Buffer;
    try {
      raw = await fs.readFile(this.tokenPath);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(`E_SPOTIFY_TOKEN_BLOB_UNREADABLE: ${(e as Error).message}`);
    }
    let parsed: EncryptedSpotifyTokenBlob;
    try {
      parsed = this._deserialize(raw);
    } catch (e: unknown) {
      throw new Error(`E_SPOTIFY_TOKEN_BLOB_UNREADABLE: ${(e as Error).message}`);
    }
    if (parsed.formatVersion !== FORMAT_VERSION || parsed.provider !== PROVIDER) {
      throw new Error("E_SPOTIFY_TOKEN_BLOB_UNREADABLE: unexpected format/provider");
    }
    return parsed;
  }

  async delete(): Promise<void> {
    await fs.rm(this.tokenPath, { force: true });
  }

  async decrypt(blob: EncryptedSpotifyTokenBlob): Promise<SpotifyTokenBundlePayload> {
    let json: string;
    // 兼容明文保存的 blob（safeStorage 不可用时的 fallback）
    if (blob.payload.length > 0 && blob.payload[0] === 0x7b /* '{' */) {
      json = blob.payload.toString("utf8");
    } else {
      json = this.storage.decryptString(blob.payload);
    }
    const data = JSON.parse(json) as SpotifyTokenBundlePayload;
    if (!data.accessToken) throw new Error("E_SPOTIFY_TOKEN_BLOB_UNREADABLE: missing accessToken");
    return data;
  }

  /** 距过期是否还有安全余量（提前 2 分钟视为"该刷新了"，避免请求中途过期）。 */
  isFresh(bundle: SpotifyTokenBundlePayload, now = Date.now()): boolean {
    const marginMs = 2 * 60_000;
    return now < bundle.gotAt + bundle.expiresIn * 1000 - marginMs;
  }

  private _serialize(blob: EncryptedSpotifyTokenBlob): Buffer {
    return Buffer.from(JSON.stringify({
      formatVersion: blob.formatVersion,
      provider: blob.provider,
      savedAt: blob.savedAt,
      payloadB64: blob.payload.toString("base64"),
    }));
  }

  private _deserialize(raw: Buffer): EncryptedSpotifyTokenBlob {
    const obj = JSON.parse(raw.toString("utf8")) as {
      formatVersion: number;
      provider: string;
      savedAt: number;
      payloadB64: string;
    };
    return {
      formatVersion: obj.formatVersion as 1,
      provider: obj.provider as "spotify",
      savedAt: obj.savedAt,
      payload: Buffer.from(obj.payloadB64, "base64"),
    };
  }
}
