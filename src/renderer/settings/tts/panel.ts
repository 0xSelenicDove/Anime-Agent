import { t } from "../i18n";
// TTS 设置面板交互：配置加载/保存、引擎切换、语速/音量滑块、
// MiniMax/GPT-SoVITS/自定义云端/MiMo/Mossland 测试发音、音色快速复刻
// 从 settings.ts 抽离。依赖 ttsState + TTS_FIELD_MAP + shared modal/utils。
// 副作用导入：模块加载时执行事件绑定 + 初始加载配置。

import { ttsState } from "./state";
import { TTS_FIELD_MAP, TTS_PROVIDER_FIELDS } from "./field-map";
import { DEFAULT_MOSSLAND_TTS_MODEL, type MosslandSyncFormat } from "../../../shared/tts-types";
import { createUniqueMiniMaxVoiceId, validateMiniMaxVoiceId } from "../../../shared/minimax-voice";
import { showHtmlModal } from "../shared/modal";
import { safeGet } from "../shared/utils";

/* ============================================================
   🎙️ TTS 设置面板交互
   - 配置加载/保存（存 general settings，跟其他设置一起）
   - 引擎选择卡片切换：选中哪个展开哪个配置表单
   - 语速/音量滑块实时显示数值 + 自动保存
   - MiniMax 测试发音：调 synthesize 合成固定文本并播放
   - 音色快速复刻：选文件→上传→训练→自动填入 voice_id
   ============================================================ */

