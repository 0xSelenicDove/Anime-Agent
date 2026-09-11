// Character 面板 DOM 引用
// 从 settings.ts 抽离。ESM 静态导入保证查询在 settings.ts 顶层代码之前执行。

export const characterPackCards = document.getElementById("character-pack-cards") as HTMLElement | null;
export const characterPackStatus = document.getElementById("character-pack-status") as HTMLElement | null;
export const characterPackImportBtn = document.getElementById("character-pack-import-btn") as HTMLButtonElement | null;
