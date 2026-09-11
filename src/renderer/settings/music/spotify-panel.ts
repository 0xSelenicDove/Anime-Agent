// Spotify 面板业务逻辑：Client ID 配置 / OAuth 登录（系统浏览器) / 搜索 / 播放控制。
// 与 music/panel.ts（网易云）结构对称，但登录是一次性 OAuth 授权而非扫码轮询，
// 播放也不是本地 mpv 而是遥控已打开的 Spotify 设备（Spotify Connect）。

import {
  spotifyClientIdInput, spotifyStatusDot, spotifyAccountStatusText, spotifyStatusDescription,
  spotifyLoginBtn, spotifySearchForm, spotifySearchHint, spotifySearchInput, spotifySearchBtn,
  spotifySearchResults, spotifyFeedbackEl,
} from "./dom";
import type { SpotifyApi, SpotifyStatusSnapshot, SpotifyIpcResult, SpotifyTrack } from "./spotify-types";

let initialized = false;
let stateUnsub: (() => void) | null = null;

function getSpotifyApi(): SpotifyApi | null {
  const w = window as unknown as { spotify?: SpotifyApi };
  return w.spotify ?? null;
}

function setSpotifyFeedback(kind: "info" | "ok" | "err", msg: string): void {
  if (!spotifyFeedbackEl) return;
  spotifyFeedbackEl.textContent = msg;
  spotifyFeedbackEl.className = "music-feedback";
  spotifyFeedbackEl.classList.add(kind === "ok" ? "music-feedback--ok" : kind === "err" ? "music-feedback--err" : "music-feedback--info");
}

function renderSpotifyStatus(status: SpotifyStatusSnapshot): void {
  if (spotifyStatusDot) {
    spotifyStatusDot.classList.toggle("is-connected", status.backendState === "connected");
  }
  if (spotifyAccountStatusText) {
    spotifyAccountStatusText.textContent = status.backendState === "connected"
      ? (status.profile?.displayName ?? "已连接")
      : status.backendState === "connecting" ? "正在等待浏览器授权…"
      : status.backendState === "error" ? "连接失败"
      : "尚未连接";
  }
  if (spotifyStatusDescription) {
    spotifyStatusDescription.textContent = status.backendState === "connected" && status.profile?.product === "free"
      ? "（免费账号无法使用 Spotify Connect 遥控播放，仅可搜索）"
      : status.backendState === "error" ? (status.errorMessage ?? "") : "";
  }
  if (spotifyLoginBtn) {
    spotifyLoginBtn.textContent = status.backendState === "connected" ? "断开连接"
      : status.backendState === "connecting" ? "取消登录" : "连接 Spotify";
    spotifyLoginBtn.disabled = false;
  }
  const connected = status.backendState === "connected";
  spotifySearchForm?.classList.toggle("is-hidden", !connected);
  if (spotifySearchHint) spotifySearchHint.textContent = connected ? "搜索 Spotify 曲库。" : "连接 Spotify 后即可搜索并遥控播放。";
}

async function startSpotifyLogin(): Promise<void> {
  const api = getSpotifyApi();
  if (!api) {
    setSpotifyFeedback("err", "window.spotify 未就绪");
    return;
  }
  const clientId = (spotifyClientIdInput?.value ?? "").trim();
  setSpotifyFeedback("info", "正在打开系统浏览器完成 Spotify 授权…");
  try {
    const r = await api.beginLogin(clientId || undefined);
    if (r.ok) {
      setSpotifyFeedback("ok", `已连接：${r.data.profile.displayName}`);
    } else {
      setSpotifyFeedback("err", "登录失败：" + r.errorCode);
    }
  } catch (err) {
    setSpotifyFeedback("err", "登录异常：" + (err instanceof Error ? err.message : String(err)));
  }
}

async function cancelSpotifyLogin(): Promise<void> {
  const api = getSpotifyApi();
  if (!api) return;
  await api.cancelLogin();
  setSpotifyFeedback("info", "已取消登录");
}

async function disconnectSpotify(): Promise<void> {
  const api = getSpotifyApi();
  if (!api) return;
  setSpotifyFeedback("info", "正在断开…");
  await api.logout();
  setSpotifyFeedback("ok", "已断开 Spotify 连接");
}

