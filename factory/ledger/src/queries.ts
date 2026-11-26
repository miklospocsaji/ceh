/**
 * Typed queries over the ledger. Ids are Postgres bigints, returned as strings; costs are
 * `numeric`, returned as numbers.
 */
import type { FailureReason as RoleFailureReason } from "@ceh/factory-roles";
import pg from "pg";
import type { Db } from "./db.ts";
import type { TokenUsage } from "./recorder.ts";

export type AuthMode = "api-key" | "subscription";
/** Why an attempt failed: a runner reason, a build reason, or a build task that left no outcome. */
export type FailureReason = RoleFailureReason | "diff-check" | "red" | "green" | "no-outcome" | "no-what-changed" | "abandoned";
export type AttemptOutcome = "succeeded" | "failed" | "aborted";

export interface WorkItemRow {
  id: string;
  /** The repository it belongs to, as `<owner>/<repo>`. */
  repository: string;
  issueNumber: number;
  changeId: string;
  branch: string;
  state: string;
  /** The Step Functions execution that created it; null for a local run. */
  executionArn: string | null;
  /** How many times the build loop sent the change back to Design. */
  designFlaws: number;
  /** The state an `aborted` or `escalated` work item stopped in; null otherwise (migration 0007). */
  stoppedIn: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewWorkItem {
  /** `<owner>/<repo>`. */
  repository: string;
  issueNumber: number;
  changeId: string;
  branch: string;
  state: string;
  executionArn?: string;
}

export interface AttemptRow {
  id: string;
  workItemId: string;
  state: string;
  role: string;
  /** 1-based, per work item and state. */
  n: number;
  startedAt: Date;
  endedAt: Date | null;
  outcome: AttemptOutcome | null;
  failureReason: FailureReason | null;
  authMode: AuthMode | null;
  costUsdEstimate: number | null;
  /** The role's validated result, on a succeeded attempt only. */
  result: unknown;
  /** The plan task a build attempt is for; null outside the build loop. */
  taskId: string | null;
  /** The artifact store prefix of a build attempt's input and outputs. */
  storePrefix: string | null;
  /** The failure classifier's label for a failed build attempt. */
  classification: unknown;
  /** The gates result of a build attempt. */
  gates: unknown;
  /** The owner commands (`comments.id`) the role was given, oldest first; empty for most attempts. */
  commentIds: string[];
}

export interface NewAttempt {
  workItemId: string;
  state: string;
  role: string;
  taskId?: string;
  storePrefix?: string;
  /** The owner commands (`comments.id`) the role is given; defaults to none. */
  commentIds?: readonly string[];
}

export type AttemptEnd =
  | { outcome: "succeeded"; result?: unknown; gates?: unknown }
  | { outcome: "failed"; failureReason: FailureReason; gates?: unknown }
  | { outcome: "aborted" };

export type ApprovalState = "open" | "closed";
export type ApprovalKind = "proposal" | "design";
/** How a closed approval was closed: by `/approve` or by `/revise` (migration 0006). */
export type ApprovalOutcome = "approved" | "revise" | "aborted";
/** What awaits the owner's approval: the proposal, or a `large` change's design. */
export type Stage = "proposal" | "design";

/** The work item state in which the owner's commands are about the stage. */
const AWAITING_STATE: Record<Stage, string> = { proposal: "awaiting-proposal-approval", design: "awaiting-design-approval" };

export interface ApprovalRow {
  id: string;
  workItemId: string;
  kind: ApprovalKind;
  state: ApprovalState;
  taskToken: string;
  requestedAt: Date;
  resolvedAt: Date | null;
  /** The login that resolved it. */
  resolvedBy: string | null;
  /** How it was closed; null while open. */
  outcome: ApprovalOutcome | null;
}

export interface NewApproval {
  workItemId: string;
  taskToken: string;
  /** Defaults to `proposal`. */
  kind?: ApprovalKind;
}

export type TaskStatus = "pending" | "done" | "superseded";

/** One task of a plan, as the planner's `tasks.json` lists it. */
export interface PlanTaskInput {
  id: string;
  title: string;
  dependsOn: readonly string[];
  files: readonly string[];
  scenarios: readonly string[];
  tests: readonly string[];
}

export interface TaskRow {
  id: string;
  workItemId: string;
  /** The id in `tasks.md`, such as `1.2`. */
  taskId: string;
  /** 1-based, in the plan's order. */
  position: number;
  title: string;
  dependsOn: string[];
  files: string[];
  scenarios: string[];
  tests: string[];
  status: TaskStatus;
  /** The commit that ticked it. */
  doneCommit: string | null;
  /** The planner attempt whose plan it came from. */
  planAttemptId: string;
}

export interface NewPlan {
  workItemId: string;
  planAttemptId: string;
  tasks: readonly PlanTaskInput[];
}

export interface MessageRow {
  id: string;
  attemptId: string;
  seq: number;
  type: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  raw: unknown;
}

export class ChangeIdTaken extends Error {
  readonly changeId: string;

