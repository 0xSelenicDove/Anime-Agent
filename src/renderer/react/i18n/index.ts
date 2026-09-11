/**
 * 聊天主界面（react/）的 i18n 基础设施。
 *
 * - 使用 i18next 核心包（框架无关）：React 组件用 useTranslation hook，
 *   非 React 的纯 ts 模块直接 import { t }。
 * - 资源文件：zh-CN.json（合并式单文件，按域名分节）。
 * - 语言来源：主进程 GeneralSettings.language（即 locale-context 的 uiLocale）。
 *   第一阶段只有中文资源；新增语言时补充 <locale>.json 并在 resources 注册。
 */
import i18next from "i18next";
import { useCallback, useSyncExternalStore } from "react";
import en from "./en.json";
import zhCN from "./zh-CN.json";
import type { CharacterPacksApi } from "../../../shared/character-pack";

declare global {
  interface Window {
    characterPacks?: CharacterPacksApi;
  }
}

export const UI_LOCALE_FALLBACK = "zh-CN";

void i18next.init({
  lng: UI_LOCALE_FALLBACK,
  fallbackLng: UI_LOCALE_FALLBACK,
  resources: {
    en: { translation: en },
    "zh-CN": { translation: zhCN },
  },
  interpolation: { escapeValue: false },
  // 缺 key 时回退到 key 本身，便于发现漏抽的文案
  parseMissingKeyHandler: (key) => key,
});

/**
 * 从主进程读取语言设置并应用。
 * 失败（IPC 不可用 / 设置读取异常）时静默保持默认 zh-CN。
 */
export async function initUiLocale(): Promise<void> {
  try {
    const general = await window.chat?.getGeneralSettings?.();
    const lang = general?.language;
    if (typeof lang === "string" && lang.trim() && lang !== UI_LOCALE_FALLBACK) {
      await i18next.changeLanguage(lang.trim());
    }
  } catch {
    // 保持默认语言
  }
}

/** 运行时切换 UI 语言。 */
export function setUiLocale(locale: string): void {
  if (locale.trim()) void i18next.changeLanguage(locale.trim());
}

// ── 当前生效角色包展示名 ──────────────────────────────────────────
// 文案里原先硬编码"昔涟"/"Cyrene"的地方，改用 {{characterName}} 占位符，
// 由这里统一注入当前生效角色包的展示名——调用方不需要在每处 t() 都手填。

const DEFAULT_CHARACTER_NAME = "昔涟";
let activeCharacterName = DEFAULT_CHARACTER_NAME;
const characterNameListeners = new Set<() => void>();

export function getActiveCharacterName(): string {
  return activeCharacterName;
}

export function setActiveCharacterName(name: string): void {
  if (!name || name === activeCharacterName) return;
  activeCharacterName = name;
  for (const listener of characterNameListeners) listener();
}

/** 订阅角色名变化（含 setActiveCharacterName 触发的首次拉取）；返回取消订阅函数。 */
export function onActiveCharacterNameChanged(listener: (name: string) => void): () => void {
  const wrapped = () => listener(activeCharacterName);
  characterNameListeners.add(wrapped);
  return () => characterNameListeners.delete(wrapped);
}

/**
 * 启动时从主进程拉取当前生效角色包名，并订阅后续切换。
 * 失败时静默保持默认名（内置昔涟包）；订阅在整个 App 生命周期内常驻，不返回取消函数。
 */
export async function initActiveCharacterName(): Promise<void> {
  try {
    const active = await window.characterPacks?.getActive();
    if (active?.manifest?.displayName) setActiveCharacterName(active.manifest.displayName);
  } catch {
    // 保持默认角色名
  }
  window.characterPacks?.onChanged((pack) => {
    if (pack?.manifest?.displayName) setActiveCharacterName(pack.manifest.displayName);
  });
}

function withCharacterName(options?: Record<string, unknown>): Record<string, unknown> {
  return { characterName: activeCharacterName, ...options };
}

/** 供非 React 模块直接使用的翻译函数（语言/角色名切换时不会触发重渲染，按调用即时取值）。 */
export const t = (key: string, options?: Record<string, unknown>) => i18next.t(key, withCharacterName(options));

function getSnapshot(): string {
  return `${i18next.language}::${activeCharacterName}`;
}

function subscribe(onChange: () => void): () => void {
  i18next.on("languageChanged", onChange);
  characterNameListeners.add(onChange);
  return () => {
    i18next.off("languageChanged", onChange);
    characterNameListeners.delete(onChange);
  };
}

/**
 * React 组件翻译 hook：语言或当前角色包切换时自动重渲染。
 * 用法：const { t } = useTranslation(); t("composer.uploadFile")
 */
export function useTranslation() {
  // 第三个参数 getServerSnapshot：renderToStaticMarkup 等服务端渲染路径必需，
  // 否则 React 抛 "Missing getServerSnapshot"（单测用静态渲染断言文案）。
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const translate = useCallback(
    (key: string, options?: Record<string, unknown>) => i18next.t(key, withCharacterName(options)),
    // snapshot 变化（语言或角色名）时刷新 useCallback 缓存
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot],
  );
  return { t: translate, locale: i18next.language };
}
