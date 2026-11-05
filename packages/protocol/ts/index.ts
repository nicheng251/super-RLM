
/**
 * super-RLM v0 protocol types.
 *
 * This file mirrors the JSON Schema generated from
 * `packages/protocol/python/src/super_rlm_protocol/models.py`.
 * Keep both sides in sync; the sample tests live with the Python package.
 */

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "partial"
  | "failed"
  | "cancelled"
  | "timed_out";

export type TicketStatus =
  | "queued"
  | "assigned"
  | "running"
  | "waiting"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "lost";

export type AssignmentStatus = "pending" | "running" | "ended";

export type AssignmentEndReason =
  | "completed"
  | "failed"
  | "waiting"
  | "blocked"
  | "cancelled"
  | "lost";

export type ReportState =
  | "progress"
  | "waiting"
  | "blocked"
  | "completed"
  | "dropped"
  | "failed"
  | "cancelled";

export type QuestionKind = "waiting" | "blocked";

export type ErrorSource = "prime_agent" | "worker" | "orchestrator";


export type EventType =
  | "task.created"
  | "task.updated"
  | "task.settled"
  | "ticket.created"
  | "ticket.updated"
  | "ticket.waiting"
  | "ticket.blocked"
  | "ticket.settled"
  | "assignment.started"
  | "assignment.ended"
  | "worker.registered"
  | "worker.lost"
  | "report.accepted"
  | "report.rejected";

export const TERMINAL_TASK_STATUSES = [
  "succeeded",
  "partial",
  "failed",
  "cancelled",
  "timed_out",
] as const satisfies readonly TaskStatus[];

export const TERMINAL_TICKET_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
] as const satisfies readonly TicketStatus[];

export const TERMINAL_REPORT_STATES = [
  "completed",
  "dropped",
  "waiting",
  "blocked",
  "failed",
] as const satisfies readonly ReportState[];

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);
}

export function isTerminalTicketStatus(status: TicketStatus): boolean {
  return (TERMINAL_TICKET_STATUSES as readonly string[]).includes(status);
}

export function isTerminalReportState(state: ReportState): boolean {
  return (TERMINAL_REPORT_STATES as readonly string[]).includes(state);
}

export interface ErrorObject {
  code: string;
  message: string;
  retryable?: boolean | null;
  source?: ErrorSource | null;
  details?: Record<string, unknown>;
}

export interface Question {
  kind: QuestionKind;
  text: string;
  asked_at?: string | null;
}

export interface Artifact {
  type: "file";
  path: string;
  mime?: string | null;
}

export interface Usage {
  total_tokens?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cost_usd?: number | null;
  [key: string]: unknown;
}

export interface TicketSummary {
  ticket_id: string;
  title: string;
  status: TicketStatus;
  profile: string;
  summary?: string | null;
  question?: Question | null;
  error?: ErrorObject | null;
  outcome?: string | null;
  no_op?: boolean | null;
  workspace?: string | null;
  branch?: string | null;
  commit?: string | null;
}

export interface TicketResult {
  ticket_id: string;
  status: TicketStatus;
  summary?: string | null;
  result?: string | null;
  artifacts: Artifact[];
  usage?: Usage | null;
  error?: ErrorObject | null;
  session_ref?: string | null;
  outcome?: string | null;
  no_op?: boolean | null;
  workspace?: string | null;
  branch?: string | null;
  commit?: string | null;
}

export interface TaskView {
  task_id: string;
  status: TaskStatus;
  prompt: string;
  created_at: string;
  updated_at: string;
  tickets: TicketSummary[];
}

export interface TaskListItem {
  task_id: string;
  status: TaskStatus;
  prompt: string;
  ticket_count: number;
  running_count: number;
  waiting_count: number;
  created_at: string;
  updated_at: string;
}

export interface TicketCreateSpec {
  title: string;
  prompt: string;
  profile?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskCreateRequest {
  prompt: string;
  tickets: TicketCreateSpec[];
  metadata?: Record<string, unknown>;
}

export interface CreatedTicket {
  ticket_id: string;
  title: string;
  status: TicketStatus;
}

export interface TaskCreateResponse {
  task_id: string;
  status: TaskStatus;
  tickets: CreatedTicket[];
}

export interface TaskListRequest {
  status?: TaskStatus | null;
  limit?: number;
  cursor?: string | null;
}

export interface TaskListResponse {
  tasks: TaskListItem[];
  next_cursor?: string | null;
}

export interface TaskWaitRequest {
  task_id: string;
  timeout_s?: number | null;
}

export interface TicketActionResult {
  ticket_id: string;
  status: TicketStatus;
  assignment_id?: string | null;
}

export interface TicketAnswerRequest {
  ticket_id: string;
  message: string;
}

export interface TicketResumeRequest {
  ticket_id: string;
  note?: string | null;
}

export interface TicketRetryRequest {
  ticket_id: string;
  note?: string | null;
}

export interface TicketCancelRequest {
  ticket_id: string;
  reason?: string | null;
}

export interface TicketCancelResponse {
  ticket_id: string;
  status: TicketStatus;
}

export interface TaskCancelRequest {
  task_id: string;
  reason?: string | null;
}

export interface TaskCancelResponse {
  task_id: string;
  status: TaskStatus;
}

export interface ResumeSpec {
  session_ref: string;
  message?: string | null;
}

export interface ExecutionRequest {
  ticket_id: string;
  assignment_id: string;
  prompt: string;
  profile: string;
  workspace: string;
  deadline?: string | null;
  resume?: ResumeSpec | null;
}

export interface ExecutionResponse {
  execution_id: string;
  status: "accepted";
}

export interface WorkerRegistration {
  worker_id: string;
  url: string;
  max_concurrency: number;
  version: string;
}

export interface WorkerHeartbeat {
  running: number;
  max_concurrency: number;
  status?: "healthy" | "draining";
}

export interface AssignmentHeartbeat {
  execution_id: string;
  phase?: "running" | "waiting" | "blocked";
}

export interface WorkerReport {
  ticket_id: string;
  assignment_id: string;
  execution_id: string;
  seq: number;
  idempotency_key: string;
  state: ReportState;
  summary?: string | null;
  result?: string | null;
  artifacts: Artifact[];
  usage?: Usage | null;
  error?: ErrorObject | null;
  session_ref?: string | null;
  resumed?: boolean | null;
  recovery?: boolean | null;
  question?: Question | null;
  timestamp: string;
}

export interface ReportAck {
  accepted: boolean;
  reason?: string | null;
}

export interface SkillReport {
  state: ReportState;
  summary?: string | null;
  result?: string | null;
  question?: Question | null;
  artifacts: Artifact[];
  error?: ErrorObject | null;
}

export interface Event {
  event_id: number;
  type: EventType;
  task_id?: string | null;
  ticket_id?: string | null;
  assignment_id?: string | null;
  worker_id?: string | null;
  data: Record<string, unknown>;
  created_at: string;
}

export interface EventPage {
  events: Event[];
  next_cursor?: string | null;
}
