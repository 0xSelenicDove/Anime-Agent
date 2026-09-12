import i18next from "i18next";
import React from "react";
import { createRoot } from "react-dom/client";
import "../ui/theme";
import { App } from "./App";
import { AppProviders } from "./app/providers/AppProviders";
import { getActiveCharacterName, initActiveCharacterName, initUiLocale, onActiveCharacterNameChanged, subscribeUiLocaleChanges, t } from "./i18n";

const container = document.getElementById("cyrene-react-root");
if (!container) {
  throw new Error("Root element #cyrene-react-root not found");
}

const root = createRoot(container);
function syncDocumentTitle(name: string): void {
  document.title = `${name} · ${t("ui.titleSuffix")}`;
}
onActiveCharacterNameChanged(syncDocumentTitle);
i18next.on("languageChanged", () => syncDocumentTitle(getActiveCharacterName()));
syncDocumentTitle(getActiveCharacterName());
void initActiveCharacterName();
// 先从主进程读取语言设置再渲染，避免首帧语言跳变；读取失败时保持默认 zh-CN
void initUiLocale().finally(() => {
  subscribeUiLocaleChanges();
  root.render(
    <React.StrictMode>
      <AppProviders>
        <App />
      </AppProviders>
    </React.StrictMode>,
  );
});
