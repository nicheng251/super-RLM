import { Key, matchesKey } from "@earendil-works/pi-tui";
import { VIEW_ORDER, type ViewName } from "./state.ts";

export type FocusArea = "editor" | "sidebar" | "main";

export type Action =
  | { kind: "exit" }
  | { kind: "view"; view: ViewName }
  | { kind: "focus"; area: FocusArea }
  | { kind: "move"; delta: number }
  | { kind: "activate" }
  | { kind: "answer" }
  | { kind: "resume" }
  | { kind: "retry" }
  | { kind: "cancel" }
  | { kind: "refresh" }
  | { kind: "back" }
  | { kind: "abort" }
  | { kind: "scroll"; delta: number };

export interface KeyContext {
  view: ViewName;
  focus: FocusArea;
  piRunning: boolean;
}

const VIEW_KEYS = [
  ["ctrl+1", "chat"],
  ["ctrl+2", "tasks"],
  ["ctrl+3", "detail"],
  ["ctrl+4", "workers"],
  ["ctrl+5", "events"],
] as const satisfies readonly (readonly [string, ViewName])[];

/** Maps one raw terminal chunk to an app action. Unmapped input reaches the focused component. */
export function mapKey(data: string, context: KeyContext): Action | null {
  if (matchesKey(data, Key.ctrl("c"))) return { kind: "exit" };
  for (const [key, view] of VIEW_KEYS) {
    if (matchesKey(data, key)) return { kind: "view", view };
  }

  if (context.focus === "editor") {
    if (matchesKey(data, Key.tab)) return { kind: "focus", area: "sidebar" };
    if (matchesKey(data, Key.escape) && context.piRunning) return { kind: "abort" };
    return null;
  }
  if (context.focus === "sidebar") return null;

  if (matchesKey(data, Key.tab)) return { kind: "focus", area: "sidebar" };
  if (matchesKey(data, Key.escape)) {
    if (context.view === "chat") return null;
    return context.view === "detail" ? { kind: "back" } : { kind: "view", view: "chat" };
  }
  if (matchesKey(data, "q")) {
    if (context.view === "detail") return { kind: "back" };
    if (context.view !== "chat") return { kind: "view", view: "chat" };
  }
  if (matchesKey(data, "j") || matchesKey(data, Key.down)) {
    return context.view === "workers" || context.view === "events"
      ? { kind: "scroll", delta: 1 }
      : { kind: "move", delta: 1 };
  }
  if (matchesKey(data, "k") || matchesKey(data, Key.up)) {
    return context.view === "workers" || context.view === "events"
      ? { kind: "scroll", delta: -1 }
      : { kind: "move", delta: -1 };
  }
  if (matchesKey(data, Key.enter) && context.view === "tasks") return { kind: "activate" };
  if (context.view === "detail") {
    if (matchesKey(data, "a")) return { kind: "answer" };
    if (matchesKey(data, "s")) return { kind: "resume" };
    if (matchesKey(data, "t")) return { kind: "retry" };
    if (matchesKey(data, "c")) return { kind: "cancel" };
  }
  if (matchesKey(data, "r")) return { kind: "refresh" };
  return null;
}