interface TtsApi {
  upload: (apiKey: string, filePath: string, purpose: "voice_clone" | "prompt_audio") => Promise<{ file_id: string }>;
  pickAudio: () => Promise<string | null>;
  clone: (payload: {
    apiKey: string; fileId: string; voiceId: string;
    promptAudioId?: string; promptText?: string;
    text: string; model?: string;
  }) => Promise<{ voiceId: string; audioDemo?: string }>;
  synthesize: (payload: {
    apiKey: string; voiceId: string; text: string;
    speed?: number; volume?: number; pitch?: number;
    model?: string; format?: "mp3" | "wav" | "pcm";
  }) => Promise<string>; // base64 音频
  // GPT-SoVITS（返回 base64 + cacheKey + cached + format）
  synthesizeGptsovits: (payload: {
    baseUrl: string; refAudioPath: string; promptText: string; text: string;
    speed?: number; format?: "wav" | "mp3";
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean; format: "wav" | "mp3" }>;
  synthesizeCachedGptsovits: (payload: {
    baseUrl: string; refAudioPath: string; promptText: string; text: string;
    speed?: number; format?: "wav" | "mp3";
    expectedCacheKey?: string;
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean; format: "wav" | "mp3" }>;
  // 自定义云端（返回 base64 + cacheKey + cached + format）
  synthesizeCustomCloud: (payload: {
    endpointUrl: string; apiKey?: string; voiceId?: string; text: string;
    speed?: number; volume?: number; format?: "wav" | "mp3"; timeoutMs?: number;
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean; format: "wav" | "mp3" }>;
  synthesizeCachedCustomCloud: (payload: {
    endpointUrl: string; apiKey?: string; voiceId?: string; text: string;
    speed?: number; volume?: number; format?: "wav" | "mp3"; timeoutMs?: number;
    expectedCacheKey?: string;
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean; format: "wav" | "mp3" }>;
  // 小米 MiMo（返回 base64 + cacheKey + cached + format）
  synthesizeMimo: (payload: {
    apiKey: string; voiceAudioPath?: string; text: string; stylePrompt?: string;
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean; format: "wav" }>;
  synthesizeCachedMimo: (payload: {
    apiKey: string; voiceAudioPath?: string; text: string; stylePrompt?: string;
    expectedCacheKey?: string;
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean; format: "wav" }>;
  // Mossland（api.mosi.cn）
  synthesizeMossland: (payload: {
    apiKey: string; voiceId: string; text: string;
    model?: string; format?: MosslandSyncFormat;
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean; format: MosslandSyncFormat }>;
  synthesizeCachedMossland: (payload: {
    apiKey: string; voiceId: string; text: string;
    model?: string; format?: MosslandSyncFormat;
    expectedCacheKey?: string;
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean; format: MosslandSyncFormat }>;
  cloneMossland: (payload: {
    apiKey: string; filePath: string; name?: string; description?: string;
  }) => Promise<{ voiceId: string; name?: string; createdAt?: number }>;
  listMosslandVoices: (payload: {
    apiKey: string; limit?: number; offset?: number; after?: string; status?: string;
  }) => Promise<{
    voices: Array<{ id: string; name: string; createdAt: number }>;
    hasMore: boolean;
    nextCursor?: string;
  }>;
  pickAudioFile: () => Promise<string | null>;
  saveSettings: (tts: Record<string, unknown>) => Promise<unknown>;
  loadSettings: () => Promise<Record<string, unknown>>;
}

declare global {
  interface Window {
    tts?: TtsApi;
  }
}

const TTS_TEST_TEXT = t("tts-panel.1");

// 获取 DOM 元素的辅助函数
function ttsEl(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}

// 切分模式按钮组：按 data-value 同步 is-active 与 aria-pressed
function applySplitModeSelection(mode: "sentence" | "paragraph"): void {
  const group = document.getElementById("tts-early-read-split-mode");
  if (!group) return;
  group.querySelectorAll<HTMLButtonElement>(".option-block").forEach((button) => {
    const active = button.dataset.value === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

// 切分模式按钮组：整体禁用/启用
function setSplitModeDisabled(disabled: boolean): void {
  const group = document.getElementById("tts-early-read-split-mode");
  if (!group) return;
  group.querySelectorAll<HTMLButtonElement>(".option-block").forEach((button) => {
    button.disabled = disabled;
  });
}

// 当前加载的 TTS 配置（内存缓存，改一个字段就存一次）

// 加载配置并填充表单
async function loadTtsConfig(): Promise<void> {
  if (!window.tts) return;
  try {
    ttsState.config = await window.tts.loadSettings() as Record<string, unknown>;
  } catch (err) {
    console.warn("[TTS] 加载配置失败:", err);
    return;
  }

  // 引擎选择
  const engine = String(ttsState.config.ttsEngine || "off");
  document.querySelectorAll<HTMLButtonElement>(".tts-engine").forEach((btn) => {
    const isActive = btn.dataset.engine === engine;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-checked", isActive ? "true" : "false");
  });
  document.querySelectorAll<HTMLElement>(".tts-config").forEach((el) => { el.hidden = true; });
  if (engine !== "off") {
    const config = document.getElementById("tts-config-" + engine);
    if (config) config.hidden = false;
  }

  // 播放交互
  ttsEl("tts-auto-read").checked = Boolean(ttsState.config.ttsAutoRead);
  ttsEl("tts-speed").value = String(ttsState.config.ttsSpeed ?? 1);
  ttsEl("tts-volume").value = String(ttsState.config.ttsVolume ?? 1);
  // 自动朗读文本切分开关 + 切分模式按钮组（关闭时置灰按钮组）
  const splitEnabled = ttsState.config.ttsEarlyReadSplitEnabled !== false;
  ttsEl("tts-early-read-split-enabled").checked = splitEnabled;
  applySplitModeSelection(ttsState.config.ttsEarlyReadSplitMode === "paragraph" ? "paragraph" : "sentence");
  setSplitModeDisabled(!splitEnabled);
  updateTtsSliderLabels();

  // MiniMax
  ttsEl("tts-minimax-key").value = String(ttsState.config.ttsMinimaxKey ?? "");
  ttsEl("tts-minimax-voice").value = String(ttsState.config.ttsMinimaxVoiceId ?? "");
  (ttsEl("tts-minimax-model") as HTMLSelectElement).value =
    ttsState.config.ttsMinimaxModel === "speech-2.8-hd" ? "speech-2.8-hd" : "speech-2.8-turbo";
  ttsEl("tts-streaming").checked = ttsState.config.ttsStreaming !== false;
  ttsEl("tts-minimax-vocal-enhance").checked = ttsState.config.ttsMinimaxVocalEnhance !== false;

  // GPT-SoVITS
  ttsEl("tts-gptsovits-url").value = String(ttsState.config.ttsGptsovitsBaseUrl ?? "http://localhost:9880");
  ttsEl("tts-gptsovits-ref-audio").value = String(ttsState.config.ttsGptsovitsRefAudioPath ?? "");
  ttsEl("tts-gptsovits-prompt-text").value = String(ttsState.config.ttsGptsovitsPromptText ?? "");
  (ttsEl("tts-gptsovits-format") as HTMLSelectElement).value =
    ttsState.config.ttsGptsovitsFormat === "mp3" ? "mp3" : "wav";
  ttsEl("tts-gptsovits-timeout").value = String(ttsState.config.ttsGptsovitsTimeoutMs ?? 180000);

  // 自定义云端
  ttsEl("tts-custom-cloud-url").value = String(ttsState.config.ttsCustomCloudEndpointUrl ?? "");
  ttsEl("tts-custom-cloud-key").value = String(ttsState.config.ttsCustomCloudApiKey ?? "");
  ttsEl("tts-custom-cloud-voice").value = String(ttsState.config.ttsCustomCloudVoiceId ?? "");
  (ttsEl("tts-custom-cloud-format") as HTMLSelectElement).value =
    ttsState.config.ttsCustomCloudFormat === "wav" ? "wav" : "mp3";
  ttsEl("tts-custom-cloud-timeout").value = String(ttsState.config.ttsCustomCloudTimeoutMs ?? 30000);

  // 小米 MiMo
  ttsEl("tts-mimo-key").value = String(ttsState.config.ttsMimoKey ?? "");
  ttsEl("tts-mimo-voice-audio").value = String(ttsState.config.ttsMimoVoiceAudioPath ?? "");
  ttsEl("tts-mimo-style").value = String(ttsState.config.ttsMimoStylePrompt ?? t("tts-panel.2"));

  // Mossland（UI 骨架已就位，IPC 第二步接通；字段值已写入 ttsState.config 以便保存）
  ttsEl("tts-mossland-key").value = String(ttsState.config.ttsMosslandKey ?? "");
  ttsEl("tts-mossland-voice").value = String(ttsState.config.ttsMosslandVoiceId ?? "");
  const mosslandModelSelect = ttsEl("tts-mossland-model") as HTMLSelectElement;
  const rawMosslandModel = String(ttsState.config.ttsMosslandModel ?? "").trim();
  const savedMosslandModel = rawMosslandModel && rawMosslandModel !== "moss-tts"
    ? rawMosslandModel
    : DEFAULT_MOSSLAND_TTS_MODEL;
  if (![...mosslandModelSelect.options].some((option) => option.value === savedMosslandModel)) {
    const savedOption = document.createElement("option");
    savedOption.value = savedMosslandModel;
    savedOption.textContent = t("tts-panel.103", { model: savedMosslandModel });
    mosslandModelSelect.appendChild(savedOption);
  }
  mosslandModelSelect.value = savedMosslandModel;
  ttsEl("tts-mossland-text").value = String(ttsState.config.ttsMosslandTestText ?? TTS_TEST_TEXT);
  (ttsEl("tts-mossland-format") as HTMLSelectElement).value =
    ttsState.config.ttsMosslandFormat === "wav" ? "wav" : "mp3";
  ttsState.config.ttsMosslandKey       = String(ttsEl("tts-mossland-key").value);
  ttsState.config.ttsMosslandVoiceId   = String(ttsEl("tts-mossland-voice").value);
  ttsState.config.ttsMosslandModel     = (ttsEl("tts-mossland-model") as HTMLSelectElement).value;
  ttsState.config.ttsMosslandTestText  = String(ttsEl("tts-mossland-text").value);
  ttsState.config.ttsMosslandFormat    = (ttsEl("tts-mossland-format") as HTMLSelectElement).value;

  // 加载完成后清掉所有 Provider 的脏态（按钮隐藏，status 清空）
  for (const provider of Object.keys(TTS_PROVIDER_FIELDS)) {
    const ui = ttsProviderUi[provider];
    if (!ui) continue;
    ui.btn.classList.add("is-hidden");
    ui.status.textContent = "";
  }
}

function updateTtsSliderLabels(): void {
  const speedVal = document.getElementById("tts-speed-val");
  const volVal = document.getElementById("tts-volume-val");
  if (speedVal) speedVal.textContent = Number(ttsEl("tts-speed").value).toFixed(1) + "x";
  if (volVal) volVal.textContent = Math.round(Number(ttsEl("tts-volume").value) * 100) + "%";
}

// 保存单个 TTS 配置字段
async function saveTtsField(field: string, value: unknown): Promise<void> {
  if (!window.tts) return;
  ttsState.config[field] = value;
  try {
    await window.tts.saveSettings({ [field]: value });
  } catch (err) {
    console.warn("[TTS] 保存配置失败:", field, err);
  }
}

// 播放 base64 音频。format 决定 Blob MIME（minimax 默认 mp3，gptsovits 默认 wav）
function playTtsAudio(base64: string, format: "wav" | "mp3" = "mp3"): void {
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const mime = format === "wav" ? "audio/wav" : "audio/mp3";
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.play().catch((err) => console.warn("[TTS] 播放失败:", err));
    audio.onended = () => URL.revokeObjectURL(url);
  } catch (err) {
    console.warn("[TTS] 音频解码失败:", err);
  }
}

// 引擎选择切换
// 只匹配带 data-engine 的按钮（即 TTS 厂商按钮）——主动开口档位按钮虽然
// 共用 .tts-engine 视觉 class，但只有 data-mode 没有 data-engine，
// 用属性选择器避免误触把它们当作 TTS 厂商处理。
document.querySelectorAll<HTMLButtonElement>("[data-engine]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const engine = btn.dataset.engine || "off";
    document.querySelectorAll<HTMLButtonElement>("[data-engine]").forEach((b) => {
      b.classList.remove("is-active");
      b.setAttribute("aria-checked", "false");
    });
    btn.classList.add("is-active");
    btn.setAttribute("aria-checked", "true");
    document.querySelectorAll<HTMLElement>(".tts-config").forEach((el) => { el.hidden = true; });
    if (engine !== "off") {
      const config = document.getElementById("tts-config-" + engine);
      if (config) config.hidden = false;
    }
    void saveTtsField("ttsEngine", engine);
  });
});

// 自动朗读开关
ttsEl("tts-auto-read").addEventListener("change", () => {
  void saveTtsField("ttsAutoRead", ttsEl("tts-auto-read").checked);
});

// 自动朗读文本切分开关（关闭时禁用切分模式按钮组并立即保存）
ttsEl("tts-early-read-split-enabled").addEventListener("change", () => {
  const enabled = ttsEl("tts-early-read-split-enabled").checked;
  setSplitModeDisabled(!enabled);
  void saveTtsField("ttsEarlyReadSplitEnabled", enabled);
});

// 语速/音量滑块（change 时保存，input 时实时显示）
ttsEl("tts-speed").addEventListener("input", updateTtsSliderLabels);
ttsEl("tts-speed").addEventListener("change", () => saveTtsField("ttsSpeed", Number(ttsEl("tts-speed").value)));
ttsEl("tts-volume").addEventListener("input", updateTtsSliderLabels);
ttsEl("tts-volume").addEventListener("change", () => saveTtsField("ttsVolume", Number(ttsEl("tts-volume").value)));

// 自动朗读文本切分模式（点击按钮即时保存并切换高亮）
const splitModeGroup = document.getElementById("tts-early-read-split-mode");
splitModeGroup?.querySelectorAll<HTMLButtonElement>(".option-block").forEach((button) => {
  button.addEventListener("click", () => {
    if (button.disabled) return;
    const mode = button.dataset.value === "paragraph" ? "paragraph" : "sentence";
    applySplitModeSelection(mode);
    void saveTtsField("ttsEarlyReadSplitMode", mode);
  });
});

// GPT-SoVITS 超时输入框（number，blur 时保存并做简单边界限制）
ttsEl("tts-gptsovits-timeout").addEventListener("change", () => {
  let value = Number(ttsEl("tts-gptsovits-timeout").value);
  if (!Number.isFinite(value) || value < 10000) value = 10000;
  if (value > 3600000) value = 3600000;
  ttsEl("tts-gptsovits-timeout").value = String(value);
  void saveTtsField("ttsGptsovitsTimeoutMs", value);
});

// ── TTS 文本输入框：按 Provider 分组 + 手动保存 ──
// 之前这里有 input/change 自动 saveTtsField（settings.ts:4270–4295），
// 但每次 input 都会触发 IPC，IME 组字过程会被打断，用户反馈"打着打着输入法被打断"。
// 现在改为：文本框只 mark dirty，真正保存只发生在用户点击 Provider 自己的"保存配置"按钮。
// switch / slider / select / 引擎选择 / Opener 档位仍然走立即保存（保持即时反馈）。

// Provider ID → { 保存按钮, 状态 div }
// 用 ttsEl() 安全获取：拿不到时返回 null，不让整个 settings.ts 初始化崩。
const ttsProviderUi: Record<string, { btn: HTMLButtonElement; status: HTMLElement } | null> = {
  minimax:        ttsEl("tts-minimax-save-btn") && safeGet("tts-minimax-save-status")
                    ? { btn: ttsEl("tts-minimax-save-btn"), status: safeGet("tts-minimax-save-status") as HTMLElement }
                    : null,
  gptsovits:      ttsEl("tts-gptsovits-save-btn") && safeGet("tts-gptsovits-save-status")
                    ? { btn: ttsEl("tts-gptsovits-save-btn"), status: safeGet("tts-gptsovits-save-status") as HTMLElement }
                    : null,
  "custom-cloud": ttsEl("tts-custom-cloud-save-btn") && safeGet("tts-custom-cloud-save-status")
                    ? { btn: ttsEl("tts-custom-cloud-save-btn"), status: safeGet("tts-custom-cloud-save-status") as HTMLElement }
                    : null,
  mimo:           ttsEl("tts-mimo-save-btn") && safeGet("tts-mimo-save-status")
                    ? { btn: ttsEl("tts-mimo-save-btn"), status: safeGet("tts-mimo-save-status") as HTMLElement }
                    : null,
  mossland:       ttsEl("tts-mossland-save-btn") && safeGet("tts-mossland-save-status")
                    ? { btn: ttsEl("tts-mossland-save-btn"), status: safeGet("tts-mossland-save-status") as HTMLElement }
                    : null,
};

// 输入框触发脏态：只显示按钮和"有未保存的更改"，不发 IPC
function markTtsProviderDirty(provider: string): void {
  const ui = ttsProviderUi[provider];
  if (!ui) return;
  ui.btn.classList.remove("is-hidden");
  ui.status.textContent = t("tts-panel.3");
  ui.status.className = "save-status";
}

for (const [provider, elIds] of Object.entries(TTS_PROVIDER_FIELDS)) {
  for (const elId of elIds) {
    const el = ttsEl(elId);
    el.addEventListener("input", () => markTtsProviderDirty(provider));
  }
}

// 保存某个 Provider 的所有文本配置
async function saveTtsProvider(provider: string): Promise<void> {
  const ui = ttsProviderUi[provider];
  if (!ui) return;
  const fields = TTS_PROVIDER_FIELDS[provider] ?? [];
  ui.btn.disabled = true;
  ui.status.textContent = t("tts-panel.4");
  ui.status.className = "save-status";
  try {
    const payload: Record<string, unknown> = {};
    for (const elId of fields) {
      const field = TTS_FIELD_MAP[elId];
      if (!field) continue;
      const el = ttsEl(elId);
      // 数字字段（timeout）转 Number；无效则跳过该字段但继续保存其他字段
      let value: unknown = el.value;
      if (elId === "tts-custom-cloud-timeout") {
        const num = Number(el.value);
        if (!Number.isFinite(num) || num <= 0) continue;
        value = num;
      }
      payload[field] = value;
      ttsState.config[field] = value;   // 同步内存中的 ttsState.config 缓存
    }
    if (Object.keys(payload).length === 0) {
      ui.status.textContent = t("tts-panel.5");
      ui.status.className = "save-status";
      return;
    }
    await window.tts!.saveSettings(payload);
    ui.status.textContent = t("tts-panel.6");
    ui.status.className = "save-status is-ok";
    ui.btn.classList.add("is-hidden");
    setTimeout(() => { ui.status.textContent = ""; }, 2000);
  } catch (e) {
    ui.status.textContent = t("tts-panel.7") + (e instanceof Error ? e.message : String(e));
    ui.status.className = "save-status is-error";
  } finally {
    ui.btn.disabled = false;
  }
}

// 注册点击 handler
for (const [provider, ui] of Object.entries(ttsProviderUi)) {
  ui?.btn.addEventListener("click", () => void saveTtsProvider(provider));
}

// GPT-SoVITS 格式选择（select，change 时直接保存）
(ttsEl("tts-gptsovits-format") as HTMLSelectElement).addEventListener("change", () => {
  void saveTtsField("ttsGptsovitsFormat", (ttsEl("tts-gptsovits-format") as HTMLSelectElement).value as "wav" | "mp3");
});

// 自定义云端格式选择
(ttsEl("tts-custom-cloud-format") as HTMLSelectElement).addEventListener("change", () => {
  void saveTtsField("ttsCustomCloudFormat", (ttsEl("tts-custom-cloud-format") as HTMLSelectElement).value as "wav" | "mp3");
});

// MiniMax 合成模型属于 select：切换即保存，不依赖 Provider 文本字段的“保存配置”按钮。
(ttsEl("tts-minimax-model") as HTMLSelectElement).addEventListener("change", () => {
  const value = (ttsEl("tts-minimax-model") as HTMLSelectElement).value;
  void saveTtsField("ttsMinimaxModel", value === "speech-2.8-hd" ? "speech-2.8-hd" : "speech-2.8-turbo");
});

// MiniMax 流式播放开关
ttsEl("tts-streaming").addEventListener("change", () => {
  void saveTtsField("ttsStreaming", ttsEl("tts-streaming").checked);
});

// MiniMax 语音增强开关
ttsEl("tts-minimax-vocal-enhance").addEventListener("change", () => {
  void saveTtsField("ttsMinimaxVocalEnhance", ttsEl("tts-minimax-vocal-enhance").checked);
});

// GPT-SoVITS 选择参考音频
document.getElementById("tts-gptsovits-ref-pick")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const filePath = await window.tts.pickAudioFile();
  if (filePath) {
    ttsEl("tts-gptsovits-ref-audio").value = filePath;
    void saveTtsField("ttsGptsovitsRefAudioPath", filePath);
  }
});

// GPT-SoVITS 测试发音
document.getElementById("tts-gptsovits-test")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const baseUrl = ttsEl("tts-gptsovits-url").value.trim();
  const refAudioPath = ttsEl("tts-gptsovits-ref-audio").value.trim();
  const promptText = ttsEl("tts-gptsovits-prompt-text").value.trim();
  const format = (ttsEl("tts-gptsovits-format") as HTMLSelectElement).value as "wav" | "mp3";
  if (!baseUrl) { window.alert(t("tts-panel.8")); return; }
  if (!refAudioPath) { window.alert(t("tts-panel.9")); return; }
  if (!promptText) { window.alert(t("tts-panel.10")); return; }

  const btn = document.getElementById("tts-gptsovits-test") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = t("tts-panel.11");
  try {
    const result = await window.tts.synthesizeGptsovits({
      baseUrl, refAudioPath, promptText, text: TTS_TEST_TEXT, format,
    });
    playTtsAudio(result.base64, result.format);
  } catch (err) {
    window.alert(t("tts-panel.12") + (err instanceof Error ? err.message : String(err)));
  } finally {
    btn.disabled = false;
    btn.textContent = t("tts-panel.13");
  }
});

// 小米 MiMo 选择昔涟克隆参考音频
document.getElementById("tts-mimo-voice-pick")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const filePath = await window.tts.pickAudioFile();
  if (filePath) {
    ttsEl("tts-mimo-voice-audio").value = filePath;
    void saveTtsField("ttsMimoVoiceAudioPath", filePath);
  }
});

// 自定义云端测试发音
document.getElementById("tts-custom-cloud-test")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const endpointUrl = ttsEl("tts-custom-cloud-url").value.trim();
  const apiKey = ttsEl("tts-custom-cloud-key").value.trim();
  const voiceId = ttsEl("tts-custom-cloud-voice").value.trim();
  const format = (ttsEl("tts-custom-cloud-format") as HTMLSelectElement).value as "wav" | "mp3";
  const timeoutMs = Number(ttsEl("tts-custom-cloud-timeout").value) || 30000;
  if (!endpointUrl) { window.alert(t("tts-panel.14")); return; }

