
/**
 * Pure Orchestrator domain rules: status derivation, report mapping, slots.
 *
 * The wire types come from packages/protocol. Internal row types live here so
 * the store and scheduler share one shape.
 */

import type {
  Artifact,
  AssignmentEndReason,
  AssignmentStatus,
  ErrorObject,
  Question,
  ReportState,
  TaskStatus,
  TaskView,
  TicketResult,
  TicketStatus,
  TicketSummary,
  Usage,
  WorkerReport,
} from "../../../packages/protocol/ts/index.ts";

export type { TicketStatus } from "../../../packages/protocol/ts/index.ts";

export type AssignmentKind = "normal" | "priority";
export type WorkerStatus = "healthy" | "draining" | "lost";

export interface TaskRecord {
  task_id: string;
  prompt: string;
  status: TaskStatus;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  cancel_requested: boolean;
  timeout_at: string | null;
}

export interface TicketRecord {
  ticket_id: string;
  task_id: string;
  title: string;
  prompt: string;
  profile: string;
  status: TicketStatus;
  summary: string | null;
  result: string | null;
  artifacts: Artifact[];
  usage: Usage | null;
  error: ErrorObject | null;
  question: Question | null;
  session_key: string;
  session_ref: string | null;
  outcome: string | null;
  no_op: boolean | null;
  retry_count: number;
  not_before: string | null;
  priority_next: boolean;
  resume_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface AssignmentRecord {
  assignment_id: string;
  ticket_id: string;
  task_id: string;
  worker_id: string | null;
  execution_id: string | null;
  status: AssignmentStatus;
  end_reason: AssignmentEndReason | null;
  kind: AssignmentKind;
  last_seq: number;
  resume_ref: string | null;
  resume_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkerRecord {
  worker_id: string;
  url: string;
  max_concurrency: number;
  running: number;
  status: WorkerStatus;
  version: string | null;
  last_heartbeat: string;
}

export interface SlotCounts {
  totalRunning: number;
  normalRunning: number;
  priorityRunning: number;
  taskNormalRunning: number;
}

export interface SlotPolicy {
  globalMax: number;
  perTaskMax: number;
  priorityReserved: number;
}

const TERMINAL_TICKET: readonly TicketStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
];

const TERMINAL_TASK: readonly TaskStatus[] = [
  "succeeded",
  "partial",
  "failed",
  "cancelled",
  "timed_out",
];

export function isTerminalTicket(status: TicketStatus): boolean {
  return TERMINAL_TICKET.includes(status);
}

export function isTerminalTask(status: TaskStatus): boolean {
  return TERMINAL_TASK.includes(status);
}

export function isActiveTicket(status: TicketStatus): boolean {
  return status === "assigned" || status === "running";
}

export function deriveTaskStatus(input: {
  cancelled: boolean;
  timedOut: boolean;
  tickets: Pick<TicketRecord, "status">[];
}): TaskStatus {
  if (input.cancelled) return "cancelled";
  if (input.timedOut) return "timed_out";

  const statuses = input.tickets.map((ticket) => ticket.status);
  if (statuses.some(isActiveTicket)) return "running";
  if (statuses.some((status) => status === "queued" || status === "lost")) return "queued";
  if (statuses.some((status) => status === "waiting" || status === "blocked")) return "waiting";

  if (statuses.length === 0) return "queued";
  if (statuses.every((status) => status === "succeeded")) return "succeeded";
  if (statuses.every((status) => status === "cancelled")) return "cancelled";
  if (statuses.some((status) => status === "succeeded")) return "partial";
  if (statuses.some((status) => status === "failed")) return "failed";
  return "timed_out";
}

export interface ReportOutcome {
  ticketStatus: TicketStatus;
  endReason: AssignmentEndReason;
  outcome?: string;
  noOp?: boolean;
}

export function reportOutcome(state: ReportState): ReportOutcome | null {
  switch (state) {
    case "progress":
      return null;
    case "waiting":
      return { ticketStatus: "waiting", endReason: "waiting" };
    case "blocked":
      return { ticketStatus: "blocked", endReason: "blocked" };
    case "completed":
      return { ticketStatus: "succeeded", endReason: "completed" };
    case "dropped":
      return { ticketStatus: "succeeded", endReason: "completed", outcome: "dropped", noOp: true };
    case "failed":
      return { ticketStatus: "failed", endReason: "failed" };
    case "cancelled":
      return { ticketStatus: "cancelled", endReason: "cancelled" };
  }
}

export function validateReportShape(report: WorkerReport): string | null {
  if (report.state === "waiting" || report.state === "blocked") {
    if (!report.question) return `${report.state}_requires_question`;
  }
  if (report.state === "completed") {
    if (!report.summary || (!report.result && report.artifacts.length === 0)) {
      return "completed_requires_result_or_artifacts";
    }
  }
  if (report.state === "dropped" && !report.summary) return "dropped_requires_summary";
  if (report.state === "failed" && !report.error) return "failed_requires_error";
  return null;
}

export function canStart(
  kind: AssignmentKind,
  counts: SlotCounts,
  policy: SlotPolicy,
  workerRunning: number,
  workerCapacity: number,
): boolean {
  if (workerRunning >= workerCapacity) return false;
  if (counts.totalRunning >= policy.globalMax) return false;
  if (kind === "priority") {
    return counts.priorityRunning < 1;
  }
  const normalCap = Math.max(0, policy.globalMax - policy.priorityReserved);
  return counts.normalRunning < normalCap && counts.taskNormalRunning < policy.perTaskMax;
}

export function taskView(input: {
  task: TaskRecord;
  tickets: TicketRecord[];
}): TaskView {
  return {
    task_id: input.task.task_id,
    status: input.task.status,
    prompt: input.task.prompt,
    created_at: input.task.created_at,
    updated_at: input.task.updated_at,
    tickets: input.tickets.map(ticketSummary),
  };
}

export function ticketSummary(ticket: TicketRecord): TicketSummary {
  return {
    ticket_id: ticket.ticket_id,
    title: ticket.title,
    status: ticket.status,
    profile: ticket.profile,
    summary: ticket.summary,
    question: ticket.question,
    error: ticket.error,
    outcome: ticket.outcome,
    no_op: ticket.no_op,
  };
}

export function ticketResult(ticket: TicketRecord, maxChars = 20000): TicketResult {
  const result = ticket.result === null ? null : ticket.result.slice(0, maxChars);
  return {
    ticket_id: ticket.ticket_id,
    status: ticket.status,
    summary: ticket.summary,
    result,
    artifacts: ticket.artifacts,
    usage: ticket.usage,
    error: ticket.error,
    session_ref: ticket.session_ref,
    outcome: ticket.outcome,
    no_op: ticket.no_op,
  };
}
