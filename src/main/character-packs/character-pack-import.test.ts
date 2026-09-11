import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importCharacterPackZip } from "./character-pack-import";
import { REQUIRED_CHARACTER_PROMPT_FILES } from "../../shared/character-pack";

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/** 1x1 透明 PNG，够用来通过"是有效图片文件"的存在性校验。 */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function buildFixture(overrides: (dir: string) => void = () => {}): string {
  const dir = temporaryDirectory("cyrene-pack-fixture-");
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "my-pack",
      displayName: "小明",
      avatarFile: "avatar.png",
      hasCustomModel: false,
    }),
  );
  fs.writeFileSync(path.join(dir, "avatar.png"), TINY_PNG);
  const promptsDir = path.join(dir, "prompts");
  fs.mkdirSync(promptsDir, { recursive: true });
  for (const name of REQUIRED_CHARACTER_PROMPT_FILES) {
    fs.writeFileSync(path.join(promptsDir, name), `# ${name} content`);
  }
  overrides(dir);
  return dir;
}

/** 用"从固定目录拷贝"模拟 extract-zip 的解压效果，测试里不需要真实 zip 文件内容。 */
function fakeExtractFrom(fixtureDir: string) {
  return async (_archivePath: string, opts: { dir: string }) => {
    fs.cpSync(fixtureDir, opts.dir, { recursive: true });
  };
}

function makeZipPlaceholder(): string {
  const dir = temporaryDirectory("cyrene-pack-zip-");
  const zipPath = path.join(dir, "pack.zip");
  fs.writeFileSync(zipPath, "not a real zip, extract() is mocked in tests");
  return zipPath;
}

