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
 * Full-screen two-stage picker: choose a Profile, then choose its model.
 * Left/right changes thinking on the model page; Esc goes back one level.
 */
export class ModelSelector implements Component, Focusable {
  readonly profiles: SelectorProfile[];
  readonly models: SelectorModel[];
  stage: "profiles" | "model" = "profiles";
  selectedProfile = 0;
  selectedModel = 0;
  error: string | null = null;
  notice: string | null = null;
  onChange: (() => void) | null = null;
  onApply: ((profile: SelectorProfile) => void) | null = null;
  onClose: (() => void) | null = null;
  private focusedFlag = false;

  constructor(profiles: SelectorProfile[], models: SelectorModel[]) {
    this.profiles = profiles;
    this.models = models;
  }

  get focused(): boolean {
    return this.focusedFlag;
  }

  set focused(value: boolean) {
    this.focusedFlag = value;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.error = null;
      this.notice = null;
      if (this.stage === "model") {
        this.stage = "profiles";
        this.changed();
      } else {
        this.onClose?.();
      }
      return;
    }

    if (this.stage === "profiles") {
      if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
        const delta = matchesKey(data, Key.up) ? -1 : 1;
        this.selectedProfile = wrapIndex(this.selectedProfile + delta, this.profiles.length);
        this.changed();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        this.stage = "model";
        this.syncModelToProfile();
        this.error = null;
        this.notice = null;
        this.changed();
      }
      return;
    }

    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      const delta = matchesKey(data, Key.up) ? -1 : 1;
      this.selectedModel = wrapIndex(this.selectedModel + delta, this.models.length);
      this.changed();
      return;
    }
    if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      this.adjustThinking(matchesKey(data, Key.left) ? -1 : 1);
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
    this.notice = null;
    this.changed();
  }

  setNotice(message: string | null): void {
    this.notice = message;
    this.error = null;
    this.changed();
  }

  updateProfile(key: string, patch: Partial<SelectorProfile>): void {
    const profile = this.profiles.find((entry) => entry.key === key);
    if (profile) Object.assign(profile, patch);
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
    profile.thinking = THINKING_LEVELS[(index + delta + THINKING_LEVELS.length) % THINKING_LEVELS.length];
  }

  private syncModelToProfile(): void {
    const profile = this.profiles[this.selectedProfile];
    if (!profile) return;
    const index = this.models.findIndex((model) => model.provider === profile.provider && model.id === profile.model);
    this.selectedModel = index >= 0 ? index : 0;
  }

  private changed(): void {
    this.onChange?.();
  }

  render(width: number): string[] {
    const safe = Math.max(24, width);
    const lines = this.stage === "profiles" ? this.renderProfiles(safe) : this.renderModel(safe);
    return lines.map((line) => truncateToWidth(line, safe));
  }

  private renderProfiles(width: number): string[] {
    const lines: string[] = [
      bold("Model & Profiles"),
      dim("↑↓ select · Enter model selection · Esc close"),
      "",
    ];
    for (let index = 0; index < this.profiles.length; index += 1) {
      const profile = this.profiles[index];
      const marker = index === this.selectedProfile ? cyan("▸") : " ";
      const label = `${marker} ${profile.label}`;
      const detail = `${profile.provider}/${profile.model}  thinking:${profile.thinking}  ctx:${profile.contextWindow ? formatTokens(profile.contextWindow) : "?"}`;
      const row = `${label.padEnd(20)}  ${detail}`;
      lines.push(index === this.selectedProfile ? inverse(truncateToWidth(row, width)) : truncateToWidth(row, width));
    }
    if (this.profiles.length === 0) lines.push(dim("No profiles available."));
    if (this.notice) lines.push("", green(this.notice));
    if (this.error) lines.push("", red(this.error));
    return lines;
  }

  private renderModel(width: number): string[] {
    const profile = this.profiles[this.selectedProfile];
    const draft = this.currentProfile();
    const lines: string[] = [
      bold(`Model · ${profile?.label ?? "Profile"}`),
      dim("↑↓ model · ←→ thinking · Enter apply · Esc back"),
      "",
    ];
    const start = visibleStart(this.selectedModel, this.models.length, 16);
    const visible = this.models.slice(start, start + 16);
    for (let row = 0; row < visible.length; row += 1) {
      const model = visible[row];
      const index = start + row;
      const marker = index === this.selectedModel ? cyan("▸") : " ";
      const current = profile && model.provider === profile.provider && model.id === profile.model ? "  *" : "";
      const context = model.contextWindow ? `  ctx:${formatTokens(model.contextWindow)}` : "";
      const label = `${marker} ${model.provider}/${model.id}${context}${current}`;
      lines.push(index === this.selectedModel ? inverse(truncateToWidth(label, width)) : truncateToWidth(label, width));
    }
    if (this.models.length === 0) lines.push(dim("No models available."));
    if (start > 0 || start + 16 < this.models.length) {
      lines.push(dim(`models ${start + 1}-${Math.min(start + 16, this.models.length)} of ${this.models.length}`));
    }
    lines.push("");
    if (draft) {
      const thinking = `${yellow("←")} ${bold(draft.thinking)} ${yellow("→")}`;
      const context = draft.contextWindow ? formatTokens(draft.contextWindow) : "?";
      lines.push(`${gray(draft.provider + "/" + draft.model)}  thinking:${thinking}  ctx:${context}`);
    }
    if (this.notice) lines.push("", green(this.notice));
    if (this.error) lines.push("", red(this.error));
    return lines;
  }

  invalidate(): void {}
}

function wrapIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return (index + count) % count;
}

function visibleStart(selected: number, count: number, size: number): number {
  if (count <= size) return 0;
  return Math.max(0, Math.min(count - size, selected - Math.floor(size / 2)));
}
