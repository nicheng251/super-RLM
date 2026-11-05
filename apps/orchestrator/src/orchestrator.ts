
/**
 * Minimal Orchestrator core: task creation, scheduling, reports, HITL actions.
 *
 * The store is the only state writer; this class is the only caller that
 * applies domain transitions. HTTP handlers are thin wrappers.
 */

import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { profileExecution, type ProfilesConfig } from "./profiles.ts";
import type {
  ExecutionRequest,
  ExecutionResponse,
  ReportAck,
  TaskCreateRequest,
  TaskCreateResponse,
  TaskListItem,
  TaskView,
  TicketActionResult,
  TicketResult,
  WorkerHeartbeat,
  WorkerRegistration,
  WorkerReport,
} from "../../../packages/protocol/ts/index.ts";
import { Store } from "./db.ts";
import {
  canStart,
  deriveTaskStatus,
  isTerminalTask,
  isTerminalTicket,
  reportOutcome,
  taskView,
  ticketResult,
  ticketSummary,
  validateReportShape,
} from "./domain.ts";
import type {
  AssignmentKind,
  AssignmentRecord,
  SlotCounts,
  SlotPolicy,
  TaskRecord,
  TicketRecord,
  WorkerRecord,
} from "./domain.ts";

export class OrchestratorError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "OrchestratorError";
    this.code = code;
    this.details = details;
  }
}

export interface DispatchSuccess {
  ok: true;
  executionId: string;
}

export interface DispatchFailure {
  ok: false;
  status: number;
  error: string;
  retryable: boolean;
}

export type DispatchResult = DispatchSuccess | DispatchFailure;
export type DispatchFn = (
  worker: WorkerRecord,
  request: ExecutionRequest,
  timeoutMs: number,
) => Promise<DispatchResult>;

export interface OrchestratorConfig {
  maxConcurrentTickets: number;
  maxConcurrentTicketsPerTask: number;
  priorityReserved: number;
  workerLeaseMs: number;
  dispatchTimeoutMs: number;
  workspaceRoot: string;
  profiles?: ProfilesConfig;
}

export const DEFAULT_CONFIG: Omit<OrchestratorConfig, "workspaceRoot"> = {
  maxConcurrentTickets: 4,
  maxConcurrentTicketsPerTask: 2,
  priorityReserved: 1,
  workerLeaseMs: 30_000,
  dispatchTimeoutMs: 10_000,
};

const BACKOFF_MS = [2_000, 5_000, 15_000];

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function defaultDispatch(
  worker: WorkerRecord,
  request: ExecutionRequest,
  timeoutMs: number,
): Promise<DispatchResult> {
  const url = `${worker.url.replace(/\/$/, "")}/v1/executions`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (response.status === 202) {
      const body = JSON.parse(text) as ExecutionResponse;
      return { ok: true, executionId: body.execution_id };
    }
    return {
      ok: false,
      status: response.status,
      error: text || `worker returned ${response.status}`,
      retryable: response.status !== 409 && response.status < 500,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
      retryable: true,
    };
  }
}

export class Orchestrator {
  readonly store: Store;
  readonly config: OrchestratorConfig;
  private readonly dispatch: DispatchFn;
  private readonly profiles: ProfilesConfig | null;
  private scheduling = false;
  private scheduleAgain = false;

  constructor(store: Store, config: OrchestratorConfig, dispatch: DispatchFn = defaultDispatch) {
    this.store = store;
    this.config = config;
    this.dispatch = dispatch;
    this.profiles = config.profiles ?? null;
  }

  private slotPolicy(): SlotPolicy {
    return {
      globalMax: this.config.maxConcurrentTickets,
      perTaskMax: this.config.maxConcurrentTicketsPerTask,
      priorityReserved: this.config.priorityReserved,
    };
  }

  private countsFor(ticket: TicketRecord, kind: AssignmentKind): SlotCounts {
    return {
      totalRunning: this.store.countRunningAssignments(),
      normalRunning: this.store.countRunningByKind("normal"),
      priorityRunning: this.store.countRunningByKind("priority"),
      taskNormalRunning: this.store.countRunningForTask(ticket.task_id, "normal"),
    };
  }

