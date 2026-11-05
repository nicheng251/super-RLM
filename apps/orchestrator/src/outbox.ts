/**
 * Durable user callback outbox.
 *
 * The Orchestrator records important events in the Store. A background
 * dispatcher delivers due callbacks to the configured URL with an HMAC
 * signature and bounded retry backoff.
 */

import { createHmac, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
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

export const CALLBACK_TIMEOUT_MS = 10_000;
export const CALLBACK_MAX_RESPONSE_BYTES = 64 * 1024;

export interface OutboxDispatcherOptions {
  now?: () => Date;
  /** Permit private, loopback, and link-local callback addresses (tests only). */
  allowPrivate?: boolean;
  /** Injectable DNS resolver: hostname -> addresses. */
  resolveHost?: (hostname: string) => Promise<string[]>;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true });
  return results.map((result) => result.address);
}

function ipv4Number(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value * 256) + octet;
  }
  return value >>> 0;
}

const PRIVATE_IPV4_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 0x00ffffff], // 0.0.0.0/8
  [0x0a000000, 0x0affffff], // 10.0.0.0/8
  [0x64400000, 0x647fffff], // 100.64.0.0/10 (CGNAT)
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16 (link-local, cloud metadata)
  [0xac100000, 0xac1fffff], // 172.16.0.0/12
  [0xc0000000, 0xc00000ff], // 192.0.0.0/24
  [0xc0000200, 0xc00002ff], // 192.0.2.0/24 (documentation)
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16
  [0xc6120000, 0xc613ffff], // 198.18.0.0/15 (benchmarking)
  [0xc6336400, 0xc63364ff], // 198.51.100.0/24 (documentation)
  [0xcb007100, 0xcb0071ff], // 203.0.113.0/24 (documentation)
  [0xe0000000, 0xefffffff], // 224.0.0.0/4 (multicast)
  [0xf0000000, 0xffffffff], // 240.0.0.0/4 (reserved, broadcast)
];

function isPrivateIpv4(address: string): boolean {
  const value = ipv4Number(address);
  if (value === null) return false;
  return PRIVATE_IPV4_RANGES.some(([start, end]) => value >= start && value <= end);
}

function mappedIpv4(host: string): string | null {
  const rest = host.slice("::ffff:".length);
  if (isIP(rest) === 4) return rest;
  const groups = rest.split(":");
  if (groups.length > 2 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
  const value = Number.parseInt(groups.map((group) => group.padStart(4, "0")).join(""), 16);
  if (!Number.isFinite(value) || value > 0xffffffff) return null;
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join(".");
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family !== 6) return false;
  const host = address.toLowerCase().split("%")[0];
  if (host === "::" || host === "::1") return true;
  if (host.startsWith("::ffff:")) {
    const embedded = mappedIpv4(host);
    return embedded !== null && isPrivateIpv4(embedded);
  }
  if (/^f[cd]/.test(host)) return true; // fc00::/7 unique local
  if (/^fe[89ab]/.test(host)) return true; // fe80::/10 link-local
  if (/^ff/.test(host)) return true; // multicast
  if (/^2001:db8(:|$)/.test(host)) return true; // documentation
  return false;
}

export interface CallbackValidationOptions {
  allowPrivate?: boolean;
  resolveHost?: (hostname: string) => Promise<string[]>;
}

/**
 * Validate a callback target before any request is made.
 *
 * Only http/https without embedded credentials is allowed. Hostnames are
 * resolved and rejected when any address is private, loopback, link-local, or
 * otherwise reserved, unless the caller explicitly opts in.
 */
export async function validateCallbackTarget(
  raw: string,
  options: CallbackValidationOptions = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("callback target is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`callback target scheme must be http or https, got ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error("callback target must not contain credentials");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new Error("callback target has no host");
  const literal = isIP(host);
  const addresses = literal
    ? [host]
    : await (options.resolveHost ?? defaultResolveHost)(host);
  if (addresses.length === 0) throw new Error(`callback target host did not resolve: ${host}`);
  if (!options.allowPrivate) {
    for (const address of addresses) {
      if (isPrivateAddress(address)) {
        throw new Error(`callback target resolves to a non-public address: ${address}`);
      }
    }
  }
  return url;
}

async function consumeBounded(response: Response, maxBytes: number): Promise<void> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`callback response exceeded ${maxBytes} bytes`);
  }
  if (!response.body) return;
  const reader = response.body.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      total += value?.byteLength ?? 0;
      if (total > maxBytes) {
        throw new Error(`callback response exceeded ${maxBytes} bytes`);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export class OutboxDispatcher {
  private readonly store: OutboxStore;
  private readonly target: string | null;
  private readonly key: string;
  private readonly clock: () => Date;
  private readonly allowPrivate: boolean;
  private readonly resolveHost: (hostname: string) => Promise<string[]>;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(store: OutboxStore, target: string | null, key: string, options: OutboxDispatcherOptions = {}) {
    this.store = store;
    this.target = target;
    this.key = key;
    this.clock = options.now ?? (() => new Date());
    this.allowPrivate = options.allowPrivate ?? false;
    this.resolveHost = options.resolveHost ?? defaultResolveHost;
    this.timeoutMs = options.timeoutMs ?? CALLBACK_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? CALLBACK_MAX_RESPONSE_BYTES;
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
      const rowTarget = (row.target || target).trim();
      let callbackUrl: URL;
      try {
        callbackUrl = await validateCallbackTarget(rowTarget, {
          allowPrivate: this.allowPrivate,
          resolveHost: this.resolveHost,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.recordFailure(row, `callback target rejected: ${detail}`, now);
        continue;
      }

      const body = typeof row.payload === "string" ? row.payload : JSON.stringify(row.payload);
      const signed = signCallback(this.key, body, Math.floor(now.getTime() / 1000));
      try {
        const response = await fetchImpl(callbackUrl.toString(), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-superrlm-timestamp": signed.timestamp,
            "x-superrlm-nonce": signed.nonce,
            "x-superrlm-signature": signed.signature,
          },
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        try {
          await consumeBounded(response, this.maxResponseBytes);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.recordFailure(row, `callback response rejected: ${detail}`, now);
          continue;
        }
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
