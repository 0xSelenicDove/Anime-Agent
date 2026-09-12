import { useSyncExternalStore } from "react";
import { initWindowI18n } from "../shared/window-i18n";
import zhCN from "./locales/zh-CN.json";
import en from "./locales/en.json";

const i18n = initWindowI18n({ "zh-CN": zhCN, en });

export const t = i18n.t;

function subscribe(onChange: () => void): () => void {
  return i18n.onLanguageApplied(onChange);
}

function getSnapshot(): string {
  return i18n.getLanguage();
}

/** React 组件翻译 hook：语言切换时自动重渲染。 */
export function useTranslation() {
  const locale = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { t, locale };
}