function renderSpotifySearchResults(r: SpotifyIpcResult<SpotifyTrack[]>, kw: string): void {
  if (!spotifySearchResults) return;
  spotifySearchResults.innerHTML = "";
  if (!r.ok) {
    const div = document.createElement("div");
    div.className = "music-feedback music-feedback--err";
    div.textContent = "搜索失败：" + r.errorCode;
    spotifySearchResults.appendChild(div);
    return;
  }
  const tracks = r.data;
  if (tracks.length === 0) {
    const p = document.createElement("p");
    p.className = "empty-hint";
    const safeKw = kw.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    p.textContent = `暂无结果，关键词 '${safeKw}' 未匹配到歌曲`;
    spotifySearchResults.appendChild(p);
    return;
  }
  for (const t of tracks) {
    const row = document.createElement("div");
    row.className = "music-search-row";

    const main = document.createElement("div");
    main.className = "music-search-row__main";
    const name = document.createElement("div");
    name.className = "music-search-row__name";
    name.textContent = t.name;
    const meta = document.createElement("div");
    meta.className = "music-search-row__meta";
    meta.textContent = [(t.artists ?? []).join(" / "), t.album].filter(Boolean).join(" · ");
    main.appendChild(name);
    main.appendChild(meta);

    const playBtn = document.createElement("button");
    playBtn.type = "button";
    playBtn.className = "btn-secondary music-search-row__play";
    playBtn.textContent = "▶ 播放";
    playBtn.addEventListener("click", async () => {
      const api = getSpotifyApi();
      if (!api) {
        setSpotifyFeedback("err", "window.spotify 未就绪");
        return;
      }
      playBtn.disabled = true;
      try {
        const res = await api.playTrack(t.uri);
        setSpotifyFeedback(res.ok ? "ok" : "err", res.ok ? `正在播放：${t.name}` : "播放失败：" + res.errorCode);
      } catch (err) {
        setSpotifyFeedback("err", "播放请求异常：" + (err instanceof Error ? err.message : String(err)));
      } finally {
        playBtn.disabled = false;
      }
    });

    row.appendChild(main);
    row.appendChild(playBtn);
    spotifySearchResults.appendChild(row);
  }
}

async function runSpotifySearch(): Promise<void> {
  const api = getSpotifyApi();
  if (!api) {
    setSpotifyFeedback("err", "window.spotify 未就绪");
    return;
  }
  const kw = (spotifySearchInput?.value ?? "").trim();
  if (!kw) {
    setSpotifyFeedback("info", "请输入搜索关键词");
    return;
  }
  if (spotifySearchResults) spotifySearchResults.innerHTML = '<p class="empty-hint">搜索中…</p>';
  try {
    const r = await api.search(kw, 20);
    renderSpotifySearchResults(r, kw);
  } catch (err) {
    if (spotifySearchResults) spotifySearchResults.innerHTML = "";
    setSpotifyFeedback("err", "搜索异常：" + (err instanceof Error ? err.message : String(err)));
  }
}

export async function loadSpotifyPanel(): Promise<void> {
  if (initialized) return;
  initialized = true;

  const api = getSpotifyApi();
  if (!api) {
    setSpotifyFeedback("err", "window.spotify 未就绪，请确认 spotify plugin 已注册");
    return;
  }

  try {
    const cfg = await api.getConfig();
    if (cfg.ok && cfg.data && spotifyClientIdInput) spotifyClientIdInput.value = cfg.data.clientId;
  } catch {
    // 未配置时留空即可
  }

  try {
    const status = await api.getStatus();
    renderSpotifyStatus(status.data);
  } catch (err) {
    setSpotifyFeedback("err", "读取状态失败：" + (err instanceof Error ? err.message : String(err)));
  }

  stateUnsub = api.onStateChanged((s) => renderSpotifyStatus(s)) ?? null;

  spotifyLoginBtn?.addEventListener("click", async () => {
    const api2 = getSpotifyApi();
    const status = await api2?.getStatus();
    if (status?.data.backendState === "connected") await disconnectSpotify();
    else if (status?.data.backendState === "connecting") await cancelSpotifyLogin();
    else await startSpotifyLogin();
  });

  spotifySearchBtn?.addEventListener("click", () => void runSpotifySearch());
  spotifySearchInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void runSpotifySearch();
  });
}

export function disposeSpotifyPanel(): void {
  stateUnsub?.();
  stateUnsub = null;
}