  constructor(changeId: string, options?: ErrorOptions) {
    super(`change id ${changeId} is taken by another work item`, options);
    this.name = "ChangeIdTaken";
    this.changeId = changeId;
  }
}

export class IssueHasWorkItem extends Error {
  readonly issueNumber: number;

  constructor(issueNumber: number, options?: ErrorOptions) {
    super(`issue #${String(issueNumber)} has a work item already`, options);
    this.name = "IssueHasWorkItem";
    this.issueNumber = issueNumber;
  }
}

export class ApprovalAlreadyOpen extends Error {
  readonly workItemId: string;

  constructor(workItemId: string, options?: ErrorOptions) {
    super(`work item ${workItemId} has an open approval already`, options);
    this.name = "ApprovalAlreadyOpen";
    this.workItemId = workItemId;
  }
}

const UNIQUE_VIOLATION = "23505";
const CHANGE_ID_KEY = "work_items_repository_change_id_key";
const ISSUE_NUMBER_KEY = "work_items_repository_issue_number_key";
const ONE_OPEN_APPROVAL = "approvals_one_open_idx";

interface WorkItemRecord {
  id: string;
  repository: string;
  issue_number: number;
  change_id: string;
  branch: string;
  state: string;
  execution_arn: string | null;
  design_flaws: number;
  stopped_in: string | null;
  created_at: Date;
  updated_at: Date;
}

interface AttemptRecord {
  id: string;
  work_item_id: string;
  state: string;
  role: string;
  n: number;
  started_at: Date;
  ended_at: Date | null;
  outcome: AttemptOutcome | null;
  failure_reason: FailureReason | null;
  auth_mode: AuthMode | null;
  cost_usd_estimate: string | null;
  result: unknown;
  task_id: string | null;
  store_prefix: string | null;
  classification: unknown;
  gates: unknown;
  comment_ids: string[];
}

interface ApprovalRecord {
  id: string;
  work_item_id: string;
  kind: ApprovalKind;
  state: ApprovalState;
  task_token: string;
  requested_at: Date;
  resolved_at: Date | null;
  resolved_by: string | null;
  outcome: ApprovalOutcome | null;
}

interface TaskRecord {
  id: string;
  work_item_id: string;
  task_id: string;
  position: number;
  title: string;
  depends_on: string[];
  files: string[];
  scenarios: string[];
  tests: string[];
  status: TaskStatus;
  done_commit: string | null;
  plan_attempt_id: string;
}

interface MessageRecord {
  id: string;
  attempt_id: string;
  seq: number;
  type: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  raw: unknown;
}

const WORK_ITEM_COLUMNS = "id, repository, issue_number, change_id, branch, state, execution_arn, design_flaws, stopped_in, created_at, updated_at";
const ATTEMPT_COLUMNS =
  "id, work_item_id, state, role, n, started_at, ended_at, outcome, failure_reason, auth_mode, cost_usd_estimate, result, task_id, store_prefix, classification, gates, comment_ids";
const APPROVAL_COLUMNS = "id, work_item_id, kind, state, task_token, requested_at, resolved_at, resolved_by, outcome";
const TASK_COLUMNS = "id, work_item_id, task_id, position, title, depends_on, files, scenarios, tests, status, done_commit, plan_attempt_id";

function toWorkItem(row: WorkItemRecord): WorkItemRow {
  return {
    id: row.id,
    repository: row.repository,
    issueNumber: row.issue_number,
    changeId: row.change_id,
    branch: row.branch,
    state: row.state,
    executionArn: row.execution_arn,
    designFlaws: row.design_flaws,
    stoppedIn: row.stopped_in,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAttempt(row: AttemptRecord): AttemptRow {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    state: row.state,
    role: row.role,
    n: row.n,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    outcome: row.outcome,
    failureReason: row.failure_reason,
    authMode: row.auth_mode,
    costUsdEstimate: row.cost_usd_estimate === null ? null : Number(row.cost_usd_estimate),
    result: row.result,
    taskId: row.task_id,
    storePrefix: row.store_prefix,
    classification: row.classification,
    gates: row.gates,
    // bigint[] comes back as strings, like every other id.
    commentIds: row.comment_ids.map(String),
  };
}

function toTask(row: TaskRecord): TaskRow {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    taskId: row.task_id,
    position: row.position,
    title: row.title,
    dependsOn: row.depends_on,
    files: row.files,
    scenarios: row.scenarios,
    tests: row.tests,
    status: row.status,
    doneCommit: row.done_commit,
    planAttemptId: row.plan_attempt_id,
  };
}

function toMessage(row: MessageRecord): MessageRow {
  return {
    id: row.id,
    attemptId: row.attempt_id,
    seq: row.seq,
    type: row.type,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    raw: row.raw,
  };
}

function toApproval(row: ApprovalRecord): ApprovalRow {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    kind: row.kind,
    state: row.state,
    taskToken: row.task_token,
    requestedAt: row.requested_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    outcome: row.outcome,
  };
}

