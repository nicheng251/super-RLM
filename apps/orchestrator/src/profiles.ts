/**
 * Named Worker profiles loaded from config/profiles.yaml.
 *
 * A profile is admin-defined capability: provider/model/thinking, timeout,
 * prepare and blocked commands, workspace layout, and delivery policy. The
 * Orchestrator resolves one into the protocol ExecutionOptions sent to a
 * Worker; profiles never contain credentials.
 */

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type {
  DeliveryCollision,
  DeliveryMode,
  DeliveryOptions,
  ExecutionOptions,
  ProfileSummary,
  ThinkingLevel,
  WorkspaceOptions,
} from "../../../packages/protocol/ts/index.ts";

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
];

export const DELIVERY_MODES: readonly DeliveryMode[] = ["artifacts", "workspace", "none"];
export const DELIVERY_COLLISIONS: readonly DeliveryCollision[] = ["version", "overwrite", "error"];

/** A simple command name: no arguments, paths, or shell syntax. */
const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface WorkspaceProfileConfig extends WorkspaceOptions {
  agent_cwd: string;
  artifact_root: string;
  metadata_command: string | null;
}

export interface DeliveryProfileConfig extends DeliveryOptions {
  mode: DeliveryMode;
  collision: DeliveryCollision;
  strip_prefix: string;
  workspace_subdir: string | null;
}

export interface ProfileConfig {
  name: string;
  description: string;
  provider: string;
  model: string;
  thinking: ThinkingLevel;
  timeout_s: number;
  prepare_command: string | null;
  blocked_commands: string[];
  workspace: WorkspaceProfileConfig;
  delivery: DeliveryProfileConfig;
}

export interface ProfilesConfig {
  profiles: Record<string, ProfileConfig>;
}

export function defaultProfilesPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../config/profiles.yaml");
}

function fail(message: string): never {
  throw new Error(`invalid profiles config: ${message}`);
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${what} must be a mapping`);
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${what} must be a non-empty string`);
  return value.trim();
}

function optionalText(value: unknown, what: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") fail(`${what} must be a string or null`);
  return value.trim() || null;
}

function descriptionText(value: unknown, what: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") fail(`${what} must be a string`);
  return value;
}

/** Relative paths must stay inside the Ticket workspace. */
export function safeRelativePath(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${what} must be a non-empty relative path`);
  const path = value.trim();
  if (isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.startsWith("\\") || path.startsWith("/")) {
    fail(`${what} must be relative: ${path}`);
  }
  if (path.split(/[\\/]+/).includes("..")) fail(`${what} must not contain '..': ${path}`);
  return path;
}

function commandNames(value: unknown, what: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(`${what} must be an array`);
  return value.map((item, index) => {
    if (typeof item !== "string" || !COMMAND_NAME.test(item)) {
      fail(`${what}[${index}] must be a simple command name`);
    }
    return item;
  });
}

function choice<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(`${what} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function profileEntries(raw: unknown): Array<{ name: string; value: Record<string, unknown> }> {
  if (Array.isArray(raw)) {
    return raw.map((item, index) => {
      const value = asObject(item, `profiles[${index}]`);
      return { name: requiredText(value.name, `profiles[${index}].name`), value };
    });
  }
  const object = asObject(raw, "profiles");
  return Object.entries(object).map(([name, item]) => ({
    name,
    value: asObject(item, `profiles.${name}`),
  }));
}

function parseProfile(name: string, raw: Record<string, unknown>): ProfileConfig {
  if (!name.trim()) fail("profile name must be non-empty");
  const workspaceRaw = raw.workspace === undefined ? {} : asObject(raw.workspace, `${name}.workspace`);
  const deliveryRaw = raw.delivery === undefined ? {} : asObject(raw.delivery, `${name}.delivery`);
  const timeout = raw.timeout_s ?? 3600;
  if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout <= 0) {
    fail(`${name}.timeout_s must be a positive integer`);
  }
  const stripPrefixRaw = deliveryRaw.strip_prefix ?? "";
  if (typeof stripPrefixRaw !== "string") fail(`${name}.delivery.strip_prefix must be a string`);
  const workspaceSubdir = deliveryRaw.workspace_subdir === undefined || deliveryRaw.workspace_subdir === null
    ? null
    : safeRelativePath(deliveryRaw.workspace_subdir, `${name}.delivery.workspace_subdir`);

  return {
    name,
    description: descriptionText(raw.description, `${name}.description`),
    provider: requiredText(raw.provider, `${name}.provider`),
    model: requiredText(raw.model, `${name}.model`),
    thinking: choice(raw.thinking ?? "medium", THINKING_LEVELS, `${name}.thinking`),
    timeout_s: timeout,
    prepare_command: optionalText(raw.prepare_command, `${name}.prepare_command`),
    blocked_commands: commandNames(raw.blocked_commands, `${name}.blocked_commands`),
    workspace: {
      agent_cwd: safeRelativePath(workspaceRaw.agent_cwd ?? ".", `${name}.workspace.agent_cwd`),
      artifact_root: safeRelativePath(workspaceRaw.artifact_root ?? ".", `${name}.workspace.artifact_root`),
      metadata_command: optionalText(workspaceRaw.metadata_command, `${name}.workspace.metadata_command`),
    },
    delivery: {
      mode: choice(deliveryRaw.mode ?? "artifacts", DELIVERY_MODES, `${name}.delivery.mode`),
      collision: choice(deliveryRaw.collision ?? "version", DELIVERY_COLLISIONS, `${name}.delivery.collision`),
      strip_prefix: stripPrefixRaw.trim()
        ? safeRelativePath(stripPrefixRaw, `${name}.delivery.strip_prefix`)
        : "",
      workspace_subdir: workspaceSubdir,
    },
  };
}