  async createTask(input: TaskCreateRequest): Promise<TaskCreateResponse> {
    if (!input.prompt.trim()) throw new OrchestratorError("invalid_prompt", "prompt is required");
    if (input.tickets.length === 0 || input.tickets.length > 16) {
      throw new OrchestratorError("invalid_tickets", "a Task needs 1..16 Tickets");
    }
    const seen = new Set<string>();
    for (const ticket of input.tickets) {
      if (!ticket.title.trim() || ticket.title.length > 200) {
        throw new OrchestratorError("invalid_ticket_title", "title must be 1..200 characters");
      }
      if (!ticket.prompt.trim()) throw new OrchestratorError("invalid_ticket_prompt", "prompt is required");
      const profileName = ticket.profile ?? "default";
      if (this.profiles && !this.profiles.profiles[profileName]) {
        throw new OrchestratorError("unknown_profile", `unknown profile: ${profileName}`, { profile: profileName });
      }
      const key = `${ticket.title.trim()}::${ticket.prompt.trim()}`;
      if (seen.has(key)) {
        throw new OrchestratorError("duplicate_ticket", `duplicate ticket: ${ticket.title}`);
      }
      seen.add(key);
    }

    const now = nowIso();
    const taskId = newId("tsk");
    const task: TaskRecord = {
      task_id: taskId,
      prompt: input.prompt,
      status: "queued",
      metadata: input.metadata ?? {},
      created_at: now,
      updated_at: now,
      cancel_requested: false,
      timeout_at: null,
    };
    const tickets: TicketRecord[] = input.tickets.map((spec) => {
      const ticketId = newId("tkt");
      return {
        ticket_id: ticketId,
        task_id: taskId,
        title: spec.title,
        prompt: spec.prompt,
        profile: spec.profile ?? "default",
        status: "queued",
        summary: null,
        result: null,
        artifacts: [],
        usage: null,
        error: null,
        question: null,
        session_key: ticketId,
        session_ref: null,
        outcome: null,
        no_op: null,
        retry_count: 0,
        not_before: null,
        priority_next: false,
        resume_message: null,
        delivered_to: [],
        delivery_error: null,
        workspace_metadata: null,
        metadata_error: null,
        created_at: now,
        updated_at: now,
      };
    });

    this.store.insertTask(task, tickets);
    this.store.appendEvent({
      type: "task.created", task_id: taskId, data: { prompt: input.prompt, ticket_count: tickets.length },
    });
    for (const ticket of tickets) {
      this.store.appendEvent({ type: "ticket.created", task_id: taskId, ticket_id: ticket.ticket_id });
    }
    await this.schedule();

    return {
      task_id: taskId,
      status: "queued",
      tickets: tickets.map((ticket) => ({
        ticket_id: ticket.ticket_id, title: ticket.title, status: ticket.status,
      })),
    };
  }

  getTask(taskId: string): TaskView {
    const { task, tickets } = this.refreshTask(taskId);
    return taskView({ task, tickets, workspaceRoot: this.config.workspaceRoot });
  }

  listTasks(query: { status?: string; limit?: number } = {}): TaskListItem[] {
    return this.store.listTasks(query).map((task) => {
      const tickets = this.store.getTicketsForTask(task.task_id);
      return {
        task_id: task.task_id,
        status: task.status,
        prompt: task.prompt,
        ticket_count: tickets.length,
        running_count: tickets.filter((ticket) => ticket.status === "assigned" || ticket.status === "running").length,
        waiting_count: tickets.filter((ticket) => ticket.status === "waiting" || ticket.status === "blocked").length,
        created_at: task.created_at,
        updated_at: task.updated_at,
      };
    });
  }

  async waitForTask(taskId: string, timeoutSeconds = 120): Promise<TaskView> {
    const deadline = Date.now() + Math.max(0, timeoutSeconds) * 1000;
    for (;;) {
      const view = this.getTask(taskId);
      if (isTerminalTask(view.status) || Date.now() >= deadline) return view;
      await sleep(200);
    }
  }

