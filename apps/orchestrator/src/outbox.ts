/**
 * Durable user callback outbox.
 *
 * The Orchestrator records important events in the Store. A background
 * dispatcher delivers due callbacks to the configured URL with an HMAC
 * signature and bounded retry backoff.
 */

import { createHmac, randomUUID } from "node:crypto";
import type { OutboxRecord, Store } from "./db.ts";

export const CALLBACK_EVENT_TYPES = [
  "ticket.waiting",
  "ticket.blocked",
  "ticket.settled",
  "task.settled",
] as const;

export type CallbackEventType = (typeof CALLBACK_EVENT_TYPES)[number];

const CALLBACK_EVENT_TYPE_SET: ReadonlySet<string> = new Set(CALLBACK_EVENT_TYPES);

export function isCallbackEventType(type: string): type is CallbackEventType {
  return CALLBACK_EVENT_TYPE_SET.has(type);
}

export interface CallbackSignature {
  timestamp: string;
  nonce: string;
  signature: string;
}

const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 60_000, 300_000];
export const MAX_CALLBACK_ATTEMPTS = 8;

export function retryDelayMs(attempts: number): number {
  const index = Math.min(Math.max(attempts - 1, 0), RETRY_DELAYS_MS.length - 1);
  return RETRY_DELAYS_MS[index];
}

/** Sign a callback body as HMAC-SHA256(timestamp + nonce + body), hex encoded. */
export function signCallback(
  key: string,
  body: string,
  timestamp: string | number = Math.floor(Date.now() / 1000),
  nonce: string = randomUUID(),
): CallbackSignature {
  const stamp = String(timestamp);
  const signature = createHmac("sha256", key)
    .update(stamp + nonce + body)
    .digest("hex");
  return { timestamp: stamp, nonce, signature };
}

export type OutboxStore = Pick<Store, "dueOutbox" | "markOutboxDelivered" | "markOutboxFailed">;

export interface OutboxDispatcherOptions {
  now?: () => Date;
}

export class OutboxDispatcher {
  private readonly store: OutboxStore;
  private readonly target: string | null;
  private readonly key: string;
  private readonly clock: () => Date;

  constructor(store: OutboxStore, target: string | null, key: string, options: OutboxDispatcherOptions = {}) {
    this.store = store;
    this.target = target;
    this.key = key;
    this.clock = options.now ?? (() => new Date());
  }

  /** Deliver due callbacks. Returns the number of callbacks acknowledged with 2xx. */
  async flush(limit = 20, fetchImpl: typeof fetch = fetch): Promise<number> {
    const target = this.target?.trim();
    if (!target) return 0;

    const now = this.clock();
    const nowIso = now.toISOString();
    const rows = this.store.dueOutbox(nowIso, limit);
    let delivered = 0;

    for (const row of rows) {
      const body = typeof row.payload === "string" ? row.payload : JSON.stringify(row.payload);
      const signed = signCallback(this.key, body, Math.floor(now.getTime() / 1000));
      try {
        const response = await fetchImpl(row.target || target, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-superrlm-timestamp": signed.timestamp,
            "x-superrlm-nonce": signed.nonce,
            "x-superrlm-signature": signed.signature,
          },
          body,
        });
        if (response.ok) {
          this.store.markOutboxDelivered(row.outbox_id, nowIso);
          delivered += 1;
          continue;
        }
        this.recordFailure(row, `callback returned ${response.status}`, now);
      } catch (error) {
        this.recordFailure(row, error instanceof Error ? error.message : String(error), now);
      }
    }

    return delivered;
  }

  private recordFailure(row: OutboxRecord, error: string, now: Date): void {
    const attempts = Number(row.attempts ?? 0) + 1;
    const failed = attempts >= MAX_CALLBACK_ATTEMPTS;
    this.store.markOutboxFailed(
      row.outbox_id,
      {
        attempts,
        nextAttemptAt: failed ? now.toISOString() : new Date(now.getTime() + retryDelayMs(attempts)).toISOString(),
        error,
        ...(failed ? { status: "failed" as const } : {}),
      },
      now.toISOString(),
    );
  }
}
