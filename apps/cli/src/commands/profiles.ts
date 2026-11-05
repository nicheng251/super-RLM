/**
 * `super-rlm profiles` reads config/profiles.yaml directly.
 *
 * list and validate do not contact the Orchestrator, so an invalid profile file
 * is caught before starting services.
 */

import { join } from "node:path";

import { resetProfileOverrides } from "../../../orchestrator/src/profileOverrides.ts";
import { loadProfiles, profileSummaries, type ProfileConfig, type ProfilesConfig } from "../../../orchestrator/src/profiles.ts";
import type { CliConfig } from "../config.ts";

export interface ProfilesOptions {
  env?: NodeJS.ProcessEnv;
}

interface ParsedArgs {
  command: "list" | "show" | "validate" | "reset" | null;
  name?: string;
  configPath?: string;
  overridesPath?: string;
  all: boolean;
  json: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  let command: ParsedArgs["command"] = null;
  let name: string | undefined;
  let configPath: string | undefined;
  let overridesPath: string | undefined;
  let all = false;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "list" || arg === "show" || arg === "validate" || arg === "reset") {
      command = arg;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--all") {
      all = true;
    } else if (arg === "--config") {
      configPath = args[++index];
    } else if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
    } else if (arg === "--overrides") {
      overridesPath = args[++index];
    } else if (arg.startsWith("--overrides=")) {
      overridesPath = arg.slice("--overrides=".length);
    } else if (!arg.startsWith("-") && (command === "show" || command === "reset") && name === undefined) {
      name = arg;
    }
  }
  return { command, name, configPath, overridesPath, all, json };
}

function printProfile(profile: ProfileConfig): void {
  console.log(`name:                  ${profile.name}`);
  console.log(`description:           ${profile.description || "-"}`);
  console.log(`provider:              ${profile.provider}`);
  console.log(`model:                 ${profile.model}`);
  console.log(`thinking:              ${profile.thinking}`);
  console.log(`timeout_s:             ${profile.timeout_s}`);
  console.log(`prepare_command:       ${profile.prepare_command ?? "-"}`);
  console.log(`blocked_commands:      ${profile.blocked_commands.length > 0 ? profile.blocked_commands.join(", ") : "-"}`);
  console.log(`capabilities:          ${profile.capabilities.length > 0 ? profile.capabilities.join(", ") : "-"}`);
  console.log(`requires_repo:         ${profile.requires_repo}`);
  console.log(`read_only:             ${profile.read_only}`);
  console.log(`write_files:           ${profile.write_files}`);
  console.log(`workspace.agent_cwd:   ${profile.workspace.agent_cwd}`);
  console.log(`workspace.artifact_root: ${profile.workspace.artifact_root}`);
  console.log(`workspace.metadata_command: ${profile.workspace.metadata_command ?? "-"}`);
  console.log(`delivery.mode:         ${profile.delivery.mode}`);
  console.log(`delivery.collision:    ${profile.delivery.collision}`);
  console.log(`delivery.strip_prefix: ${profile.delivery.strip_prefix || "-"}`);
  console.log(`delivery.workspace_subdir: ${profile.delivery.workspace_subdir ?? "-"}`);
}

function usage(): void {
  console.error("Usage: super-rlm profiles list|show <name>|validate [--json] [--config <path>]");
  console.error("       super-rlm profiles reset <name>|--all [--overrides <path>]");
}

export function runProfiles(config: CliConfig, args: string[], options: ProfilesOptions = {}): number {
  const parsed = parseArgs(args);
  if (!parsed.command) {
    usage();
    return 1;
  }
  if (parsed.command === "reset") {
    if (parsed.all && parsed.name !== undefined) {
      console.error("[profiles] use either a profile name or --all, not both");
      return 1;
    }
    if (!parsed.all && parsed.name === undefined) {
      usage();
      return 1;
    }
    const name = parsed.all ? null : parsed.name ?? null;
    const overridesPath = parsed.overridesPath
      ?? options.env?.SUPER_RLM_PROFILE_OVERRIDES
      ?? join(config.home, "profiles.overrides.json");
    try {
      const result = resetProfileOverrides(overridesPath, name);
      if (result.removed.length === 0 && !result.fileRemoved) {
        console.log(name === null
          ? `[profiles] no overrides file at ${overridesPath}`
          : `[profiles] no override for ${name}`);
        return 0;
      }
      const scope = name ?? (result.removed.length > 0 ? result.removed.join(", ") : overridesPath);
      console.log(`[profiles] removed overrides for ${scope}; config/profiles.yaml values apply on the next Orchestrator start`);
      return 0;
    } catch (error) {
      console.error(`[profiles] ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  let profiles: ProfilesConfig;
  try {
    profiles = loadProfiles(parsed.configPath ?? profilesConfigPath(config, options.env));
  } catch (error) {
    console.error(`[profiles] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (parsed.command === "validate") {
    const names = Object.keys(profiles.profiles).sort();
    if (parsed.json) {
      console.log(JSON.stringify({ valid: true, profiles: names }, null, 2));
    } else {
      console.log(`profiles config is valid: ${names.join(", ")}`);
    }
    return 0;
  }

  if (parsed.command === "list") {
    if (parsed.json) {
      console.log(JSON.stringify(profileSummaries(profiles), null, 2));
      return 0;
    }
    for (const profile of profileSummaries(profiles)) {
      console.log([
        profile.name.padEnd(12),
        `${profile.provider}/${profile.model}`.padEnd(28),
        profile.thinking.padEnd(7),
        profile.description || "-",
        profile.capabilities.length > 0 ? `[${profile.capabilities.join(",")}]` : "[-]",
        `repo=${profile.requires_repo}`,
        `read_only=${profile.read_only}`,
        `write_files=${profile.write_files}`,
      ].join(" ").trimEnd());
    }
    return 0;
  }

  if (!parsed.name) {
    usage();
    return 1;
  }
  const profile = profiles.profiles[parsed.name];
  if (!profile) {
    console.error(`[profiles] unknown profile: ${parsed.name}`);
    return 1;
  }
  if (parsed.json) {
    console.log(JSON.stringify(profile, null, 2));
  } else {
    printProfile(profile);
  }
  return 0;
}

export function profilesConfigPath(config: CliConfig, env: NodeJS.ProcessEnv = process.env): string {
  return env.SUPER_RLM_PROFILES_CONFIG ?? join(config.repoRoot, "config", "profiles.yaml");
}