  getTicketResult(ticketId: string, maxChars = 20_000): TicketResult {
    const ticket = this.store.getTicket(ticketId);
    if (!ticket) throw new OrchestratorError("ticket_not_found", `no such ticket: ${ticketId}`);
    return ticketResult(ticket, maxChars, this.config.workspaceRoot);
  }

  async answerTicket(ticketId: string, message: string): Promise<TicketActionResult> {
    const ticket = this.requireTicket(ticketId);
    if (ticket.status !== "waiting") {
      throw new OrchestratorError("ticket_not_waiting", `Ticket ${ticketId} is ${ticket.status}, not waiting`);
    }
    this.store.insertAnswer(ticketId, "answer", message);
    this.store.updateTicket(ticketId, {
      status: "queued",
      question: null,
      priority_next: true,
      resume_message: message,
      updated_at: nowIso(),
    });
    this.store.appendEvent({ type: "ticket.updated", task_id: ticket.task_id, ticket_id: ticketId, data: { action: "answer" } });
    await this.schedule();
    return this.actionResult(ticketId);
  }

  async resumeTicket(ticketId: string, note: string | null = null): Promise<TicketActionResult> {
    const ticket = this.requireTicket(ticketId);
    if (ticket.status !== "blocked") {
      throw new OrchestratorError("ticket_not_blocked", `Ticket ${ticketId} is ${ticket.status}, not blocked`);
    }
    this.store.insertAnswer(ticketId, "resume", note ?? "");
    this.store.updateTicket(ticketId, {
      status: "queued",
      question: null,
      priority_next: true,
      resume_message: note,
      updated_at: nowIso(),
    });
    this.store.appendEvent({ type: "ticket.updated", task_id: ticket.task_id, ticket_id: ticketId, data: { action: "resume" } });
    await this.schedule();
    return this.actionResult(ticketId);
  }

  async retryTicket(ticketId: string, note: string | null = null): Promise<TicketActionResult> {
    const ticket = this.requireTicket(ticketId);
    if (ticket.status !== "failed" && ticket.status !== "lost") {
      throw new OrchestratorError("ticket_not_retryable", `Ticket ${ticketId} is ${ticket.status}`);
    }
    this.store.insertAnswer(ticketId, "retry", note ?? "");
    this.store.updateTicket(ticketId, {
      status: "queued",
      retry_count: 0,
      not_before: null,
      priority_next: false,
      resume_message: note,
      updated_at: nowIso(),
    });
    this.store.appendEvent({ type: "ticket.updated", task_id: ticket.task_id, ticket_id: ticketId, data: { action: "retry" } });
    await this.schedule();
    return this.actionResult(ticketId);
  }

  async cancelTicket(ticketId: string, reason: string | null = null): Promise<TicketActionResult> {
    const ticket = this.requireTicket(ticketId);
    if (isTerminalTicket(ticket.status)) return this.actionResult(ticketId);
    await this.endActiveAssignment(ticket, "cancelled", reason);
    this.store.updateTicket(ticketId, { status: "cancelled", updated_at: nowIso() });
    this.store.appendEvent({
      type: "ticket.settled", task_id: ticket.task_id, ticket_id: ticketId, data: { status: "cancelled", reason },
    });
    this.refreshTask(ticket.task_id);
    await this.schedule();
    return this.actionResult(ticketId);
  }

  async cancelTask(taskId: string, reason: string | null = null): Promise<TaskView> {
    const task = this.store.getTask(taskId);
    if (!task) throw new OrchestratorError("task_not_found", `no such task: ${taskId}`);
    this.store.updateTask(taskId, { cancel_requested: true, updated_at: nowIso() });
    for (const ticket of this.store.getTicketsForTask(taskId)) {
      if (!isTerminalTicket(ticket.status)) await this.cancelTicket(ticket.ticket_id, reason);
    }
    this.store.updateTask(taskId, { status: "cancelled", updated_at: nowIso() });
    this.store.appendEvent({ type: "task.settled", task_id: taskId, data: { status: "cancelled", reason } });
    return this.getTask(taskId);
  }