/** Load and validate profiles. The default path is <repoRoot>/config/profiles.yaml. */
export function loadProfiles(path?: string, env: NodeJS.ProcessEnv = process.env): ProfilesConfig {
  const configPath = path ?? env.SUPER_RLM_PROFILES_CONFIG ?? defaultProfilesPath();
  let rawText: string;
  try {
    rawText = readFileSync(configPath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read profiles config ${configPath}: ${reason}`);
  }
  let parsed: unknown;
  try {
    parsed = parse(rawText);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    fail(`cannot parse ${configPath}: ${reason}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(`top level must be a mapping: ${configPath}`);
  }
  const rawProfiles = (parsed as Record<string, unknown>).profiles;
  const entries = profileEntries(rawProfiles);
  if (entries.length === 0) fail("at least one profile is required");

  const profiles: Record<string, ProfileConfig> = {};
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.name)) fail(`duplicate profile name: ${entry.name}`);
    seen.add(entry.name);
    profiles[entry.name] = parseProfile(entry.name, entry.value);
  }
  if (!profiles.default) fail("the default profile is required");
  return { profiles };
}

export function profileSummary(profile: ProfileConfig): ProfileSummary {
  return {
    name: profile.name,
    description: profile.description,
    provider: profile.provider,
    model: profile.model,
    thinking: profile.thinking,
  };
}

/** Sanitized list for GET /v1/profiles; commands and workspace policy stay internal. */
export function profileSummaries(config: ProfilesConfig): ProfileSummary[] {
  return Object.values(config.profiles)
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(profileSummary);
}

/** Resolve a profile into the ExecutionOptions sent with an Assignment. */
export function profileExecution(profile: ProfileConfig): ExecutionOptions {
  return {
    provider: profile.provider,
    model: profile.model,
    thinking: profile.thinking,
    timeout_s: profile.timeout_s,
    prepare_command: profile.prepare_command,
    blocked_commands: [...profile.blocked_commands],
    workspace: {
      agent_cwd: profile.workspace.agent_cwd,
      artifact_root: profile.workspace.artifact_root,
      metadata_command: profile.workspace.metadata_command,
    },
    delivery: {
      mode: profile.delivery.mode,
      collision: profile.delivery.collision,
      strip_prefix: profile.delivery.strip_prefix,
      workspace_subdir: profile.delivery.workspace_subdir,
    },
  };
}
