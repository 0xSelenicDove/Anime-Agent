import { t } from "../i18n";
// Scheduler 面板业务逻辑：列表渲染 / 编辑器 / 任务 CRUD
// 从 settings.ts 抽离。依赖 scheduler DOM 引用（./dom）、schedulerState（./state）、
// 纯函数（./utils）、shared showModal、scheduler/types 类型。

import type { ScheduledTask, ScheduleConfig } from "./types";
import { schedulerState } from "./state";
import {
  schedulerEmpty, schedulerList,
  schedulerEditor, schedulerEditorTitle,
  schedulerTitleInput, schedulerPromptInput, schedulerEnabledInput,
  schedulerKindInput, schedulerOnceRunAtInput, schedulerTimeOfDayInput,
  schedulerDayOfWeekInput, schedulerIntervalEveryInput, schedulerIntervalUnitInput,
  schedulerToolLimitInput, schedulerToolPicker, schedulerToolEmptyHint,
  schedulerSaveStatus,
} from "./dom";
import {
  toLocalDateTimeInputValue,
  isValidTimeOfDay,
  formatSchedulerDate,
  describeSchedule,
} from "./utils";
import { showModal } from "../shared/modal";

/** 插件列表最小视图：只取运行状态，供任务卡片判断"等待插件启用"。 */
interface PluginListLike {
  id: string;
  status: string;
}

declare global {
  interface Window {
    plugins?: {
      list(): Promise<{ plugins?: PluginListLike[] } | PluginListLike[]>;
    };
  }
}

export function setSchedulerStatus(text: string, className = ""): void {
  if (!schedulerSaveStatus) return;
  schedulerSaveStatus.textContent = text;
  schedulerSaveStatus.className = "save-status" + (className ? " " + className : "");
}

export function renderSchedulerTools(selectedIds: string[] = []): void {
  if (!schedulerToolPicker) return;
  schedulerToolPicker.replaceChildren();
  const selected = new Set(selectedIds);
  for (const tool of schedulerState.tools) {
    const label = document.createElement("label");
    label.className = "scheduler-tool-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = tool.id;
    checkbox.checked = selected.has(tool.id);
    checkbox.addEventListener("change", updateSchedulerConditionalFields);
    const copy = document.createElement("span");
    copy.textContent = `${tool.name} (${tool.id}) · ${tool.risk}${tool.enabled ? "" : t("scheduler-panel.1")}`;
    label.appendChild(checkbox);
    label.appendChild(copy);
    schedulerToolPicker.appendChild(label);
  }
}

export async function renderSchedulerList(): Promise<void> {
  if (!schedulerList || !schedulerEmpty) return;
  schedulerList.replaceChildren();
  schedulerEmpty.classList.toggle("is-hidden", schedulerState.tasks.length > 0);
  for (const task of schedulerState.tasks) {
    const card = document.createElement("article");
    card.className = "scheduler-card";
    card.innerHTML = `
      <div class="scheduler-card__head">
        <div class="scheduler-card__title"><span><svg width="16" height="16" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M23.9998 44.3332C34.1251 44.3332 42.3332 36.1251 42.3332 25.9999C42.3332 15.8747 34.1251 7.66656 23.9998 7.66656C13.8746 7.66656 5.6665 15.8747 5.6665 25.9999C5.6665 36.1251 13.8746 44.3332 23.9998 44.3332Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M23.7594 15.3536L23.7582 26.3624L31.5305 34.1347" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 9.00001L11 4.00001" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M44 9.00001L37 4.00001" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg></span><strong></strong><span class="scheduler-badge"></span></div>
      </div>
      <div class="scheduler-card__meta"></div>
      <div class="scheduler-card__actions"></div>
      <div class="scheduler-history is-hidden"></div>
    `;
    const strong = card.querySelector("strong");
    if (strong) strong.textContent = task.title;
    const isPluginTask = Boolean(task.ownerPluginId);
    const pluginRunning = isPluginTask && schedulerState.pluginRunning[task.ownerPluginId!] === true;
    const badge = card.querySelector(".scheduler-badge") as HTMLSpanElement | null;
    if (badge) {
      badge.textContent = task.enabled ? t("scheduler-panel.2") : t("scheduler-panel.3");
      badge.classList.toggle("is-disabled", !task.enabled);
    }
    const meta = card.querySelector(".scheduler-card__meta");
    if (meta) {
      const parts: string[] = [];
      if (isPluginTask) parts.push(t("scheduler-panel.44", { id: task.ownerPluginId }));
      parts.push(describeSchedule(task.schedule));
      parts.push(t("scheduler-panel.45", { date: formatSchedulerDate(task.nextFireAt) }));
      parts.push(t("scheduler-panel.46", { mode: task.mode ?? "work" }));
      // 插件任务固定走工具白名单，不存在"全部已启用工具"的展示分支
      parts.push(t("scheduler-panel.47", { tools: isPluginTask ? (task.allowedToolIds.join(", ") || t("scheduler-panel.4")) : (task.toolMode === "all-enabled" ? t("scheduler-panel.5") : task.allowedToolIds.join(", ") || t("scheduler-panel.6")) }));
      if (isPluginTask && !pluginRunning) parts.push(t("scheduler-panel.7"));
      meta.textContent = parts.join(" · ");
    }
    const actions = card.querySelector(".scheduler-card__actions") as HTMLDivElement | null;
    if (actions) {
      const fireBtn = document.createElement("button");
      fireBtn.type = "button";
      fireBtn.className = "ghost-btn";
      fireBtn.textContent = t("scheduler-panel.8");
      // 插件停用时引擎会跳过其任务，直接禁用按钮避免无效点击
      fireBtn.disabled = isPluginTask && !pluginRunning;
      if (fireBtn.disabled) fireBtn.title = t("scheduler-panel.9");
      fireBtn.addEventListener("click", () => void fireSchedulerTask(task.id));
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "ghost-btn";
      editBtn.textContent = t("scheduler-panel.10");
      editBtn.addEventListener("click", () => void openSchedulerEditor(task));
      const toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.className = "ghost-btn";
      toggleBtn.textContent = task.enabled ? t("scheduler-panel.11") : t("scheduler-panel.12");
      toggleBtn.addEventListener("click", () => void toggleSchedulerTask(task, !task.enabled));
      const historyBtn = document.createElement("button");
      historyBtn.type = "button";
      historyBtn.className = "ghost-btn";
      historyBtn.textContent = t("scheduler-panel.13");
      historyBtn.addEventListener("click", () => void toggleSchedulerHistory(task.id, card));
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "ghost-btn";
      deleteBtn.textContent = t("scheduler-panel.14");
      deleteBtn.addEventListener("click", () => void deleteSchedulerTask(task.id));
      actions.append(fireBtn, editBtn, toggleBtn, historyBtn, deleteBtn);
    }
    schedulerList.appendChild(card);
  }
}