describe("importCharacterPackZip", () => {
  it("导入合法角色包：写入 userCharacterPacksDir/<id>/ 并返回 pack 摘要", async () => {
    const fixture = buildFixture();
    const zipPath = makeZipPlaceholder();
    const userCharacterPacksDir = temporaryDirectory("cyrene-user-packs-");

    const result = await importCharacterPackZip({
      zipPath,
      userCharacterPacksDir,
      extract: fakeExtractFrom(fixture),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pack.manifest.id).toBe("my-pack");
    expect(result.pack.manifest.displayName).toBe("小明");
    expect(result.pack.source).toBe("user");
    expect(fs.existsSync(path.join(userCharacterPacksDir, "my-pack", "manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(userCharacterPacksDir, "my-pack", "prompts", "soul.md"))).toBe(true);
  });

  it("zip 文件不存在 → zip_not_found", async () => {
    const userCharacterPacksDir = temporaryDirectory("cyrene-user-packs-");
    const result = await importCharacterPackZip({
      zipPath: "/no/such/file.zip",
      userCharacterPacksDir,
    });
    expect(result).toEqual({ ok: false, reason: "zip_not_found" });
  });

  it("缺少 manifest.json → missing_manifest", async () => {
    const fixture = buildFixture();
    fs.rmSync(path.join(fixture, "manifest.json"));
    const userCharacterPacksDir = temporaryDirectory("cyrene-user-packs-");

    const result = await importCharacterPackZip({
      zipPath: makeZipPlaceholder(),
      userCharacterPacksDir,
      extract: fakeExtractFrom(fixture),
    });
    expect(result).toEqual({ ok: false, reason: "missing_manifest" });
  });

  it("manifest id 格式非法 → invalid_manifest", async () => {
    const fixture = buildFixture((dir) => {
      fs.writeFileSync(
        path.join(dir, "manifest.json"),
        JSON.stringify({ schemaVersion: 1, id: "Not Valid!", displayName: "x", avatarFile: "avatar.png", hasCustomModel: false }),
      );
    });
    const userCharacterPacksDir = temporaryDirectory("cyrene-user-packs-");

    const result = await importCharacterPackZip({
      zipPath: makeZipPlaceholder(),
      userCharacterPacksDir,
      extract: fakeExtractFrom(fixture),
    });
    expect(result).toEqual({ ok: false, reason: "invalid_manifest" });
  });

  it("manifest id 与内置包冲突（cyrene/generic）→ invalid_manifest", async () => {
    const fixture = buildFixture((dir) => {
      fs.writeFileSync(
        path.join(dir, "manifest.json"),
        JSON.stringify({ schemaVersion: 1, id: "cyrene", displayName: "x", avatarFile: "avatar.png", hasCustomModel: false }),
      );
    });
    const userCharacterPacksDir = temporaryDirectory("cyrene-user-packs-");

    const result = await importCharacterPackZip({
      zipPath: makeZipPlaceholder(),
      userCharacterPacksDir,
      extract: fakeExtractFrom(fixture),
    });
    expect(result).toEqual({ ok: false, reason: "invalid_manifest" });
  });

  it("缺少必填 prompt 文件 → missing_prompt_files", async () => {
    const fixture = buildFixture((dir) => {
      fs.rmSync(path.join(dir, "prompts", "soul.md"));
    });
    const userCharacterPacksDir = temporaryDirectory("cyrene-user-packs-");

    const result = await importCharacterPackZip({
      zipPath: makeZipPlaceholder(),
      userCharacterPacksDir,
      extract: fakeExtractFrom(fixture),
    });
    expect(result).toEqual({ ok: false, reason: "missing_prompt_files", detail: "soul.md" });
  });

  it("prompts/ 下出现保留名 worldbook → reserved_prompt_name", async () => {
    const fixture = buildFixture((dir) => {
      fs.mkdirSync(path.join(dir, "prompts", "worldbook"), { recursive: true });
      fs.writeFileSync(path.join(dir, "prompts", "worldbook", "story.md"), "x");
    });
    const userCharacterPacksDir = temporaryDirectory("cyrene-user-packs-");

    const result = await importCharacterPackZip({
      zipPath: makeZipPlaceholder(),
      userCharacterPacksDir,
      extract: fakeExtractFrom(fixture),
    });
    expect(result).toEqual({ ok: false, reason: "reserved_prompt_name", detail: "worldbook" });
  });

  it("头像文件缺失 → missing_avatar", async () => {
    const fixture = buildFixture((dir) => {
      fs.rmSync(path.join(dir, "avatar.png"));
    });
    const userCharacterPacksDir = temporaryDirectory("cyrene-user-packs-");

    const result = await importCharacterPackZip({
      zipPath: makeZipPlaceholder(),
      userCharacterPacksDir,
      extract: fakeExtractFrom(fixture),
    });
    expect(result).toEqual({ ok: false, reason: "missing_avatar" });
  });

  it("声明自定义模型但模型入口文件缺失 → missing_model", async () => {
    const fixture = buildFixture((dir) => {
      fs.writeFileSync(
        path.join(dir, "manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          id: "my-pack",
          displayName: "小明",
          avatarFile: "avatar.png",
          hasCustomModel: true,
          modelEntryFile: "model/Model.model3.json",
        }),
      );
    });
    const userCharacterPacksDir = temporaryDirectory("cyrene-user-packs-");

    const result = await importCharacterPackZip({
      zipPath: makeZipPlaceholder(),
      userCharacterPacksDir,
      extract: fakeExtractFrom(fixture),
    });
    expect(result).toEqual({ ok: false, reason: "missing_model" });
  });

  it("目标 id 已存在且未指定 overwrite → already_exists；overwrite:true 时替换旧内容", async () => {
    const fixture = buildFixture();
    const userCharacterPacksDir = temporaryDirectory("cyrene-user-packs-");
    fs.mkdirSync(path.join(userCharacterPacksDir, "my-pack"), { recursive: true });
    fs.writeFileSync(path.join(userCharacterPacksDir, "my-pack", "old-marker.txt"), "old");

    const first = await importCharacterPackZip({
      zipPath: makeZipPlaceholder(),
      userCharacterPacksDir,
      extract: fakeExtractFrom(fixture),
    });
    expect(first).toEqual({ ok: false, reason: "already_exists" });
    expect(fs.existsSync(path.join(userCharacterPacksDir, "my-pack", "old-marker.txt"))).toBe(true);

    const second = await importCharacterPackZip({
      zipPath: makeZipPlaceholder(),
      userCharacterPacksDir,
      overwrite: true,
      extract: fakeExtractFrom(fixture),
    });
    expect(second.ok).toBe(true);
    expect(fs.existsSync(path.join(userCharacterPacksDir, "my-pack", "old-marker.txt"))).toBe(false);
    expect(fs.existsSync(path.join(userCharacterPacksDir, "my-pack", "manifest.json"))).toBe(true);
  });

  it("解压失败时返回 extract_failed 且不残留临时目录", async () => {
    const userCharacterPacksDir = temporaryDirectory("cyrene-user-packs-");
    const result = await importCharacterPackZip({
      zipPath: makeZipPlaceholder(),
      userCharacterPacksDir,
      extract: async () => { throw new Error("corrupt zip"); },
    });
    expect(result).toEqual({ ok: false, reason: "extract_failed", detail: "corrupt zip" });
  });
});