function only<T>(rows: T[], what: string): T {
  const [row] = rows;
  if (row === undefined) throw new Error(`${what}: no row`);
  return row;
}

/**
 * Rejects with ChangeIdTaken when another work item of the repository has the change id, and
 * with IssueHasWorkItem when the repository's issue has one already (a concurrent Intake that lost).
 */
export async function createWorkItem(db: Db, item: NewWorkItem): Promise<WorkItemRow> {
  try {
    const { rows } = await db.query<WorkItemRecord>(
      `INSERT INTO work_items (repository, issue_number, change_id, branch, state, execution_arn) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${WORK_ITEM_COLUMNS}`,
      [item.repository, item.issueNumber, item.changeId, item.branch, item.state, item.executionArn ?? null],
    );
    return toWorkItem(only(rows, "createWorkItem"));
  } catch (error) {
    if (isUniqueViolation(error, CHANGE_ID_KEY)) throw new ChangeIdTaken(item.changeId, { cause: error });
    if (isUniqueViolation(error, ISSUE_NUMBER_KEY)) throw new IssueHasWorkItem(item.issueNumber, { cause: error });
    throw error;
  }
}

/** The work item of a repository's issue; an issue has at most one (migration 0004). */
export async function findWorkItemByIssue(db: Db, repository: string, issueNumber: number): Promise<WorkItemRow | undefined> {
  const { rows } = await db.query<WorkItemRecord>(
    `SELECT ${WORK_ITEM_COLUMNS} FROM work_items WHERE repository = $1 AND issue_number = $2`,
    [repository, issueNumber],
  );
  return rows[0] === undefined ? undefined : toWorkItem(rows[0]);
}

export async function findWorkItemByChangeId(db: Db, repository: string, changeId: string): Promise<WorkItemRow | undefined> {
  const { rows } = await db.query<WorkItemRecord>(`SELECT ${WORK_ITEM_COLUMNS} FROM work_items WHERE repository = $1 AND change_id = $2`, [repository, changeId]);
  return rows[0] === undefined ? undefined : toWorkItem(rows[0]);
}

/** A state update refused: the work item was not in the state its writer expected. */
export class StateChanged extends Error {
  override readonly name = "StateChanged";
  readonly workItemId: string;
  readonly expected: string;
  /** The state found instead. */
  readonly actual: string;

  constructor(workItemId: string, expected: string, actual: string) {
    super(`work item ${workItemId} is ${actual}, not ${expected}, so its state was not changed`);
    this.workItemId = workItemId;
    this.expected = expected;
    this.actual = actual;
  }
}

/** The states a work item stops in; `stopped_in` records where it was. */
const STOPPED = ["aborted", "escalated"];

