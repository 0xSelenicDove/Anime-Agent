import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import extract from "extract-zip";
import { inspectPluginDir } from "./loader";
import type { PluginManifest } from "./types";

export const PLUGIN_ZIP_LIMITS = {
  archiveBytes: 50 * 1024 * 1024,
  entries: 2_000,
  entryBytes: 50 * 1024 * 1024,
  expandedBytes: 200 * 1024 * 1024,
  compressionRatio: 200,
} as const;

export interface PreparedPluginZip {
  stagingDir: string;
  pluginDir: string;
  manifest: PluginManifest;
}

/**
 * 宿主安装记录的保留文件名。插件市场安装来源记录保存在宿主管理的
 * plugin-install-metadata 目录中，插件包内不允许出现同名文件，
 * 防止插件包伪造来源信息。
 */
const HOST_METADATA_RESERVED_NAME = "cyrene-market.json";

/** 市场安装来源记录（宿主侧持久化，与插件目录解耦） */
export interface PluginHostMetadata {
  origin: "market";
  registryId: string;
  installedVersion: string;
  installedAt: string;
}

function hostMetadataPath(userPluginRoot: string, pluginId: string): string {
  return path.join(path.dirname(userPluginRoot), "plugin-install-metadata", `${pluginId}.json`);
}

export async function writeHostMetadata(
  userPluginRoot: string,
  pluginId: string,
  metadata: PluginHostMetadata,
): Promise<void> {
  const file = hostMetadataPath(userPluginRoot, pluginId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

/** 读取市场安装来源记录；不存在或内容损坏时返回 undefined（按本地插件处理）。 */
export function readHostMetadataSync(userPluginRoot: string, pluginId: string): PluginHostMetadata | undefined {
  try {
    const raw = readFileSync(hostMetadataPath(userPluginRoot, pluginId), "utf8");
    const parsed = JSON.parse(raw) as Partial<PluginHostMetadata>;
    if (parsed.origin !== "market" || typeof parsed.installedVersion !== "string") return undefined;
    return {
      origin: "market",
      registryId: typeof parsed.registryId === "string" ? parsed.registryId : "",
      installedVersion: parsed.installedVersion,
      installedAt: typeof parsed.installedAt === "string" ? parsed.installedAt : "",
    };
  } catch {
    return undefined;
  }
}

export async function removeHostMetadata(userPluginRoot: string, pluginId: string): Promise<void> {
  await rm(hostMetadataPath(userPluginRoot, pluginId), { force: true });
}

function validateEntryName(fileName: string): string {
  if (!fileName || fileName.includes("\0")) throw new Error("ZIP 包含空文件名或 NUL 字符");
  const normalized = fileName.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`ZIP 包含绝对路径: ${fileName}`);
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === ".." || segment.includes(":"))) {
    throw new Error(`ZIP 包含不安全路径: ${fileName}`);
  }
  if (segments.some((segment) => /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) {
    throw new Error(`ZIP 包含 Windows 不支持的路径: ${fileName}`);
  }
  return normalized.replace(/\/+$/, "").toLowerCase();
}

async function assertNoLinks(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error(`ZIP 不允许包含符号链接: ${entry.name}`);
    if (info.isDirectory()) await assertNoLinks(target);
    else if (!info.isFile()) throw new Error(`ZIP 包含不支持的文件类型: ${entry.name}`);
  }
}

async function locatePluginDirectory(stagingDir: string): Promise<string> {
  if (existsSync(path.join(stagingDir, "manifest.json"))) return stagingDir;
  const entries = (await readdir(stagingDir, { withFileTypes: true }))
    .filter((entry) => entry.name !== "__MACOSX");
  if (entries.length !== 1 || !entries[0].isDirectory()) {
    throw new Error("ZIP 必须在根目录或唯一的顶层目录中包含 manifest.json");
  }
  return path.join(stagingDir, entries[0].name);
}

export interface PreparePluginZipOptions {
  /**
   * 期望的插件身份（市场安装时传入）。解出的 manifest 必须与之完全一致，
   * 防止下载的插件包与市场登记条目不符。
   */
  expectedIdentity?: { id: string; version: string };
}

