import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { ViewName } from "./state.ts";

export type FocusArea = "editor" | "main";

export type Action =
  | { kind: "exit" }
  | { kind: "view"; view: ViewName }
  | { kind: "move"; delta: number }
  | { kind: "activate" }
  | { kind: "answer" }
  | { kind: "resume" }
  | { kind: "retry" }
  | { kind: "cancel" }
  | { kind: "open-session" }
  | { kind: "refresh" }
  | { kind: "cycle-filter" }
  | { kind: "abort" }
  | { kind: "scroll"; delta: number }
  | { kind: "command" };

export interface KeyContext {
  view: ViewName;
  focus: FocusArea;
  piRunning: boolean;
}

const ALT_VIEW_KEYS = [
  ["alt+1", "chat"],
  ["alt+2", "tasks"],
  ["alt+3", "workers"],
  ["alt+4", "events"],
] as const satisfies readonly (readonly [string, ViewName])[];

const ALT_DIGIT_VIEWS: Record<string, ViewName> = {
  "\x1b1": "chat",
  "\x1b2": "tasks",
  "\x1b3": "workers",
  "\x1b4": "events",
};

function altDigitView(data: string): ViewName | null {
  const raw = ALT_DIGIT_VIEWS[data];
  if (raw) return raw;
  for (const [key, view] of ALT_VIEW_KEYS) {
    if (matchesKey(data, key)) return view;
  }
  return null;
}

/** Maps one raw terminal chunk to an app action. Unmapped input reaches the focused component. */
export function mapKey(data: string, context: KeyContext): Action | null {
  if (matchesKey(data, Key.ctrl("c"))) return { kind: "exit" };
  if (context.view === "session") {
    // The nested session view owns Esc and scrolling; Alt+1..4 stay disabled
    // so the only way back is the documented Esc -> Task Detail chain.
    if (matchesKey(data, Key.escape)) return { kind: "view", view: "detail" };
    if (matchesKey(data, "j") || matchesKey(data, Key.down)) return { kind: "scroll", delta: 1 };
    if (matchesKey(data, "k") || matchesKey(data, Key.up)) return { kind: "scroll", delta: -1 };
    if (matchesKey(data, "r")) return { kind: "refresh" };
    return null;
  }
  const view = altDigitView(data);
  if (view) return { kind: "view", view };

  if (context.focus === "editor") {
    if (matchesKey(data, Key.escape) && context.piRunning) return { kind: "abort" };
    return null;
  }

  if (matchesKey(data, "/")) return { kind: "command" };
  if (context.view === "tasks" && matchesKey(data, "f")) return { kind: "cycle-filter" };
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
    if (matchesKey(data, Key.escape)) return { kind: "view", view: "tasks" };
    if (matchesKey(data, "v")) return { kind: "open-session" };
    if (matchesKey(data, "a")) return { kind: "answer" };
    if (matchesKey(data, "s")) return { kind: "resume" };
    if (matchesKey(data, "t")) return { kind: "retry" };
    if (matchesKey(data, "c")) return { kind: "cancel" };
  }
  if (matchesKey(data, "r")) return { kind: "refresh" };
  return null;
}