/**
 * Moves the work item from `from` to `state` and returns it (compare-and-set, add-work-item-resume):
 * one statement that changes the row only while it is in `from`, so a stopped worker that writes
 * late cannot move an aborted work item. A work item in another state rejects with StateChanged; a
 * missing one is an error. Stopping (`aborted`, `escalated`) records the state it stopped in as
 * `stopped_in`, kept from one stopped state to the other; any other state clears it.
 */
export async function setWorkItemState(db: Db, workItemId: string, state: string, expected: { from: string }): Promise<WorkItemRow> {
  const { rows } = await db.query<WorkItemRecord>(
    `UPDATE work_items SET state = $2, updated_at = now(),
       stopped_in = CASE WHEN $2 = ANY($4::text[]) THEN (CASE WHEN state = ANY($4::text[]) THEN stopped_in ELSE state END) ELSE NULL END
     WHERE id = $1 AND state = $3 RETURNING ${WORK_ITEM_COLUMNS}`,
    [workItemId, state, expected.from, STOPPED],
  );
  if (rows[0] !== undefined) return toWorkItem(rows[0]);
  const found = await db.query<{ state: string }>("SELECT state FROM work_items WHERE id = $1", [workItemId]);
  const actual = found.rows[0]?.state;
  if (actual === undefined) throw new Error(`work item ${workItemId} not found`);
  throw new StateChanged(workItemId, expected.from, actual);
}

export interface Adoption {
  /** The state the adopting execution read. */
  from: string;
  /** The state its entry state runs in. */
  to: string;
  executionArn: string;
  /** Whether the design-flaw count starts again, as for a resumed escalation. */
  freshDesignFlaws: boolean;
}

/**
 * A resumed execution takes the work item over (add-work-item-resume, Adopt): its ARN is stored,
 * and the work item moves from `from` to `to` (compare-and-set, as `setWorkItemState`), which
 * clears `stopped_in`.
 */
export async function adoptWorkItem(db: Db, workItemId: string, adoption: Adoption): Promise<WorkItemRow> {
  const { rows } = await db.query<WorkItemRecord>(
    `UPDATE work_items SET state = $2, execution_arn = $4, stopped_in = NULL, updated_at = now(),
       design_flaws = CASE WHEN $5 THEN 0 ELSE design_flaws END
     WHERE id = $1 AND state = $3 RETURNING ${WORK_ITEM_COLUMNS}`,
    [workItemId, adoption.to, adoption.from, adoption.executionArn, adoption.freshDesignFlaws],
  );
  if (rows[0] !== undefined) return toWorkItem(rows[0]);
  const found = await db.query<{ state: string }>("SELECT state FROM work_items WHERE id = $1", [workItemId]);
  const actual = found.rows[0]?.state;
  if (actual === undefined) throw new Error(`work item ${workItemId} not found`);
  throw new StateChanged(workItemId, adoption.from, actual);
}

