
/**
 * Single-instance lock for the Orchestrator.
 *
 * A lock file holds the owner PID. A stale PID is removed. This is a local
 * development guard, not a distributed lock.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

export interface LockHandle {
  path: string;
  pid: number;
  release(): void;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function acquireLock(dir: string, pid = process.pid): LockHandle {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "orchestrator.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, String(pid));
      closeSync(fd);
      return {
        path,
        pid,
        release() {
          try {
            if (readFileSync(path, "utf8").trim() === String(pid)) unlinkSync(path);
          } catch {
            // Already gone.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = existsSync(path) ? Number(readFileSync(path, "utf8").trim()) : 0;
      if (isProcessAlive(existing)) {
        throw new Error(`Orchestrator is already running with pid ${existing}`);
      }
      unlinkSync(path);
    }
  }
  throw new Error(`Could not acquire Orchestrator lock at ${path}`);
}
