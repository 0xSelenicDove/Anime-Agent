import type { AgentExecutionMode, CyreneRunOptions } from "../orchestrator/cyrene-agent";
import type { ChannelToolSandbox } from "./settings-store";
import type { ChannelChatType, ChannelId } from "./types";

export interface ChannelAgentPolicy {
  executionMode: AgentExecutionMode;
  exposeTools: boolean;
  includeInteractiveTools: boolean;
  permissionMode: NonNullable<CyreneRunOptions["permissionMode"]>;
}

export function resolveChannelAgentPolicy(
  toolSandbox: ChannelToolSandbox,
  context?: { channel?: ChannelId; chatType?: ChannelChatType },
): ChannelAgentPolicy {
  // 群聊 / 服务器频道（QQ NapCat、QQ 官方机器人、Discord 服务器同样处理）：
  // 共享上下文，可能有陌生人在场，强制纯 Chat 模式、禁工具
  if (
    (context?.channel === "qq" || context?.channel === "qqbot" || context?.channel === "discord")
    && context.chatType === "group"
  ) {
    return {
      executionMode: "chat",
      exposeTools: false,
      includeInteractiveTools: false,
      permissionMode: "normal",
    };
  }
  if (toolSandbox === "off") {
    return {
      executionMode: "chat",
      exposeTools: false,
      includeInteractiveTools: false,
      permissionMode: "normal",
    };
  }
  return {
    executionMode: "work",
    exposeTools: true,
    includeInteractiveTools: false,
    permissionMode: "allow_all",
  };
}

/**
 * 在 buildOptions 之后再次收紧策略，避免 Chat 工具开关已把工具目录写入
 * capabilities/toolSystemContent 时，QQ 群聊仍看到或意外启用这些工具。
 */
export function enforceChannelAgentPolicy(
  options: CyreneRunOptions,
  policy: ChannelAgentPolicy,
): void {
  options.harnessInteractiveTools = policy.includeInteractiveTools;
  options.permissionMode = policy.permissionMode;
  if (policy.exposeTools) return;
  options.tools = [];
  options.toolSystemContent = "";
  options.skillLayerContent = "";
  if (options.capabilities) {
    options.capabilities = {
      ...options.capabilities,
      tools: [],
      toolIds: new Set<string>(),
    };
  }
}
