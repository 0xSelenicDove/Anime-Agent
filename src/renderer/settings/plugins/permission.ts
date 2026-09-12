import { t } from "../i18n";
// 权限档位 UI：read-only / scoped / per-action / full 四档切换
// 从 settings.ts 抽离。依赖 plugins DOM 引用 + shared modal。
// 副作用导入：模块加载时执行事件绑定 + 初始加载档位。

import { permissionBlocksWrap, permissionNote } from "./dom";
import { _initModalOverlay } from "../shared/modal";
import { modalState } from "../shared/modal-state";

type PermissionLevel = "project-read-only" | "read-only" | "scoped" | "per-action" | "full";

const PERMISSION_NOTES: Record<PermissionLevel, string> = {
  "project-read-only": t("plugins-permission.1"),
  "read-only": t("plugins-permission.2"),
  "scoped": t("plugins-permission.3"),
  "per-action": t("plugins-permission.4"),
  "full": t("plugins-permission.5"),
};

function paintPermissionUI(level: PermissionLevel): void {
  if (!permissionBlocksWrap) return;
  // scoped 档已从插件面板移除，回退显示只读
  const display = level === "scoped" ? "read-only" : level;
  const blocks = permissionBlocksWrap.querySelectorAll<HTMLButtonElement>("button[data-level]");
  blocks.forEach((b) => {
    const isActive = b.dataset.level === display;
    b.classList.toggle("is-active", isActive);
    b.setAttribute("aria-pressed", String(isActive));
  });
  if (permissionNote) {
    permissionNote.textContent = PERMISSION_NOTES[level];
  }
}

async function confirmFullAccess(): Promise<boolean> {
  // 完全访问需要延迟确认 + 风险提示
  _initModalOverlay();
  if (!modalState.cyOverlay) return false;
  const iconEl = modalState.cyOverlay.querySelector("#cy-modal-icon") as HTMLElement;
  const titleEl = modalState.cyOverlay.querySelector("#cy-modal-title") as HTMLElement;
  const msgEl = modalState.cyOverlay.querySelector("#cy-modal-message") as HTMLElement;
  const cancelBtn = modalState.cyOverlay.querySelector("#cy-modal-cancel") as HTMLButtonElement;
  const confirmBtn = modalState.cyOverlay.querySelector("#cy-modal-confirm") as HTMLButtonElement;
  iconEl.textContent = "⚠️";
  titleEl.textContent = t("plugins-permission.6");
  msgEl.textContent = t("plugins-permission.7");
  cancelBtn.textContent = t("plugins-permission.8");
  modalState.cyOverlay.classList.remove("is-hidden");

  // 倒计时 5 秒强制等待
  let remain = 5;
  confirmBtn.disabled = true;
  confirmBtn.textContent = t("plugins-permission.9") + remain + "）";
  const tick = setInterval(() => {
    remain -= 1;
    if (remain <= 0) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = t("plugins-permission.10");
      clearInterval(tick);
    } else {
      confirmBtn.textContent = t("plugins-permission.11") + remain + "）";
    }
  }, 1000);

  return new Promise((resolve) => {
    const cleanup = (result: boolean) => {
      clearInterval(tick);
      confirmBtn.disabled = false;
      modalState.cyOverlay?.classList.add("is-hidden");
      cancelBtn.removeEventListener("click", onCancel);
      confirmBtn.removeEventListener("click", onConfirm);
      resolve(result);
    };
    const onCancel = () => cleanup(false);
    const onConfirm = () => cleanup(true);
    cancelBtn.addEventListener("click", onCancel);
    confirmBtn.addEventListener("click", onConfirm);
  });
}

// 事件绑定（模块加载时执行）
if (permissionBlocksWrap) {
  permissionBlocksWrap.addEventListener("click", async (event) => {
    const btn = (event.target as HTMLElement)?.closest("button[data-level]") as HTMLButtonElement | null;
    if (!btn) return;
    const target = (btn.dataset.level || "") as PermissionLevel;
    if (!target) return;
    if (btn.classList.contains("is-active")) {
      console.log("[settings] 档位未变，不动作");
      return;
    }

    if (target === "full") {
      const ok = await confirmFullAccess();
      if (!ok) {
        console.log("[settings] 用户取消了完全访问");
        return;
      }
    }

    console.log("[settings] 切换权限档位 →", target);
    try {
      const result = await window.settings?.setPermissionLevel?.(target);
      if (result?.ok) {
        paintPermissionUI((result.level || target) as PermissionLevel);
      } else {
        console.warn("[settings] 切换档位失败:", result?.error);
      }
    } catch (err) {
      console.error("[settings] 切换档位异常:", err);
    }
  });

  // 初始化：从后端拿当前档位
  void (async () => {
    try {
      const result = await window.settings?.getPermissionLevel?.();
      const level = (result?.level || "read-only") as PermissionLevel;
      console.log("[settings] 当前权限档位:", level);
      paintPermissionUI(level);
    } catch (err) {
      console.warn("[settings] 加载权限档位失败:", err);
      paintPermissionUI("read-only");
    }
  })();
}