  registerWorker(input: WorkerRegistration): WorkerRecord {
    const now = nowIso();
    const worker: WorkerRecord = {
      worker_id: input.worker_id,
      url: input.url,
      max_concurrency: input.max_concurrency,
      running: this.store.countRunningForWorker(input.worker_id),
      status: "healthy",
      version: input.version,
      last_heartbeat: now,
    };
    this.store.upsertWorker(worker);
    this.store.appendEvent({ type: "worker.registered", worker_id: worker.worker_id, data: { url: worker.url } });
    void this.schedule();
    return worker;
  }

  async heartbeatWorker(workerId: string, input: WorkerHeartbeat): Promise<WorkerRecord> {
    const worker = this.store.getWorker(workerId);
    if (!worker) throw new OrchestratorError("worker_not_found", `no such worker: ${workerId}`);
    this.store.updateWorker(workerId, {
      running: input.running,
      max_concurrency: input.max_concurrency,
      status: input.status,
      last_heartbeat: nowIso(),
    });
    await this.schedule();
    return this.store.getWorker(workerId)!;
  }

  assignmentHeartbeat(assignmentId: string): void {
    const assignment = this.store.getAssignment(assignmentId);
    if (!assignment) throw new OrchestratorError("assignment_not_found", `no such assignment: ${assignmentId}`);
    this.store.updateAssignment(assignmentId, { updated_at: nowIso() });
  }

  async handleReport(report: WorkerReport): Promise<ReportAck> {
    const assignment = this.store.getAssignment(report.assignment_id);
    if (!assignment) throw new OrchestratorError("assignment_not_found", `no such assignment: ${report.assignment_id}`);
    if (report.ticket_id !== assignment.ticket_id) return { accepted: false, reason: "ticket_mismatch" };
    if (this.store.hasReport(report.idempotency_key)) return { accepted: true, reason: "duplicate" };
    if (assignment.status === "ended") return { accepted: false, reason: "assignment_ended" };
    if (report.seq <= assignment.last_seq) return { accepted: true, reason: "duplicate" };

    const shapeError = validateReportShape(report);
    if (shapeError) return { accepted: false, reason: shapeError };

    const ticket = this.requireTicket(report.ticket_id);
    this.store.insertReport({
      ticket_id: report.ticket_id,
      assignment_id: report.assignment_id,
      execution_id: report.execution_id,
      seq: report.seq,
      idempotency_key: report.idempotency_key,
      state: report.state,
      summary: report.summary ?? null,
      result: report.result ?? null,
      artifacts: report.artifacts,
      usage: report.usage ?? null,
      error: report.error ?? null,
      session_ref: report.session_ref ?? null,
      resumed: report.resumed ?? null,
      recovery: report.recovery ?? null,
      question: report.question ?? null,
      timestamp: report.timestamp,
    });
    this.store.updateAssignment(assignment.assignment_id, {
      last_seq: report.seq, updated_at: nowIso(),
    });

    if (report.state === "progress") {
      this.store.updateTicket(ticket.ticket_id, {
        summary: report.summary ?? ticket.summary,
        session_ref: report.session_ref ?? ticket.session_ref,
        workspace_metadata: report.workspace_metadata ?? ticket.workspace_metadata,
        metadata_error: report.metadata_error ?? ticket.metadata_error,
        updated_at: nowIso(),
      });
      this.store.appendEvent({
        type: "ticket.updated", task_id: ticket.task_id, ticket_id: ticket.ticket_id,
        assignment_id: assignment.assignment_id, data: { state: "progress" },
      });
      return { accepted: true };
    }

    const outcome = reportOutcome(report.state);
    if (!outcome) return { accepted: false, reason: "invalid_state" };

    this.store.updateAssignment(assignment.assignment_id, {
      status: "ended", end_reason: outcome.endReason, updated_at: nowIso(),
    });
    this.store.updateTicket(ticket.ticket_id, {
      status: outcome.ticketStatus,
      summary: report.summary ?? ticket.summary,
      result: report.result ?? ticket.result,
      artifacts: report.artifacts.length > 0 ? report.artifacts : ticket.artifacts,
      usage: report.usage ?? ticket.usage,
      error: report.error ?? ticket.error,
      question: report.question ?? null,
      session_ref: report.session_ref ?? ticket.session_ref,
      outcome: outcome.outcome ?? ticket.outcome,
      no_op: outcome.noOp ?? ticket.no_op,
      delivered_to: report.delivered_to ?? [],
      delivery_error: report.delivery_error ?? null,
      workspace_metadata: report.workspace_metadata ?? ticket.workspace_metadata,
      metadata_error: report.metadata_error ?? ticket.metadata_error,
      updated_at: nowIso(),
    });
    if (assignment.worker_id) {
      const worker = this.store.getWorker(assignment.worker_id);
      if (worker) {
        this.store.updateWorker(worker.worker_id, {
          running: this.store.countRunningForWorker(worker.worker_id),
        });
      }
    }
    this.store.appendEvent({
      type: "assignment.ended", task_id: ticket.task_id, ticket_id: ticket.ticket_id,
      assignment_id: assignment.assignment_id, worker_id: assignment.worker_id,
      data: { state: report.state, end_reason: outcome.endReason },
    });
    if (report.state === "waiting" || report.state === "blocked") {
      this.store.appendEvent({
        type: report.state === "waiting" ? "ticket.waiting" : "ticket.blocked",
        task_id: ticket.task_id, ticket_id: ticket.ticket_id, data: { question: report.question },
      });
    } else {
      this.store.appendEvent({
        type: "ticket.settled", task_id: ticket.task_id, ticket_id: ticket.ticket_id,
        data: { status: outcome.ticketStatus, outcome: outcome.outcome ?? null },
      });
    }
    this.refreshTask(ticket.task_id);
    await this.schedule();
    return { accepted: true };
  }

