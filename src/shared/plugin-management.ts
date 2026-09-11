export type PluginRuntimeStatus =
  | "disabled"
  | "starting"
  | "running"
  | "stopping"
  | "failed";

export interface PluginListEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  entry: string;
  apiVersion: number;
  source: "builtin" | "user";
  /** 用户插件来源：market 表示经插件市场安装（宿主安装记录可查），local 表示本地 ZIP 导入 */
  origin?: "local" | "market";
  path: string;
  defaultEnabled: boolean;
  configuredEnabled: boolean;
  enabled: boolean;
  status: PluginRuntimeStatus;
  error?: string;
  hasUnregister: boolean;
  canOpen: boolean;
  /** Icon as a data URL when the plugin provides a valid image file. */
  icon?: string;
}

export interface PluginScanIssue {
  root: string;
  path?: string;
  source: "builtin" | "user";
  message: string;
}

export interface PluginOverview {
  plugins: PluginListEntry[];
  issues: PluginScanIssue[];
}

/** 插件市场条目（主进程校验 registry 后下发给渲染端的展示数据，不含 zip 地址与哈希） */
export interface MarketPluginEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  downloads: number;
  homepage?: string;
}

export interface MarketListResult {
  ok: boolean;
  error?: string;
  plugins: MarketPluginEntry[];
}

export type MarketInstallResult =
  | { ok: true; plugin: { id: string; name: string; version: string }; overview?: PluginOverview }
  | { ok: false; error: string };

export interface PluginManagementApi {
  list(): Promise<PluginOverview | PluginListEntry[]>;
  setEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }>;
  open(id: string): Promise<{ ok: boolean; error?: string }>;
  rescan(): Promise<PluginOverview>;
  importZip(): Promise<{
    ok: boolean;
    canceled?: boolean;
    error?: string;
    plugin?: { id: string; name: string; version: string };
    overview?: PluginOverview;
  }>;
  uninstall(id: string): Promise<{ ok: boolean; error?: string; overview?: PluginOverview }>;
  marketList(): Promise<MarketListResult>;
  marketInstall(id: string): Promise<MarketInstallResult>;
}
