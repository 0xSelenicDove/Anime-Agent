import { describe, expect, it } from "vitest";
import { isNewerVersion, isValidPluginVersion } from "./version";

describe("isValidPluginVersion", () => {
  it("接受标准三段数字版本", () => {
    expect(isValidPluginVersion("0.1.0")).toBe(true);
    expect(isValidPluginVersion("1.10.3")).toBe(true);
    expect(isValidPluginVersion(" 0.2.0 ")).toBe(true);
  });

  it("拒绝前导零", () => {
    expect(isValidPluginVersion("01.1.0")).toBe(false);
    expect(isValidPluginVersion("1.01.0")).toBe(false);
    expect(isValidPluginVersion("1.1.00")).toBe(false);
  });

  it("拒绝预发布号与 build 元数据", () => {
    expect(isValidPluginVersion("1.0.0-beta.1")).toBe(false);
    expect(isValidPluginVersion("1.0.0+build.123")).toBe(false);
  });

  it("拒绝缺段、多段与非数字", () => {
    expect(isValidPluginVersion("1.0")).toBe(false);
    expect(isValidPluginVersion("1.0.0.0")).toBe(false);
    expect(isValidPluginVersion("v1.0.0")).toBe(false);
    expect(isValidPluginVersion("1.a.0")).toBe(false);
    expect(isValidPluginVersion("")).toBe(false);
  });
});

describe("isNewerVersion", () => {
  it("逐段数字比较，不受字符串比较误导", () => {
    expect(isNewerVersion("1.10.0", "1.9.0")).toBe(true);
    expect(isNewerVersion("1.9.0", "1.10.0")).toBe(false);
    expect(isNewerVersion("2.0.0", "1.99.99")).toBe(true);
    expect(isNewerVersion("1.0.1", "1.0.0")).toBe(true);
  });

  it("相同版本返回 false", () => {
    expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false);
  });

  it("任一版本非法返回 false", () => {
    expect(isNewerVersion("abc", "1.0.0")).toBe(false);
    expect(isNewerVersion("1.0.0", "1.0.0-beta")).toBe(false);
  });
});