  /** Recover assignments left open by a previous Orchestrator process. */
  recover(): void {
    for (const assignment of this.store.listActiveAssignments()) {
      this.store.updateAssignment(assignment.assignment_id, {
        status: "ended", end_reason: "lost", updated_at: nowIso(),
      });
      const ticket = this.store.getTicket(assignment.ticket_id);
      if (!ticket || isTerminalTicket(ticket.status)) continue;
      const retryCount = ticket.retry_count + 1;
      if (retryCount > 3) {
        this.store.updateTicket(ticket.ticket_id, {
          status: "failed",
          error: { code: "worker_lost", message: "Orchestrator restarted with an open assignment", retryable: true },
          updated_at: nowIso(),
        });
      } else {
        const delay = BACKOFF_MS[Math.min(retryCount - 1, BACKOFF_MS.length - 1)];
        this.store.updateTicket(ticket.ticket_id, {
          status: "lost",
          retry_count: retryCount,
          not_before: new Date(Date.now() + delay).toISOString(),
          updated_at: nowIso(),
        });
      }
      this.store.appendEvent({
        type: "assignment.ended", task_id: ticket.task_id, ticket_id: ticket.ticket_id,
        assignment_id: assignment.assignment_id, worker_id: assignment.worker_id,
        data: { reason: "orchestrator_recovery" },
      });
      this.refreshTask(ticket.task_id);
    }
  }

  async schedule(): Promise<void> {
    if (this.scheduling) {
      this.scheduleAgain = true;
      return;
    }
    this.scheduling = true;
    try {
      this.reapWorkers();
      const now = nowIso();
      const queued = this.store.nextQueuedTickets(now);
      for (const ticket of queued) {
        if (isTerminalTicket(ticket.status) || ticket.status === "assigned" || ticket.status === "running") continue;
        if (this.store.getActiveAssignment(ticket.ticket_id)) continue;
        const task = this.store.getTask(ticket.task_id);
        if (!task || task.cancel_requested) continue;
        const kind: AssignmentKind = ticket.priority_next ? "priority" : "normal";
        await this.tryStart(ticket, kind);
      }
    } finally {
      this.scheduling = false;
      if (this.scheduleAgain) {
        this.scheduleAgain = false;
        void this.schedule();
      }
    }
  }

