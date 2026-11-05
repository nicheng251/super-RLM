/**
 * Copy a Ticket's artifacts from its runtime workspace.
 *
 * Artifact paths are relative to the Ticket workspace. The Orchestrator owns
 * the artifact list; the local CLI only performs the file copy.
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { TicketResult } from "../../../../packages/protocol/ts/index.ts";
import type { CliConfig } from "../config.ts";

export interface ArtifactCopyOptions {
  all?: boolean;
}

/** Artifact copying only needs the artifact list plus the optional workspace report. */
export type TicketWorkspaceResult = Pick<TicketResult, "artifacts"> & {
  workspace_metadata?: Record<string, unknown> | null;
  metadata_error?: string | null;
};

export interface ArtifactCopyResult {
  ticket_id: string;
  workspace: string;
  destination: string;
  copied: string[];
  files: number;
  workspace_metadata: Record<string, unknown> | null;
  metadata_error: string | null;
}

export interface RunArtifactsOptions {
  to?: string;
  all?: boolean;
}

const REPORT_CONFIG = ".super-rlm-report.json";
const PREPARED_MARKER = ".super-rlm-prepared";
const BLOCKED_BIN = ".super-rlm-bin";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatMetadataValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function uniquePath(base: string): string {
  if (!existsSync(base)) return base;
  for (let index = 1; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existsSync(candidate)) return candidate;
  }
}

function isInside(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function countFiles(root: string): number {
  let count = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) count += countFiles(path);
    else if (entry.isFile()) count += 1;
  }
  return count;
}

function workspaceFor(config: CliConfig, ticketId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(ticketId)) {
    throw new Error(`invalid ticket id: ${ticketId}`);
  }
  const workspace = join(config.workspaceRoot, ticketId);
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    throw new Error(`workspace does not exist: ${workspace}`);
  }
  return workspace;
}

/** Copy the Ticket's reported artifacts, or its whole workspace when `all` is set. */
export function copyTicketArtifacts(
  config: CliConfig,
  ticketId: string,
  result: TicketWorkspaceResult,
  destinationDir: string,
  options: ArtifactCopyOptions = {},
): ArtifactCopyResult {
  const workspace = workspaceFor(config, ticketId);
  const destinationRoot = resolve(destinationDir);
  const details = {
    workspace_metadata: result.workspace_metadata ?? null,
    metadata_error: result.metadata_error ?? null,
  };

  if (options.all) {
    if (isInside(workspace, destinationRoot)) {
      throw new Error(`destination must be outside the workspace (${workspace}).`);
    }
    const destination = uniquePath(join(destinationRoot, ticketId));
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(workspace, destination, {
      recursive: true,
      filter: (source) => {
        const name = basename(source);
        return name !== REPORT_CONFIG && name !== PREPARED_MARKER && name !== BLOCKED_BIN && name !== ".git";
      },
    });
    return {
      ticket_id: ticketId,
      workspace,
      destination,
      copied: [destination],
      files: countFiles(destination),
      ...details,
    };
  }

  if (result.artifacts.length === 0) {
    throw new Error(`Ticket ${ticketId} has no artifacts. Use --all to copy the entire workspace.`);
  }

  const copied: string[] = [];
  for (const artifact of result.artifacts) {
    if (artifact.type !== "file") throw new Error(`unsupported artifact type: ${artifact.type}`);
    const raw = artifact.path;
    if (!raw || isAbsolute(raw) || raw.split(/[\\/]/).includes("..")) {
      throw new Error(`unsafe artifact path: ${raw}`);
    }
    const source = [resolve(workspace, raw), resolve(workspace, "repo", raw)].find(
      (candidate) => isInside(workspace, candidate) && candidate !== resolve(workspace)
        && existsSync(candidate) && statSync(candidate).isFile(),
    );
    if (!source) {
      if (!isInside(workspace, resolve(workspace, raw))) {
        throw new Error(`artifact escapes the workspace: ${raw}`);
      }
      throw new Error(`artifact not found: ${raw}`);
    }
    const target = resolve(destinationRoot, raw);
    if (!isInside(destinationRoot, target) || target === destinationRoot) {
      throw new Error(`artifact escapes the destination: ${raw}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    copied.push(target);
  }

  return {
    ticket_id: ticketId,
    workspace,
    destination: destinationRoot,
    copied,
    files: copied.length,
    ...details,
  };
}

async function fetchTicketResult(config: CliConfig, ticketId: string): Promise<TicketResult> {
  const base = config.orchestratorUrl.replace(/\/$/, "");
  const response = await fetch(`${base}/v1/tickets/${encodeURIComponent(ticketId)}/result`, {
    headers: { authorization: `Bearer ${config.routerToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Orchestrator ${response.status}: ${text}`);
  }
  return JSON.parse(text) as TicketResult;
}

export async function runArtifacts(
  config: CliConfig,
  ticketId: string | undefined,
  options: RunArtifactsOptions = {},
): Promise<number> {
  if (!ticketId) {
    console.error("Usage: super-rlm artifacts <ticket_id> [--to <destination-dir>] [--all]");
    return 1;
  }
  try {
    const result = await fetchTicketResult(config, ticketId);
    const copy = copyTicketArtifacts(config, ticketId, result, options.to ?? process.cwd(), {
      all: options.all,
    });
    for (const path of copy.copied) console.log(`copied ${path}`);
    console.log(`Ticket ${ticketId}: ${copy.files} file(s)`);
    console.log(`workspace: ${copy.workspace}`);
    if (copy.workspace_metadata) {
      for (const [key, value] of Object.entries(copy.workspace_metadata)) {
        console.log(`metadata.${key}: ${formatMetadataValue(value)}`);
      }
    }
    if (copy.metadata_error) console.log(`metadata error: ${copy.metadata_error}`);
    return 0;
  } catch (error) {
    console.error(errorMessage(error));
    return 1;
  }
}
