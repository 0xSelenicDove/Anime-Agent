import { resolveAsset } from "../../shared/renderer-base";
import type { CharacterPackSummary, CharacterPacksApi } from "../../shared/character-pack";

declare global {
  interface Window {
    characterPacks?: CharacterPacksApi;
  }
}

export interface ActiveCharacterBranding {
  displayName: string;
  avatarUrl: string;
}

/**
 * 角色包内任意资源文件的 url 解析：内置包走 resolveAsset()（渲染器自身打包根
 * 目录下的静态资源），用户导入包走 character-pack:// 协议（服务
 * userData/character-packs/<id>/ 下的文件）。头像、图标、Live2D 模型文件都走这条规则。
 */
export function resolveCharacterPackAssetUrl(pack: CharacterPackSummary, relativeFile: string): string {
  if (pack.source === "builtin") return resolveAsset(relativeFile);
  return `character-pack://${pack.manifest.id}/${relativeFile}`;
}

export function resolveCharacterPackAvatarUrl(pack: CharacterPackSummary): string {
  return resolveCharacterPackAssetUrl(pack, pack.manifest.avatarFile);
}

export function toBranding(pack: CharacterPackSummary): ActiveCharacterBranding {
  return {
    displayName: pack.manifest.displayName,
    avatarUrl: resolveCharacterPackAvatarUrl(pack),
  };
}

export async function getActiveCharacterPack(): Promise<CharacterPackSummary | null> {
  try {
    return (await window.characterPacks?.getActive()) ?? null;
  } catch {
    return null;
  }
}

/**
 * 没有接入 i18n 的传统面板（sidebar / call / settings 等）用这个函数把
 * 名字、头像相关的 DOM 节点同步为当前生效角色包，并在切换角色包时自动更新。
 * 返回取消订阅函数。
 */
export function applyActiveCharacterBranding(targets: {
  nameEls?: ReadonlyArray<Element | null | undefined>;
  avatarEls?: ReadonlyArray<HTMLImageElement | null | undefined>;
  /** 传入时会把 document.title 设置为 "<展示名><titleSuffix>"。 */
  titleSuffix?: string;
  onChange?: (branding: ActiveCharacterBranding) => void;
}): () => void {
  function apply(pack: CharacterPackSummary): void {
    const branding = toBranding(pack);
    for (const el of targets.nameEls ?? []) {
      if (el) el.textContent = branding.displayName;
    }
    for (const el of targets.avatarEls ?? []) {
      if (el) el.src = branding.avatarUrl;
    }
    if (targets.titleSuffix !== undefined) {
      document.title = branding.displayName + targets.titleSuffix;
    }
    targets.onChange?.(branding);
  }

  void getActiveCharacterPack().then((pack) => {
    if (pack) apply(pack);
  });
  return window.characterPacks?.onChanged(apply) ?? (() => {});
}
