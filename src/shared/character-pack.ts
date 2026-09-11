/**
 * 角色包（Character Pack）共享类型。
 *
 * 一个角色包 = { manifest.json, avatar 图片, 可选 icon, prompts/ 覆盖集, 可选 model/ }。
 * 本文件不依赖任何其他模块，供 main / renderer / shared 三端共同引用。
 */

/** 内置默认角色包 id：昔涟。永远作为内部占位符保留，不做物理迁移。 */
export const DEFAULT_CHARACTER_PACK_ID = "cyrene";

/** 内置的第二个示例角色包：无 IP 背景的通用助手人设。 */
export const GENERIC_CHARACTER_PACK_ID = "generic";

/** 角色包 id 合法性规则：小写字母/数字/下划线/短横线，1~64 位。 */
export const CHARACTER_PACK_ID_PATTERN = /^[a-z0-9_-]{1,64}$/;

export function isValidCharacterPackId(value: unknown): value is string {
  return typeof value === "string" && CHARACTER_PACK_ID_PATTERN.test(value);
}

export interface CharacterPackManifest {
  schemaVersion: 1;
  /** 文件夹名 / 唯一标识，需匹配 CHARACTER_PACK_ID_PATTERN。 */
  id: string;
  /** 展示名，替换掉界面中原先硬编码的"昔涟"/"Cyrene"。 */
  displayName: string;
  author?: string;
  description?: string;
  /** 头像文件名（相对包目录），必填。 */
  avatarFile: string;
  /** 应用图标文件名（相对包目录），可选，缺省时使用内置图标预设。 */
  iconFile?: string;
  /** 是否携带自定义 Live2D 模型；false 时复用内置模型。 */
  hasCustomModel: boolean;
  /** 自定义模型入口文件（相对包目录），hasCustomModel 为 true 时必填。 */
  modelEntryFile?: string;
}

/**
 * 一个角色包必须提供的 prompt 文件（相对 <包目录>/prompts/）。
 * 缺一个都会在导入时被拒绝——否则该模式下会静默落回内置文件，
 * 导致"只换了一半人设"的诡异效果。styles/*、tool_usage.md、cita_system.md、
 * phone_style.md 与 worldbook/* 不在此列，允许包不提供、共用内置版本。
 */
export const REQUIRED_CHARACTER_PROMPT_FILES = [
  "chat_system.md",
  "chat_identity.md",
  "soul.md",
  "canon_quotes.md",
  "cyrene_harness.md",
  "work_system.md",
  "work_identity.md",
  "work_remark.md",
  "canon_quotes_lite.md",
  "learn_system.md",
  "learn_identity.md",
  "code_system.md",
  "code_identity.md",
  "code_remark.md",
  "phone_system.md",
  "phone_identity.md",
] as const;

/** 角色包的 prompts/ 内不允许出现这些保留名——它们是跨包共享内容，
 *  出现同名文件会意外遮蔽内置的 worldbook / 其他角色的 moments 人设卡。 */
export const RESERVED_CHARACTER_PROMPT_NAMES = ["worldbook", "moments_personas"] as const;

export type CharacterPackSource = "builtin" | "user";

export type CharacterPackImportResultShape =
  | { ok: true; pack: CharacterPackSummary }
  | { ok: false; reason: string; detail?: string };

export type CharacterPackDeleteResultShape =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * preload 暴露的 window.characterPacks 完整形状。三端渲染代码
 * （i18n、apply-active-character、settings 面板）都从这里引用同一个类型，
 * 避免各自写 `declare global` 时字段不一致导致 TS 声明合并冲突。
 */
export interface CharacterPacksApi {
  list: () => Promise<CharacterPackSummary[]>;
  getActive: () => Promise<CharacterPackSummary>;
  onChanged: (callback: (pack: CharacterPackSummary) => void) => () => void;
  pickZip: () => Promise<string | null>;
  importZip: (zipPath: string, overwrite?: boolean) => Promise<CharacterPackImportResultShape>;
  delete: (packId: string) => Promise<CharacterPackDeleteResultShape>;
}

export interface CharacterPackSummary {
  manifest: CharacterPackManifest;
  source: CharacterPackSource;
}
