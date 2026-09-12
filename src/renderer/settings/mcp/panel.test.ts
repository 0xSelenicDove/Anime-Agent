import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// mcp/panel.ts 是副作用导入（模块加载即绑定事件），直接 import 会触发 settings.ts 循环依赖。
// 这里用文件内容验证模式（与 custom-endpoint-markup.test.ts 一致），
// 验证 MCP 面板的关键交互代码、模态框内容、事件绑定完整性。

const mcpSource = fs.readFileSync(
  fileURLToPath(new URL("./panel.ts", import.meta.url)),
  "utf8",
);
const settingsSource = fs.readFileSync(
  fileURLToPath(new URL("../settings.ts", import.meta.url)),
  "utf8",
);
const modalSource = fs.readFileSync(
  fileURLToPath(new URL("../shared/modal.ts", import.meta.url)),
  "utf8",
);
const html = fs.readFileSync(
  fileURLToPath(new URL("../index.html", import.meta.url)),
  "utf8",
);

describe("MCP Server 管理 UI - 事件绑定", () => {
  it("绑定了 pluginAddBtn 的 click 事件用于添加 MCP Server", () => {
    expect(mcpSource).toContain('pluginAddBtn?.addEventListener("click"');
  });

  it("绑定了 customEndpointGuideBtn 的 click 事件用于显示接入说明", () => {
    expect(mcpSource).toContain('customEndpointGuideBtn?.addEventListener("click"');
  });

  it("presetCards 切换厂商事件绑定在 settings.ts 中", () => {
    expect(settingsSource).toContain('presetCards?.addEventListener("click"');
  });

  it("customEndpointControls 云端/本地模式切换事件绑定在 settings.ts 中", () => {
    expect(settingsSource).toContain('customEndpointControls?.addEventListener("click"');
  });

  it("clearChatHistoryBtn 清空聊天事件绑定在 settings.ts 中", () => {
    expect(settingsSource).toContain('clearChatHistoryBtn.addEventListener("click"');
  });
});

describe("MCP Server 管理 UI - 添加流程", () => {
  it("第一步用 showInputModal 收集启动命令", () => {
    expect(mcpSource).toContain('showInputModal');
    expect(mcpSource).toContain('t("mcp-panel.3")');
    expect(mcpSource).toContain('t("mcp-panel.4")');
  });

  it("第二步用 showInputModal 收集 Server 名称", () => {
    expect(mcpSource).toContain('t("mcp-panel.5")');
    expect(mcpSource).toContain('t("mcp-panel.6")');
  });

  it("空命令时提前返回不调用 IPC", () => {
    expect(mcpSource).toContain('用户取消或命令为空');
  });

  it("调用 window.settings.addMcpServer IPC 传入 stdio transport", () => {
    expect(mcpSource).toContain('window.settings?.addMcpServer');
    expect(mcpSource).toContain('transport: "stdio"');
  });

  it("成功时显示工具数量，失败时显示错误信息", () => {
    expect(mcpSource).toContain('t("mcp-panel.11")');
    expect(mcpSource).toContain('t("mcp-panel.12")');
    expect(mcpSource).toContain('t("mcp-panel.13")');
    expect(mcpSource).toContain('t("mcp-panel.9")');
  });
});

describe("自定义端点接入说明模态框 - 内容完整性", () => {
  it("包含官方云端模型说明段落", () => {
    expect(mcpSource).toContain('t("mcp-panel.19")');
    expect(mcpSource).toContain('t("mcp-panel.20")');
  });

  it("包含自定义端点高级说明段落", () => {
    expect(mcpSource).toContain('t("mcp-panel.22")');
    expect(mcpSource).toContain('t("mcp-panel.23")');
    expect(mcpSource).toContain('t("mcp-panel.24")');
  });

  it("包含不支持边界警告", () => {
    expect(mcpSource).toContain('t("mcp-panel.25")');
    expect(mcpSource).toContain('t("mcp-panel.26")');
  });

  it("包含 API Key 安全说明", () => {
    expect(mcpSource).toContain('t("mcp-panel.30")');
  });

  it("包含测试连接建议", () => {
    expect(mcpSource).toContain('t("mcp-panel.28")');
    expect(mcpSource).toContain('t("mcp-panel.29")');
  });

  it("包含三个 FAQ 折叠项", () => {
    expect(mcpSource).toContain('t("mcp-panel.32")');
    expect(mcpSource).toContain('t("mcp-panel.34")');
    expect(mcpSource).toContain('t("mcp-panel.36")');
  });

  it("点击接入说明按钮时调用 showHtmlModal", () => {
    expect(mcpSource).toContain("showHtmlModal");
    expect(mcpSource).toContain('t("mcp-panel.38")');
    expect(mcpSource).toContain("CUSTOM_ENDPOINT_GUIDE_BODY");
  });
});

describe("模态框 overlay 交互结构", () => {
  it("showHtmlModal 使用独立的 cyHtmlOverlay 避免与 showModal 冲突", () => {
    expect(modalSource).toContain("cyHtmlOverlay");
    expect(modalSource).toContain("cy-html-modal-overlay");
    expect(modalSource).toContain("cy-html-modal");
  });

  it("showHtmlModal 创建包含 body 和确认按钮的 dialog 结构", () => {
    expect(modalSource).toContain('id="cy-html-modal-body"');
    expect(modalSource).toContain('id="cy-html-modal-confirm"');
    expect(modalSource).toContain('role="dialog"');
    expect(modalSource).toContain('aria-modal="true"');
  });

  it("showHtmlModal 确认后隐藏 overlay 并 resolve", () => {
    expect(modalSource).toMatch(/showHtmlModal[\s\S]*classList\.add\("is-hidden"\)/);
    expect(modalSource).toMatch(/showHtmlModal[\s\S]*resolve\(\)/);
  });

  it("showInputModal 支持回车确认和 Esc 取消", () => {
    expect(modalSource).toContain('"Enter"');
    expect(modalSource).toContain('"Escape"');
  });

  it("showModal 返回 Promise<boolean> 供确认/取消判断", () => {
    expect(modalSource).toMatch(/showModal[\s\S]*resolve\(result\)/);
    expect(modalSource).toContain("cleanup(false)");
    expect(modalSource).toContain("cleanup(true)");
  });
});

describe("HTML 元素存在性", () => {
  it("index.html 包含 plugin-add-btn 按钮", () => {
    expect(html).toContain('class="plugin-add-btn"');
  });

  it("index.html 包含 custom-endpoint-guide-btn 按钮", () => {
    expect(html).toContain('id="custom-endpoint-guide-btn"');
  });

  it("index.html 包含 custom-endpoint-controls 容器", () => {
    expect(html).toContain('id="custom-endpoint-controls"');
  });
});