  const btn = document.getElementById("tts-custom-cloud-test") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = t("tts-panel.15");
  try {
    const result = await window.tts.synthesizeCustomCloud({
      endpointUrl, apiKey, voiceId, text: TTS_TEST_TEXT,
      speed: Number(ttsEl("tts-speed").value),
      volume: Number(ttsEl("tts-volume").value),
      format,
      timeoutMs,
    });
    playTtsAudio(result.base64, result.format);
  } catch (err) {
    window.alert(t("tts-panel.16") + (err instanceof Error ? err.message : String(err)));
  } finally {
    btn.disabled = false;
    btn.textContent = t("tts-panel.17");
  }
});

// 小米 MiMo 测试发音
document.getElementById("tts-mimo-test")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const apiKey = ttsEl("tts-mimo-key").value.trim();
  const voiceAudioPath = ttsEl("tts-mimo-voice-audio").value.trim();
  const stylePrompt = ttsEl("tts-mimo-style").value.trim();
  if (!apiKey) { window.alert(t("tts-panel.18")); return; }
  if (!voiceAudioPath) { window.alert(t("tts-panel.19")); return; }

  const btn = document.getElementById("tts-mimo-test") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = t("tts-panel.20");
  try {
    const result = await window.tts.synthesizeMimo({
      apiKey, voiceAudioPath, stylePrompt, text: TTS_TEST_TEXT,
    });
    playTtsAudio(result.base64, result.format);
  } catch (err) {
    window.alert(t("tts-panel.21") + (err instanceof Error ? err.message : String(err)));
  } finally {
    btn.disabled = false;
    btn.textContent = t("tts-panel.22");
  }
});

