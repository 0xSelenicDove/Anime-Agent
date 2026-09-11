import * as path from "node:path";

export interface ScreenshotHelperPathEnvironment {
  isPackaged: boolean;
  appPath: string;
  resourcesPath: string;
  envOverride: string | undefined;
  /** Defaults to process.platform; overridable for tests. */
  platform?: NodeJS.Platform;
}

/**
 * The native capture helper (native/cyrene-screenshot) only implements the Win32
 * GDI/DXGI capture backends — there is no macOS/Linux port. Returns null on any
 * other platform so callers can degrade the screenshot feature instead of
 * spawning a binary that was never built.
 */
export function resolveScreenshotHelperPath(environment: ScreenshotHelperPathEnvironment): string | null {
  if (environment.envOverride?.trim()) return environment.envOverride;
  const platform = environment.platform ?? process.platform;
  if (platform !== "win32") return null;
  // Always a Windows path (the helper only ships a Win32 build), regardless of the
  // host platform building this string — path.win32 keeps that true even when this
  // runs on a non-Windows dev/CI machine.
  if (environment.isPackaged) {
    return path.win32.join(environment.resourcesPath, "bin", "cyrene-screenshot.exe");
  }
  return path.win32.join(environment.appPath, "native", "cyrene-screenshot", "target", "release", "cyrene-screenshot.exe");
}