export async function preparePluginZip(
  zipPath: string,
  userPluginRoot: string,
  opts: PreparePluginZipOptions = {},
): Promise<PreparedPluginZip> {
  if (path.extname(zipPath).toLowerCase() !== ".zip") throw new Error("只能导入 .zip 插件包");
  const archive = await stat(zipPath);
  if (!archive.isFile()) throw new Error("所选路径不是普通 ZIP 文件");
  if (archive.size > PLUGIN_ZIP_LIMITS.archiveBytes) throw new Error("ZIP 文件超过 50 MiB 限制");

  await mkdir(userPluginRoot, { recursive: true });
  const stagingBase = path.join(path.dirname(userPluginRoot), "plugin-install-staging");
  await mkdir(stagingBase, { recursive: true });
  const stagingDir = path.join(stagingBase, randomUUID());
  let entryCount = 0;
  let expandedBytes = 0;
  const entryNames = new Set<string>();
  try {
    await extract(zipPath, {
      dir: stagingDir,
      onEntry(entry) {
        const entryName = validateEntryName(entry.fileName);
        if (entryNames.has(entryName)) throw new Error(`ZIP 包含重复或大小写冲突路径: ${entry.fileName}`);
        const baseName = entryName.split("/").pop() ?? "";
        if (baseName === HOST_METADATA_RESERVED_NAME) {
          throw new Error(`ZIP 不允许包含宿主保留文件: ${entry.fileName}`);
        }
        entryNames.add(entryName);
        entryCount += 1;
        if (entryCount > PLUGIN_ZIP_LIMITS.entries) throw new Error("ZIP 文件条目超过 2000 项限制");
        if ((entry.generalPurposeBitFlag & 1) !== 0) throw new Error("不支持加密 ZIP");
        const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if ((unixMode & 0xf000) === 0xa000) throw new Error(`ZIP 不允许包含符号链接: ${entry.fileName}`);
        if (entry.uncompressedSize > PLUGIN_ZIP_LIMITS.entryBytes) {
          throw new Error(`ZIP 单文件解压后超过 50 MiB: ${entry.fileName}`);
        }
        expandedBytes += entry.uncompressedSize;
        if (expandedBytes > PLUGIN_ZIP_LIMITS.expandedBytes) throw new Error("ZIP 解压总量超过 200 MiB 限制");
        if (
          entry.uncompressedSize > 1024 * 1024
          && (entry.compressedSize === 0
            || entry.uncompressedSize / entry.compressedSize > PLUGIN_ZIP_LIMITS.compressionRatio)
        ) {
          throw new Error(`ZIP 条目压缩比异常: ${entry.fileName}`);
        }
      },
    });
    await assertNoLinks(stagingDir);
    const pluginDir = await locatePluginDirectory(stagingDir);
    const inspected = inspectPluginDir(pluginDir);
    if (!inspected.manifest) throw new Error(inspected.error ?? "插件 manifest 校验失败");
    const expected = opts.expectedIdentity;
    if (
      expected
      && (inspected.manifest.id !== expected.id || inspected.manifest.version !== expected.version)
    ) {
      throw new Error(
        `插件包与市场登记信息不符: 期望 ${expected.id}@${expected.version}，`
        + `实际 ${inspected.manifest.id}@${inspected.manifest.version}`,
      );
    }
    return { stagingDir, pluginDir, manifest: inspected.manifest };
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

export async function discardPreparedPlugin(prepared: PreparedPluginZip): Promise<void> {
  await rm(prepared.stagingDir, { recursive: true, force: true });
}

export interface CommitPreparedPluginOptions {
  /** 市场安装时传入：目录提交成功前先落来源记录，提交失败则一并回滚清除。 */
  marketOrigin?: { registryId: string };
}

export async function commitPreparedPlugin(
  prepared: PreparedPluginZip,
  userPluginRoot: string,
  replace: boolean,
  opts: CommitPreparedPluginOptions = {},
): Promise<string> {
  const destination = path.join(userPluginRoot, prepared.manifest.id);
  const backupRoot = path.join(path.dirname(userPluginRoot), "plugin-install-backups");
  const backup = path.join(backupRoot, `${prepared.manifest.id}-${randomUUID()}`);
  const destinationExists = existsSync(destination);
  if (destinationExists && !replace) throw new Error(`插件已存在: ${prepared.manifest.id}`);

  let backedUp = false;
  // 替换场景下先留底旧来源记录，提交失败时原样恢复，避免旧插件丢失市场身份
  const previousMetadata = opts.marketOrigin
    ? readHostMetadataSync(userPluginRoot, prepared.manifest.id)
    : undefined;
  try {
    if (opts.marketOrigin) {
      await writeHostMetadata(userPluginRoot, prepared.manifest.id, {
        origin: "market",
        registryId: opts.marketOrigin.registryId,
        installedVersion: prepared.manifest.version,
        installedAt: new Date().toISOString(),
      });
    }
    if (destinationExists) {
      await mkdir(backupRoot, { recursive: true });
      await rename(destination, backup);
      backedUp = true;
    }
    await rename(prepared.pluginDir, destination);
  } catch (error) {
    if (backedUp && !existsSync(destination)) await rename(backup, destination);
    if (opts.marketOrigin) {
      if (previousMetadata) {
        await writeHostMetadata(userPluginRoot, prepared.manifest.id, previousMetadata);
      } else {
        await removeHostMetadata(userPluginRoot, prepared.manifest.id);
      }
    }
    throw error;
  } finally {
    await rm(prepared.stagingDir, { recursive: true, force: true });
  }
  if (backedUp) {
    try {
      await rm(backup, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[plugins] 已安装 ${prepared.manifest.id}，但旧版本备份清理失败:`, error);
    }
  }
  return destination;
}
