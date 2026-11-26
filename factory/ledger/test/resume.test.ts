/**
 * add-work-item-resume task 2.1: migration 0007 and the compare-and-set state update, against the
 * local Postgres. The handlers' use of them (`/abort`, Adopt, retry counts) is proved in
 * factory/orchestrator/test/resume.test.ts.
 */
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.ts";
import {
  abortOpenAttempts,
  closeApproval,
  closeAttempt,
  createWorkItem,
  findOpenApproval,
  findWorkItemByIssue,
  listAttempts,
  openApproval,
  openAttempt,
  setWorkItemState,
  StateChanged,
  type WorkItemRow,
} from "../src/queries.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";

const REPOSITORY = "miklospocsaji/vocab";
const OWNER = "miklospocsaji";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase("resume");
  await migrate(db.pool);
  return () => db.close();
});

afterEach(async () => {
  await db.pool.query("TRUNCATE work_items, attempts, messages, events, approvals, tasks, comments CASCADE");
});

async function workItem(state: string, issueNumber = 12): Promise<WorkItemRow> {
  return createWorkItem(db.pool, { repository: REPOSITORY, issueNumber, changeId: `add-thing-${String(issueNumber)}`, branch: `add-thing-${String(issueNumber)}`, state });
}

describe("migration 0007: aborted and stopped_in", () => {
  it("leaves the rows from before it as they were, with no stopped_in", async () => {
    const old = await createTestDatabase("resume_backfill");
    const before = await mkdtemp(join(tmpdir(), "ledger-migrations-"));
    try {
      const all = resolve(import.meta.dirname, "../migrations");
      for (const file of (await readdir(all)).filter((name) => name < "0007")) await cp(join(all, file), join(before, file));
      await migrate(old.pool, before);
      const { rows } = await old.pool.query<{ id: string }>(
        "INSERT INTO work_items (repository, issue_number, change_id, branch, state) VALUES ($1, 11, 'add-a', 'add-a', 'escalated'), ($1, 12, 'add-b', 'add-b', 'build') RETURNING id",
        [REPOSITORY],
      );
      const [first, second] = rows.map((row) => row.id);
      await old.pool.query("INSERT INTO attempts (work_item_id, state, role, n, ended_at, outcome, failure_reason) VALUES ($1, 'proposal', 'proposal-author', 1, now(), 'failed', 'error')", [first]);
      await old.pool.query("INSERT INTO attempts (work_item_id, state, role, n, ended_at, outcome) VALUES ($1, 'proposal', 'proposal-author', 1, now(), 'succeeded')", [second]);
      await old.pool.query("INSERT INTO attempts (work_item_id, state, role, n) VALUES ($1, 'plan', 'planner', 1)", [second]);
      await old.pool.query("INSERT INTO approvals (work_item_id, state, task_token, resolved_at, resolved_by, outcome) VALUES ($1, 'closed', 't1', now(), $2, 'approved')", [second, OWNER]);

      expect(await migrate(old.pool)).toEqual(["0007_resume"]);

      const items = await old.pool.query<{ state: string; stopped_in: string | null }>("SELECT state, stopped_in FROM work_items ORDER BY id");
      expect(items.rows).toEqual([
        { state: "escalated", stopped_in: null },
        { state: "build", stopped_in: null },
      ]);
      const attempts = await old.pool.query<{ outcome: string | null; failure_reason: string | null }>("SELECT outcome, failure_reason FROM attempts ORDER BY id");
      expect(attempts.rows).toEqual([
        { outcome: "failed", failure_reason: "error" },
        { outcome: "succeeded", failure_reason: null },
        { outcome: null, failure_reason: null },
      ]);
      const approvals = await old.pool.query<{ outcome: string }>("SELECT outcome FROM approvals");
      expect(approvals.rows).toEqual([{ outcome: "approved" }]);
    } finally {
      await rm(before, { recursive: true, force: true });
      await old.close();
    }
  });

  it("closes an attempt aborted, with no failure reason and no result, and refuses an aborted attempt with a failure reason", async () => {
    const item = await workItem("proposal");
    const attempt = await openAttempt(db.pool, { workItemId: item.id, state: "proposal", role: "proposal-author" });

    const aborted = await closeAttempt(db.pool, attempt.id, { outcome: "aborted" });

    expect(aborted).toMatchObject({ id: attempt.id, outcome: "aborted", failureReason: null, result: null });
    expect(aborted.endedAt).toBeInstanceOf(Date);
    const other = await openAttempt(db.pool, { workItemId: item.id, state: "proposal", role: "proposal-author" });
    await expect(db.pool.query("UPDATE attempts SET ended_at = now(), outcome = 'aborted', failure_reason = 'error' WHERE id = $1", [other.id])).rejects.toThrow(/attempts/);
    await expect(db.pool.query("UPDATE attempts SET ended_at = now(), outcome = 'maybe' WHERE id = $1", [other.id])).rejects.toThrow(/attempts/);
  });

  it("closes the work item's open attempts aborted, and only those", async () => {
    const item = await workItem("build");
    const other = await workItem("build", 13);
    const done = await openAttempt(db.pool, { workItemId: item.id, state: "plan", role: "planner" });
    await closeAttempt(db.pool, done.id, { outcome: "succeeded" });
    const failed = await openAttempt(db.pool, { workItemId: item.id, state: "build", role: "test-author", taskId: "1.1" });
    await closeAttempt(db.pool, failed.id, { outcome: "failed", failureReason: "red" });
    const open = await openAttempt(db.pool, { workItemId: item.id, state: "build", role: "implementer", taskId: "1.1" });
    const elsewhere = await openAttempt(db.pool, { workItemId: other.id, state: "build", role: "implementer", taskId: "1.1" });

    const closed = await abortOpenAttempts(db.pool, item.id);

    expect(closed.map((attempt) => attempt.id)).toEqual([open.id]);
    expect((await listAttempts(db.pool, item.id)).map((attempt) => attempt.outcome)).toEqual(["succeeded", "failed", "aborted"]);
    expect((await listAttempts(db.pool, other.id)).map((attempt) => [attempt.id, attempt.outcome])).toEqual([[elsewhere.id, null]]);
    expect(await abortOpenAttempts(db.pool, item.id)).toEqual([]);
  });

  it("closes an approval aborted", async () => {
    const item = await workItem("awaiting-proposal-approval");
    await openApproval(db.pool, { workItemId: item.id, taskToken: "t" });

    expect(await closeApproval(db.pool, item.id, OWNER, "aborted")).toMatchObject({ state: "closed", outcome: "aborted", resolvedBy: OWNER });
    expect(await findOpenApproval(db.pool, item.id)).toBeUndefined();
  });
});