/** Closes the work item's open attempts `aborted` and returns them, oldest first. */
export async function abortOpenAttempts(db: Db, workItemId: string): Promise<AttemptRow[]> {
  const { rows } = await db.query<AttemptRecord>(
    `UPDATE attempts SET ended_at = clock_timestamp(), outcome = 'aborted' WHERE work_item_id = $1 AND ended_at IS NULL RETURNING ${ATTEMPT_COLUMNS}`,
    [workItemId],
  );
  return rows.map(toAttempt).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

/** Opens the next attempt for the work item's state, numbered from 1. */
export async function openAttempt(db: Db, attempt: NewAttempt): Promise<AttemptRow> {
  const { rows } = await db.query<AttemptRecord>(
    `INSERT INTO attempts (work_item_id, state, role, n, task_id, store_prefix, comment_ids)
     SELECT $1, $2, $3, COALESCE(MAX(n), 0) + 1, $4, $5, $6::bigint[] FROM attempts WHERE work_item_id = $1 AND state = $2
     RETURNING ${ATTEMPT_COLUMNS}`,
    [attempt.workItemId, attempt.state, attempt.role, attempt.taskId ?? null, attempt.storePrefix ?? null, [...(attempt.commentIds ?? [])]],
  );
  return toAttempt(only(rows, "openAttempt"));
}

/** Closes an open attempt, with the role's result if it succeeded; closing one twice is an error. */
export async function closeAttempt(db: Db, attemptId: string, end: AttemptEnd): Promise<AttemptRow> {
  const failureReason = end.outcome === "failed" ? end.failureReason : null;
  const gatesOf = end.outcome === "aborted" ? undefined : end.gates;
  const result = end.outcome === "succeeded" && end.result !== undefined ? JSON.stringify(end.result) : null;
  const gates = gatesOf === undefined ? null : JSON.stringify(gatesOf);
  const { rows } = await db.query<AttemptRecord>(
    `UPDATE attempts SET ended_at = clock_timestamp(), outcome = $2, failure_reason = $3, result = $4::jsonb, gates = $5::jsonb
     WHERE id = $1 AND ended_at IS NULL
     RETURNING ${ATTEMPT_COLUMNS}`,
    [attemptId, end.outcome, failureReason, result, gates],
  );
  if (rows[0] === undefined) throw new Error(`attempt ${attemptId} is not open`);
  return toAttempt(rows[0]);
}

export async function listAttempts(db: Db, workItemId: string): Promise<AttemptRow[]> {
  const { rows } = await db.query<AttemptRecord>(`SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE work_item_id = $1 ORDER BY id`, [
    workItemId,
  ]);
  return rows.map(toAttempt);
}

export async function listMessages(db: Db, attemptId: string): Promise<MessageRow[]> {
  const { rows } = await db.query<MessageRecord>(
    `SELECT id, attempt_id, seq, type, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, raw
     FROM messages WHERE attempt_id = $1 ORDER BY seq`,
    [attemptId],
  );
  return rows.map(toMessage);
}

/** The work item's estimated cost in USD: the sum over its attempts; attempts without an estimate count as 0. */
export async function workItemCost(db: Db, workItemId: string): Promise<number> {
  const { rows } = await db.query<{ total: string }>(
    "SELECT COALESCE(SUM(cost_usd_estimate), 0) AS total FROM attempts WHERE work_item_id = $1",
    [workItemId],
  );
  return Number(only(rows, "workItemCost").total);
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION &&
    (error as { constraint?: unknown }).constraint === constraint
  );
}

/** An attempt's token usage: the sum over its result messages, which carry each session's totals. */
export interface AttemptUsage extends TokenUsage {
  attemptId: string;
}

/** Token usage per attempt of the work item, in attempt order; an attempt without a result message has zeros. */
export async function listAttemptUsage(db: Db, workItemId: string): Promise<AttemptUsage[]> {
  const { rows } = await db.query<{ attempt_id: string; input: string; output: string; cache_read: string; cache_creation: string }>(
    `SELECT a.id AS attempt_id,
            COALESCE(SUM(m.input_tokens), 0) AS input,
            COALESCE(SUM(m.output_tokens), 0) AS output,
            COALESCE(SUM(m.cache_read_tokens), 0) AS cache_read,
            COALESCE(SUM(m.cache_creation_tokens), 0) AS cache_creation
     FROM attempts a LEFT JOIN messages m ON m.attempt_id = a.id AND m.type = 'result'
     WHERE a.work_item_id = $1
     GROUP BY a.id ORDER BY a.id`,
    [workItemId],
  );
  return rows.map((row) => ({
    attemptId: row.attempt_id,
    inputTokens: Number(row.input),
    outputTokens: Number(row.output),
    cacheReadTokens: Number(row.cache_read),
    cacheCreationTokens: Number(row.cache_creation),
  }));
}

/** Stores an open approval with its task token; rejects with ApprovalAlreadyOpen if one is open. */
export async function openApproval(db: Db, approval: NewApproval): Promise<ApprovalRow> {
  try {
    const { rows } = await db.query<ApprovalRecord>(
      `INSERT INTO approvals (work_item_id, kind, state, task_token) VALUES ($1, $2, 'open', $3) RETURNING ${APPROVAL_COLUMNS}`,
      [approval.workItemId, approval.kind ?? "proposal", approval.taskToken],
    );
    return toApproval(only(rows, "openApproval"));
  } catch (error) {
    if (isUniqueViolation(error, ONE_OPEN_APPROVAL)) throw new ApprovalAlreadyOpen(approval.workItemId, { cause: error });
    throw error;
  }
}

