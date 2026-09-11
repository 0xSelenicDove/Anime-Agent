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
  zip_not_found: "找不到选中的 zip 文件",
  zip_too_large: "zip 文件过大（上限 200MB）",
  extract_failed: "解压失败，请确认文件是有效的 zip",
  extracted_too_large: "解压后体积过大（上限 500MB）",
  missing_manifest: "zip 里缺少 manifest.json",
  invalid_manifest: "manifest.json 字段不合法，或 id 与内置角色包冲突",
  missing_prompt_files: "缺少必需的人设 prompt 文件",
  reserved_prompt_name: "prompts/ 下包含保留名称（worldbook / moments_personas），请移除后重试",
  missing_avatar: "找不到 manifest 里指定的头像文件",
  missing_model: "声明了自定义模型，但模型入口文件不存在",
};

const DELETE_FAILURE_MESSAGES: Record<string, string> = {
  not_found: "角色包不存在或已被删除",
  cannot_delete_builtin: "内置角色包不能删除",
  is_active: "当前正在使用这个角色包，请先切换到其他角色包再删除",
  invalid_id: "角色包 id 无效",
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
      deleteBtn.title = "删除这个角色包";
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
  setStatus("切换中…");
  try {
    await window.settings?.saveGeneral({ activeCharacterPackId: packId });
    activePackId = packId;
    setStatus("已切换，桌宠形象与部分窗口标题可能需要重新打开才会更新。", "is-ok");
    const packs = await window.characterPacks?.list();
    if (packs) renderCards(packs);
  } catch (error) {
    console.error("[settings] switch character pack failed:", error);
    setStatus("切换失败，请重试", "is-error");
  } finally {
    switching = false;
  }
}

async function removePack(packId: string, displayName: string): Promise<void> {
  const confirmed = await showModal({
    title: "删除角色包",
    message: `确定要删除角色包"${displayName}"吗？此操作无法恢复。`,
    icon: "🗑️",
    confirmText: "删除",
    cancelText: "取消",
  });
  if (!confirmed) return;
  try {
    const result = await window.characterPacks?.delete(packId);
    if (result?.ok) {
      setStatus("已删除", "is-ok");
      await loadCharacterPanel();
    } else if (result) {
      setStatus(DELETE_FAILURE_MESSAGES[result.reason] ?? "删除失败", "is-error");
    } else {
      setStatus("删除失败，请重试", "is-error");
    }
  } catch (error) {
    console.error("[settings] delete character pack failed:", error);
    setStatus("删除失败，请重试", "is-error");
  }
}

async function importFromZip(zipPath: string, overwrite = false): Promise<void> {
  setStatus("导入中…");
  try {
    const result = await window.characterPacks?.importZip(zipPath, overwrite);
    if (!result) return;
    if (result.ok) {
      setStatus(`已导入"${result.pack.manifest.displayName}"，点击卡片即可切换`, "is-ok");
      await loadCharacterPanel();
      return;
    }
    if (result.reason === "already_exists" && !overwrite) {
      const confirmed = await showModal({
        title: "角色包已存在",
        message: "已经安装了同名角色包，是否覆盖？",
        icon: "⚠️",
        confirmText: "覆盖",
        cancelText: "取消",
      });
      if (confirmed) await importFromZip(zipPath, true);
      else setStatus("已取消导入");
      return;
    }
    setStatus(IMPORT_FAILURE_MESSAGES[result.reason] ?? `导入失败：${result.reason}`, "is-error");
  } catch (error) {
    console.error("[settings] import character pack failed:", error);
    setStatus("导入失败，请重试", "is-error");
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
    setStatus("加载角色包列表失败", "is-error");
  }
}

window.characterPacks?.onChanged((pack) => {
  activePackId = pack.manifest.id;
  void loadCharacterPanel();
});

void loadCharacterPanel();
