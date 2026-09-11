import * as fs from "node:fs";
import { findPromptPath } from "../external-content-paths";

/**
 * 加载 prompts 目录下的 Markdown/文本文件。
 * 文件不存在或读取失败时返回空字符串，避免调用方因 prompt 缺失崩溃。
 */
export function loadPromptFile(filename: string): string {
  try {
    const filePath = findPromptPath(filename);
    if (!filePath) return "";
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * 文本类场景（朋友圈动态、主动消息）不需要人设文件里与 Live2D/视觉形象
 * 相关的章节。角色包作者可在 soul.md 中放置该标记，标记之后的内容在这
 * 类场景下会被裁掉；未放置标记时返回整段文本，不做任何裁剪。
 */
export const MOMENTS_CUTOFF_MARKER = "<!-- MOMENTS_CUTOFF -->";

export function applyMomentsCutoff(text: string): string {
  const index = text.indexOf(MOMENTS_CUTOFF_MARKER);
  return (index === -1 ? text : text.slice(0, index)).trim();
}
