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
 * The native capture helper (native/cyrene-screenshot) implements Win32 GDI/DXGI
 * and macOS CGDisplay capture backends; there is no Linux port. Returns null on
 * any other platform so callers can degrade the screenshot feature instead of
 * spawning a binary that was never built.
 */
export function resolveScreenshotHelperPath(environment: ScreenshotHelperPathEnvironment): string | null {
  if (environment.envOverride?.trim()) return environment.envOverride;
  const platform = environment.platform ?? process.platform;
  if (platform === "darwin") {
    // macOS paths are POSIX, unlike the Windows branch below — path.join (not
    // path.win32.join) is intentional here.
    if (environment.isPackaged) {
      return path.join(environment.resourcesPath, "bin", "cyrene-screenshot");
    }
    return path.join(environment.appPath, "native", "cyrene-screenshot", "target", "release", "cyrene-screenshot");
  }
  if (platform !== "win32") return null;
  // Always a Windows path (the Win32 branch only ships a Win32 build),
  // regardless of the host platform building this string — path.win32 keeps
  // that true even when this runs on a non-Windows dev/CI machine.
  if (environment.isPackaged) {
    return path.win32.join(environment.resourcesPath, "bin", "cyrene-screenshot.exe");
  }
  return path.win32.join(environment.appPath, "native", "cyrene-screenshot", "target", "release", "cyrene-screenshot.exe");
}
