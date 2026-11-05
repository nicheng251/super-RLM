/** Read-only formatting for Prime Agent session JSONL files. */

export type SessionLineKind = "user" | "assistant" | "thinking" | "tool" | "system" | "error";

export interface SessionLine {
  kind: SessionLineKind;
  text: string;
}

export interface ParseSessionOptions {
  /** Maximum number of rendered entries, keeping the most recent ones. */
  limit?: number;
  maxTextChars?: number;
  maxToolChars?: number;
  maxToolLines?: number;
}

/**
 * Parses Prime Agent session JSONL into display entries.
 *
 * Only `type: "message"` records are read. Malformed lines and unrelated
 * session records are ignored. Tool output is summarized so a viewer cannot
 * dump an unbounded result into the terminal.
 */
export function parseSessionJsonl(text: string, options: ParseSessionOptions = {}): SessionLine[] {
  const limit = Math.max(0, options.limit ?? 100);
  const maxTextChars = Math.max(0, options.maxTextChars ?? 700);
  const maxToolChars = Math.max(0, options.maxToolChars ?? 320);
  const maxToolLines = Math.max(0, options.maxToolLines ?? 4);
  const out: SessionLine[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object") continue;
    const entry = record as Record<string, unknown>;
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!message || typeof message !== "object") continue;
    readMessage(message as Record<string, unknown>, out, {
      maxTextChars,
      maxToolChars,
      maxToolLines,
    });
  }

  return limit === 0 ? [] : out.slice(-limit);
}

interface Limits {
  maxTextChars: number;
  maxToolChars: number;
  maxToolLines: number;
}

function readMessage(message: Record<string, unknown>, out: SessionLine[], limits: Limits): void {
  const role = typeof message.role === "string" ? message.role : "";
  if (role === "toolResult" || role === "tool") {
    const name = typeof message.toolName === "string" && message.toolName
      ? message.toolName
      : "tool";
    const summary = summarizeToolOutput(
      contentText(message.content),
      limits.maxToolChars,
      limits.maxToolLines,
    );
    const mark = message.isError === true ? "\u2717" : "\u2713";
    out.push({ kind: "tool", text: `${mark} ${name}${summary ? `  ${summary}` : ""}` });
    return;
  }
  if (role !== "user" && role !== "assistant" && role !== "system") return;

  const fallbackKind: SessionLineKind =
    role === "user" ? "user" : role === "system" ? "system" : "assistant";
  for (const block of contentBlocks(message.content)) {
    const type = typeof block.type === "string" ? block.type : "";
    if (type === "thinking") {
      const thinking = typeof block.thinking === "string" ? block.thinking : "";
      if (thinking) out.push({ kind: "thinking", text: truncateText(thinking, limits.maxTextChars) });
      continue;
    }
    if (type === "toolCall" || type === "tool_call") {
      const name = typeof block.name === "string" && block.name ? block.name : "tool";
      const args = formatArgs(block.arguments);
      out.push({ kind: "tool", text: `\u2699 ${name}${args ? `  ${args}` : ""}` });
      continue;
    }
    const text = typeof block.text === "string" ? block.text : "";
    if (text) out.push({ kind: fallbackKind, text: truncateText(text, limits.maxTextChars) });
  }
}

function contentBlocks(content: unknown): Record<string, unknown>[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (typeof block === "string") return [{ type: "text", text: block }];
    return block && typeof block === "object" ? [block as Record<string, unknown>] : [];
  });
}

function contentText(content: unknown): string {
  return contentBlocks(content)
    .map((block) => typeof block.text === "string" ? block.text : "")
    .filter((text) => text.length > 0)
    .join("\n");
}

function formatArgs(args: unknown): string {
  let text: string;
  try {
    text = typeof args === "string" ? args : JSON.stringify(args);
  } catch {
    return "";
  }
  if (!text) return "";
  text = text.replace(/\s+/g, " ").trim();
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

export function truncateText(text: string, maxChars: number): string {
  const normalized = normalize(text);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}\u2026 (+${normalized.length - maxChars} chars)`;
}

/** Keeps the first lines/chars of a tool result and reports what was hidden. */
export function summarizeToolOutput(text: string, maxChars = 320, maxLines = 4): string {
  const normalized = normalize(text);
  if (!normalized) return "";
  const lines = normalized.split("\n");
  let summary = lines.slice(0, maxLines).join("\n");
  const hidden: string[] = [];
  if (lines.length > maxLines) hidden.push(`+${lines.length - maxLines} lines`);
  if (summary.length > maxChars) {
    const truncated = summary.length - maxChars;
    summary = summary.slice(0, maxChars);
    hidden.push(`+${truncated} chars`);
  }
  return hidden.length > 0 ? `${summary} \u2026 (${hidden.join(", ")})` : summary;
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/[ \t]+$/gm, "").trimEnd();
}
