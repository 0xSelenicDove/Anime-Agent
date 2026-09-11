// Spotify app config (Client ID only), stored as a plain JSON file under
// userData/music/spotify — a Client ID isn't a secret for the PKCE flow this
// integration uses (no client_secret involved), so unlike token-vault.ts this
// file doesn't need safeStorage encryption. Mirrors ../openapi-config.ts.
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface SpotifyConfig {
  clientId: string;
}

const FILENAME = "spotify-config.json";

export class SpotifyConfigStore {
  constructor(private readonly configDir: string) {}

  private get configPath(): string {
    return path.join(this.configDir, FILENAME);
  }

  async load(): Promise<SpotifyConfig | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.configPath, "utf8");
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(`E_SPOTIFY_CONFIG_UNREADABLE: ${(e as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e: unknown) {
      throw new Error(`E_SPOTIFY_CONFIG_UNREADABLE: ${(e as Error).message}`);
    }
    const cfg = parsed as Partial<SpotifyConfig>;
    if (typeof cfg.clientId !== "string" || !cfg.clientId) return null;
    return { clientId: cfg.clientId };
  }

  async save(config: SpotifyConfig): Promise<void> {
    if (!config.clientId || typeof config.clientId !== "string") {
      throw new Error("E_SPOTIFY_CONFIG_INVALID: clientId required");
    }
    await fs.mkdir(this.configDir, { recursive: true });
    const tmp = this.configPath + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(config, null, 2), "utf8");
    await fs.rename(tmp, this.configPath);
  }

  async delete(): Promise<void> {
    await fs.rm(this.configPath, { force: true });
  }
}
