export interface SseMessage {
  id?: number;
  event?: string;
  data: string;
}

/** Incremental parser for the `text/event-stream` framing used by the Orchestrator. */
export class SseParser {
  private buffer = "";

  feed(chunk: string): SseMessage[] {
    this.buffer = (this.buffer + chunk).replace(/\r\n/g, "\n");
    const messages: SseMessage[] = [];
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const message = parseBlock(block);
      if (message) messages.push(message);
      boundary = this.buffer.indexOf("\n\n");
    }
    return messages;
  }

  get pending(): string {
    return this.buffer;
  }
}

export function parseBlock(block: string): SseMessage | null {
  let id: number | undefined;
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "id") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) id = parsed;
    } else if (field === "event") event = value;
  }
  if (data.length === 0) return null;
  return { id, event, data: data.join("\n") };
}