// ── Mossland ──
// 当前为 UI 骨架：所有按钮触发"功能开发中"占位 modal，
// ── Mossland ──
// 第二步已接通：所有按钮走真实 IPC 调用，错误抛到 status / alert。
function setMosslandStatus(text: string, type: "ok" | "error" | "loading"): void {
  const el = document.getElementById("tts-mossland-clone-status");
  if (!el) return;
  el.textContent = text;
  el.className = "tts-clone-status" + (type ? " is-" + type : "");
}

function setMosslandListStatus(text: string, type: "ok" | "error" | "loading"): void {
  const el = document.getElementById("tts-mossland-list-voices-status");
  if (!el) return;
  el.textContent = text;
  el.className = "tts-clone-status" + (type ? " is-" + type : "");
}

/** 把拉到的 voices 列表渲染成 `<ul>`；每行有一个"使用此 voice"按钮，点击回填到 #tts-mossland-voice */
function renderMosslandVoiceList(voices: Array<{ id: string; name: string }>): void {
  const ul = document.getElementById("tts-mossland-voice-list");
  if (!ul) return;
  ul.replaceChildren();
  for (const v of voices) {
    const li = document.createElement("li");
    const idSpan = document.createElement("span");
    idSpan.className = "voice-id";
    idSpan.textContent = v.id;
    const nameSpan = document.createElement("span");
    nameSpan.className = "voice-name";
    nameSpan.textContent = v.name;
    const useBtn = document.createElement("button");
    useBtn.type = "button";
    useBtn.className = "voice-use";
    useBtn.textContent = t("tts-panel.23");
    useBtn.addEventListener("click", () => {
      ttsEl("tts-mossland-voice").value = v.id;
    });
    li.append(idSpan, nameSpan, useBtn);
    ul.appendChild(li);
  }
}

