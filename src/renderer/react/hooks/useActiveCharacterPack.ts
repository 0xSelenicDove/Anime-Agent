import { useEffect, useState } from "react";
import type { CharacterPackSummary, CharacterPacksApi } from "../../../shared/character-pack";
import { resolveCharacterPackAvatarUrl } from "../../shared/apply-active-character";

declare global {
  interface Window {
    characterPacks?: CharacterPacksApi;
  }
}

const DEFAULT_PACK: CharacterPackSummary = {
  manifest: {
    schemaVersion: 1,
    id: "cyrene",
    displayName: "昔涟",
    avatarFile: "avatars/cyrene-avatar.png",
    hasCustomModel: true,
  },
  source: "builtin",
};

/** 当前生效角色包（响应式）：切换角色包时自动刷新。 */
export function useActiveCharacterPack(): CharacterPackSummary {
  const [pack, setPack] = useState<CharacterPackSummary>(DEFAULT_PACK);

  useEffect(() => {
    let active = true;
    void window.characterPacks?.getActive()
      .then((active_) => { if (active && active_) setPack(active_); })
      .catch(() => {});
    const unsubscribe = window.characterPacks?.onChanged((next) => {
      if (active) setPack(next);
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  return pack;
}

/** 当前生效角色包的头像 url（内置包走 resolveAsset，用户导入包走 character-pack:// 协议）。 */
export function useActiveCharacterAvatarUrl(): string {
  const pack = useActiveCharacterPack();
  return resolveCharacterPackAvatarUrl(pack);
}
