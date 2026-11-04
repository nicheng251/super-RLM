
/**
 * SQLite store for the minimal Orchestrator.
 *
 * v0 uses node:sqlite (Node >= 22.5) with WAL, a schema version, and
 * replaceable repository methods. The store never decides domain transitions;
 * it only reads and writes rows.
 */

import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import type {
  AssignmentRecord,
  TaskRecord,
  TicketRecord,
  WorkerRecord,
} from "./domain.ts";

type Row = Record<string, unknown>;

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  timeout_at TEXT
);

CREATE TABLE IF NOT EXISTS tickets (
  ticket_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  profile TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT,
  result TEXT,
  artifacts TEXT NOT NULL DEFAULT '[]',
  usage TEXT,
  error TEXT,
  question TEXT,
  session_key TEXT NOT NULL,
  session_ref TEXT,
  outcome TEXT,
  no_op INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0,
  not_before TEXT,
  priority_next INTEGER NOT NULL DEFAULT 0,
  resume_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tickets_task_idx ON tickets(task_id);
CREATE INDEX IF NOT EXISTS tickets_status_idx ON tickets(status);

CREATE TABLE IF NOT EXISTS assignments (
  assignment_id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(ticket_id),
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  worker_id TEXT,
  execution_id TEXT,
  status TEXT NOT NULL,
  end_reason TEXT,
  kind TEXT NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  resume_ref TEXT,
  resume_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS assignments_ticket_idx ON assignments(ticket_id);
CREATE INDEX IF NOT EXISTS assignments_worker_idx ON assignments(worker_id);
CREATE INDEX IF NOT EXISTS assignments_status_idx ON assignments(status);

CREATE TABLE IF NOT EXISTS reports (
  report_id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id TEXT NOT NULL REFERENCES tickets(ticket_id),
  assignment_id TEXT NOT NULL REFERENCES assignments(assignment_id),
  execution_id TEXT,
  seq INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  summary TEXT,
  result TEXT,
  artifacts TEXT NOT NULL DEFAULT '[]',
  usage TEXT,
  error TEXT,
  session_ref TEXT,
  resumed INTEGER,
  recovery INTEGER,
  question TEXT,
  timestamp TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_ticket_idx ON reports(ticket_id);

CREATE TABLE IF NOT EXISTS workers (
  worker_id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  max_concurrency INTEGER NOT NULL,
  running INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  version TEXT,
  last_heartbeat TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ticket_answers (
  answer_id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id TEXT NOT NULL REFERENCES tickets(ticket_id),
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  task_id TEXT,
  ticket_id TEXT,
  assignment_id TEXT,
  worker_id TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_task_idx ON events(task_id);
`;

export interface TaskListQuery {
  status?: string;
  limit?: number;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as Row | undefined;
    const hasTickets = this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tickets'",
    ).get() !== undefined;
    let version = row ? Number(row.value) : (hasTickets ? 1 : 0);
    if (!Number.isFinite(version)) version = 0;
    if (version > SCHEMA_VERSION) {
      throw new Error(`Database schema v${version} is newer than this build (v${SCHEMA_VERSION})`);
    }
    for (let next = version + 1; next <= SCHEMA_VERSION; next += 1) {
      this.applyMigration(next);
    }
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(SCHEMA_VERSION));
  }

  private applyMigration(version: number): void {
    if (version === 2) {
      this.ensureColumn("tickets", "priority_next", "INTEGER NOT NULL DEFAULT 0");
      this.ensureColumn("tickets", "resume_message", "TEXT");
      return;
    }
    // Version 1 is the base schema above.
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    if (!columns.some((row) => row.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // ---- tasks and tickets -------------------------------------------------

  insertTask(task: TaskRecord, tickets: TicketRecord[]): void {
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO tasks (task_id, prompt, status, metadata, created_at, updated_at, cancel_requested, timeout_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        task.task_id, task.prompt, task.status, JSON.stringify(task.metadata),
        task.created_at, task.updated_at, task.cancel_requested ? 1 : 0, task.timeout_at,
      );
      const insertTicket = this.db.prepare(`
        INSERT INTO tickets (
          ticket_id, task_id, title, prompt, profile, status, summary, result, artifacts, usage,
          error, question, session_key, session_ref, outcome, no_op, retry_count, not_before,
          priority_next, resume_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const ticket of tickets) {
        insertTicket.run(
          ticket.ticket_id, ticket.task_id, ticket.title, ticket.prompt, ticket.profile,
          ticket.status, ticket.summary, ticket.result, JSON.stringify(ticket.artifacts),
          ticket.usage === null ? null : JSON.stringify(ticket.usage),
          ticket.error === null ? null : JSON.stringify(ticket.error),
          ticket.question === null ? null : JSON.stringify(ticket.question),
          ticket.session_key, ticket.session_ref, ticket.outcome,
          ticket.no_op === null ? null : ticket.no_op ? 1 : 0,
          ticket.retry_count, ticket.not_before, ticket.priority_next ? 1 : 0, ticket.resume_message,
          ticket.created_at, ticket.updated_at,
        );
      }
    });
  }

  getTask(taskId: string): TaskRecord | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as Row | undefined;
    return row ? taskFromRow(row) : null;
  }

  listTasks(query: TaskListQuery = {}): TaskRecord[] {
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const rows = query.status
      ? this.db.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(query.status, limit)
      : this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?").all(limit);
    return (rows as Row[]).map(taskFromRow);
  }

  updateTask(taskId: string, patch: Partial<Pick<TaskRecord, "status" | "cancel_requested" | "timeout_at" | "updated_at">>): void {
    const fields: Record<string, unknown> = {};
    if (patch.status !== undefined) fields.status = patch.status;
    if (patch.cancel_requested !== undefined) fields.cancel_requested = patch.cancel_requested ? 1 : 0;
    if (patch.timeout_at !== undefined) fields.timeout_at = patch.timeout_at;
    if (patch.updated_at !== undefined) fields.updated_at = patch.updated_at;
    this.updateRow("tasks", "task_id", taskId, fields);
  }

  getTicket(ticketId: string): TicketRecord | null {
    const row = this.db.prepare("SELECT * FROM tickets WHERE ticket_id = ?").get(ticketId) as Row | undefined;
    return row ? ticketFromRow(row) : null;
  }

  getTicketsForTask(taskId: string): TicketRecord[] {
    return (this.db.prepare("SELECT * FROM tickets WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as Row[])
      .map(ticketFromRow);
  }

  updateTicket(ticketId: string, patch: Partial<TicketRecord>): void {
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (key === "artifacts" || key === "usage" || key === "error" || key === "question") {
        fields[key] = value === null ? null : JSON.stringify(value);
      } else if (key === "no_op") {
        fields[key] = value === null ? null : value ? 1 : 0;
      } else {
        fields[key] = value;
      }
    }
    this.updateRow("tickets", "ticket_id", ticketId, fields);
  }

  nextQueuedTickets(now: string, limit = 50): TicketRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM tickets
      WHERE status IN ('queued', 'lost') AND (not_before IS NULL OR not_before <= ?)
      ORDER BY created_at ASC LIMIT ?
    `).all(now, limit);
    return (rows as Row[]).map(ticketFromRow);
  }

  // ---- assignments --------------------------------------------------------

  insertAssignment(assignment: AssignmentRecord): void {
    this.db.prepare(`
      INSERT INTO assignments (
        assignment_id, ticket_id, task_id, worker_id, execution_id, status, end_reason,
        kind, last_seq, resume_ref, resume_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      assignment.assignment_id, assignment.ticket_id, assignment.task_id, assignment.worker_id,
      assignment.execution_id, assignment.status, assignment.end_reason, assignment.kind,
      assignment.last_seq, assignment.resume_ref, assignment.resume_message,
      assignment.created_at, assignment.updated_at,
    );
  }

  getAssignment(assignmentId: string): AssignmentRecord | null {
    const row = this.db.prepare("SELECT * FROM assignments WHERE assignment_id = ?").get(assignmentId) as Row | undefined;
    return row ? assignmentFromRow(row) : null;
  }

  getActiveAssignment(ticketId: string): AssignmentRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM assignments WHERE ticket_id = ? AND status IN ('pending', 'running')
      ORDER BY created_at DESC LIMIT 1
    `).get(ticketId) as Row | undefined;
    return row ? assignmentFromRow(row) : null;
  }

  updateAssignment(assignmentId: string, patch: Partial<AssignmentRecord>): void {
    this.updateRow("assignments", "assignment_id", assignmentId, { ...patch });
  }

  listActiveAssignmentsForWorker(workerId: string): AssignmentRecord[] {
    return (this.db.prepare(`
      SELECT * FROM assignments WHERE worker_id = ? AND status IN ('pending', 'running')
    `).all(workerId) as Row[]).map(assignmentFromRow);
  }

  listActiveAssignments(): AssignmentRecord[] {
    return (this.db.prepare(`
      SELECT * FROM assignments WHERE status IN ('pending', 'running')
    `).all() as Row[]).map(assignmentFromRow);
  }

  countRunningAssignments(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE status = 'running'").get() as Row).n);
  }

  countRunningByKind(kind: "normal" | "priority"): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE status = 'running' AND kind = ?").get(kind) as Row).n);
  }

  countRunningForTask(taskId: string, kind: "normal" | "priority"): number {
    return Number((this.db.prepare(`
      SELECT COUNT(*) AS n FROM assignments WHERE status = 'running' AND task_id = ? AND kind = ?
    `).get(taskId, kind) as Row).n);
  }

  countRunningForWorker(workerId: string): number {
    return Number((this.db.prepare(`
      SELECT COUNT(*) AS n FROM assignments WHERE status = 'running' AND worker_id = ?
    `).get(workerId) as Row).n);
  }

  // ---- reports -----------------------------------------------------------

  hasReport(idempotencyKey: string): boolean {
    return this.db.prepare("SELECT 1 FROM reports WHERE idempotency_key = ?").get(idempotencyKey) !== undefined;
  }

  insertReport(report: {
    ticket_id: string;
    assignment_id: string;
    execution_id: string | null;
    seq: number;
    idempotency_key: string;
    state: string;
    summary: string | null;
    result: string | null;
    artifacts: unknown[];
    usage: unknown;
    error: unknown;
    session_ref: string | null;
    resumed: boolean | null;
    recovery: boolean | null;
    question: unknown;
    timestamp: string;
  }): void {
    this.db.prepare(`
      INSERT INTO reports (
        ticket_id, assignment_id, execution_id, seq, idempotency_key, state, summary,
        result, artifacts, usage, error, session_ref, resumed, recovery, question,
        timestamp, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      report.ticket_id, report.assignment_id, report.execution_id, report.seq,
      report.idempotency_key, report.state, report.summary, report.result,
      JSON.stringify(report.artifacts),
      report.usage === null ? null : JSON.stringify(report.usage),
      report.error === null ? null : JSON.stringify(report.error),
      report.session_ref,
      report.resumed === null ? null : report.resumed ? 1 : 0,
      report.recovery === null ? null : report.recovery ? 1 : 0,
      report.question === null ? null : JSON.stringify(report.question),
      report.timestamp, new Date().toISOString(),
    );
  }

  // ---- workers -----------------------------------------------------------

  upsertWorker(worker: WorkerRecord): void {
    this.db.prepare(`
      INSERT INTO workers (worker_id, url, max_concurrency, running, status, version, last_heartbeat)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(worker_id) DO UPDATE SET
        url = excluded.url,
        max_concurrency = excluded.max_concurrency,
        running = excluded.running,
        status = excluded.status,
        version = excluded.version,
        last_heartbeat = excluded.last_heartbeat
    `).run(
      worker.worker_id, worker.url, worker.max_concurrency, worker.running,
      worker.status, worker.version, worker.last_heartbeat,
    );
  }

  getWorker(workerId: string): WorkerRecord | null {
    const row = this.db.prepare("SELECT * FROM workers WHERE worker_id = ?").get(workerId) as Row | undefined;
    return row ? workerFromRow(row) : null;
  }

  listWorkers(): WorkerRecord[] {
    return (this.db.prepare("SELECT * FROM workers ORDER BY worker_id").all() as Row[]).map(workerFromRow);
  }

  updateWorker(workerId: string, patch: Partial<WorkerRecord>): void {
    this.updateRow("workers", "worker_id", workerId, { ...patch });
  }

  // ---- answers and events ------------------------------------------------

  insertAnswer(ticketId: string, kind: "answer" | "resume" | "retry", message: string): void {
    this.db.prepare(`
      INSERT INTO ticket_answers (ticket_id, kind, message, created_at) VALUES (?, ?, ?, ?)
    `).run(ticketId, kind, message, new Date().toISOString());
  }

  appendEvent(event: {
    type: string;
    task_id?: string | null;
    ticket_id?: string | null;
    assignment_id?: string | null;
    worker_id?: string | null;
    data?: Record<string, unknown>;
  }): number {
    const result = this.db.prepare(`
      INSERT INTO events (type, task_id, ticket_id, assignment_id, worker_id, data, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.type, event.task_id ?? null, event.ticket_id ?? null,
      event.assignment_id ?? null, event.worker_id ?? null,
      JSON.stringify(event.data ?? {}), new Date().toISOString(),
    );
    return Number(result.lastInsertRowid);
  }

  listEvents(taskId?: string, after = 0, limit = 100): Array<Record<string, unknown>> {
    const rows = taskId
      ? this.db.prepare("SELECT * FROM events WHERE task_id = ? AND event_id > ? ORDER BY event_id ASC LIMIT ?").all(taskId, after, limit)
      : this.db.prepare("SELECT * FROM events WHERE event_id > ? ORDER BY event_id ASC LIMIT ?").all(after, limit);
    return (rows as Row[]).map((row) => ({
      ...row,
      data: parseJson(row.data, {}),
    }));
  }

  // ---- helpers -----------------------------------------------------------

  private updateRow(table: string, idColumn: string, id: string, fields: Record<string, unknown>): void {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const assignments = keys.map((key) => `${key} = ?`).join(", ");
    const values = keys.map((key) => fields[key]) as SQLInputValue[];
    this.db.prepare(`UPDATE ${table} SET ${assignments} WHERE ${idColumn} = ?`).run(...values, id);
  }
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function taskFromRow(row: Row): TaskRecord {
  return {
    task_id: String(row.task_id),
    prompt: String(row.prompt),
    status: row.status as TaskRecord["status"],
    metadata: parseJson(row.metadata, {}),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    cancel_requested: Number(row.cancel_requested) === 1,
    timeout_at: row.timeout_at === null ? null : String(row.timeout_at),
  };
}

function ticketFromRow(row: Row): TicketRecord {
  return {
    ticket_id: String(row.ticket_id),
    task_id: String(row.task_id),
    title: String(row.title),
    prompt: String(row.prompt),
    profile: String(row.profile),
    status: row.status as TicketRecord["status"],
    summary: row.summary === null ? null : String(row.summary),
    result: row.result === null ? null : String(row.result),
    artifacts: parseJson(row.artifacts, []),
    usage: row.usage === null ? null : parseJson(row.usage, null),
    error: row.error === null ? null : parseJson(row.error, null),
    question: row.question === null ? null : parseJson(row.question, null),
    session_key: String(row.session_key),
    session_ref: row.session_ref === null ? null : String(row.session_ref),
    outcome: row.outcome === null ? null : String(row.outcome),
    no_op: row.no_op === null ? null : Number(row.no_op) === 1,
    retry_count: Number(row.retry_count),
    not_before: row.not_before === null ? null : String(row.not_before),
    priority_next: Number(row.priority_next) === 1,
    resume_message: row.resume_message === null ? null : String(row.resume_message),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function assignmentFromRow(row: Row): AssignmentRecord {
  return {
    assignment_id: String(row.assignment_id),
    ticket_id: String(row.ticket_id),
    task_id: String(row.task_id),
    worker_id: row.worker_id === null ? null : String(row.worker_id),
    execution_id: row.execution_id === null ? null : String(row.execution_id),
    status: row.status as AssignmentRecord["status"],
    end_reason: row.end_reason === null ? null : (row.end_reason as AssignmentRecord["end_reason"]),
    kind: row.kind as AssignmentRecord["kind"],
    last_seq: Number(row.last_seq),
    resume_ref: row.resume_ref === null ? null : String(row.resume_ref),
    resume_message: row.resume_message === null ? null : String(row.resume_message),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function workerFromRow(row: Row): WorkerRecord {
  return {
    worker_id: String(row.worker_id),
    url: String(row.url),
    max_concurrency: Number(row.max_concurrency),
    running: Number(row.running),
    status: row.status as WorkerRecord["status"],
    version: row.version === null ? null : String(row.version),
    last_heartbeat: String(row.last_heartbeat),
  };
}
