import { t } from "../i18n";
// Timeout 面板业务逻辑：超时配置加载 / 保存 / 重置按钮绑定
// 从 settings.ts 抽离。依赖 timeout DOM 引用（./dom）、api DOM 引用（../api/dom，复用 modelRequestTimeoutSec*）。
// saveTimeoutSettings 导出供 settings.ts 的 API 表单处理器调用（跨面板共享保存逻辑）。

import {
  timeoutUserChoiceInput, timeoutUserChoiceReset,
  timeoutTestInput, timeoutTestReset,
  maxParallelToolCallsInput,
} from "./dom";
import { modelRequestTimeoutSecInput, modelRequestTimeoutSecReset } from "../api/dom";
import { setSaveStatus, setRuntimeSaveStatus } from "../shared/save-status";
import { parsePositiveIntOrThrow } from "../shared/parse";
import type { TimeoutSettings } from "../../../shared/timeout-types";

export async function loadTimeoutSettings(): Promise<void> {
  try {
    const cfg = await window.settings!.getTimeoutSettings();
    timeoutUserChoiceInput.value = String(cfg.userChoiceTimeout / 1000);
    timeoutTestInput.value = String(cfg.testTimeout);
    modelRequestTimeoutSecInput.value = cfg.modelRequestTimeoutSec != null ? String(cfg.modelRequestTimeoutSec) : "";
    const generalSettings = await window.settings!.getGeneral();
    maxParallelToolCallsInput.value = String(generalSettings.maxParallelToolCalls ?? 4);
    setRuntimeSaveStatus(t("timeout-panel.1"));
  } catch {
    setRuntimeSaveStatus(t("timeout-panel.2"), "is-error");
  }
}

export async function saveTimeoutSettings(saveTestTimeout: boolean): Promise<boolean> {
  let settings: Partial<TimeoutSettings>;
  try {
    if (!saveTestTimeout) {
      settings = {
        userChoiceTimeout: 1000 * parsePositiveIntOrThrow(timeoutUserChoiceInput.value, t("timeout-panel.3")),
        modelRequestTimeoutSec: modelRequestTimeoutSecInput.value === "" ? undefined : parsePositiveIntOrThrow(modelRequestTimeoutSecInput.value, t("timeout-panel.4")),
      };
    } else {
      settings = {
        testTimeout: parsePositiveIntOrThrow(timeoutTestInput.value, t("timeout-panel.5")),
      };
    }
  } catch (e) {
    if (saveTestTimeout) {
      setSaveStatus(t("timeout-panel.6") + e, "is-error");
    } else {
      setRuntimeSaveStatus(t("timeout-panel.7") + e, "is-error");
    }
    return false;
  }
  try {
    await window.settings!.saveTimeoutSettings(settings);
    if (!saveTestTimeout) {
      const requested = Number(maxParallelToolCallsInput.value);
      await window.settings!.saveGeneral({
        maxParallelToolCalls: Number.isFinite(requested) ? requested : 4,
      });
    }
    if (saveTestTimeout) {
      setSaveStatus(t("timeout-panel.8"), "is-ok");
    } else {
      setRuntimeSaveStatus(t("timeout-panel.9"), "is-ok");
    }
    return true;
  } catch {
    if (saveTestTimeout) {
      setSaveStatus(t("timeout-panel.10"), "is-error");
    } else {
      setRuntimeSaveStatus(t("timeout-panel.11"), "is-error");
    }
  }
  return false;
}

// ===== 重置按钮事件绑定（模块加载时执行） =====
timeoutTestReset.addEventListener("click", () => { timeoutTestInput.value = "15000" });
timeoutUserChoiceReset.addEventListener("click", () => { timeoutUserChoiceInput.value = "60" });
modelRequestTimeoutSecReset.addEventListener("click", () => { modelRequestTimeoutSecInput.value = "" });

// 模块加载时拉一次配置
void loadTimeoutSettings();
