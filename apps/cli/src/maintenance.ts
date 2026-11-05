import { existsSync, renameSync, rmSync, statSync } from "node:fs";
import { basename } from "node:path";

import { DEFAULT_OLDER_THAN_DAYS, runGc, type GcDeps, type GcOptions } from "./commands/gc.ts";
import type { CliConfig } from "./config.ts";
import { servicePaths, type ServiceName } from "./services.ts";
import { detectRunningStack, hasRunningStack, type RunningStack } from "./supervisor/detect.ts";

export const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_LOG_KEEP = 3;
export const DEFAULT_MAINTENANCE_GC_OLDER_THAN_DAYS = DEFAULT_OLDER_THAN_DAYS;

export interface LogRotationOptions {
  maxBytes?: number;
  keep?: number;
}

export interface LogRotationResult {
  name?: ServiceName;
  path: string;
  rotated: boolean;
  size?: number;
  error?: string;
}

export interface StartupMaintenanceOptions {
  detect?: (config: CliConfig) => Promise<RunningStack>;
  env?: NodeJS.ProcessEnv;
  rotateLogs?: (config: CliConfig, options?: LogRotationOptions) => LogRotationResult[];
  gc?: (config: CliConfig, options?: GcOptions, deps?: GcDeps) => Promise<number>;
  log?: (message: string) => void;
  now?: Date;
}

export interface StartupMaintenanceResult {
  ran: boolean;
  skipped?: "stack-running" | "stack-unknown";
  rotated: LogRotationResult[];
  gcCode: number | null;
  errors: string[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function integerInRange(
  value: string | number | undefined,
  fallback: number,
  minimum: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= minimum ? value : fallback;
  }
  const trimmed = value.trim();
  if (!/^[0-9]+$/.test(trimmed)) return fallback;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

export function logRotationOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Required<LogRotationOptions> {
  return {
    maxBytes: integerInRange(env.SUPER_RLM_LOG_MAX_BYTES, DEFAULT_LOG_MAX_BYTES, 1),
    keep: integerInRange(env.SUPER_RLM_LOG_KEEP, DEFAULT_LOG_KEEP, 1),
  };
}

export function maintenanceGcOlderThanDays(env: NodeJS.ProcessEnv = process.env): number {
  return integerInRange(
    env.SUPER_RLM_GC_OLDER_THAN_DAYS,
    DEFAULT_MAINTENANCE_GC_OLDER_THAN_DAYS,
    0,
  );
}

/** Auto maintenance is enabled by default; only the exact value "0" disables it. */
export function autoMaintenanceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SUPER_RLM_AUTO_MAINTENANCE?.trim() !== "0";
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

export function describeLogRotation(result: LogRotationResult): string {
  const label = result.name ?? basename(result.path);
  return result.size === undefined ? label : `${label} (${formatBytes(result.size)})`;
}

/**
 * Rotate one service log in place: current -> `.1`, `.1` -> `.2`, ...
 *
 * A missing log or a log at or below `maxBytes` is left alone. The newest
 * rotated file beyond `keep` is removed first, so a failure while shifting
 * leaves the current log intact rather than truncating it.
 */
export function rotateLogFile(
  path: string,
  options: LogRotationOptions = {},
): LogRotationResult {
  const maxBytes = integerInRange(options.maxBytes, DEFAULT_LOG_MAX_BYTES, 1);
  const keep = integerInRange(options.keep, DEFAULT_LOG_KEEP, 1);

  let stats;
  try {
    stats = statSync(path);
  } catch (error) {
    if (isMissingFile(error)) return { path, rotated: false };
    return { path, rotated: false, error: errorMessage(error) };
  }
  if (!stats.isFile()) {
    return { path, rotated: false, size: stats.size, error: "not a regular file" };
  }
  if (stats.size <= maxBytes) {
    return { path, rotated: false, size: stats.size };
  }

  try {
    rmSync(`${path}.${keep}`, { force: true });
    for (let index = keep - 1; index >= 1; index -= 1) {
      const from = `${path}.${index}`;
      if (existsSync(from)) renameSync(from, `${path}.${index + 1}`);
    }
    renameSync(path, `${path}.1`);
    return { path, rotated: true, size: stats.size };
  } catch (error) {
    return { path, rotated: false, size: stats.size, error: errorMessage(error) };
  }
}

export function rotateServiceLogs(
  config: CliConfig,
  options: LogRotationOptions = logRotationOptionsFromEnv(),
): LogRotationResult[] {
  return (["orchestrator", "worker"] as const).map((name) => ({
    ...rotateLogFile(servicePaths(config, name).log, options),
    name,
  }));
}

/**
 * Rotate closed service logs and optionally run a GC pass.
 *
 * Maintenance is best effort and never deletes while the stack is up. It
 * probes the stack itself and returns without touching logs or resources when
 * the stack is running or its state cannot be determined.
 */
export async function runStartupMaintenance(
  config: CliConfig,
  options: StartupMaintenanceOptions = {},
): Promise<StartupMaintenanceResult> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((message: string) => console.log(message));
  const errors: string[] = [];

  const detect = options.detect ?? detectRunningStack;
  let stack: RunningStack;
  try {
    stack = await detect(config);
  } catch (error) {
    const message = errorMessage(error);
    log(`maintenance: skipped (cannot determine whether the stack is running: ${message})`);
    return { ran: false, skipped: "stack-unknown", rotated: [], gcCode: null, errors: [message] };
  }
  if (hasRunningStack(stack)) {
    log("maintenance: skipped (the stack is running)");
    return { ran: false, skipped: "stack-running", rotated: [], gcCode: null, errors };
  }

  const rotateLogs = options.rotateLogs ?? rotateServiceLogs;
  let rotated: LogRotationResult[] = [];
  try {
    rotated = rotateLogs(config, logRotationOptionsFromEnv(env));
  } catch (error) {
    const message = errorMessage(error);
    errors.push(message);
    log(`maintenance: log rotation failed: ${message}`);
  }
  for (const result of rotated) {
    if (result.error) {
      errors.push(result.error);
      log(`maintenance: could not rotate ${result.name ?? basename(result.path)}: ${result.error}`);
    } else if (result.rotated) {
      log(`maintenance: rotated ${describeLogRotation(result)}`);
    }
  }

  let gcCode: number | null = null;
  if (autoMaintenanceEnabled(env)) {
    const gc = options.gc ?? runGc;
    const gcOptions: GcOptions = {
      apply: true,
      olderThanDays: maintenanceGcOlderThanDays(env),
    };
    if (options.now) gcOptions.now = options.now;
    try {
      gcCode = await gc(config, gcOptions);
    } catch (error) {
      const message = errorMessage(error);
      errors.push(message);
      log(`maintenance: gc failed: ${message}; continuing`);
    }
  }

  return { ran: true, rotated, gcCode, errors };
}
