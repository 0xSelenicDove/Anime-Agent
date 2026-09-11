import { describe, expect, it } from "vitest";
import { resolveScreenshotHelperPath } from "./helper-path";

describe("resolveScreenshotHelperPath", () => {
  it("uses the development Rust release binary", () => {
    expect(resolveScreenshotHelperPath({
      isPackaged: false,
      appPath: "C:\\repo",
      resourcesPath: "C:\\app\\resources",
      envOverride: undefined,
      platform: "win32",
    })).toBe("C:\\repo\\native\\cyrene-screenshot\\target\\release\\cyrene-screenshot.exe");
  });

  it("uses the packaged resources binary", () => {
    expect(resolveScreenshotHelperPath({
      isPackaged: true,
      appPath: "C:\\app\\resources\\app.asar",
      resourcesPath: "C:\\app\\resources",
      envOverride: undefined,
      platform: "win32",
    })).toBe("C:\\app\\resources\\bin\\cyrene-screenshot.exe");
  });

  it("allows an explicit helper path override", () => {
    expect(resolveScreenshotHelperPath({
      isPackaged: true,
      appPath: "C:\\app\\resources\\app.asar",
      resourcesPath: "C:\\app\\resources",
      envOverride: "D:\\debug\\cyrene-screenshot.exe",
      platform: "win32",
    })).toBe("D:\\debug\\cyrene-screenshot.exe");
  });

  it("returns null on non-Windows platforms since no native helper is built for them", () => {
    expect(resolveScreenshotHelperPath({
      isPackaged: true,
      appPath: "/Applications/Cyrene.app/Contents/Resources/app.asar",
      resourcesPath: "/Applications/Cyrene.app/Contents/Resources",
      envOverride: undefined,
      platform: "darwin",
    })).toBeNull();
  });

  it("still honors an explicit override on non-Windows platforms", () => {
    expect(resolveScreenshotHelperPath({
      isPackaged: false,
      appPath: "/repo",
      resourcesPath: "/repo/resources",
      envOverride: "/usr/local/bin/cyrene-screenshot",
      platform: "darwin",
    })).toBe("/usr/local/bin/cyrene-screenshot");
  });
});
