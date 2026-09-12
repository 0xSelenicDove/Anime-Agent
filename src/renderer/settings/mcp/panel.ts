import { t } from "../i18n";
// MCP Server 管理 UI：添加/删除/启停 MCP Server，自定义端点接入说明
// 从 settings.ts 抽离。依赖 shared/modal + shared/parse + plugins/dom + api/dom。
// 副作用导入：模块加载时执行事件绑定 + 接入说明渲染。

import { showModal, showHtmlModal, showInputModal } from "../shared/modal";
import { parseCommandLine } from "../shared/parse";
import { pluginAddBtn } from "../plugins/dom";
import { customEndpointGuideBtn } from "../api/dom";

// ── MCP Server 管理 UI ──────────────────────────────────────
console.log("[settings] plugin-add-btn 查询结果:", pluginAddBtn ? t("mcp-panel.1") : t("mcp-panel.2"));


pluginAddBtn?.addEventListener("click", async () => {
  console.log("[settings] ＋ 按钮被点击，弹出输入框…");
  const command = await showInputModal({
    title: t("mcp-panel.3"),
    message: t("mcp-panel.4"),
    placeholder: "node path\\to\\server.js --flag",
    icon: "🧩",
  });
  if (!command || !command.trim()) {
    console.log("[settings] 用户取消或命令为空");
    return;
  }

  const nameInput = await showInputModal({
    title: t("mcp-panel.5"),
    message: t("mcp-panel.6"),
    placeholder: t("mcp-panel.7"),
    icon: "🏷️",
  });
  const name = (nameInput && nameInput.trim()) || t("mcp-panel.8");
  const serverId = "mcp-" + Date.now();
  const parsed = parseCommandLine(command.trim());
  if (!parsed.command) {
    await showModal({ title: t("mcp-panel.9"), message: t("mcp-panel.10"), icon: "⚠️" });
    return;
  }

  console.log("[settings] 添加 MCP server:", name, serverId, command.trim());

  try {
    const result = await window.settings?.addMcpServer?.({
      id: serverId,
      name: name,
      transport: "stdio",
      command: parsed.command,
      args: parsed.args,
    });

    if (result?.ok) {
      console.log("[settings] MCP server 添加成功，工具数:", result.toolIds?.length);
      await showModal({
        title: t("mcp-panel.11"),
        message: '"' + name + t("mcp-panel.12") + (result.toolIds?.length || 0) + t("mcp-panel.13"),
        icon: "✅",
      });
    } else {
      console.error("[settings] MCP server 添加失败:", result?.error);
      await showModal({
        title: t("mcp-panel.14"),
        message: (result?.error || t("mcp-panel.15")) + t("mcp-panel.16"),
        icon: "⚠️",
      });
    }
  } catch (err) {
    console.error("[settings] MCP server 添加异常:", err);
    await showModal({
      title: t("mcp-panel.17"),
      message: t("mcp-panel.18"),
      icon: "⚠️",
    });
  }
});

export const CUSTOM_ENDPOINT_GUIDE_BODY = [
  '<section class="custom-endpoint-guide-section">',
  `  <h4>${t("mcp-panel.19")}</h4>`,
  `  <p>${t("mcp-panel.20")}</p>`,
  `  <p class="custom-endpoint-guide-note">${t("mcp-panel.21")}</p>`,
  '</section>',
  '<section class="custom-endpoint-guide-section">',
  `  <h4>${t("mcp-panel.22")}<span>${t("mcp-panel.23")}</span></h4>`,
  `  <p>${t("mcp-panel.24")}</p>`,
  `  <div class="custom-endpoint-guide-warning"><strong>${t("mcp-panel.25")}</strong>${t("mcp-panel.26")}</div>`,
  `  <p>${t("mcp-panel.27")}<strong>${t("mcp-panel.28")}</strong>${t("mcp-panel.29")}</p>`,
  `  <p class="custom-endpoint-guide-security">${t("mcp-panel.30")}</p>`,
  '</section>',
  '<section class="custom-endpoint-guide-section custom-endpoint-faq">',
  `  <h4>${t("mcp-panel.31")}</h4>`,
  '  <details>',
  `    <summary>${t("mcp-panel.32")}</summary>`,
  `    <p>${t("mcp-panel.33")}</p>`,
  '  </details>',
  '  <details>',
  `    <summary>${t("mcp-panel.34")}</summary>`,
  `    <p>${t("mcp-panel.35")}</p>`,
  '  </details>',
  '  <details>',
  `    <summary>${t("mcp-panel.36")}</summary>`,
  `    <p>${t("mcp-panel.37")}</p>`,
  '  </details>',
  '</section>',
].join("\n");

customEndpointGuideBtn?.addEventListener("click", () => {
  void showHtmlModal({
    title: t("mcp-panel.38"),
    icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M12 10.5V17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="7.25" r="1.1" fill="currentColor"/></svg>',
    htmlBody: CUSTOM_ENDPOINT_GUIDE_BODY,
  });
});