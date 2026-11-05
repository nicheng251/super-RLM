import { TASK_FILTERS, type TaskFilter, type ViewName } from "./state.ts";

export type SlashCommand =
  | { name: "help" }
  | { name: "chat" | "tasks" | "workers" | "events" }
  | { name: "detail"; taskId?: string }
  | { name: "filter"; filter?: TaskFilter }
  | { name: "search"; query: string }
  | { name: "clear" }
  | { name: "refresh" }
  | { name: "abort" }
  | { name: "quit" }
  | { name: "answer" }
  | { name: "unknown"; raw: string };

export const COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
  { name: "chat", description: "switch to Chat" },
  { name: "tasks", description: "switch to Tasks" },
  { name: "detail", description: "open Task Detail (optional task id)" },
  { name: "workers", description: "switch to Workers" },
  { name: "events", description: "switch to Events" },
  { name: "filter", description: "filter Tasks: all | waiting | running | terminal" },
  { name: "search", description: "search Tasks by id or prompt" },
  { name: "clear", description: "clear task search and filter" },
  { name: "refresh", description: "refresh the current view" },
  { name: "answer", description: "answer the selected waiting Ticket" },
  { name: "abort", description: "abort the current Pi turn" },
  { name: "quit", description: "exit the TUI" },
  { name: "help", description: "show the command list" },
];

export const COMMAND_HELP = [
  "/chat                 switch to Chat",
  "/tasks                switch to Tasks",
  "/detail [task_id]     open Task Detail",
  "/workers              switch to Workers",
  "/events               switch to Events",
  "/filter [name]        cycle or set task filter (all|waiting|running|terminal)",
  "/search <text>        filter tasks by id or prompt; no text clears",
  "/clear                clear the task search and filter",
  "/refresh              refresh current view",
  "/answer               answer the selected waiting Ticket",
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
  const parts = rest.split(/\s+/).filter(Boolean);
  if (!name) return { name: "unknown", raw: text };
  switch (name) {
    case "help":
      return { name: "help" };
    case "chat":
    case "tasks":
    case "workers":
    case "events":
      return { name };
    case "detail":
    case "task":
      return { name: "detail", taskId: parts[0] };
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

export function viewForCommand(command: SlashCommand): ViewName | null {
  return command.name === "chat" || command.name === "tasks" || command.name === "workers" || command.name === "events"
    ? command.name
    : null;
}