describe("setWorkItemState: compare-and-set", () => {
  it("moves a work item only from the state its writer expects", async () => {
    const item = await workItem("proposal");

    const moved = await setWorkItemState(db.pool, item.id, "awaiting-proposal-approval", { from: "proposal" });
    expect(moved).toMatchObject({ id: item.id, state: "awaiting-proposal-approval" });

    const stale = setWorkItemState(db.pool, item.id, "awaiting-proposal-approval", { from: "proposal" });
    await expect(stale).rejects.toThrow(StateChanged);
    await expect(stale).rejects.toThrow(/proposal/);
    expect((await findWorkItemByIssue(db.pool, REPOSITORY, 12))?.state).toBe("awaiting-proposal-approval");
    await expect(setWorkItemState(db.pool, "999999", "proposal", { from: "intake" })).rejects.toThrow("999999");
  });

  it("records the state a work item stopped in when it is aborted or escalated, keeps it from one to the other, and clears it when it goes on", async () => {
    const item = await workItem("build");

    const aborted = await setWorkItemState(db.pool, item.id, "aborted", { from: "build" });
    expect(aborted).toMatchObject({ state: "aborted", stoppedIn: "build" });

    const escalated = await setWorkItemState(db.pool, item.id, "escalated", { from: "aborted" });
    expect(escalated).toMatchObject({ state: "escalated", stoppedIn: "build" });

    const resumed = await setWorkItemState(db.pool, item.id, "build", { from: "escalated" });
    expect(resumed).toMatchObject({ state: "build", stoppedIn: null });

    const planning = await workItem("plan", 13);
    expect(await setWorkItemState(db.pool, planning.id, "escalated", { from: "plan" })).toMatchObject({ state: "escalated", stoppedIn: "plan" });
  });

  it("Scenario: Late write after abort is refused", async () => {
    const item = await workItem("proposal");
    const attempt = await openAttempt(db.pool, { workItemId: item.id, state: "proposal", role: "proposal-author" });
    // The abort, while the Proposal worker's session runs.
    await abortOpenAttempts(db.pool, item.id);
    await setWorkItemState(db.pool, item.id, "aborted", { from: "proposal" });

    // The stopped worker finishes late: its attempt and its state update are both refused.
    await expect(closeAttempt(db.pool, attempt.id, { outcome: "succeeded", result: {} })).rejects.toThrow(/not open/);
    await expect(setWorkItemState(db.pool, item.id, "awaiting-proposal-approval", { from: "proposal" })).rejects.toThrow(StateChanged);

    expect(await findWorkItemByIssue(db.pool, REPOSITORY, 12)).toMatchObject({ state: "aborted", stoppedIn: "proposal" });
    expect((await listAttempts(db.pool, item.id)).map((row) => row.outcome)).toEqual(["aborted"]);
  });
});
