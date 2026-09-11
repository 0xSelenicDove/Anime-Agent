import * as path from "node:path";
import type { ScreenshotInsertPayload } from "../../shared/ipc-channels";
import type { ScreenshotHelperClient } from "./helper-client";

/**
 * The capture helper always reports paths matching the platform it was built
 * for (Win32 backslash paths or macOS POSIX paths — see helper-path.ts), which
 * is always the same platform this code is running on (a given Electron build
 * only ever spawns its own platform's helper). `platform` is threaded through
 * explicitly (defaulting to `process.platform`) rather than switching on
 * `path.sep` so tests can exercise both branches deterministically regardless
 * of the host CI platform — `url.pathToFileURL` can't be used here since it
 * applies the *actual* host platform's semantics, which would mangle a
 * "C:\\..." path when a test simulates Windows on a non-Windows CI host.
 */
function win32PathToFileUrl(win32Path: string): string {
  const resolved = path.win32.resolve(win32Path);
  const [drive, ...segments] = resolved.split(path.win32.sep).filter(Boolean);
  return `file:///${drive}/${segments.map(encodeURIComponent).join("/")}`;
}

function posixPathToFileUrl(posixPath: string): string {
  const resolved = path.posix.resolve(posixPath);
  const segments = resolved.split(path.posix.sep).filter(Boolean);
  return `file:///${segments.map(encodeURIComponent).join("/")}`;
}

function pathToFileUrl(resolvedPath: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? win32PathToFileUrl(resolvedPath) : posixPathToFileUrl(resolvedPath);
}

export type ScreenshotInsertData = ScreenshotInsertPayload;
export type ScreenshotInsertCandidate =
  Omit<ScreenshotInsertPayload, "previewUrl">
  & { previewUrl?: string };

export interface ScreenshotService {
  init(initialHotkey: string): void;
  prewarm(): Promise<void>;
  startFromHotkey(): Promise<{ ok: boolean; reason?: string }>;
  startFromChatButton(sendInsert?: (data: ScreenshotInsertData) => void): Promise<{ ok: boolean; reason?: string }>;
  replaceHotkey(next: string): { ok: boolean; activeHotkey: string | null };
  suspendHotkey(): void;
  resumeHotkey(): void;
  shutdown(): Promise<void>;
}

export interface ScreenshotServiceDeps {
  client: ScreenshotHelperClient;
  sendInsert(data: ScreenshotInsertData): void;
  registerShortcut(accelerator: string, callback: () => void): boolean;
  unregisterShortcut(accelerator: string): void;
}

export interface ScreenshotImageProbe {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
}

export function validateScreenshotInsert(
  data: ScreenshotInsertCandidate,
  screenshotDirectory: string,
  loadImage: (filePath: string) => ScreenshotImageProbe,
  platform: NodeJS.Platform = process.platform,
): ScreenshotInsertData | null {
  // The native capture helper's filePath always matches the platform it was
  // built for (win32 or macOS — see helper-path.ts), which is always the
  // platform this code is running on in production; `platform` is threaded
  // through explicitly so tests can exercise both branches deterministically.
  const p = platform === "win32" ? path.win32 : path.posix;
  const root = p.resolve(screenshotDirectory);
  const filePath = p.resolve(data.filePath);
  const relative = p.relative(root, filePath);
  if (
    relative.length === 0
    || relative === ".."
    || relative.startsWith(`..${p.sep}`)
    || p.isAbsolute(relative)
    || p.extname(filePath).toLowerCase() !== ".png"
  ) {
    return null;
  }

  const image = loadImage(filePath);
  if (image.isEmpty()) return null;
  const size = image.getSize();
  if (
    size.width <= 0
    || size.height <= 0
    || size.width !== data.width
    || size.height !== data.height
  ) {
    return null;
  }
  return {
    ...data,
    filePath,
    previewUrl: pathToFileUrl(filePath, platform),
  };
}

function reasonFrom(error: unknown): string {
  return error instanceof Error ? error.message : "SCREENSHOT_FAILED";
}

/**
 * Stand-in for platforms without a native capture helper build (currently
 * everything but Windows — see helper-path.ts). Every action resolves with a
 * clear, stable reason instead of attempting to spawn a binary that doesn't exist.
 */
export function createUnsupportedPlatformScreenshotService(): ScreenshotService {
  const reason = "SCREENSHOT_UNSUPPORTED_PLATFORM";
  return {
    init() {},
    async prewarm() {},
    async startFromHotkey() {
      return { ok: false, reason };
    },
    async startFromChatButton() {
      return { ok: false, reason };
    },
    replaceHotkey() {
      return { ok: false, activeHotkey: null };
    },
    suspendHotkey() {},
    resumeHotkey() {},
    async shutdown() {},
  };
}

export function createScreenshotService(deps: ScreenshotServiceDeps): ScreenshotService {
  let activeHotkey: string | null = null;
  let suspendedHotkey: string | null = null;

  const startFromHotkey = async (): Promise<{ ok: boolean; reason?: string }> => {
    try {
      await deps.client.start("clipboard-only", "hotkey");
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: reasonFrom(error) };
    }
  };

  const startFromChatButton = async (
    sendInsert: (data: ScreenshotInsertData) => void = deps.sendInsert,
  ): Promise<{ ok: boolean; reason?: string }> => {
    try {
      const result = await deps.client.start("clipboard-and-file", "chat-button");
      if (!result.filePath) {
        return { ok: false, reason: "SCREENSHOT_FILE_PATH_REQUIRED" };
      }
      sendInsert({
        filePath: result.filePath,
        width: result.width,
        height: result.height,
        mime: result.mime,
        previewUrl: pathToFileUrl(result.filePath, process.platform),
        hasAnnotations: result.hasAnnotations,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: reasonFrom(error) };
    }
  };

  const register = (accelerator: string): boolean => {
    try {
      return deps.registerShortcut(accelerator, () => {
        void startFromHotkey();
      });
    } catch {
      return false;
    }
  };

  const replaceHotkey = (
    next: string,
  ): { ok: boolean; activeHotkey: string | null } => {
    const previous = activeHotkey;
    if (previous === next) {
      return { ok: true, activeHotkey: previous };
    }
    if (previous) {
      deps.unregisterShortcut(previous);
      activeHotkey = null;
    }
    if (register(next)) {
      activeHotkey = next;
      return { ok: true, activeHotkey };
    }
    if (previous && register(previous)) {
      activeHotkey = previous;
    }
    return { ok: false, activeHotkey };
  };

  return {
    init(initialHotkey) {
      replaceHotkey(initialHotkey);
    },
    async prewarm() {
      try {
        await deps.client.ensureStarted();
      } catch (error) {
        // Helper availability is optional at app startup. A later screenshot
        // request will retry through ScreenshotHelperClient.start().
        console.warn("[Screenshot] native helper prewarm failed:", error);
      }
    },
    startFromHotkey,
    startFromChatButton,
    replaceHotkey,
    suspendHotkey() {
      if (!activeHotkey || suspendedHotkey) return;
      suspendedHotkey = activeHotkey;
      deps.unregisterShortcut(activeHotkey);
      activeHotkey = null;
    },
    resumeHotkey() {
      if (!suspendedHotkey) return;
      if (register(suspendedHotkey)) {
        activeHotkey = suspendedHotkey;
        suspendedHotkey = null;
      }
    },
    async shutdown() {
      if (activeHotkey) {
        deps.unregisterShortcut(activeHotkey);
      }
      activeHotkey = null;
      suspendedHotkey = null;
      await deps.client.shutdown();
    },
  };
}
