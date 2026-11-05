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
  | { kind: "cycle-filter" }
  | { kind: "back" }
  | { kind: "abort" }
  | { kind: "scroll"; delta: number }
  | { kind: "command" }
  | { kind: "leader" };

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
  ["f1", "chat"],
  ["f2", "tasks"],
  ["f3", "detail"],
  ["f4", "workers"],
  ["f5", "events"],
] as const satisfies readonly (readonly [string, ViewName])[];

const ALT_DIGIT_VIEWS: Record<string, ViewName> = {
  "\x1b1": "chat",
  "\x1b2": "tasks",
  "\x1b3": "detail",
  "\x1b4": "workers",
  "\x1b5": "events",
};

const CTRL_DIGIT_VIEWS: Record<string, ViewName> = {
  "1": "chat",
  "2": "tasks",
  "3": "detail",
  "4": "workers",
  "5": "events",
};

/** Ctrl+digit is encoded differently by Kitty, xterm modifyOtherKeys, and some terminals. */
function ctrlDigitView(data: string): ViewName | null {
  const kitty = /^\x1b\[(49|50|51|52|53);5u$/.exec(data);
  if (kitty) return CTRL_DIGIT_VIEWS[String(Number(kitty[1]) - 48)] ?? null;
  const digit = /^\x1b\[([1-5]);5u$/.exec(data);
  if (digit) return CTRL_DIGIT_VIEWS[digit[1]] ?? null;
  const modifyOther = /^\x1b\[27;5;(49|50|51|52|53)~$/.exec(data);
  if (modifyOther) return CTRL_DIGIT_VIEWS[String(Number(modifyOther[1]) - 48)] ?? null;
  return null;
}

/** Maps one raw terminal chunk to an app action. Unmapped input reaches the focused component. */
export function mapKey(data: string, context: KeyContext): Action | null {
  if (matchesKey(data, Key.ctrl("c"))) return { kind: "exit" };
  if (matchesKey(data, Key.ctrl("k"))) return { kind: "leader" };
  const altDigit = ALT_DIGIT_VIEWS[data];
  if (altDigit) return { kind: "view", view: altDigit };
  for (const [key, view] of VIEW_KEYS) {
    if (matchesKey(data, key)) return { kind: "view", view };
  }
  const ctrlDigit = ctrlDigitView(data);
  if (ctrlDigit) return { kind: "view", view: ctrlDigit };

  if (context.focus === "editor") {
    if (matchesKey(data, Key.escape) && context.piRunning) return { kind: "abort" };
    return null;
  }

  if (matchesKey(data, "/")) return { kind: "command" };
  if (context.view === "tasks" && matchesKey(data, "f")) return { kind: "cycle-filter" };
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