// 测试发音：走 window.tts.synthesizeMossland
document.getElementById("tts-mossland-test")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const apiKey = ttsEl("tts-mossland-key").value.trim();
  const voiceId = ttsEl("tts-mossland-voice").value.trim();
  const text = ttsEl("tts-mossland-text").value.trim();
  const model = (ttsEl("tts-mossland-model") as HTMLSelectElement).value;
  const format = (ttsEl("tts-mossland-format") as HTMLSelectElement).value as MosslandSyncFormat;
  if (!apiKey) { window.alert(t("tts-panel.24")); return; }
  if (!voiceId) { window.alert(t("tts-panel.25")); return; }
  if (!text) { window.alert(t("tts-panel.26")); return; }

  const btn = document.getElementById("tts-mossland-test") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = t("tts-panel.27");
  const statusEl = document.getElementById("tts-mossland-test-status");
  if (statusEl) { statusEl.textContent = t("tts-panel.28"); statusEl.className = "tts-clone-status is-loading"; }
  try {
    const result = await window.tts.synthesizeMossland({ apiKey, voiceId, text, model, format });
    playTtsAudio(result.base64, result.format);
    if (statusEl) {
      statusEl.textContent = t("tts-panel.29");
      statusEl.className = "tts-clone-status is-ok";
      setTimeout(() => { statusEl.textContent = ""; }, 2000);
    }
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = "❌ " + (err instanceof Error ? err.message : String(err));
      statusEl.className = "tts-clone-status is-error";
    } else {
      window.alert(t("tts-panel.30") + (err instanceof Error ? err.message : String(err)));
    }
  } finally {
    btn.disabled = false;
    btn.textContent = t("tts-panel.31");
  }
});