export async function loadSchedulerPanel(): Promise<void> {
  const [tasksResult, toolsResult, pluginsResult] = await Promise.all([
    window.cyreneScheduler!.list(),
    window.cyreneScheduler!.getTools(),
    // 插件运行状态决定"等待插件启用"提示；查询失败按未知处理，不阻塞任务列表
    window.plugins?.list().catch(() => undefined),
  ]);
  if (tasksResult.ok) schedulerState.tasks = tasksResult.value ?? [];
  if (toolsResult.ok) schedulerState.tools = toolsResult.value ?? [];
  const pluginList = pluginsResult
    ? (Array.isArray(pluginsResult) ? pluginsResult : pluginsResult.plugins ?? [])
    : [];
  schedulerState.pluginRunning = {};
  for (const plugin of pluginList) {
    schedulerState.pluginRunning[plugin.id] = plugin.status === "running";
  }
  renderSchedulerTools();
  await renderSchedulerList();
}

export async function openSchedulerEditor(task?: ScheduledTask): Promise<void> {
  schedulerState.editingTaskId = task?.id ?? null;
  schedulerEditor?.classList.remove("is-hidden");
  // 确保工具列表已加载
  if (schedulerState.tools.length === 0) {
    const toolsResult = await window.cyreneScheduler!.getTools();
    if (toolsResult.ok) schedulerState.tools = toolsResult.value ?? [];
  }
  if (schedulerEditorTitle) schedulerEditorTitle.textContent = task ? t("scheduler-panel.15") : t("scheduler-panel.16");
  if (schedulerTitleInput) schedulerTitleInput.value = task?.title ?? "";
  if (schedulerPromptInput) schedulerPromptInput.value = task?.prompt ?? "";
  if (schedulerEnabledInput) schedulerEnabledInput.checked = task?.enabled ?? true;
  if (schedulerKindInput) schedulerKindInput.value = task?.schedule.kind ?? "daily";
  if (schedulerOnceRunAtInput) schedulerOnceRunAtInput.value = "";
  if (schedulerTimeOfDayInput) schedulerTimeOfDayInput.value = "08:00";
  if (schedulerDayOfWeekInput) schedulerDayOfWeekInput.value = "1";
  if (schedulerIntervalEveryInput) schedulerIntervalEveryInput.value = "1";
  if (schedulerIntervalUnitInput) schedulerIntervalUnitInput.value = "minutes";
  if (task?.schedule.kind === "once" && schedulerOnceRunAtInput) schedulerOnceRunAtInput.value = toLocalDateTimeInputValue(task.schedule.runAt);
  if ((task?.schedule.kind === "daily" || task?.schedule.kind === "weekly") && schedulerTimeOfDayInput) schedulerTimeOfDayInput.value = task.schedule.timeOfDay;
  if (task?.schedule.kind === "weekly" && schedulerDayOfWeekInput) schedulerDayOfWeekInput.value = String(task.schedule.dayOfWeek);
  if (task?.schedule.kind === "interval") {
    if (schedulerIntervalEveryInput) schedulerIntervalEveryInput.value = String(task.schedule.every);
    if (schedulerIntervalUnitInput) schedulerIntervalUnitInput.value = task.schedule.unit;
  }
  if (schedulerToolLimitInput) {
    // 插件任务只能使用显式工具白名单，锁定开关防止切换为全部工具
    const lockAllowList = Boolean(task?.ownerPluginId);
    schedulerToolLimitInput.checked = lockAllowList || task?.toolMode === "allow-list";
    schedulerToolLimitInput.disabled = lockAllowList;
  }
  renderSchedulerTools(task?.allowedToolIds ?? []);
  updateSchedulerConditionalFields();
  setSchedulerStatus(t("scheduler-panel.17"));
}