export async function findOpenApproval(db: Db, workItemId: string): Promise<ApprovalRow | undefined> {
  const { rows } = await db.query<ApprovalRecord>(`SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE work_item_id = $1 AND state = 'open'`, [
    workItemId,
  ]);
  return rows[0] === undefined ? undefined : toApproval(rows[0]);
}

/**
 * Closes the work item's open approval, resolved by `resolvedBy` with `outcome`, and returns it
 * with its task token. One statement, so of two concurrent closes only one gets the approval; the
 * other, and a close with nothing open, get undefined.
 */
export async function closeApproval(db: Db, workItemId: string, resolvedBy: string, outcome: ApprovalOutcome = "approved"): Promise<ApprovalRow | undefined> {
  const { rows } = await db.query<ApprovalRecord>(
    `UPDATE approvals SET state = 'closed', resolved_at = clock_timestamp(), resolved_by = $2, outcome = $3
     WHERE work_item_id = $1 AND state = 'open'
     RETURNING ${APPROVAL_COLUMNS}`,
    [workItemId, resolvedBy, outcome],
  );
  return rows[0] === undefined ? undefined : toApproval(rows[0]);
}

/**
 * Opens a closed approval again, so the owner can retry after resuming the execution failed.
 * Rejects with ApprovalAlreadyOpen if the work item has another open approval.
 */
export async function reopenApproval(db: Db, approvalId: string): Promise<ApprovalRow> {
  let rows: ApprovalRecord[];
  try {
    ({ rows } = await db.query<ApprovalRecord>(
      `UPDATE approvals SET state = 'open', resolved_at = NULL, resolved_by = NULL, outcome = NULL WHERE id = $1 RETURNING ${APPROVAL_COLUMNS}`,
      [approvalId],
    ));
  } catch (error) {
    if (isUniqueViolation(error, ONE_OPEN_APPROVAL)) {
      const workItemId = (await db.query<{ work_item_id: string }>("SELECT work_item_id FROM approvals WHERE id = $1", [approvalId])).rows[0]?.work_item_id;
      throw new ApprovalAlreadyOpen(workItemId ?? "unknown", { cause: error });
    }
    throw error;
  }
  if (rows[0] === undefined) throw new Error(`approval ${approvalId} not found`);
  return toApproval(rows[0]);
}


/** The classifier's label for a build attempt; a missing attempt is an error. */
export async function setAttemptClassification(db: Db, attemptId: string, classification: unknown): Promise<AttemptRow> {
  const { rows } = await db.query<AttemptRecord>(`UPDATE attempts SET classification = $2::jsonb WHERE id = $1 RETURNING ${ATTEMPT_COLUMNS}`, [
    attemptId,
    JSON.stringify(classification),
  ]);
  if (rows[0] === undefined) throw new Error(`attempt ${attemptId} not found`);
  return toAttempt(rows[0]);
}

/** Counts one more design flaw on the work item and returns it; a missing work item is an error. */
export async function incrementDesignFlaws(db: Db, workItemId: string): Promise<WorkItemRow> {
  const { rows } = await db.query<WorkItemRecord>(
    `UPDATE work_items SET design_flaws = design_flaws + 1, updated_at = now() WHERE id = $1 RETURNING ${WORK_ITEM_COLUMNS}`,
    [workItemId],
  );
  if (rows[0] === undefined) throw new Error(`work item ${workItemId} not found`);
  return toWorkItem(rows[0]);
}

/**
 * Stores an accepted plan's tasks and returns the work item's live tasks. The unfinished rows of
 * an earlier plan are superseded; done rows stay as they are, and a plan entry with a done
 * task's id keeps that row. Runs in one transaction.
 */
export async function storePlan(db: Db, plan: NewPlan): Promise<TaskRow[]> {
  await inTransaction(db, async (client) => {
    await client.query("UPDATE tasks SET status = 'superseded' WHERE work_item_id = $1 AND status = 'pending'", [plan.workItemId]);
    const { rows } = await client.query<{ task_id: string }>("SELECT task_id FROM tasks WHERE work_item_id = $1 AND status = 'done'", [plan.workItemId]);
    const done = new Set(rows.map((row) => row.task_id));
    for (const [index, task] of plan.tasks.entries()) {
      if (done.has(task.id)) continue;
      await client.query(
        `INSERT INTO tasks (work_item_id, task_id, position, title, depends_on, files, scenarios, tests, status, plan_attempt_id)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, 'pending', $9)`,
        [
          plan.workItemId,
          task.id,
          index + 1,
          task.title,
          JSON.stringify(task.dependsOn),
          JSON.stringify(task.files),
          JSON.stringify(task.scenarios),
          JSON.stringify(task.tests),
          plan.planAttemptId,
        ],
      );
    }
  });
  return listTasks(db, plan.workItemId);
}

