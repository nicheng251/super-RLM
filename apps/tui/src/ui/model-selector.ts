import {
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";

import { THINKING_LEVELS, type ThinkingLevel } from "../commands.ts";
import { bold, cyan, dim, gray, green, inverse, red, yellow } from "./theme.ts";
import { formatTokens } from "./panes.ts";

export interface SelectorProfile {
  key: string;
  label: string;
  kind: "router" | "worker";
  provider: string;
  model: string;
  thinking: ThinkingLevel;
  contextWindow: number | null;
}

export interface SelectorModel {
  provider: string;
  id: string;
  contextWindow: number | null;
  reasoning?: boolean;
}

/**
 * Full-width overlay for choosing a model and thinking level for the Router
 * and for each Worker profile. Left/right changes thinking; up/down moves.
 */
export class ModelSelector implements Component, Focusable {
  readonly profiles: SelectorProfile[];
  readonly models: SelectorModel[];
  selectedProfile = 0;
  selectedModel = 0;
  pane: "profiles" | "models" = "profiles";
  error: string | null = null;
  onChange: (() => void) | null = null;
  onApply: ((profile: SelectorProfile) => void) | null = null;
  onClose: (() => void) | null = null;
  private focusedFlag = false;

  constructor(profiles: SelectorProfile[], models: SelectorModel[]) {
    this.profiles = profiles;
    this.models = models;
    this.syncModelToProfile();
  }

  get focused(): boolean {
    return this.focusedFlag;
  }

  set focused(value: boolean) {
    this.focusedFlag = value;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.onClose?.();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.pane = this.pane === "profiles" ? "models" : "profiles";
      this.changed();
      return;
    }
    if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      this.adjustThinking(matchesKey(data, Key.left) ? -1 : 1);
      this.changed();
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      const delta = matchesKey(data, Key.up) ? -1 : 1;
      if (this.pane === "profiles") {
        this.selectedProfile = wrapIndex(this.selectedProfile + delta, this.profiles.length);
        this.syncModelToProfile();
      } else {
        this.selectedModel = wrapIndex(this.selectedModel + delta, this.models.length);
      }
      this.changed();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const profile = this.currentProfile();
      if (profile) this.onApply?.(profile);
    }
  }

  setError(message: string | null): void {
    this.error = message;
    this.changed();
  }

  currentProfile(): SelectorProfile | null {
    const profile = this.profiles[this.selectedProfile];
    if (!profile) return null;
    const model = this.models[this.selectedModel];
    return model
      ? {
          ...profile,
          provider: model.provider,
          model: model.id,
          contextWindow: model.contextWindow,
        }
      : profile;
  }

  private adjustThinking(delta: number): void {
    const profile = this.profiles[this.selectedProfile];
    if (!profile) return;
    const index = THINKING_LEVELS.indexOf(profile.thinking);
    const next = THINKING_LEVELS[(index + delta + THINKING_LEVELS.length) % THINKING_LEVELS.length];
    profile.thinking = next;
  }

  private syncModelToProfile(): void {
    const profile = this.profiles[this.selectedProfile];
    if (!profile) return;
    const index = this.models.findIndex((model) => model.provider === profile.provider && model.id === profile.model);
    if (index >= 0) this.selectedModel = index;
  }

  private changed(): void {
    this.onChange?.();
  }

  render(width: number): string[] {
    const safe = Math.max(24, width);
    const draft = this.currentProfile();
    const lines: string[] = [
      bold("Model & Profiles"),
      dim("Tab switch panes · ↑↓ select · ←→ thinking · Enter apply · Esc close"),
      "",
    ];

    const leftWidth = Math.min(22, Math.max(14, Math.floor(safe / 4)));
    const rightWidth = Math.max(10, safe - leftWidth - 3);
    const modelStart = visibleStart(this.selectedModel, this.models.length, 10);
    const modelRows = this.models.slice(modelStart, modelStart + 10);
    const rows = Math.max(this.profiles.length, modelRows.length);

    const leftHeader = "Profiles";
    const rightHeader = "Models";
    lines.push(`${dim(leftHeader.padEnd(leftWidth))}   ${dim(rightHeader)}`);

    for (let row = 0; row < rows; row += 1) {
      const profileRow = this.profiles[row];
      const modelRow = modelRows[row];
      let left = "";
      if (profileRow) {
        const marker = row === this.selectedProfile ? cyan("▸") : " ";
        const label = `${marker} ${profileRow.label}`;
        left = row === this.selectedProfile && this.pane === "profiles" ? inverse(truncateToWidth(label, leftWidth)) : truncateToWidth(label, leftWidth);
      }
      let right = "";
      if (modelRow) {
        const index = modelStart + row;
        const marker = index === this.selectedModel ? cyan("▸") : " ";
        const context = modelRow.contextWindow ? ` ctx:${formatTokens(modelRow.contextWindow)}` : "";
        const label = `${marker} ${modelRow.provider}/${modelRow.id}${context}`;
        right = index === this.selectedModel && this.pane === "models" ? inverse(truncateToWidth(label, rightWidth)) : truncateToWidth(label, rightWidth);
      }
      lines.push(`${pad(left, leftWidth)}   ${right}`);
    }

    if (modelStart > 0 || modelStart + 10 < this.models.length) {
      lines.push(dim(`models ${modelStart + 1}-${Math.min(modelStart + 10, this.models.length)} of ${this.models.length}`));
    }
    lines.push("");
    if (draft) {
      const thinking = `${yellow("←")} ${bold(draft.thinking)} ${yellow("→")}`;
      const context = draft.contextWindow ? formatTokens(draft.contextWindow) : "?";
      lines.push(`${bold(draft.label)}  ${gray(draft.provider + "/" + draft.model)}  thinking:${thinking}  ctx:${context}`);
    }
    if (this.error) lines.push(red(this.error));
    return lines.map((line) => truncateToWidth(line, safe));
  }

  invalidate(): void {}
}

function pad(text: string, width: number): string {
  const visible = visibleWidth(text);
  return visible >= width ? truncateToWidth(text, width) : text + " ".repeat(width - visible);
}

function visibleWidth(text: string): number {
  return truncateToWidth(text, 10000).replace(/\x1b\[[0-9;]*m/g, "").length;
}

function wrapIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return (index + count) % count;
}

function visibleStart(selected: number, count: number, size: number): number {
  if (count <= size) return 0;
  return Math.max(0, Math.min(count - size, selected - Math.floor(size / 2)));
}
