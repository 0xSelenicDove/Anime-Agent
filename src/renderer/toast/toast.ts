// 注意力 Toast 中心渲染页（纯表现层）。
// 生命周期权威在主进程 ToastService：本页只做三件事——
//   1. 堆叠渲染主进程推送的 toast（同 id 覆盖，等待操作档在上组）
//   2. 用户点击/关闭只上报 toast id，跳转决策完全在主进程
//   3. 高度协议：内容区实际高度变化时上报，主进程 clamp 后调整窗口尺寸

import {
  TOAST_MAX_VISIBLE,
  type ToastItem,
  type ToastPushPayload,
  type ToastTier,
} from "../../shared/toast-types";
import avatarIconUrl from "./assets/toast-avatar.png";
import actionSoundUrl from "./assets/toast-action.mp3";
import notifySoundUrl from "./assets/toast-notify.mp3";

const api = window.toast;
const stack = document.getElementById("toast-stack");

/** 堆叠容器的上下内边距与卡片间距，须与 toast.css 保持一致（折叠高度计算用） */
const STACK_PADDING = 28;
const STACK_GAP = 12;

/** 退出动画总时长（与 CSS 过渡时长匹配） */
const LEAVE_MS = 220;

interface CardEntry {
  item: ToastItem;
  el: HTMLElement;
  /** 退出动画进行中的定时器；期间同 id 重新 push 会撤销退出 */
  removalTimer: number | null;
}

const cards = new Map<string, CardEntry>();

const actionSound = new Audio(actionSoundUrl);
const notifySound = new Audio(notifySoundUrl);

/** 档位决定音效：等待操作档引起注意型，通知档轻提示型 */
function playSound(tier: ToastTier): void {
  const audio = tier === "action-pending" ? actionSound : notifySound;
  audio.currentTime = 0;
  void audio.play().catch(() => {
    // 播放失败不影响提醒展示本身
  });
}

const CLOSE_ICON =
  '<svg width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden="true"><line x1="2" y1="2" x2="7" y2="7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="7" y1="2" x2="2" y2="7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

function buildCard(item: ToastItem): HTMLElement {
  const el = document.createElement("article");
  el.className = `toast-card toast-card--${item.tier}`;
  el.dataset.id = item.id;

  const icon = document.createElement("span");
  icon.className = "toast-card__icon";
  const avatar = document.createElement("img");
  avatar.src = avatarIconUrl;
  avatar.alt = "";
  avatar.draggable = false;
  icon.appendChild(avatar);

  const body = document.createElement("div");
  body.className = "toast-card__body";

  const title = document.createElement("div");
  title.className = "toast-card__title";
  title.textContent = item.title;

  const summary = document.createElement("div");
  summary.className = "toast-card__summary";
  summary.textContent = item.summary ?? "";
  if (!item.summary) summary.hidden = true;

  body.append(title, summary);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-card__close";
  close.setAttribute("aria-label", "关闭提醒");
  close.innerHTML = CLOSE_ICON;
  close.addEventListener("click", (event) => {
    event.stopPropagation();
    api?.dismissed(item.id);
  });

  el.append(icon, body, close);
  el.addEventListener("click", () => {
    api?.clicked(item.id);
  });
  return el;
}

/** 同 id 覆盖时更新文本内容（不重建节点，避免打断动画） */
function updateCardContent(el: HTMLElement, item: ToastItem): void {
  const title = el.querySelector<HTMLElement>(".toast-card__title");
  if (title) title.textContent = item.title;
  const summary = el.querySelector<HTMLElement>(".toast-card__summary");
  if (summary) {
    summary.textContent = item.summary ?? "";
    summary.hidden = !item.summary;
  }
}

/** 撤销进行中的退出动画（退出期间同 id 重新 push 的覆盖语义） */
function cancelRemoval(entry: CardEntry): void {
  if (entry.removalTimer === null) return;
  window.clearTimeout(entry.removalTimer);
  entry.removalTimer = null;
  entry.el.classList.remove("toast-card--leaving");
  entry.el.style.height = "";
  entry.el.style.marginBottom = "";
}