export function closeSchedulerEditor(): void {
  schedulerState.editingTaskId = null;
  schedulerEditor?.classList.add("is-hidden");
}

export function updateSchedulerConditionalFields(): void {
  const kind = schedulerKindInput?.value ?? "daily";
  document.querySelectorAll(".scheduler-once-field").forEach(el => el.classList.toggle("is-hidden", kind !== "once"));
  document.querySelectorAll(".scheduler-time-field").forEach(el => el.classList.toggle("is-hidden", kind !== "daily" && kind !== "weekly"));
  document.querySelectorAll(".scheduler-weekly-field").forEach(el => el.classList.toggle("is-hidden", kind !== "weekly"));
  document.querySelectorAll(".scheduler-interval-field").forEach(el => el.classList.toggle("is-hidden", kind !== "interval"));
  const allowListEnabled = Boolean(schedulerToolLimitInput?.checked);
  schedulerToolPicker?.classList.toggle("is-hidden", !allowListEnabled);
  const selectedCount = collectAllowedToolIds().length;
  schedulerToolEmptyHint?.classList.toggle("is-hidden", !allowListEnabled || selectedCount > 0);
}

export function collectSchedule(): ScheduleConfig {
  const kind = schedulerKindInput?.value ?? "daily";
  if (kind === "once") {
    const value = schedulerOnceRunAtInput?.value;
    if (!value) throw new Error(t("scheduler-panel.18"));
    const runAt = new Date(value);
    if (Number.isNaN(runAt.getTime())) throw new Error(t("scheduler-panel.19"));
    if (runAt.getTime() <= Date.now()) throw new Error(t("scheduler-panel.20"));
    return { kind: "once", runAt: runAt.toISOString() };
  }
  if (kind === "weekly") {
    const timeOfDay = schedulerTimeOfDayInput?.value || "08:00";
    if (!isValidTimeOfDay(timeOfDay)) throw new Error(t("scheduler-panel.21"));
    const dayOfWeek = Number(schedulerDayOfWeekInput?.value ?? 1);
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) throw new Error(t("scheduler-panel.22"));
    return { kind: "weekly", dayOfWeek: dayOfWeek as 0 | 1 | 2 | 3 | 4 | 5 | 6, timeOfDay };
  }
  if (kind === "interval") {
    const every = Number(schedulerIntervalEveryInput?.value ?? 1);
    const unit = schedulerIntervalUnitInput?.value === "hours" ? "hours" : "minutes";
    if (!Number.isInteger(every) || every <= 0) throw new Error(t("scheduler-panel.23"));
    if (unit === "minutes" && every > 1440) throw new Error(t("scheduler-panel.24"));
    if (unit === "hours" && every > 168) throw new Error(t("scheduler-panel.25"));
    return { kind: "interval", every, unit };
  }
  const timeOfDay = schedulerTimeOfDayInput?.value || "08:00";
  if (!isValidTimeOfDay(timeOfDay)) throw new Error(t("scheduler-panel.26"));
  return { kind: "daily", timeOfDay };
}

