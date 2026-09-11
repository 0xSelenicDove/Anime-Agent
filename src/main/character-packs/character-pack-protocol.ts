// character-pack:// 协议的安全解析（照 moment-media-protocol.ts 模式）。
//
// 只服务用户导入包（userData/character-packs/<id>/...）；内置包（cyrene/generic）
// 走既有的 resolveAsset()，不经过这个协议。
//
// 安全边界（写死）：
// - 映射式解析：packId + 相对路径 → 主进程拼绝对路径，禁止直拼 decodedUrl；
// - packId 白名单正则（与 CHARACTER_PACK_ID_PATTERN 一致）；
// - 相对路径按 "/" 分段校验，每段禁止空、"."、".." 及非白名单字符
//   （模型包需要 model/textures/xxx.png 这类多级子路径，因此不能像
//   moment-media 那样只允许单层文件名）；
// - 解析结果必须位于 <userCharacterPacksDir>/<packId>/ 内（杜绝 ../ 路径穿越）。

import * as path from "path";
import { CHARACTER_PACK_ID_PATTERN } from "../../shared/character-pack";

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_.-]+$/;

function isSafeCharacterPackFile(packId: string, file: string): boolean {
  if (!CHARACTER_PACK_ID_PATTERN.test(packId)) return false;
  if (!file) return false;
  const segments = file.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== ".." && SAFE_PATH_SEGMENT.test(segment),
  );
}

export function parseCharacterPackUrl(rawUrl: string): { packId: string; file: string } | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "character-pack:") return null;

  let packId: string;
  let file: string;
  try {
    packId = decodeURIComponent(url.host || "");
    file = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  } catch {
    return null;
  }

  if (!isSafeCharacterPackFile(packId, file)) return null;
  return { packId, file };
}

export function resolveCharacterPackAssetPath(
  userCharacterPacksDir: string,
  packId: string,
  file: string,
): string | null {
  if (!isSafeCharacterPackFile(packId, file)) return null;
  const base = path.resolve(userCharacterPacksDir, packId);
  const resolved = path.resolve(base, ...file.split("/"));
  const relative = path.relative(base, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolved;
}
