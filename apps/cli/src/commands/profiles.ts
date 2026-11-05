/**
 * `super-rlm profiles` reads config/profiles.yaml directly.
 *
 * list and validate do not contact the Orchestrator, so an invalid profile file
 * is caught before starting services.
 */

import { join } from "node:path";

import { loadProfiles, profileSummaries, type ProfileConfig, type ProfilesConfig } from "../../../orchestrator/src/profiles.ts";
import type { CliConfig } from "../config.ts";

export interface ProfilesOptions {
  env?: NodeJS.ProcessEnv;
}

interface ParsedArgs {
  command: "list" | "show" | "validate" | null;
  name?: string;
  configPath?: string;
  json: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  let command: ParsedArgs["command"] = null;
  let name: string | undefined;
  let configPath: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "list" || arg === "show" || arg === "validate") {
      command = arg;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--config") {
      configPath = args[++index];
    } else if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
    } else if (!arg.startsWith("-") && command === "show" && name === undefined) {
      name = arg;
    }
  }
  return { command, name, configPath, json };
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
}

export function runProfiles(config: CliConfig, args: string[], options: ProfilesOptions = {}): number {
  const parsed = parseArgs(args);
  if (!parsed.command) {
    usage();
    return 1;
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