export function collectAllowedToolIds(): string[] {
  if (!schedulerToolPicker) return [];
  return Array.from(schedulerToolPicker.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')).map(input => input.value);
}

export async function saveSchedulerTask(): Promise<void> {
  try {
    setSchedulerStatus(t("scheduler-panel.27"));
    const title = (schedulerTitleInput?.value ?? "").trim();
    const prompt = (schedulerPromptInput?.value ?? "").trim();
    if (!title) throw new Error(t("scheduler-panel.28"));
    if (!prompt) throw new Error(t("scheduler-panel.29"));
    const editingTask = schedulerState.tasks.find(t => t.id === schedulerState.editingTaskId);
    const isPluginTask = Boolean(editingTask?.ownerPluginId);
    const input = {
      title,
      prompt,
      // 插件任务没有 enabled：编辑器里的启用勾选是用户授权，保存后由主进程按新规格写入指纹
      ...(isPluginTask
        ? { pluginUserEnabled: schedulerEnabledInput?.checked ?? true }
        : { enabled: schedulerEnabledInput?.checked ?? true }),
      schedule: collectSchedule(),
      toolMode: isPluginTask || schedulerToolLimitInput?.checked ? "allow-list" : "all-enabled",
      allowedToolIds: collectAllowedToolIds(),
    };
    const result = schedulerState.editingTaskId
      ? await window.cyreneScheduler!.update(schedulerState.editingTaskId, input)
      : await window.cyreneScheduler!.add(input);
    if (!result.ok) throw new Error(result.error ?? t("scheduler-panel.30"));
    await loadSchedulerPanel();
    closeSchedulerEditor();
  } catch (err) {
    setSchedulerStatus(err instanceof Error ? err.message : String(err), "is-error");
  }
}

/**
 * 启用插件任务前弹出确认：启用即用户对该任务执行规格的一次明确授权，
 * 确认后主进程写入授权指纹，插件再改动规格会立刻失去授权。
 */
async function confirmPluginTaskEnable(task: ScheduledTask): Promise<boolean> {
  const promptPreview = task.prompt.length > 120 ? `${task.prompt.slice(0, 120)}…` : task.prompt;
  const tools = task.allowedToolIds.length ? task.allowedToolIds.join(", ") : t("scheduler-panel.31");
  const message = [
    t("scheduler-panel.48", { id: task.ownerPluginId }),
    t("scheduler-panel.49", { schedule: describeSchedule(task.schedule) }),
    t("scheduler-panel.50", { prompt: promptPreview }),
    t("scheduler-panel.51", { mode: task.mode ?? "work" }),
    t("scheduler-panel.52", { tools }),
  ].join(" · ");
  return showModal({ title: t("scheduler-panel.32"), message, confirmText: t("scheduler-panel.33") });
}

export async function toggleSchedulerTask(task: ScheduledTask, enabled: boolean): Promise<void> {
  if (enabled && task.ownerPluginId) {
    const confirmed = await confirmPluginTaskEnable(task);
    if (!confirmed) return;
  }
  const result = await window.cyreneScheduler!.toggle(task.id, enabled);
  if (!result.ok) window.alert(result.error ?? t("scheduler-panel.34"));
  await loadSchedulerPanel();
}

export async function fireSchedulerTask(id: string): Promise<void> {
  const result = await window.cyreneScheduler!.fireNow(id);
  if (!result.ok) {
    const message = result.reason === "task already running"
      ? t("scheduler-panel.35")
      : result.reason === "plugin not running"
        ? t("scheduler-panel.36")
        : (result.error ?? result.reason ?? t("scheduler-panel.37"));
    window.alert(message);
  }
}

export async function deleteSchedulerTask(id: string): Promise<void> {
  const ok = await showModal({ title: t("scheduler-panel.38"), message: t("scheduler-panel.39"), icon: '<svg width="18" height="18" viewBox="0 0 48 48" fill="none" aria-hidden="true" style="vertical-align:-2px"><path fill-rule="evenodd" clip-rule="evenodd" d="M8 15H40L37 44H11L8 15Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M20.002 25.0024V35.0026" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M28.0024 24.9995V34.9972" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M12 14.9999L28.3242 3L36 15" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>', confirmText: t("scheduler-panel.40") });
  if (!ok) return;
  const result = await window.cyreneScheduler!.delete(id);
  if (!result.ok) window.alert(result.error ?? t("scheduler-panel.41"));
  await loadSchedulerPanel();
}

export async function toggleSchedulerHistory(taskId: string, card: Element): Promise<void> {
  const box = card.querySelector(".scheduler-history") as HTMLDivElement | null;
  if (!box) return;
  if (!box.classList.contains("is-hidden")) {
    box.classList.add("is-hidden");
    return;
  }
  const result = await window.cyreneScheduler!.getHistory(taskId, 10);
  const rows = result.value ?? [];
  box.replaceChildren();
  if (!result.ok || rows.length === 0) {
    box.textContent = result.ok ? t("scheduler-panel.42") : (result.error ?? t("scheduler-panel.43"));
  } else {
    for (const row of rows) {
      const div = document.createElement("div");
      div.textContent = `${formatSchedulerDate(row.firedAt)} ${row.status}${row.durationMs ? ` ${Math.round(row.durationMs / 100) / 10}s` : ""}：${row.outputPreview ?? row.errorMessage ?? row.reason ?? ""}`;
      box.appendChild(div);
    }
  }
  box.classList.remove("is-hidden");
}
