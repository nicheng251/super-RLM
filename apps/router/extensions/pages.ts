
/**
 * L2 pages: /tasks and /task <id>.
 *
 * The page models in ../src hold state and actions; this file only renders with
 * Pi TUI primitives and forwards user actions.
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { OrchestratorClient } from "../src/client.ts";
import { TaskDetailPageModel, TasksPageModel } from "../src/page-model.ts";
import type { TaskListItem, TicketSummary } from "../../../packages/protocol/ts/index.ts";

const BASE = process.env.SUPER_RLM_ORCHESTRATOR_URL ?? "http://127.0.0.1:8787";
const TOKEN = process.env.SUPER_RLM_ROUTER_TOKEN ?? "";

type Tui = { requestRender(): void };
type Done<T> = (value: T) => void;

interface TasksResult { action: "open"; taskId: string }
interface DetailResult {
  action: "answer" | "resume" | "retry" | "cancel_ticket" | "cancel_task";
  ticketId?: string;
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function statusColor(status: string): "success" | "error" | "warning" | "accent" | "dim" {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "lost") return "error";
  if (status === "waiting" || status === "blocked" || status === "partial") return "warning";
  if (status === "running" || status === "assigned" || status === "queued") return "accent";
  return "dim";
}

function box(theme: Theme, width: number, title: string, body: string[], footer: string): string[] {
  const inner = Math.max(30, width - 4);
  const edge = (text: string) => theme.fg("border", text);
  const row = (text: string) => edge("│ ") + pad(truncateToWidth(text, inner - 2), inner - 2) + edge(" │");
  const lines = [edge(`╭─ ${title} ${"─".repeat(Math.max(0, inner - title.length - 4))}╮`)];
  for (const line of body) lines.push(row(line));
  lines.push(row(""));
  lines.push(row(theme.fg("dim", footer)));
  lines.push(edge(`╰${"─".repeat(inner)}╯`));
  return lines;
}

class TasksComponent {
  focused = false;
  private readonly model: TasksPageModel;
  private readonly theme: Theme;
  private readonly tui: Tui;
  private readonly done: Done<TasksResult | undefined>;

  constructor(client: OrchestratorClient, theme: Theme, tui: Tui, done: Done<TasksResult | undefined>) {
    this.model = new TasksPageModel(client);
    this.theme = theme;
    this.tui = tui;
    this.done = done;
    void this.reload();
  }

  private async reload(): Promise<void> {
    await this.model.load();
    this.tui.requestRender();
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q") {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, "up")) this.model.move(-1);
    else if (matchesKey(data, "down")) this.model.move(1);
    else if (matchesKey(data, "return")) {
      const task = this.model.selectedTask();
      if (task) this.done({ action: "open", taskId: task.task_id });
    } else if (data === "r") {
      void this.reload();
    }
  }

  render(width: number): string[] {
    const state = this.model.state;
    const body: string[] = [];
    if (state.loading) body.push(this.theme.fg("dim", "Loading tasks..."));
    else if (state.error) body.push(this.theme.fg("error", state.error));
    else if (state.tasks.length === 0) body.push(this.theme.fg("dim", "No tasks."));
    else {
      for (let index = 0; index < state.tasks.length; index += 1) {
        const task = state.tasks[index];
        const selected = index === state.selected;
        const marker = selected ? this.theme.fg("accent", "▶ ") : "  ";
        const status = this.theme.fg(statusColor(task.status), task.status.padEnd(10));
        const counts = this.theme.fg("dim", `tickets=${task.ticket_count} run=${task.running_count} wait=${task.waiting_count}`);
        body.push(`${marker}${status} ${task.task_id}  ${counts}`);
        body.push(`   ${this.theme.fg(selected ? "text" : "dim", truncateToWidth(task.prompt, Math.max(20, width - 10)))}`);
      }
    }
    return box(this.theme, width, "Tasks", body, "↑↓ navigate • Enter open • r refresh • q close");
  }
}

class TaskDetailComponent {
  focused = false;
  private readonly model: TaskDetailPageModel;
  private readonly theme: Theme;
  private readonly tui: Tui;
  private readonly done: Done<DetailResult | undefined>;

  constructor(client: OrchestratorClient, taskId: string, theme: Theme, tui: Tui, done: Done<DetailResult | undefined>) {
    this.model = new TaskDetailPageModel(client, taskId);
    this.theme = theme;
    this.tui = tui;
    this.done = done;
    void this.reload();
  }

  private async reload(): Promise<void> {
    await this.model.load();
    this.tui.requestRender();
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q") {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, "up")) {
      this.model.move(-1);
      return;
    }
    if (matchesKey(data, "down")) {
      this.model.move(1);
      return;
    }
    if (data === "r") {
      void this.reload();
      return;
    }
    const ticket = this.model.selectedTicket();
    if (!ticket) return;
    if (data === "a" && ticket.status === "waiting") {
      this.done({ action: "answer", ticketId: ticket.ticket_id });
    } else if (data === "b" && ticket.status === "blocked") {
      this.done({ action: "resume", ticketId: ticket.ticket_id });
    } else if (data === "t" && (ticket.status === "failed" || ticket.status === "lost")) {
      this.done({ action: "retry", ticketId: ticket.ticket_id });
    } else if (data === "x") {
      this.done({ action: "cancel_ticket", ticketId: ticket.ticket_id });
    } else if (data === "c") {
      this.done({ action: "cancel_task" });
    }
  }

  render(width: number): string[] {
    const state = this.model.state;
    const body: string[] = [];
    if (state.loading) body.push(this.theme.fg("dim", "Loading task..."));
    else if (state.error) body.push(this.theme.fg("error", state.error));
    else if (!state.task) body.push(this.theme.fg("dim", "Task not found."));
    else {
      const task = state.task;
      body.push(`${this.theme.fg("accent", task.task_id)}  ${this.theme.fg(statusColor(task.status), task.status)}`);
      body.push(this.theme.fg("dim", truncateToWidth(task.prompt, Math.max(20, width - 6))));
      body.push("");
      for (let index = 0; index < task.tickets.length; index += 1) {
        const ticket = task.tickets[index];
        const selected = index === state.selected;
        const marker = selected ? this.theme.fg("accent", "▶ ") : "  ";
        body.push(`${marker}${this.theme.fg(statusColor(ticket.status), ticket.status.padEnd(10))} ${ticket.ticket_id}  ${ticket.title}`);
      }
      const ticket = this.model.selectedTicket();
      if (ticket) {
        body.push("");
        body.push(this.theme.fg("accent", ticket.title));
        if (ticket.workspace) body.push(`workspace: ${truncateToWidth(ticket.workspace, Math.max(20, width - 6))}`);
        if (ticket.branch) body.push(`branch: ${ticket.branch}`);
        if (ticket.commit) body.push(`commit: ${ticket.commit}`);
        if (ticket.delivered_to.length > 0) {
          body.push(`delivered: ${truncateToWidth(ticket.delivered_to.join(", "), Math.max(20, width - 6))}`);
        }
        if (ticket.delivery_error) {
          body.push(this.theme.fg("error", `delivery error: ${truncateToWidth(ticket.delivery_error, Math.max(20, width - 6))}`));
        }
        if (ticket.summary) body.push(`summary: ${ticket.summary}`);
        if (ticket.question) body.push(this.theme.fg("warning", `question: ${ticket.question.text}`));
        if (ticket.error) body.push(this.theme.fg("error", `error: ${ticket.error.code}: ${ticket.error.message}`));
        if (ticket.outcome) body.push(`outcome: ${ticket.outcome}`);
      }
    }
    return box(this.theme, width, `Task ${this.model.taskId}`, body,
      "↑↓ ticket • a answer • b resume • t retry • x cancel ticket • c cancel task • r refresh • q close");
  }
}

async function openTasks(ctx: ExtensionCommandContext, client: OrchestratorClient): Promise<TasksResult | undefined> {
  return ctx.ui.custom<TasksResult | undefined>(
    (tui, theme, _keybindings, done) => new TasksComponent(client, theme, tui, done),
    { overlay: true },
  );
}

async function openTaskDetail(
  ctx: ExtensionCommandContext,
  client: OrchestratorClient,
  taskId: string,
): Promise<void> {
  let current = taskId;
  for (;;) {
    const result = await ctx.ui.custom<DetailResult | undefined>(
      (tui, theme, _keybindings, done) => new TaskDetailComponent(client, current, theme, tui, done),
      { overlay: true },
    );
    if (!result) return;
    if (result.action === "answer" && result.ticketId) {
      const message = await ctx.ui.input("Answer:", "Your answer");
      if (message) await client.answer(result.ticketId, message);
    } else if (result.action === "resume" && result.ticketId) {
      const note = await ctx.ui.input("Resume note:", "What changed?");
      await client.resume(result.ticketId, note ?? undefined);
    } else if (result.action === "retry" && result.ticketId) {
      const note = await ctx.ui.input("Retry note:", "Extra context");
      await client.retry(result.ticketId, note ?? undefined);
    } else if (result.action === "cancel_ticket" && result.ticketId) {
      if (await ctx.ui.confirm("Cancel ticket?", `Cancel ${result.ticketId}?`)) {
        await client.cancelTicket(result.ticketId, "cancelled from Tasks page");
      }
    } else if (result.action === "cancel_task") {
      if (await ctx.ui.confirm("Cancel task?", `Cancel ${current} and all active tickets?`)) {
        await client.cancelTask(current, "cancelled from Tasks page");
        return;
      }
    }
  }
}

export function registerPageCommands(pi: ExtensionAPI): void {
  const client = new OrchestratorClient({ baseUrl: BASE, token: TOKEN });

  pi.registerCommand("tasks", {
    description: "Open the Tasks page",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Tasks requires TUI mode", "warning");
        return;
      }
      const result = await openTasks(ctx, client);
      if (result) await openTaskDetail(ctx, client, result.taskId);
    },
  });

  pi.registerCommand("task", {
    description: "Open a Task page: /task <task_id>",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Task requires TUI mode", "warning");
        return;
      }
      let taskId = args.trim();
      if (!taskId) {
        const result = await openTasks(ctx, client);
        if (!result) return;
        taskId = result.taskId;
      }
      await openTaskDetail(ctx, client, taskId);
    },
  });
}