  private async tryStart(ticket: TicketRecord, kind: AssignmentKind): Promise<boolean> {
    const task = this.store.getTask(ticket.task_id);
    const originCwd = typeof task?.metadata?.origin_cwd === "string" && task.metadata.origin_cwd.trim()
      ? task.metadata.origin_cwd
      : null;
    const workers = this.store.listWorkers().filter((worker) => worker.status === "healthy");
    for (const worker of workers) {
      const counts = this.countsFor(ticket, kind);
      const workerRunning = this.store.countRunningForWorker(worker.worker_id);
      if (!canStart(kind, counts, this.slotPolicy(), workerRunning, worker.max_concurrency)) continue;

      const now = nowIso();
      const assignment: AssignmentRecord = {
        assignment_id: newId("asg"),
        ticket_id: ticket.ticket_id,
        task_id: ticket.task_id,
        worker_id: worker.worker_id,
        execution_id: null,
        status: "pending",
        end_reason: null,
        kind,
        last_seq: 0,
        resume_ref: ticket.session_ref,
        resume_message: ticket.resume_message,
        created_at: now,
        updated_at: now,
      };
      this.store.insertAssignment(assignment);
      this.store.updateTicket(ticket.ticket_id, {
        status: "assigned", priority_next: false, resume_message: null, updated_at: now,
      });

      const request: ExecutionRequest = {
        ticket_id: ticket.ticket_id,
        assignment_id: assignment.assignment_id,
        prompt: ticket.prompt,
        profile: ticket.profile,
        workspace: `${this.config.workspaceRoot}/${ticket.ticket_id}`,
        origin_cwd: originCwd,
        deadline: null,
        resume: ticket.session_ref
          ? { session_ref: ticket.session_ref, message: ticket.resume_message ?? undefined }
          : null,
      };
      const profile = this.profiles?.profiles[ticket.profile];
      if (profile) request.execution = profileExecution(profile);
      const result = await this.dispatch(worker, request, this.config.dispatchTimeoutMs);
      if (result.ok) {
        this.store.updateAssignment(assignment.assignment_id, {
          status: "running", execution_id: result.executionId, updated_at: nowIso(),
        });
        this.store.updateTicket(ticket.ticket_id, { status: "running", updated_at: nowIso() });
        this.store.updateWorker(worker.worker_id, {
          running: this.store.countRunningForWorker(worker.worker_id),
          last_heartbeat: worker.last_heartbeat,
        });
        this.store.appendEvent({
          type: "assignment.started", task_id: ticket.task_id, ticket_id: ticket.ticket_id,
          assignment_id: assignment.assignment_id, worker_id: worker.worker_id,
          data: { kind, execution_id: result.executionId },
        });
        return true;
      }

      this.store.updateAssignment(assignment.assignment_id, {
        status: "ended", end_reason: "failed", updated_at: nowIso(),
      });
      this.store.appendEvent({
        type: "assignment.ended", task_id: ticket.task_id, ticket_id: ticket.ticket_id,
        assignment_id: assignment.assignment_id, worker_id: worker.worker_id,
        data: { error: result.error, status: result.status },
      });
      if (result.status === 409) {
        this.store.updateTicket(ticket.ticket_id, { status: "queued", updated_at: nowIso() });
        continue;
      }
      const retryCount = ticket.retry_count + 1;
      if (!result.retryable || retryCount > 3) {
        this.store.updateTicket(ticket.ticket_id, {
          status: "failed",
          error: { code: "dispatch_failed", message: result.error, retryable: result.retryable },
          updated_at: nowIso(),
        });
        this.refreshTask(ticket.task_id);
      } else {
        const delay = BACKOFF_MS[Math.min(retryCount - 1, BACKOFF_MS.length - 1)];
        this.store.updateTicket(ticket.ticket_id, {
          status: "queued",
          retry_count: retryCount,
          not_before: new Date(Date.now() + delay).toISOString(),
          updated_at: nowIso(),
        });
      }
      return false;
    }
    return false;
  }

