import type { ViewName } from "./state.ts";

export type SlashCommand =
  | { name: "help" }
  | { name: "chat" | "tasks" | "workers" | "events" }
  | { name: "detail"; taskId?: string }
  | { name: "refresh" }
  | { name: "abort" }
  | { name: "quit" }
  | { name: "answer" }
  | { name: "unknown"; raw: string };

export const COMMAND_HELP = [
  "/chat                 switch to Chat",
  "/tasks                switch to Tasks",
  "/detail [task_id]     open Task Detail",
  "/workers              switch to Workers",
  "/events               switch to Events",
  "/refresh              refresh current view",
  "/answer               answer the selected waiting Ticket",
  "/abort                abort the current Pi turn",
  "/quit                 exit the TUI",
  "/help                 show this list",
];

export function parseSlashCommand(input: string): SlashCommand | null {
  const text = input.trim();
  if (!text.startsWith("/")) return null;
  const parts = text.slice(1).trim().split(/\s+/).filter(Boolean);
  const name = (parts.shift() ?? "").toLowerCase();
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
