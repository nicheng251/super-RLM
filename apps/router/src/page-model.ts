
import type { TaskListItem, TaskView, TicketSummary } from "../../../packages/protocol/ts/index.ts";
import type { OrchestratorClient } from "./client.ts";

export interface TasksPageState {
  tasks: TaskListItem[];
  selected: number;
  loading: boolean;
  error: string | null;
}

export class TasksPageModel {
  readonly client: OrchestratorClient;
  state: TasksPageState = { tasks: [], selected: 0, loading: false, error: null };

  constructor(client: OrchestratorClient) {
    this.client = client;
  }

  async load(limit = 20): Promise<void> {
    this.state.loading = true;
    this.state.error = null;
    try {
      this.state.tasks = await this.client.listTasks(limit);
      this.state.selected = Math.min(this.state.selected, Math.max(0, this.state.tasks.length - 1));
    } catch (error) {
      this.state.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.state.loading = false;
    }
  }

  move(delta: number): void {
    if (this.state.tasks.length === 0) return;
    this.state.selected = Math.max(0, Math.min(this.state.tasks.length - 1, this.state.selected + delta));
  }

  selectedTask(): TaskListItem | null {
    return this.state.tasks[this.state.selected] ?? null;
  }
}

export interface TaskDetailPageState {
  task: TaskView | null;
  selected: number;
  loading: boolean;
  error: string | null;
}

export class TaskDetailPageModel {
  readonly client: OrchestratorClient;
  taskId: string;
  state: TaskDetailPageState = { task: null, selected: 0, loading: false, error: null };

  constructor(client: OrchestratorClient, taskId: string) {
    this.client = client;
    this.taskId = taskId;
  }

  async load(): Promise<void> {
    this.state.loading = true;
    this.state.error = null;
    try {
      this.state.task = await this.client.getTask(this.taskId);
      this.state.selected = Math.min(this.state.selected, Math.max(0, this.state.task.tickets.length - 1));
    } catch (error) {
      this.state.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.state.loading = false;
    }
  }

  move(delta: number): void {
    const tickets = this.state.task?.tickets ?? [];
    if (tickets.length === 0) return;
    this.state.selected = Math.max(0, Math.min(tickets.length - 1, this.state.selected + delta));
  }

  selectedTicket(): TicketSummary | null {
    return this.state.task?.tickets[this.state.selected] ?? null;
  }
}