  private reapWorkers(): void {
    const now = Date.now();
    for (const worker of this.store.listWorkers()) {
      if (worker.status === "lost") continue;
      if (now - Date.parse(worker.last_heartbeat) <= this.config.workerLeaseMs) continue;
      this.store.updateWorker(worker.worker_id, { status: "lost", running: 0 });
      this.store.appendEvent({ type: "worker.lost", worker_id: worker.worker_id });
      for (const assignment of this.store.listActiveAssignmentsForWorker(worker.worker_id)) {
        this.store.updateAssignment(assignment.assignment_id, {
          status: "ended", end_reason: "lost", updated_at: nowIso(),
        });
        const ticket = this.store.getTicket(assignment.ticket_id);
        if (!ticket || isTerminalTicket(ticket.status)) continue;
        const retryCount = ticket.retry_count + 1;
        if (retryCount > 3) {
          this.store.updateTicket(ticket.ticket_id, {
            status: "failed",
            error: { code: "worker_lost", message: "worker heartbeat expired", retryable: true },
            updated_at: nowIso(),
          });
        } else {
          const delay = BACKOFF_MS[Math.min(retryCount - 1, BACKOFF_MS.length - 1)];
          this.store.updateTicket(ticket.ticket_id, {
            status: "lost",
            retry_count: retryCount,
            not_before: new Date(Date.now() + delay).toISOString(),
            updated_at: nowIso(),
          });
        }
        this.refreshTask(ticket.task_id);
      }
    }
  }

  private async endActiveAssignment(
    ticket: TicketRecord,
    endReason: AssignmentRecord["end_reason"],
    reason: string | null = null,
  ): Promise<void> {
    const assignment = this.store.getActiveAssignment(ticket.ticket_id);
    if (!assignment) return;
    this.store.updateAssignment(assignment.assignment_id, {
      status: "ended", end_reason: endReason, updated_at: nowIso(),
    });
    if (assignment.worker_id) {
      const worker = this.store.getWorker(assignment.worker_id);
      if (worker) {
        this.store.updateWorker(worker.worker_id, {
          running: this.store.countRunningForWorker(worker.worker_id),
        });
        if (endReason === "cancelled" && assignment.execution_id) {
          try {
            await fetch(`${worker.url.replace(/\/$/, "")}/v1/executions/${assignment.execution_id}/cancel`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ reason: reason ?? "cancelled" }),
              signal: AbortSignal.timeout(2000),
            });
          } catch {
            // Cancellation is authoritative in the Orchestrator; a Worker
            // notification failure does not roll the Ticket back.
          }
        }
      }
    }
  }

  private refreshTask(taskId: string): { task: TaskRecord; tickets: TicketRecord[] } {
    const task = this.store.getTask(taskId);
    if (!task) throw new OrchestratorError("task_not_found", `no such task: ${taskId}`);
    const tickets = this.store.getTicketsForTask(taskId);
    const timedOut = task.timeout_at !== null && Date.parse(task.timeout_at) <= Date.now();
    const status = deriveTaskStatus({ cancelled: task.cancel_requested, timedOut, tickets });
    if (status !== task.status) {
      this.store.updateTask(taskId, { status, updated_at: nowIso() });
      this.store.appendEvent({ type: "task.updated", task_id: taskId, data: { status } });
      if (isTerminalTask(status)) {
        this.store.appendEvent({ type: "task.settled", task_id: taskId, data: { status } });
      }
      return { task: { ...task, status }, tickets };
    }
    return { task, tickets };
  }

  private actionResult(ticketId: string): TicketActionResult {
    const ticket = this.requireTicket(ticketId);
    const assignment = this.store.getActiveAssignment(ticketId);
    return { ticket_id: ticket.ticket_id, status: ticket.status, assignment_id: assignment?.assignment_id ?? null };
  }

  private requireTicket(ticketId: string): TicketRecord {
    const ticket = this.store.getTicket(ticketId);
    if (!ticket) throw new OrchestratorError("ticket_not_found", `no such ticket: ${ticketId}`);
    return ticket;
  }
}
