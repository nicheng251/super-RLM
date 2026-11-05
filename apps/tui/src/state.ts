import { isTerminalTaskStatus, type Event, type TaskListItem, type WorkerView } from "../../../packages/protocol/ts/index.ts";

export type { WorkerView };

export type ViewName = "chat" | "tasks" | "detail" | "workers" | "events";

export const VIEW_ORDER: readonly ViewName[] = ["chat", "tasks", "workers", "events"];
export const VIEW_LABELS: Record<ViewName, string> = {
  chat: "Chat",
  tasks: "Tasks",
  detail: "Task Detail",
  workers: "Workers",
  events: "Events",
};

export type TaskFilter = "all" | "waiting" | "running" | "terminal";

export const TASK_FILTERS: readonly TaskFilter[] = ["all", "waiting", "running", "terminal"];

export function nextTaskFilter(filter: TaskFilter): TaskFilter {
  const index = TASK_FILTERS.indexOf(filter);
  return TASK_FILTERS[(index + 1) % TASK_FILTERS.length];
}

export type PiStatus = "starting" | "idle" | "running" | "error";

export interface ServiceHealth {
  orchestrator: boolean;
  worker: boolean;
  sse: boolean;
  pi: PiStatus;
}

export interface AppState {
  view: ViewName;
  previousView: ViewName;
  filter: TaskFilter;
  query: string;
  workers: WorkerView[];
  events: Event[];
  eventCursor: number;
  unreadEvents: number;
  health: ServiceHealth;
}

export function createState(): AppState {
  return {
    view: "chat",
    previousView: "chat",
    filter: "all",
    query: "",
    workers: [],
    events: [],
    eventCursor: 0,
    unreadEvents: 0,
    health: { orchestrator: false, worker: false, sse: false, pi: "starting" },
  };
}

export function clamp(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, index));
}

/** Applies the task status bucket and a case-insensitive task id/prompt search. */
export function filterTasks(
  tasks: readonly TaskListItem[],
  filter: TaskFilter,
  query: string,
): TaskListItem[] {
  const needle = query.trim().toLowerCase();
  return tasks.filter((task) => {
    if (needle && !`${task.task_id}\n${task.prompt}`.toLowerCase().includes(needle)) return false;
    switch (filter) {
      case "all":
        return true;
      case "waiting":
        return task.status === "waiting" || task.waiting_count > 0;
      case "running":
        return task.status === "running" || task.running_count > 0;
      case "terminal":
        return isTerminalTaskStatus(task.status);
    }
  });
}

export function setView(state: AppState, view: ViewName): void {
  if (state.view !== view) state.previousView = state.view;
  state.view = view;
  if (view === "events") state.unreadEvents = 0;
}

export function waitingTaskCount(tasks: readonly TaskListItem[]): number {
  return tasks.reduce((total, task) => total + task.waiting_count, 0);
}

export function addEvent(state: AppState, event: Event): void {
  state.eventCursor = Math.max(state.eventCursor, event.event_id);
  state.events = [...state.events, event].slice(-200);
  if (state.view !== "events") state.unreadEvents += 1;
}

/** Formats a compact one-line event summary for the Events pane. */
export function formatEventLine(event: Event): string {
  const target = event.ticket_id ?? event.task_id ?? event.worker_id ?? "";
  const time = new Date(event.created_at);
  const stamp = Number.isNaN(time.getTime()) ? "--:--:--" : time.toISOString().slice(11, 19);
  const detail = summarizePayload(event.data);
  return `${stamp}  ${event.type.padEnd(20)} ${target}${detail ? `  ${detail}` : ""}`;
}

function summarizePayload(data: Record<string, unknown>): string {
  for (const key of ["title", "status", "summary", "reason", "message"]) {
    const value = data[key];
    if (typeof value === "string" && value) return value.length > 80 ? `${value.slice(0, 77)}...` : value;
  }
  return "";
}
