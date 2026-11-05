import {
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";

import { clamp, VIEW_LABELS, VIEW_ORDER, type ViewName } from "../state.ts";
import { bold, cyan, dim, gray, green, inverse, red, yellow } from "./theme.ts";

export class LinesPane implements Component {
  lines: string[] = [];

  setLines(lines: string[]): void {
    this.lines = lines;
  }

  render(width: number): string[] {
    const safe = Math.max(1, width);
    return this.lines.map((line) => truncateToWidth(line, safe));
  }

  invalidate(): void {}
}

export interface SidebarModel {
  current: ViewName;
  focused: boolean;
  tasksWaiting: number;
  detailWaiting: boolean;
  workers: number;
  unreadEvents: number;
}

export class SidebarPane implements Component {
  cursor = 0;
  private readonly getModel: () => SidebarModel;
  private readonly onActivate: (view: ViewName) => void;

  constructor(
    getModel: () => SidebarModel,
    onActivate: (view: ViewName) => void,
  ) {
    this.getModel = getModel;
    this.onActivate = onActivate;
  }

  syncToCurrent(): void {
    this.cursor = Math.max(0, VIEW_ORDER.indexOf(this.getModel().current));
  }

  render(width: number): string[] {
    const safe = Math.max(1, width);
    const model = this.getModel();
    const rows: string[] = [
      bold(model.focused ? "super-RLM L3  [focus]" : "super-RLM L3"),
      gray("\u2500".repeat(Math.max(1, Math.min(24, safe)))),
      "",
    ];
    for (let index = 0; index < VIEW_ORDER.length; index += 1) {
      const view = VIEW_ORDER[index];
      const selected = index === this.cursor;
      const current = view === model.current;
      const marker = current ? cyan("\u25cf") : " ";
      let suffix = "";
      if (view === "tasks" && model.tasksWaiting > 0) suffix = yellow(` \u25cf ${model.tasksWaiting}`);
      if (view === "detail" && model.detailWaiting) suffix = yellow(" ?");
      if (view === "workers" && model.workers > 0) suffix = gray(` ${model.workers}`);
      if (view === "events" && model.unreadEvents > 0) suffix = yellow(` \u25cf ${model.unreadEvents}`);
      const label = `${marker} ${VIEW_LABELS[view]}${suffix}`;
      rows.push(selected ? inverse(truncateToWidth(label, safe)) : truncateToWidth(label, safe));
    }
    rows.push("", gray("Ctrl+1-5: view"), gray("^C: exit"));
    return rows.map((row) => truncateToWidth(row, safe));
  }

  invalidate(): void {}
}

export interface StatusModel {
  projectId: string;
  orchestrator: boolean;
  worker: boolean;
  sse: boolean;
  pi: string;
}

export class StatusBar implements Component {
  private readonly getModel: () => StatusModel;

  constructor(getModel: () => StatusModel) {
    this.getModel = getModel;
  }

  render(width: number): string[] {
    const model = this.getModel();
    const dot = (on: boolean, label: string) => `${on ? green("\u25cf") : red("\u25cb")} ${label}`;
    const parts = [
      bold(cyan("super-RLM")),
      gray(model.projectId),
      dot(model.orchestrator, "orch"),
      dot(model.worker, "worker"),
      dot(model.sse, "sse"),
      `${model.pi === "error" ? red("\u25cf") : model.pi === "idle" ? green("\u25cf") : yellow("\u25cf")} pi:${model.pi}`,
    ];
    return [truncateToWidth(parts.join("  "), Math.max(1, width))];
  }

  invalidate(): void {}
}

export class Footer implements Component {
  text = "";
  private transient = "";

  setTransient(message: string): void {
    this.transient = message;
  }

  render(width: number): string[] {
    const safe = Math.max(1, width);
    const help = this.text ? dim(this.text) : "";
    if (!this.transient) return [truncateToWidth(help, safe)];
    return [truncateToWidth(help, safe), truncateToWidth(yellow(this.transient), safe)];
  }

  invalidate(): void {}
}

export type ChatKind = "user" | "assistant" | "tool" | "system" | "error";

export interface ChatLine {
  kind: ChatKind;
  text: string;
}

export class ChatPane implements Component {
  lines: ChatLine[] = [];

  setLines(lines: ChatLine[]): void {
    this.lines = lines;
  }

  render(width: number): string[] {
    const safe = Math.max(1, width);
    const out: string[] = [];
    for (const line of this.lines) {
      const prefix = line.kind === "user"
        ? cyan("you  ")
        : line.kind === "assistant"
          ? green("pi   ")
          : line.kind === "tool"
            ? dim("tool ")
            : line.kind === "error"
              ? red("err  ")
              : gray("     ");
      const body = wrapTextWithAnsi(line.text || " ", Math.max(8, safe - 5));
      for (let index = 0; index < body.length; index += 1) {
        out.push(truncateToWidth(`${index === 0 ? prefix : "     "}${body[index]}`, safe));
      }
    }
    if (out.length === 0) out.push(dim("Ask the Router. Enter sends; Esc aborts a running turn."));
    return out;
  }

  invalidate(): void {}
}
