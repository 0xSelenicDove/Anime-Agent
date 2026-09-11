import { describe, expect, it } from "vitest";
import * as path from "path";
import { parseCharacterPackUrl, resolveCharacterPackAssetPath } from "./character-pack-protocol";

describe("character-pack protocol", () => {
  it("解析合法 URL，支持多级子路径（模型贴图/动作等）", () => {
    expect(parseCharacterPackUrl("character-pack://my-pack/avatar.png"))
      .toEqual({ packId: "my-pack", file: "avatar.png" });
    expect(parseCharacterPackUrl("character-pack://my-pack/model/texture_0.png"))
      .toEqual({ packId: "my-pack", file: "model/texture_0.png" });
  });

  it("拒绝非法 packId、路径穿越、协议不符", () => {
    expect(parseCharacterPackUrl("character-pack://Not_Valid!/avatar.png")).toBeNull();
    expect(parseCharacterPackUrl("character-pack://my-pack/..%2F..%2Fapp-settings.json")).toBeNull();
    expect(parseCharacterPackUrl("character-pack://my-pack/model/..%2F..%2Fsecret")).toBeNull();
    expect(parseCharacterPackUrl("character-pack:///avatar.png")).toBeNull();
    expect(parseCharacterPackUrl("https://my-pack/avatar.png")).toBeNull();
  });

  it("resolve 结果必须位于 <root>/<packId>/ 内", () => {
    const root = path.join("C:", "userData", "character-packs");
    const resolved = resolveCharacterPackAssetPath(root, "my-pack", "model/texture_0.png");
    expect(resolved).toBe(path.resolve(root, "my-pack", "model", "texture_0.png"));

    expect(resolveCharacterPackAssetPath(root, "../escape", "avatar.png")).toBeNull();
    expect(resolveCharacterPackAssetPath(root, "my-pack", "../other-pack/avatar.png")).toBeNull();
  });
});
