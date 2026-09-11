import { useTranslation } from "../../i18n";
import { useActiveCharacterPack } from "../../hooks/useActiveCharacterPack";

interface CharacterStatusPillProps {
  avatarPath: string;
  name?: string;
  status?: string;
}

export function CharacterStatusPill({
  avatarPath,
  name,
  status,
}: CharacterStatusPillProps) {
  const { t } = useTranslation();
  const activePack = useActiveCharacterPack();
  return (
    <div className="cy-status-pill">
      <img className="cy-status-avatar" src={avatarPath} alt="" />
      <span className="cy-status-name">{name ?? activePack.manifest.displayName}</span>
      <span className="cy-status-divider">·</span>
      <span className="cy-status-text">{status ?? t("ui.modelNotConnected")}</span>
    </div>
  );
}
