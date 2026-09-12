/**
 * 通用的“传统面板”（sidebar / tasks / call / toast / sticker-manager 等非
 * React、非 i18next 的静态 HTML 窗口）i18n 运行时。用法：每个窗口自带一份
 * locales/{zh-CN,en}.json，在窗口自己的入口文件里调用一次
 * createWindowI18n({ "zh-CN": zhCN, en })，拿到该窗口专用的 t()/applyLanguage()。
 *
 * 语言来源与 react/settings 窗口一致：主进程 GeneralSettings.language，
 * 通过 window.chat.onUiLocaleChanged 实时广播。
 */

declare global {
  interface Window {
    chat?: {
      onUiLocaleChanged?: (callback: (locale: string) => void) => () => void;
    };
    settings?: {
      getGeneral?: () => Promise<{ language?: string }>;
    };
  }
}

type Dict = Record<string, string>;

export interface WindowI18n {
  /** 供动态生成文案使用；key 缺失时回退 zh-CN，再回退 key 本身。 */
  t(key: string, vars?: Record<string, string | number>): string;
  /** 返回当前生效的语言（如 "zh-CN" | "en"）。 */
  getLanguage(): string;
  /** 应用一次语言：刷新所有 data-i18n(-<attr>) 标记的静态文案，并通知订阅方重新渲染动态内容。 */
  applyLanguage(language: string | undefined | null): void;
  /** 订阅主进程广播的语言切换；失败（IPC 不可用）时静默忽略。 */
  subscribeLanguageChanges(): void;
  /** 语言变化时需要重新渲染动态内容的调用方在此订阅，返回取消订阅函数。 */
  onLanguageApplied(listener: () => void): () => void;
}

const ATTR_MARKERS: ReadonlyArray<[attr: string, marker: string]> = [
  ["placeholder", "data-i18n-placeholder"],
  ["title", "data-i18n-title"],
  ["aria-label", "data-i18n-aria-label"],
  ["alt", "data-i18n-alt"],
];

export function createWindowI18n(dicts: Record<string, Dict>, fallback = "zh-CN"): WindowI18n {
  let currentLanguage = fallback;
  const languageChangeListeners = new Set<() => void>();

  function currentDict(): Dict {
    return dicts[currentLanguage] ?? dicts[fallback];
  }

  function t(key: string, vars?: Record<string, string | number>): string {
    const raw = currentDict()[key] ?? dicts[fallback]?.[key] ?? key;
    if (!vars) return raw;
    return Object.entries(vars).reduce(
      (text, [name, value]) => text.split(`{{${name}}}`).join(String(value)),
      raw,
    );
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

  return {
    t,
    getLanguage: () => currentLanguage,
    applyLanguage(language) {
      currentLanguage = language && dicts[language] ? language : fallback;
      applyStaticMarkup();
      for (const listener of languageChangeListeners) listener();
    },
    subscribeLanguageChanges() {
      try {
        window.chat?.onUiLocaleChanged?.((locale: string) => this.applyLanguage(locale));
      } catch {
        // IPC 不可用时忽略，保持当前语言
      }
    },
    onLanguageApplied(listener) {
      languageChangeListeners.add(listener);
      return () => languageChangeListeners.delete(listener);
    },
  };
}

/**
 * 便捷初始化：拉取主进程当前语言、应用一次、并订阅后续广播。
 *
 * 注意：这是异步的——调用后紧跟着的同步顶层代码仍会先于语言应用完成执行。
 * 只被 [data-i18n] 标记驱动的静态 HTML 天然没问题（语言到达后自动刷新）；
 * 但任何“只在模块加载时计算一次 t(...) 结果”的变量（如顶层 const 数组、
 * 传给别处回调的字符串）不会在语言到达后自动更新——这类场景请改成在
 * onLanguageApplied() 回调里重新计算，而不是在模块顶层直接用一次性结果。
 */
export function initWindowI18n(dicts: Record<string, Dict>, fallback = "zh-CN"): WindowI18n {
  const i18n = createWindowI18n(dicts, fallback);
  i18n.subscribeLanguageChanges();
  void window.settings?.getGeneral?.()
    .then((cfg) => i18n.applyLanguage(cfg?.language))
    .catch(() => i18n.applyLanguage(fallback));
  return i18n;
}