/** The work item's live (not superseded) tasks, in plan order. */
export async function listTasks(db: Db, workItemId: string): Promise<TaskRow[]> {
  const { rows } = await db.query<TaskRecord>(
    `SELECT ${TASK_COLUMNS} FROM tasks WHERE work_item_id = $1 AND status <> 'superseded' ORDER BY position, id`,
    [workItemId],
  );
  return rows.map(toTask);
}

/** Marks a pending task done with the commit that ticked it; any other task is an error. */
export async function markTaskDone(db: Db, workItemId: string, taskId: string, commit: string): Promise<TaskRow> {
  const { rows } = await db.query<TaskRecord>(
    `UPDATE tasks SET status = 'done', done_commit = $3 WHERE work_item_id = $1 AND task_id = $2 AND status = 'pending' RETURNING ${TASK_COLUMNS}`,
    [workItemId, taskId, commit],
  );
  if (rows[0] === undefined) throw new Error(`task ${taskId} of work item ${workItemId} is not pending`);
  return toTask(rows[0]);
}

/** Runs `fn` in a transaction: on a client of its own for a pool, or in the caller's for a client. */
async function inTransaction(db: Db, fn: (client: pg.PoolClient | pg.Client) => Promise<void>): Promise<void> {
  if (!(db instanceof pg.Pool)) {
    await fn(db);
    return;
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await fn(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** What an owner command came to (add-owner-commands design, "Ledger"). */
export type CommentOutcome = "applied" | "busy" | "refused" | "unknown";

export interface CommentRow {
  id: string;
  /** Null when the issue had no work item. */
  workItemId: string | null;
  repository: string;
  issueNumber: number;
  githubCommentId: number;
  author: string;
  /** As written, unknown verbs too. */
  verb: string;
  /** The comment's body as read at receipt. */
  body: string;
  receivedAt: Date;
  outcome: CommentOutcome;
  /** The work item's state the command met; null without a work item. */
  stateMet: string | null;
}

export type NewComment = Omit<CommentRow, "id" | "receivedAt">;

interface CommentRecord {
  id: string;
  work_item_id: string | null;
  repository: string;
  issue_number: number;
  github_comment_id: string;
  author: string;
  verb: string;
  body: string;
  received_at: Date;
  outcome: CommentOutcome;
  state_met: string | null;
}

const COMMENT_COLUMNS = "id, work_item_id, repository, issue_number, github_comment_id, author, verb, body, received_at, outcome, state_met";

/** The verbs whose applied command counts as an owner intervention (docs/m3.5-owner-commands.md, section 3). */
const INTERVENTION_VERBS = ["approve", "revise", "abort", "resume"];

function toComment(row: CommentRecord): CommentRow {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    repository: row.repository,
    issueNumber: row.issue_number,
    // GitHub's ids are 64-bit; today's fit a double exactly (checked on the way in).
    githubCommentId: Number(row.github_comment_id),
    author: row.author,
    verb: row.verb,
    body: row.body,
    receivedAt: row.received_at,
    outcome: row.outcome,
    stateMet: row.state_met,
  };
}

/**
 * The issue's work item, locked (`SELECT … FOR UPDATE`) until the caller's transaction ends, so
 * commands on one work item are decided one at a time. `db` must be a client inside a
 * transaction; on a pool the lock would end with the statement. Undefined without a work item:
 * nothing is locked then.
 */
export async function lockWorkItem(db: Db, repository: string, issueNumber: number): Promise<WorkItemRow | undefined> {
  const { rows } = await db.query<WorkItemRecord>(`SELECT ${WORK_ITEM_COLUMNS} FROM work_items WHERE repository = $1 AND issue_number = $2 FOR UPDATE`, [
    repository,
    issueNumber,
  ]);
  return rows[0] === undefined ? undefined : toWorkItem(rows[0]);
}

/**
 * Records an owner command; undefined when its GitHub comment id is recorded already, which then
 * stays as it was. A concurrent record of the same id waits for the first to commit, then gets
 * undefined.
 */
export async function recordComment(db: Db, comment: NewComment): Promise<CommentRow | undefined> {
  if (!Number.isSafeInteger(comment.githubCommentId) || comment.githubCommentId <= 0) {
    throw new Error(`not a GitHub comment id: ${String(comment.githubCommentId)}`);
  }
  const { rows } = await db.query<CommentRecord>(
    `INSERT INTO comments (work_item_id, repository, issue_number, github_comment_id, author, verb, body, outcome, state_met)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (github_comment_id) DO NOTHING
     RETURNING ${COMMENT_COLUMNS}`,
    [comment.workItemId, comment.repository, comment.issueNumber, comment.githubCommentId, comment.author, comment.verb, comment.body, comment.outcome, comment.stateMet],
  );
  return rows[0] === undefined ? undefined : toComment(rows[0]);
}

/** Sets what a recorded command came to, once its effect is known; a missing row is an error. */
export async function setCommentOutcome(db: Db, commentId: string, outcome: CommentOutcome): Promise<CommentRow> {
  const { rows } = await db.query<CommentRecord>(`UPDATE comments SET outcome = $2 WHERE id = $1 RETURNING ${COMMENT_COLUMNS}`, [commentId, outcome]);
  if (rows[0] === undefined) throw new Error(`comment ${commentId} not found`);
  return toComment(rows[0]);
}

/** The work item's owner commands, oldest first. */
export async function listComments(db: Db, workItemId: string): Promise<CommentRow[]> {
  const { rows } = await db.query<CommentRecord>(`SELECT ${COMMENT_COLUMNS} FROM comments WHERE work_item_id = $1 ORDER BY received_at, id`, [workItemId]);
  return rows.map(toComment);
}

/** The work item's owner interventions: its applied `/approve`, `/revise`, `/abort` and `/resume`. */
export async function countInterventions(db: Db, workItemId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>("SELECT count(*) AS n FROM comments WHERE work_item_id = $1 AND outcome = 'applied' AND verb = ANY($2)", [
    workItemId,
    INTERVENTION_VERBS,
  ]);
  return Number(rows[0]?.n ?? 0);
}

/** One of a stage's questions, with the attempt that answers or answered it, if one was opened. */
export interface StageQuestion {
  comment: CommentRow;
  attempt: AttemptRow | undefined;
}

/**
 * The stage's applied owner commands, oldest first: the comments applied while the work item
 * awaited the stage's approval (`/approve`, `/revise`, `/question`).
 */
export async function stageComments(db: Db, workItemId: string, stage: Stage): Promise<CommentRow[]> {
  const { rows } = await db.query<CommentRecord>(
    `SELECT ${COMMENT_COLUMNS} FROM comments WHERE work_item_id = $1 AND state_met = $2 AND outcome = 'applied' ORDER BY received_at, id`,
    [workItemId, AWAITING_STATE[stage]],
  );
  return rows.map(toComment);
}

/** The stage's applied `/question`s, oldest first, each with the `<stage>-question` attempt that names it. */
export async function stageQuestions(db: Db, workItemId: string, stage: Stage): Promise<StageQuestion[]> {
  const questions = (await stageComments(db, workItemId, stage)).filter((comment) => comment.verb === "question");
  const attempts = (await listAttempts(db, workItemId)).filter((attempt) => attempt.state === `${stage}-question`);
  return questions.map((comment) => ({ comment, attempt: attempts.filter((attempt) => attempt.commentIds.includes(comment.id)).at(-1) }));
}

/** The work item's open question attempt, of either stage; a work item answers one question at a time. */
export async function openQuestionAttempt(db: Db, workItemId: string): Promise<AttemptRow | undefined> {
  const { rows } = await db.query<AttemptRecord>(
    `SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE work_item_id = $1 AND state IN ('proposal-question', 'design-question') AND ended_at IS NULL ORDER BY id DESC LIMIT 1`,
    [workItemId],
  );
  return rows[0] === undefined ? undefined : toAttempt(rows[0]);
}