// 克隆子区块：选择文件（用现有 pickAudio）
document.getElementById("tts-mossland-clone-pick")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const filePath = await window.tts.pickAudio();
  if (filePath) ttsEl("tts-mossland-clone-file").value = filePath;
});

// 克隆子区块：开始上传（multipart）
document.getElementById("tts-mossland-clone-start")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const apiKey = ttsEl("tts-mossland-key").value.trim();
  const filePath = ttsEl("tts-mossland-clone-file").value.trim();
  const name = ttsEl("tts-mossland-clone-name").value.trim();
  const description = ttsEl("tts-mossland-clone-desc").value.trim();
  if (!apiKey) { window.alert(t("tts-panel.32")); return; }
  if (!filePath) { window.alert(t("tts-panel.33")); return; }

  setMosslandStatus(t("tts-panel.34"), "loading");
  try {
    const result = await window.tts.cloneMossland({
      apiKey, filePath,
      name: name || undefined,
      description: description || undefined,
    });
    // 自动填到上方「音色 ID」+ 同步写到 ttsState.config（让保存按钮 / chat 调度都能用）
    ttsEl("tts-mossland-voice").value = result.voiceId;
    void saveTtsField("ttsMosslandVoiceId", result.voiceId);
    setMosslandStatus(t("tts-panel.104", { id: result.voiceId }), "ok");
  } catch (err) {
    setMosslandStatus("❌ " + (err instanceof Error ? err.message : String(err)), "error");
  }
});

// 拉取音色列表：调 listMosslandVoices + 渲染
document.getElementById("tts-mossland-list-voices")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const apiKey = ttsEl("tts-mossland-key").value.trim();
  if (!apiKey) { window.alert(t("tts-panel.35")); return; }

  setMosslandListStatus(t("tts-panel.36"), "loading");
  try {
    const result = await window.tts.listMosslandVoices({ apiKey, limit: 150 });
    if (result.voices.length === 0) {
      setMosslandListStatus(t("tts-panel.37"), "error");
    } else {
      renderMosslandVoiceList(result.voices);
      const moreHint = result.hasMore ? t("tts-panel.38") : "";
      setMosslandListStatus(t("tts-panel.105", { count: result.voices.length, moreHint }), "ok");
    }
  } catch (err) {
    setMosslandListStatus("❌ " + (err instanceof Error ? err.message : String(err)), "error");
  }
});

// 克隆须知 modal（富文本，复用 showHtmlModal 复用 MiniMax 那套样式）
document.getElementById("tts-mossland-clone-info-btn")?.addEventListener("click", () => {
  void showHtmlModal({
    title: t("tts-panel.39"),
    icon: "ⓘ",
    htmlBody: [
      '<div class="tts-clone-spec-block">',
      `  <h4>${t("tts-panel.40")}</h4>`,
      `  <p>${t("tts-panel.41")}<code>voice_id</code>${t("tts-panel.42")}</p>`,
      '</div>',
      '<div class="tts-clone-spec-block">',
      '  <h4><svg class="tts-clone-spec-icon" width="18" height="18" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 44V4H31L40 14.5V44H8Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M32 14L26 16.9688V31.5" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="20.5" cy="31.5" r="5.5" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg> 参考音频 <code>audio_sample</code></h4>',
      '  <ul>',
      `    <li>${t("tts-panel.43")}<strong>multipart/form-data</strong>${t("tts-panel.44")}</li>`,
      `    <li>${t("tts-panel.45")}<code>audio_sample</code>${t("tts-panel.46")}</li>`,
      `    <li>${t("tts-panel.47")}<code>name</code>${t("tts-panel.48")}</li>`,
      `    <li>${t("tts-panel.49")}<code>description</code>${t("tts-panel.50")}</li>`,
      `    <li>${t("tts-panel.51")}</li>`,
      '  </ul>',
      '</div>',
      '<div class="tts-clone-spec-block">',
      '  <h4><svg class="tts-clone-spec-icon" width="18" height="18" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="24" cy="24" r="18" fill="none" stroke="currentColor" stroke-width="4"/><path d="M24 14V16" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><circle cx="24" cy="32" r="2.5" fill="currentColor"/></svg> 后续合成</h4>',
      '  <ul>',
      `    <li>${t("tts-panel.52")}<code>POST /v1/audio/speech</code></li>`,
      `    <li>${t("tts-panel.53")}<code>moss-tts-1.5-flash</code>${t("tts-panel.54")}<code>moss-tts-1.0-pro</code>${t("tts-panel.55")}</li>`,
      '  </ul>',
      '</div>',
    ].join("\n"),
  });
});

