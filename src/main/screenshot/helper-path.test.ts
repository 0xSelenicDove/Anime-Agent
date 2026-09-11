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

  it("uses the development Rust release binary on macOS", () => {
    expect(resolveScreenshotHelperPath({
      isPackaged: false,
      appPath: "/repo",
      resourcesPath: "/repo/resources",
      envOverride: undefined,
      platform: "darwin",
    })).toBe("/repo/native/cyrene-screenshot/target/release/cyrene-screenshot");
  });

  it("uses the packaged resources binary on macOS", () => {
    expect(resolveScreenshotHelperPath({
      isPackaged: true,
      appPath: "/Applications/Cyrene.app/Contents/Resources/app.asar",
      resourcesPath: "/Applications/Cyrene.app/Contents/Resources",
      envOverride: undefined,
      platform: "darwin",
    })).toBe("/Applications/Cyrene.app/Contents/Resources/bin/cyrene-screenshot");
  });

  it("returns null on platforms with no native helper build (e.g. Linux)", () => {
    expect(resolveScreenshotHelperPath({
      isPackaged: true,
      appPath: "/opt/cyrene/resources/app.asar",
      resourcesPath: "/opt/cyrene/resources",
      envOverride: undefined,
      platform: "linux",
    })).toBeNull();
  });

  it("still honors an explicit override on unsupported platforms", () => {
    expect(resolveScreenshotHelperPath({
      isPackaged: false,
      appPath: "/repo",
      resourcesPath: "/repo/resources",
      envOverride: "/usr/local/bin/cyrene-screenshot",
      platform: "linux",
    })).toBe("/usr/local/bin/cyrene-screenshot");
  });
});
