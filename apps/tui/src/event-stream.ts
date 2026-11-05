import type { Event } from "../../../packages/protocol/ts/index.ts";
import { SseParser } from "./sse.ts";

export type StreamStatus = "connecting" | "open" | "error" | "closed";

export interface EventStreamHandlers {
  onEvent(event: Event): void;
  onStatus(status: StreamStatus, detail?: string): void;
}

/** Reconnecting SSE reader for GET /v1/events with a persistent cursor. */
export class OrchestratorEventStream {
  private controller: AbortController | null = null;
  private stopped = false;
  private attempt = 0;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly getCursor: () => number;
  private readonly handlers: EventStreamHandlers;

  constructor(
    baseUrl: string,
    token: string,
    getCursor: () => number,
    handlers: EventStreamHandlers,
  ) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.getCursor = getCursor;
    this.handlers = handlers;
  }

  start(): void {
    this.stopped = false;
    void this.run();
  }

  stop(): void {
    this.stopped = true;
    this.controller?.abort();
    this.controller = null;
    this.handlers.onStatus("closed");
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      this.handlers.onStatus("connecting");
      this.controller = new AbortController();
      try {
        const response = await fetch(`${this.baseUrl}/v1/events?after=${this.getCursor()}`, {
          headers: { authorization: `Bearer ${this.token}`, accept: "text/event-stream" },
          signal: this.controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`events ${response.status}`);
        }
        this.attempt = 0;
        this.handlers.onStatus("open");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parser = new SseParser();
        while (!this.stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const message of parser.feed(decoder.decode(value, { stream: true }))) {
            const event = parseEvent(message.data);
            if (event) this.handlers.onEvent(event);
          }
        }
      } catch (error) {
        if (this.stopped) break;
        this.handlers.onStatus("error", error instanceof Error ? error.message : String(error));
      }
      if (this.stopped) break;
      const delay = Math.min(15_000, 500 * 2 ** this.attempt);
      this.attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    if (!this.stopped) this.handlers.onStatus("closed");
  }
}

export function parseEvent(data: string): Event | null {
  try {
    const parsed = JSON.parse(data) as Event;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.event_id !== "number" || typeof parsed.type !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}