// MiniMax 测试发音
document.getElementById("tts-minimax-test")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const apiKey = ttsEl("tts-minimax-key").value.trim();
  const voiceId = ttsEl("tts-minimax-voice").value.trim();
  const modelSelect = ttsEl("tts-minimax-model") as HTMLSelectElement;
  const model = modelSelect.value === "speech-2.8-hd" ? "speech-2.8-hd" : "speech-2.8-turbo";
  if (!apiKey) { window.alert(t("tts-panel.56")); return; }
  if (!voiceId) { window.alert(t("tts-panel.57")); return; }

  const btn = document.getElementById("tts-minimax-test") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = t("tts-panel.58");
  try {
    const vocalEnhance = { enabled: ttsEl("tts-minimax-vocal-enhance").checked };
    const base64 = await window.tts.synthesize({ apiKey, voiceId, text: TTS_TEST_TEXT, model, vocalEnhance });
    playTtsAudio(base64);
  } catch (err) {
    window.alert(t("tts-panel.59") + (err instanceof Error ? err.message : String(err)));
  } finally {
    btn.disabled = false;
    btn.textContent = t("tts-panel.60");
  }
});

// ── 音色快速复刻 ──
// 选择配音文件
document.getElementById("tts-clone-pick")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const filePath = await window.tts.pickAudio();
  if (filePath) ttsEl("tts-clone-file").value = filePath;
});

// 选择示例音频
document.getElementById("tts-clone-prompt-pick")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const filePath = await window.tts.pickAudio();
  if (filePath) ttsEl("tts-clone-prompt-file").value = filePath;
});

// 设置复刻状态文案
function setCloneStatus(text: string, type: "ok" | "error" | "loading"): void {
  const el = document.getElementById("tts-clone-status");
  if (!el) return;
  el.textContent = text;
  el.className = "tts-clone-status" + (type ? " is-" + type : "");
}

// 开始复刻
document.getElementById("tts-clone-start")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const apiKey = ttsEl("tts-minimax-key").value.trim();
  const cloneFile = ttsEl("tts-clone-file").value.trim();
  const promptFile = ttsEl("tts-clone-prompt-file").value.trim();
  const promptText = ttsEl("tts-clone-prompt-text").value.trim();
  const cloneText = ttsEl("tts-clone-text").value.trim();
  const voiceId = ttsEl("tts-clone-voice-id").value.trim();

  if (!apiKey) { window.alert(t("tts-panel.61")); return; }
  if (!cloneFile) { window.alert(t("tts-panel.62")); return; }
  if (!cloneText) { window.alert(t("tts-panel.63")); return; }
  if (!voiceId) { window.alert(t("tts-panel.64")); return; }
  const voiceIdError = validateMiniMaxVoiceId(voiceId);
  if (voiceIdError) { setCloneStatus("❌ " + voiceIdError, "error"); return; }

  const btn = document.getElementById("tts-clone-start") as HTMLButtonElement;
  btn.disabled = true;
  setCloneStatus(t("tts-panel.65"), "loading");

  try {
    // 步骤1: 上传配音文件
    const cloneUpload = await window.tts.upload(apiKey, cloneFile, "voice_clone");
    setCloneStatus(t("tts-panel.66") + cloneUpload.file_id + t("tts-panel.67"), "loading");

    // 步骤2: 上传示例音频（可选）
    let promptFileId: string | undefined;
    if (promptFile) {
      const promptUpload = await window.tts.upload(apiKey, promptFile, "prompt_audio");
      promptFileId = promptUpload.file_id;
      setCloneStatus(t("tts-panel.68"), "loading");
    } else {
      setCloneStatus(t("tts-panel.69"), "loading");
    }

    // 步骤3: 音色克隆
    const result = await window.tts.clone({
      apiKey, fileId: cloneUpload.file_id, voiceId,
      promptAudioId: promptFileId, promptText: promptText || undefined,
      text: cloneText,
    });

    // 自动填入音色 ID
    ttsEl("tts-minimax-voice").value = result.voiceId;
    void saveTtsField("ttsMinimaxVoiceId", result.voiceId);

    setCloneStatus(t("tts-panel.70") + result.voiceId + t("tts-panel.71"), "ok");

    // 如果有试听音频，播放
    if (result.audioDemo) {
      try {
        const resp = await fetch(result.audioDemo);
        const buf = await resp.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        playTtsAudio(base64);
      } catch { /* 试听音频播放失败不影响主流程 */ }
    }
  } catch (err) {
    setCloneStatus("❌ " + (err instanceof Error ? err.message : String(err)), "error");
    // 失败可能是"服务端已创建但响应丢失"（重试同 ID 会报 2039 重复），
    // 自动换一个新的音色 ID，让用户直接点重试即可。
    const failedVoiceId = ttsEl("tts-clone-voice-id").value.trim();
    if (failedVoiceId) {
      ttsEl("tts-clone-voice-id").value = createUniqueMiniMaxVoiceId();
    }
  } finally {
    btn.disabled = false;
  }
});

