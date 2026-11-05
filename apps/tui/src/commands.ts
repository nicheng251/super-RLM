import { TASK_FILTERS, type TaskFilter } from "./state.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];

export type SlashCommand =
  | { name: "help" }
  | { name: "model"; action?: "list" | "thinking"; model?: string; thinking?: ThinkingLevel }
  | { name: "filter"; filter?: TaskFilter }
  | { name: "search"; query: string }
  | { name: "clear" }
  | { name: "refresh" }
  | { name: "abort" }
  | { name: "quit" }
  | { name: "answer" }
  | { name: "unknown"; raw: string };

export const COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
  { name: "filter", description: "filter Tasks: all | waiting | running | terminal" },
  { name: "search", description: "search Tasks by id or prompt" },
  { name: "clear", description: "clear task search and filter" },
  { name: "refresh", description: "refresh the current view" },
  { name: "answer", description: "answer the selected waiting Ticket" },
  { name: "model", description: "show, list, or switch the Router model and thinking level" },
  { name: "abort", description: "abort the current Pi turn" },
  { name: "quit", description: "exit the TUI" },
  { name: "help", description: "show the command list" },
];

export const COMMAND_HELP = [
  "/filter [name]        cycle or set task filter (all|waiting|running|terminal)",
  "/search <text>        filter tasks by id or prompt; no text clears",
  "/clear                clear the task search and filter",
  "/refresh              refresh current view",
  "/answer               answer the selected waiting Ticket",
  "/model                show the Router model, thinking level, and context",
  "/model list           list available Router models",
  "/model thinking       list available thinking levels",
  "/model <provider/id>  switch the Router model",
  "/model thinking <lvl> set reasoning: off|minimal|low|medium|high|xhigh|max",
  "/abort                abort the current Pi turn",
  "/quit                 exit the TUI",
  "/help                 show this list",
];

export function parseSlashCommand(input: string): SlashCommand | null {
  const text = input.trim();
  if (!text.startsWith("/")) return null;
  const body = text.slice(1).trim();
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(body);
  const name = (match?.[1] ?? "").toLowerCase();
  const rest = (match?.[2] ?? "").trim();
  if (!name) return { name: "unknown", raw: text };
  switch (name) {
    case "help":
      return { name: "help" };
    case "model": {
      if (!rest) return { name: "model" };
      const parts = rest.split(/\s+/);
      const first = parts[0].toLowerCase();
      if (first === "list" && parts.length === 1) return { name: "model", action: "list" };
      if (first === "thinking") {
        if (parts.length === 1) return { name: "model", action: "thinking" };
        if (parts.length === 2) {
          const level = parts[1].toLowerCase();
          if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
            return { name: "unknown", raw: text };
          }
          return { name: "model", thinking: level as ThinkingLevel };
        }
        return { name: "unknown", raw: text };
      }
      if (parts.length === 1) return { name: "model", model: parts[0] };
      if (parts.length === 2) {
        const level = parts[1].toLowerCase();
        if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
          return { name: "unknown", raw: text };
        }
        return { name: "model", model: parts[0], thinking: level as ThinkingLevel };
      }
      return { name: "unknown", raw: text };
    }
    case "filter": {
      if (!rest) return { name: "filter" };
      const filter = rest.toLowerCase();
      if (!(TASK_FILTERS as readonly string[]).includes(filter)) {
        return { name: "unknown", raw: text };
      }
      return { name: "filter", filter: filter as TaskFilter };
    }
    case "search":
      return { name: "search", query: rest };
    case "clear":
      return { name: "clear" };
    case "refresh":
      return { name: "refresh" };
    case "abort":
      return { name: "abort" };
    case "quit":
    case "exit":
      return { name: "quit" };
    case "answer":
      return { name: "answer" };
    default:
      return { name: "unknown", raw: text };
  }
}