/** 展示顺序：等待操作档在上组、通知档在下组，同组按创建时间排序（新的更靠角落） */
function orderedEntries(): CardEntry[] {
  const action: CardEntry[] = [];
  const notify: CardEntry[] = [];
  for (const entry of cards.values()) {
    (entry.item.tier === "action-pending" ? action : notify).push(entry);
  }
  const byTime = (a: CardEntry, b: CardEntry) => a.item.createdAt - b.item.createdAt;
  action.sort(byTime);
  notify.sort(byTime);
  return [...action, ...notify];
}

let lastReportedHeight = 0;

/**
 * 高度协议：上报堆叠容器的内容需求高度；只在变化时发送，避免 ResizeObserver 回调。
 * 必须测 scrollHeight 而不是 offsetHeight：CSS 里容器有 max-height: 100%，
 * 参照的是窗口当前高度——窗口尚小（或初始 1px）时 offsetHeight 会被压成窗口高，
 * 主进程永远等不到真实高度，形成"窗口小 → 测不准 → 窗口放不大"的死锁；
 * scrollHeight 反映内容真实需求，不受裁剪影响。
 */
function reportHeight(): void {
  if (!stack) return;
  const height = stack.scrollHeight;
  if (height === lastReportedHeight) return;
  lastReportedHeight = height;
  api?.reportHeight(height);
}

function relayout(): void {
  if (!stack) return;
  const ordered = orderedEntries();
  // 按优先级顺序重排 DOM（appendChild 移动既有节点，不重建）
  for (const { el } of ordered) stack.appendChild(el);
  // 超出可见上限时：窗口只撑到前 N 条的总高度，其余滚进容器折叠区
  if (ordered.length > TOAST_MAX_VISIBLE) {
    let visible = STACK_PADDING;
    for (let i = 0; i < TOAST_MAX_VISIBLE; i++) {
      visible += ordered[i].el.offsetHeight + STACK_GAP;
    }
    stack.style.maxHeight = `${visible - STACK_GAP}px`;
  } else {
    stack.style.maxHeight = "";
  }
  reportHeight();
}

function push(payload: ToastPushPayload): void {
  if (!stack) return;
  const existing = cards.get(payload.id);
  if (existing) {
    cancelRemoval(existing);
    existing.item = payload;
    updateCardContent(existing.el, payload);
  } else {
    const el = buildCard(payload);
    cards.set(payload.id, { item: payload, el, removalTimer: null });
  }
  if (payload.sound) playSound(payload.tier);
  relayout();
}

/** 主进程已决定移除：播退出动画后从 DOM 清除 */
function remove(id: string): void {
  if (!stack) return;
  const entry = cards.get(id);
  if (!entry || entry.removalTimer !== null) return;
  const el = entry.el;
  // 固定当前高度后再过渡到 0，配合负 margin 折叠间距，实现平滑收起
  el.style.height = `${el.offsetHeight}px`;
  void el.offsetHeight; // 强制回流，让固定高度先生效
  el.classList.add("toast-card--leaving");
  el.style.height = "0";
  el.style.marginBottom = `-${STACK_GAP}px`;
  entry.removalTimer = window.setTimeout(() => {
    entry.removalTimer = null;
    cards.delete(id);
    el.remove();
    relayout();
  }, LEAVE_MS);
}

/** 页面加载/重载后恢复当前列表（主进程权威状态快照，不播音效） */
async function restore(): Promise<void> {
  if (!stack || !api) return;
  try {
    const list = await api.getAll();
    for (const item of list) {
      if (cards.has(item.id)) continue;
      cards.set(item.id, { item, el: buildCard(item), removalTimer: null });
    }
    relayout();
  } catch {
    // 主进程侧未就绪：等待后续 push 事件即可
  }
}

function main(): void {
  if (!stack) return;
  api?.onPush(push);
  api?.onRemove(remove);
  // 字体加载等原因导致卡片高度变化时，重算折叠高度并重新上报
  new ResizeObserver(() => relayout()).observe(stack);
  void restore();
}

main();