// ── 音色快速复刻：规格说明模态框 ──
// 字段顺序：file_id → voice_id → clone_prompt(prompt_audio / prompt_text) → text(试听)
const CLONE_SPEC_BODY = [
  '<div class="tts-clone-spec-block">',
  '  <h4>',
  '    <svg class="tts-clone-spec-icon" width="18" height="18" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">',
  '      <path d="M24 44C35.0457 44 44 35.0457 44 24C44 12.9543 35.0457 4 24 4C12.9543 4 4 12.9543 4 24C4 35.0457 12.9543 44 24 44Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>',
  '      <path d="M18 22H30" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <path d="M18 28H30" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <path d="M24.0083 22V34" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <path d="M30 15L24 21L18 15" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '    </svg>',
  t("tts-panel.72"),
  '  </h4>',
  `  <p>${t("tts-panel.73")}<span class="tts-clone-fee">¥9.9</span>。`,
  `${t("tts-panel.74")}<code>text</code> + <code>model</code>${t("tts-panel.75")}</p>`,
  '</div>',
  '<div class="tts-clone-spec-block">',
  '  <h4>',
  '    <svg class="tts-clone-spec-icon" width="18" height="18" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">',
  '      <path d="M7 4H41" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <path d="M7 44H41" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <path d="M11 44C13.6667 30.6611 18 23.9944 24 24C30 24.0056 34.3333 30.6722 37 44H11Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>',
  '      <path d="M37 4C34.3333 17.3389 30 24.0056 24 24C18 23.9944 13.6667 17.3278 11 4H37Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>',
  '      <path d="M21 15H27" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <path d="M19 38H29" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '    </svg>',
  t("tts-panel.76"),
  '  </h4>',
  `  <p>${t("tts-panel.77")}<strong>${t("tts-panel.78")}</strong>${t("tts-panel.79")}</p>`,
  '</div>',
  '<div class="tts-clone-spec-block">',
  '  <h4>',
  '    <svg class="tts-clone-spec-icon" width="18" height="18" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">',
  '      <path d="M8 44V4H31L40 14.5V44H8Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <path d="M32 14L26 16.9688V31.5" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <circle cx="20.5" cy="31.5" r="5.5" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '    </svg>',
  `${t("tts-panel.80")}<code>file_id</code>${t("tts-panel.81")}`,
  '  </h4>',
  '  <ul>',
  `    <li>${t("tts-panel.82")}</li>`,
  `    <li>${t("tts-panel.83")}</li>`,
  `    <li>${t("tts-panel.84")}</li>`,
  '  </ul>',
  '</div>',
  '<div class="tts-clone-spec-block">',
  '  <h4>',
  '    <svg class="tts-clone-spec-icon" width="18" height="18" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">',
  '      <path d="M10 10H32H38V44H10V10Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <path d="M10 10L32 4V10" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <circle cx="24" cy="24" r="4" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <path d="M20 34H28" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '    </svg>',
  t("tts-panel.85"),
  '  </h4>',
  '  <ul>',
  `    <li>${t("tts-panel.86")}</li>`,
  `    <li>${t("tts-panel.87")}</li>`,
  `    <li>${t("tts-panel.88")}<code>-</code>、<code>_</code></li>`,
  `    <li>${t("tts-panel.89")}<code>-</code>${t("tts-panel.90")}<code>_</code></li>`,
  `    <li>${t("tts-panel.91")}</li>`,
  '  </ul>',
  '</div>',
  '<div class="tts-clone-spec-block">',
  '  <h4>',
  '    <svg class="tts-clone-spec-icon" width="18" height="18" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">',
  '      <path d="M24 44C35.0457 44 44 35.0457 44 24C44 12.9543 35.0457 4 24 4C12.9543 4 4 12.9543 4 24C4 35.0457 12.9543 44 24 44Z" fill="none" stroke="currentColor" stroke-width="4"/>',
  '      <path d="M30 18V30" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>',
  '      <path d="M36 22V26" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>',
  '      <path d="M18 18V30" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>',
  '      <path d="M12 22V26" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>',
  '      <path d="M24 14V34" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>',
  '    </svg>',
  t("tts-panel.92"),
  '  </h4>',
  `  <p>${t("tts-panel.93")}</p>`,
  '  <ul>',
  `    <li>${t("tts-panel.94")}</li>`,
  `    <li>${t("tts-panel.95")}</li>`,
  `    <li>${t("tts-panel.96")}</li>`,
  `    <li>${t("tts-panel.97")}<code>prompt_text</code>${t("tts-panel.98")}</li>`,
  '  </ul>',
  '</div>',
  '<div class="tts-clone-spec-block">',
  '  <h4>',
  '    <svg class="tts-clone-spec-icon" width="18" height="18" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">',
  '      <path d="M40 33V42C40 43.1046 39.1046 44 38 44H31.5" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <path d="M40 16V6C40 4.89543 39.1046 4 38 4H10C8.89543 4 8 4.89543 8 6V42C8 43.1046 8.89543 44 10 44H16" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <path d="M16 16H30" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>',
  '      <path d="M23 44L40 23" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>',
  '      <path d="M16 24H24" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>',
  '    </svg>',
  `${t("tts-panel.99")}<code>text</code>${t("tts-panel.100")}`,
  '  </h4>',
  `  <p>${t("tts-panel.101")}</p>`,
  '</div>',
].join("\n");

function showCloneSpecModal(): void {
  void showHtmlModal({
    title: t("tts-panel.102"),
    icon: "ⓘ",
    htmlBody: CLONE_SPEC_BODY,
  });
}

document.getElementById("tts-clone-info-btn")?.addEventListener("click", showCloneSpecModal);
document.getElementById("tts-clone-info-link")?.addEventListener("click", showCloneSpecModal);

const cloneVoiceIdInput = document.getElementById("tts-clone-voice-id") as HTMLInputElement | null;
if (cloneVoiceIdInput && !cloneVoiceIdInput.value.trim()) {
  cloneVoiceIdInput.value = createUniqueMiniMaxVoiceId();
}

// 初始加载配置
void loadTtsConfig();
