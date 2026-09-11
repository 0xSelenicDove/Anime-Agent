/**
 * 插件版本号工具。
 * 插件版本只接受三段数字（主.次.修订），不允许前导零、预发布号和 build 元数据，
 * 比较规则即逐段数字比较，避免各处自行实现字符串比较产生歧义。
 */

const PLUGIN_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** 判断字符串是否为合法的插件版本号（如 "0.1.0"、"1.10.3"） */
export function isValidPluginVersion(v: string): boolean {
  return typeof v === "string" && PLUGIN_VERSION_PATTERN.test(v.trim());
}

/**
 * 判断 candidate 是否严格高于 baseline。
 * 两个版本都必须合法；任一非法直接返回 false（调用方应先校验合法性）。
 */
export function isNewerVersion(candidate: string, baseline: string): boolean {
  if (!isValidPluginVersion(candidate) || !isValidPluginVersion(baseline)) {
    return false;
  }
  const parse = (v: string): [number, number, number] => {
    const [major, minor, patch] = v.trim().split(".").map(Number);
    return [major, minor, patch];
  };
  const a = parse(candidate);
  const b = parse(baseline);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}