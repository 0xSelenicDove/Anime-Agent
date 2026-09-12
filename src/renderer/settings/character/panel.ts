import { t } from "../i18n";
// Character 面板业务逻辑：列出已安装角色包、切换当前角色包、导入/删除用户角色包。
// 从 settings.ts 抽离。副作用导入：模块加载时执行初始加载 + 事件订阅。

import { characterPackCards, characterPackImportBtn, characterPackStatus } from "./dom";
import { resolveCharacterPackAvatarUrl } from "../../shared/apply-active-character";
import { showModal } from "../shared/modal";
import type { CharacterPackSummary, CharacterPacksApi } from "../../../shared/character-pack";

declare global {
  interface Window {
    characterPacks?: CharacterPacksApi;
  }
}

const IMPORT_FAILURE_MESSAGES: Record<string, string> = {
  zip_not_found: t("character-panel.1"),
  zip_too_large: t("character-panel.2"),
  extract_failed: t("character-panel.3"),
  extracted_too_large: t("character-panel.4"),
  missing_manifest: t("character-panel.5"),
  invalid_manifest: t("character-panel.6"),
  missing_prompt_files: t("character-panel.7"),
  reserved_prompt_name: t("character-panel.8"),
  missing_avatar: t("character-panel.9"),
  missing_model: t("character-panel.10"),
};

const DELETE_FAILURE_MESSAGES: Record<string, string> = {
  not_found: t("character-panel.11"),
  cannot_delete_builtin: t("character-panel.12"),
  is_active: t("character-panel.13"),
  invalid_id: t("character-panel.14"),
};

let activePackId = "cyrene";
let switching = false;

function setStatus(text: string, tone: "" | "is-ok" | "is-error" = ""): void {
  if (!characterPackStatus) return;
  characterPackStatus.textContent = text;
  characterPackStatus.className = "user-field-hint" + (tone ? " " + tone : "");
}

function renderCards(packs: CharacterPackSummary[]): void {
  if (!characterPackCards) return;
  characterPackCards.innerHTML = "";
  for (const pack of packs) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "preset-card" + (pack.manifest.id === activePackId ? " is-active" : "");
    button.dataset.packId = pack.manifest.id;
    button.setAttribute("aria-pressed", String(pack.manifest.id === activePackId));
    button.title = pack.manifest.description ?? pack.manifest.displayName;

    const logo = document.createElement("span");
    logo.className = "preset-card__logo";
    const img = document.createElement("img");
    img.src = resolveCharacterPackAvatarUrl(pack);
    img.alt = "";
    img.width = 24;
    img.height = 24;
    img.draggable = false;
    logo.appendChild(img);

    const name = document.createElement("span");
    name.className = "preset-card__name";
    name.textContent = pack.manifest.displayName;

    button.appendChild(logo);
    button.appendChild(name);
    button.addEventListener("click", () => void activatePack(pack.manifest.id));

    if (pack.source === "user") {
      const deleteBtn = document.createElement("span");
      deleteBtn.textContent = "×";
      deleteBtn.title = t("character-panel.15");
      deleteBtn.style.cssText = "position:absolute;top:2px;right:6px;font-size:14px;opacity:0.6;cursor:pointer;";
      deleteBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        void removePack(pack.manifest.id, pack.manifest.displayName);
      });
      button.style.position = "relative";
      button.appendChild(deleteBtn);
    }

    characterPackCards.appendChild(button);
  }
}

async function activatePack(packId: string): Promise<void> {
  if (packId === activePackId || switching) return;
  switching = true;
  setStatus(t("character-panel.16"));
  try {
    await window.settings?.saveGeneral({ activeCharacterPackId: packId });
    activePackId = packId;
    setStatus(t("character-panel.17"), "is-ok");
    const packs = await window.characterPacks?.list();
    if (packs) renderCards(packs);
  } catch (error) {
    console.error("[settings] switch character pack failed:", error);
    setStatus(t("character-panel.18"), "is-error");
  } finally {
    switching = false;
  }
}

async function removePack(packId: string, displayName: string): Promise<void> {
  const confirmed = await showModal({
    title: t("character-panel.19"),
    message: t("character-panel.34", { name: displayName }),
    icon: "🗑️",
    confirmText: t("character-panel.20"),
    cancelText: t("character-panel.21"),
  });
  if (!confirmed) return;
  try {
    const result = await window.characterPacks?.delete(packId);
    if (result?.ok) {
      setStatus(t("character-panel.22"), "is-ok");
      await loadCharacterPanel();
    } else if (result) {
      setStatus(DELETE_FAILURE_MESSAGES[result.reason] ?? t("character-panel.23"), "is-error");
    } else {
      setStatus(t("character-panel.24"), "is-error");
    }
  } catch (error) {
    console.error("[settings] delete character pack failed:", error);
    setStatus(t("character-panel.25"), "is-error");
  }
}

async function importFromZip(zipPath: string, overwrite = false): Promise<void> {
  setStatus(t("character-panel.26"));
  try {
    const result = await window.characterPacks?.importZip(zipPath, overwrite);
    if (!result) return;
    if (result.ok) {
      setStatus(t("character-panel.35", { name: result.pack.manifest.displayName }), "is-ok");
      await loadCharacterPanel();
      return;
    }
    if (result.reason === "already_exists" && !overwrite) {
      const confirmed = await showModal({
        title: t("character-panel.27"),
        message: t("character-panel.28"),
        icon: "⚠️",
        confirmText: t("character-panel.29"),
        cancelText: t("character-panel.30"),
      });
      if (confirmed) await importFromZip(zipPath, true);
      else setStatus(t("character-panel.31"));
      return;
    }
    setStatus(IMPORT_FAILURE_MESSAGES[result.reason] ?? t("character-panel.36", { reason: result.reason }), "is-error");
  } catch (error) {
    console.error("[settings] import character pack failed:", error);
    setStatus(t("character-panel.32"), "is-error");
  }
}

characterPackImportBtn?.addEventListener("click", () => {
  void (async () => {
    const zipPath = await window.characterPacks?.pickZip();
    if (zipPath) await importFromZip(zipPath);
  })();
});

async function loadCharacterPanel(): Promise<void> {
  try {
    const [packs, active] = await Promise.all([
      window.characterPacks?.list() ?? Promise.resolve([]),
      window.characterPacks?.getActive(),
    ]);
    if (active) activePackId = active.manifest.id;
    renderCards(packs ?? []);
  } catch (error) {
    console.error("[settings] load character packs failed:", error);
    setStatus(t("character-panel.33"), "is-error");
  }
}

window.characterPacks?.onChanged((pack) => {
  activePackId = pack.manifest.id;
  void loadCharacterPanel();
});

void loadCharacterPanel();
