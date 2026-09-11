// 角色包 zip 导入：解压到临时目录校验，通过后再移入 userData/character-packs/<id>/。
// 纯函数模块（extract/fs 全部可注入），仿照 skills/snapshot-install.ts 的解压方式。
//
// 校验规则（写死）：
// - manifest.json 必须存在且通过 validateManifest（id 合法、不与内置包冲突、必填字段齐全）。
// - prompts/ 下 REQUIRED_CHARACTER_PROMPT_FILES 必须全部存在且非空——否则该模式会静默
//   落回内置文件，出现"只换了一半人设"的效果，不如直接拒绝导入。
// - prompts/ 下不允许出现 RESERVED_CHARACTER_PROMPT_NAMES（worldbook / moments_personas），
//   否则会意外遮蔽跨角色共享的内容。
// - 头像文件必须存在、是图片扩展名、且解析后仍落在包目录内（防止 manifest 里写 ../ 路径）。
// - 声明自定义模型时，模型入口文件必须存在。
// - zip 体积与解压后体积都有上限，防止 zip 炸弹。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  REQUIRED_CHARACTER_PROMPT_FILES,
  RESERVED_CHARACTER_PROMPT_NAMES,
  type CharacterPackManifest,
  type CharacterPackSummary,
} from "../../shared/character-pack";
import { CHARACTER_PACK_MANIFEST_FILENAME, validateManifest } from "./character-pack-registry";

const MAX_ZIP_BYTES = 200 * 1024 * 1024; // 200MB：足够容纳一个 Live2D 模型
const MAX_EXTRACTED_BYTES = 500 * 1024 * 1024; // 500MB：解压后体积上限，防 zip 炸弹
const SAFE_IMAGE_EXT = /\.(?:png|jpg|jpeg|webp)$/i;

export type CharacterPackImportFailureReason =
  | "zip_not_found"
  | "zip_too_large"
  | "extract_failed"
  | "extracted_too_large"
  | "missing_manifest"
  | "invalid_manifest"
  | "missing_prompt_files"
  | "reserved_prompt_name"
  | "missing_avatar"
  | "missing_model"
  | "already_exists";

export type CharacterPackImportResult =
  | { ok: true; pack: CharacterPackSummary }
  | { ok: false; reason: CharacterPackImportFailureReason; detail?: string };

export interface CharacterPackImportOptions {
  zipPath: string;
  userCharacterPacksDir: string;
  /** 目标 id 已存在时是否覆盖；false 时返回 already_exists，交由调用方向用户确认后重试。 */
  overwrite?: boolean;
  extract?: (archivePath: string, opts: { dir: string }) => Promise<void>;
}

function dirSizeBytes(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else total += fs.statSync(full).size;
    }
  }
  return total;
}

function readManifestFromStaging(stagingDir: string): CharacterPackManifest | null {
  const manifestPath = path.join(stagingDir, CHARACTER_PACK_MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Partial<CharacterPackManifest>;
    return validateManifest(raw);
  } catch {
    return null;
  }
}

function findMissingPromptFiles(stagingDir: string): string[] {
  const promptsDir = path.join(stagingDir, "prompts");
  return REQUIRED_CHARACTER_PROMPT_FILES.filter((name) => {
    const filePath = path.join(promptsDir, name);
    return !fs.existsSync(filePath) || fs.readFileSync(filePath, "utf8").trim().length === 0;
  });
}

function findReservedPromptNames(stagingDir: string): string[] {
  const promptsDir = path.join(stagingDir, "prompts");
  if (!fs.existsSync(promptsDir)) return [];
  const present = new Set(fs.readdirSync(promptsDir));
  return RESERVED_CHARACTER_PROMPT_NAMES.filter((name) => present.has(name));
}

/** 校验 manifest 里的相对路径确实落在包目录内（防止 "../../etc/passwd" 之类）。 */
function resolveWithinStaging(stagingDir: string, relativePath: string): string | null {
  const base = path.resolve(stagingDir);
  const resolved = path.resolve(base, relativePath);
  const relative = path.relative(base, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolved;
}

export async function importCharacterPackZip(options: CharacterPackImportOptions): Promise<CharacterPackImportResult> {
  const {
    zipPath,
    userCharacterPacksDir,
    overwrite = false,
    extract = async (archivePath, opts) => {
      const { default: extractZip } = await import("extract-zip");
      await extractZip(archivePath, opts);
    },
  } = options;

  if (!fs.existsSync(zipPath)) return { ok: false, reason: "zip_not_found" };
  if (fs.statSync(zipPath).size > MAX_ZIP_BYTES) return { ok: false, reason: "zip_too_large" };

  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-pack-import-"));
  try {
    try {
      await extract(zipPath, { dir: stagingDir });
    } catch (err) {
      return { ok: false, reason: "extract_failed", detail: err instanceof Error ? err.message : String(err) };
    }

    if (dirSizeBytes(stagingDir) > MAX_EXTRACTED_BYTES) return { ok: false, reason: "extracted_too_large" };

    const manifest = readManifestFromStaging(stagingDir);
    if (!fs.existsSync(path.join(stagingDir, CHARACTER_PACK_MANIFEST_FILENAME))) {
      return { ok: false, reason: "missing_manifest" };
    }
    if (!manifest) return { ok: false, reason: "invalid_manifest" };

    const missingPrompts = findMissingPromptFiles(stagingDir);
    if (missingPrompts.length > 0) {
      return { ok: false, reason: "missing_prompt_files", detail: missingPrompts.join(", ") };
    }

    const reservedNames = findReservedPromptNames(stagingDir);
    if (reservedNames.length > 0) {
      return { ok: false, reason: "reserved_prompt_name", detail: reservedNames.join(", ") };
    }

    const avatarPath = resolveWithinStaging(stagingDir, manifest.avatarFile);
    if (!avatarPath || !fs.existsSync(avatarPath) || !SAFE_IMAGE_EXT.test(avatarPath)) {
      return { ok: false, reason: "missing_avatar" };
    }

    if (manifest.hasCustomModel) {
      const modelPath = manifest.modelEntryFile ? resolveWithinStaging(stagingDir, manifest.modelEntryFile) : null;
      if (!modelPath || !fs.existsSync(modelPath)) return { ok: false, reason: "missing_model" };
    }

    const finalDir = path.join(userCharacterPacksDir, manifest.id);
    if (fs.existsSync(finalDir)) {
      if (!overwrite) return { ok: false, reason: "already_exists" };
      fs.rmSync(finalDir, { recursive: true, force: true });
    }

    fs.mkdirSync(userCharacterPacksDir, { recursive: true });
    fs.cpSync(stagingDir, finalDir, { recursive: true });

    return { ok: true, pack: { manifest, source: "user" } };
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}
