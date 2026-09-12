/**
 * Settings 窗口 i18n。这是一个独立于 src/renderer/react/i18n 的最小实现：
 * Settings 窗口是纯 vanilla TS + 静态 HTML（无 React/无 i18next），
 * 文案通过 data-i18n(-<attr>) 标记 + 一份合并 JSON 字典驱动。
 *
 * 语言来源与 react 窗口一致：主进程 GeneralSettings.language，
 * 通过 window.chat.onUiLocaleChanged 实时广播（见 general-settings-lifecycle.ts）。
 */
import zhCN from "./locales/zh-CN.json";
import en from "./locales/en.json";

type Dict = Record<string, string>;

const DICTS: Record<string, Dict> = {
  "zh-CN": zhCN as Dict,
  en: en as Dict,
};

const ATTR_MARKERS: ReadonlyArray<[attr: string, marker: string]> = [
  ["placeholder", "data-i18n-placeholder"],
  ["title", "data-i18n-title"],
  ["aria-label", "data-i18n-aria-label"],
  ["alt", "data-i18n-alt"],
];

let currentLanguage = "zh-CN";

function currentDict(): Dict {
  return DICTS[currentLanguage] ?? DICTS["zh-CN"];
}

/** 供动态生成文案（保存状态、错误提示等）使用；key 缺失时回退 zh-CN，再回退 key 本身。 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const raw = currentDict()[key] ?? DICTS["zh-CN"][key] ?? key;
  if (!vars) return raw;
  return Object.entries(vars).reduce(
    (text, [name, value]) => text.split(`{{${name}}}`).join(String(value)),
    raw,
  );
}

/** 返回当前生效的语言（"zh-CN" | "en"），供需要按语言分支渲染整段内容的场景使用。 */
export function getSettingsLanguage(): string {
  return currentLanguage;
}

function applyStaticMarkup(): void {
  const dict = currentDict();
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (key && dict[key] !== undefined) el.textContent = dict[key];
  });
  for (const [attr, marker] of ATTR_MARKERS) {
    document.querySelectorAll<HTMLElement>(`[${marker}]`).forEach((el) => {
      const key = el.getAttribute(marker);
      if (key && dict[key] !== undefined) el.setAttribute(attr, dict[key]);
    });
  }
}

const languageChangeListeners = new Set<() => void>();

/** 语言变化时需要重新渲染动态内容（当前分区标题、已打开的弹窗等）的调用方在此订阅。 */
export function onSettingsLanguageApplied(listener: () => void): () => void {
  languageChangeListeners.add(listener);
  return () => languageChangeListeners.delete(listener);
}

/** 应用一次语言：刷新所有静态标记的文案，并通知动态内容的订阅方重新渲染。 */
export function applySettingsLanguage(language: string | undefined | null): void {
  currentLanguage = language && DICTS[language] ? language : "zh-CN";
  applyStaticMarkup();
  for (const listener of languageChangeListeners) listener();
}

/** 订阅主进程广播的语言切换（用户在设置里点了 EN/中文）；失败（IPC 不可用）时静默忽略。 */
export function subscribeSettingsLanguageChanges(): void {
  try {
    window.chat?.onUiLocaleChanged?.((locale: string) => applySettingsLanguage(locale));
  } catch {
    // IPC 不可用时忽略，保持当前语言
  }
}
