import * as fs from "node:fs";
import * as path from "node:path";
import { getExternalContentPaths } from "../external-content-paths";
import { loadGeneralSettings } from "../settings/settings-facade";
import {
  CHARACTER_PACK_ID_PATTERN,
  DEFAULT_CHARACTER_PACK_ID,
  GENERIC_CHARACTER_PACK_ID,
  type CharacterPackManifest,
  type CharacterPackSummary,
} from "../../shared/character-pack";

export const CHARACTER_PACK_MANIFEST_FILENAME = "manifest.json";

/**
 * 内置角色包清单。avatarFile / modelEntryFile 对内置包而言是相对于
 * renderer 静态资源根目录（src/renderer/public/）的路径，通过既有的
 * resolveAsset() 解析——内置包不经过 character-pack:// 协议。
 */
const BUILTIN_CHARACTER_PACKS: CharacterPackManifest[] = [
  {
    schemaVersion: 1,
    id: DEFAULT_CHARACTER_PACK_ID,
    displayName: "昔涟",
    description: "内置默认角色人设（Honkai: Star Rail 同人角色 Cyrene）。",
    avatarFile: "avatars/cyrene-avatar.png",
    hasCustomModel: true,
    modelEntryFile: "models/cyrene/Cyrene.model3.json",
  },
  {
    schemaVersion: 1,
    id: GENERIC_CHARACTER_PACK_ID,
    displayName: "小助手",
    description: "不含角色 IP 背景的通用助手人设，开箱即用，复用内置 Live2D 形象。",
    avatarFile: "character-packs/generic/avatar.png",
    hasCustomModel: false,
  },
];

function readManifestFile(manifestPath: string): CharacterPackManifest | null {
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Partial<CharacterPackManifest>;
    return validateManifest(raw);
  } catch {
    return null;
  }
}

/** 校验角色包 manifest 的必填字段与格式；非法时返回 null。 */
export function validateManifest(raw: Partial<CharacterPackManifest> | null | undefined): CharacterPackManifest | null {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "string" || !CHARACTER_PACK_ID_PATTERN.test(raw.id)) return null;
  if (BUILTIN_CHARACTER_PACKS.some((pack) => pack.id === raw.id)) return null; // 不允许与内置包 id 冲突
  if (typeof raw.displayName !== "string" || !raw.displayName.trim()) return null;
  if (typeof raw.avatarFile !== "string" || !raw.avatarFile.trim()) return null;
  const hasCustomModel = Boolean(raw.hasCustomModel);
  if (hasCustomModel && (typeof raw.modelEntryFile !== "string" || !raw.modelEntryFile.trim())) return null;
  return {
    schemaVersion: 1,
    id: raw.id,
    displayName: raw.displayName.trim(),
    author: typeof raw.author === "string" ? raw.author : undefined,
    description: typeof raw.description === "string" ? raw.description : undefined,
    avatarFile: raw.avatarFile,
    iconFile: typeof raw.iconFile === "string" ? raw.iconFile : undefined,
    hasCustomModel,
    modelEntryFile: hasCustomModel ? raw.modelEntryFile : undefined,
  };
}

/** 扫描 userData/character-packs/ 下所有用户导入的角色包。 */
function scanUserCharacterPacks(userCharacterPacksDir: string): CharacterPackSummary[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(userCharacterPacksDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const summaries: CharacterPackSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(userCharacterPacksDir, entry.name, CHARACTER_PACK_MANIFEST_FILENAME);
    const manifest = readManifestFile(manifestPath);
    if (!manifest || manifest.id !== entry.name) continue; // 文件夹名必须与 manifest.id 一致
    summaries.push({ manifest, source: "user" });
  }
  return summaries;
}

/** 列出所有可用角色包：内置包在前，用户导入包在后。 */
export function listInstalledCharacterPacks(): CharacterPackSummary[] {
  const { userCharacterPacksDir } = getExternalContentPaths();
  return [
    ...BUILTIN_CHARACTER_PACKS.map((manifest): CharacterPackSummary => ({ manifest, source: "builtin" })),
    ...scanUserCharacterPacks(userCharacterPacksDir),
  ];
}

/** 当前设置中记录的角色包 id（未经过“是否真实存在”校验）。 */
export function getActiveCharacterPackId(): string {
  return loadGeneralSettings().activeCharacterPackId || DEFAULT_CHARACTER_PACK_ID;
}

/**
 * 解析当前生效角色包。若设置中记录的 id 对应的包已被删除/损坏，
 * 优雅回退到内置默认包，而不是抛错或显示空白名称。
 */
export function resolveActiveCharacterPack(): CharacterPackSummary {
  const activeId = getActiveCharacterPackId();
  const installed = listInstalledCharacterPacks();
  const found = installed.find((pack) => pack.manifest.id === activeId);
  if (found) return found;
  return installed.find((pack) => pack.manifest.id === DEFAULT_CHARACTER_PACK_ID) ?? {
    manifest: BUILTIN_CHARACTER_PACKS[0],
    source: "builtin",
  };
}

/** 便捷方法：主进程里需要把窗口标题/托盘提示/toast 标题里的硬编码名字换成当前角色名时使用。 */
export function getActiveCharacterDisplayName(): string {
  return resolveActiveCharacterPack().manifest.displayName;
}

export type DeleteCharacterPackResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "cannot_delete_builtin" | "is_active" | "invalid_id" };

/** 删除一个用户导入的角色包目录。内置包与当前正在使用的包不允许删除。 */
export function deleteCharacterPack(packId: string): DeleteCharacterPackResult {
  if (!CHARACTER_PACK_ID_PATTERN.test(packId)) return { ok: false, reason: "invalid_id" };
  if (BUILTIN_CHARACTER_PACKS.some((pack) => pack.id === packId)) {
    return { ok: false, reason: "cannot_delete_builtin" };
  }
  if (getActiveCharacterPackId() === packId) {
    return { ok: false, reason: "is_active" };
  }
  const { userCharacterPacksDir } = getExternalContentPaths();
  const dir = path.join(userCharacterPacksDir, packId);
  if (!fs.existsSync(dir)) return { ok: false, reason: "not_found" };
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}
