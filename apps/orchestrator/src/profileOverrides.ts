/**
 * Model-selection overrides for Worker profiles.
 *
 * The TUI writes these as `<SUPER_RLM_HOME>/profiles.overrides.json`; the
 * Orchestrator applies them on top of config/profiles.yaml at startup. The file
 * is a flat object of profile name to a partial provider/model/thinking patch.
 *
 * Validation is strict. A malformed file or an invalid entry is a startup
 * error: silently ignoring it would run Tickets with model settings the
 * operator did not intend. `super-rlm profiles reset` is the repair path.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

import type { ThinkingLevel } from "../../../packages/protocol/ts/index.ts";
import {
  THINKING_LEVELS,
  updateProfile,
  type ProfilesConfig,
} from "./profiles.ts";

export interface ProfileOverride {
  provider?: string;
  model?: string;
  thinking?: ThinkingLevel;
}

export type ProfileOverrides = Record<string, ProfileOverride>;

const OVERRIDE_FIELDS = new Set(["provider", "model", "thinking"]);

function invalid(source: string, message: string): Error {
  return new Error(`invalid profile overrides ${source}: ${message}`);
}

function overrideText(value: unknown, source: string, name: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw invalid(source, `${name}.${field} must be a non-empty string`);
  }
  return value.trim();
}

/** Parse and validate an already-decoded overrides document. */
export function parseProfileOverrides(raw: unknown, source: string): ProfileOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalid(source, "top level must be an object mapping profile names to overrides");
  }
  const overrides: ProfileOverrides = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!name.trim()) throw invalid(source, "profile name must be non-empty");
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw invalid(source, `${name} must be an object`);
    }
    const entry = value as Record<string, unknown>;
    for (const field of Object.keys(entry)) {
      if (!OVERRIDE_FIELDS.has(field)) {
        throw invalid(source, `${name} has unknown field ${JSON.stringify(field)}; allowed fields are provider, model, thinking`);
      }
    }
    const patch: ProfileOverride = {};
    if ("provider" in entry) patch.provider = overrideText(entry.provider, source, name, "provider");
    if ("model" in entry) patch.model = overrideText(entry.model, source, name, "model");
    if ("thinking" in entry) {
      if (typeof entry.thinking !== "string" || !(THINKING_LEVELS as readonly string[]).includes(entry.thinking)) {
        throw invalid(source, `${name}.thinking must be one of ${THINKING_LEVELS.join(", ")}`);
      }
      patch.thinking = entry.thinking as ThinkingLevel;
    }
    if (Object.keys(patch).length === 0) {
      throw invalid(source, `${name} must set at least one of provider, model, thinking`);
    }
    overrides[name] = patch;
  }
  return overrides;
}

/** Load overrides from disk. A missing file means no overrides. */
export function loadProfileOverrides(path: string): ProfileOverrides {
  if (!existsSync(path)) return {};
  let rawText: string;
  try {
    rawText = readFileSync(path, "utf8");
  } catch (error) {
    throw invalid(path, `cannot read file: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw invalid(path, `malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseProfileOverrides(parsed, path);
}

/**
 * Apply validated overrides to loaded profiles.
 *
 * Unknown profile names are rejected: a stale override after a profiles.yaml
 * rename must be fixed, not ignored. All names are checked before any profile
 * is mutated, so a failed apply leaves the config untouched.
 */
export function applyProfileOverrides(config: ProfilesConfig, overrides: ProfileOverrides, source: string): void {
  for (const name of Object.keys(overrides)) {
    if (!config.profiles[name]) {
      throw invalid(source, `unknown profile ${JSON.stringify(name)}`);
    }
  }
  for (const [name, patch] of Object.entries(overrides)) {
    updateProfile(config, name, patch);
  }
}

/**
 * Write the JSON document through a temporary file in the same directory,
 * fsync it, then rename it over the target. A failed write leaves the previous
 * file intact and removes the temporary file.
 */
function atomicWriteJson(path: string, value: unknown): void {
  const directory = dirname(path);
  const temporary = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  let fd: number | undefined;
  try {
    mkdirSync(directory, { recursive: true });
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* the original error is more useful */ }
    }
    try { unlinkSync(temporary); } catch { /* nothing to clean up */ }
    throw new Error(`cannot write profile overrides ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (process.platform !== "win32") {
    try {
      const directoryFd = openSync(directory, "r");
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    } catch {
      // Directory fsync is best effort and unsupported on some filesystems.
    }
  }
}

/**
 * Persist one profile's model selection. Existing overrides for other profiles
 * are preserved. The whole provider/model/thinking snapshot is written so the
 * override stays complete if profiles.yaml later changes.
 */
export function saveProfileOverride(path: string, name: string, override: ProfileOverride): ProfileOverrides {
  const overrides = loadProfileOverrides(path);
  const snapshot: ProfileOverride = {};
  if (override.provider !== undefined) snapshot.provider = override.provider;
  if (override.model !== undefined) snapshot.model = override.model;
  if (override.thinking !== undefined) snapshot.thinking = override.thinking;
  overrides[name] = snapshot;
  atomicWriteJson(path, overrides);
  return overrides;
}

export interface ResetResult {
  /** Override names removed by this call. */
  removed: string[];
  /** True when the overrides file itself was deleted. */
  fileRemoved: boolean;
}

/**
 * Remove overrides so the next Orchestrator start uses config/profiles.yaml.
 *
 * `name === null` clears all overrides and tolerates a malformed file, which
 * makes it the repair path when startup is blocked by a broken override.
 * A single-name reset does not require the name to still exist in
 * profiles.yaml, so stale entries can be removed. A missing file or missing
 * entry is a successful no-op.
 */
export function resetProfileOverrides(path: string, name: string | null): ResetResult {
  if (!existsSync(path)) return { removed: [], fileRemoved: false };
  if (name === null) {
    let removed: string[] = [];
    try {
      removed = Object.keys(loadProfileOverrides(path)).sort();
    } catch {
      // Clear-all still discards the broken file; that is the point of the repair path.
    }
    unlinkSync(path);
    return { removed, fileRemoved: true };
  }
  const overrides = loadProfileOverrides(path);
  if (!(name in overrides)) return { removed: [], fileRemoved: false };
  delete overrides[name];
  if (Object.keys(overrides).length === 0) {
    unlinkSync(path);
    return { removed: [name], fileRemoved: true };
  }
  atomicWriteJson(path, overrides);
  return { removed: [name], fileRemoved: false };
}
