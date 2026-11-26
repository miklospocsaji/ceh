/**
 * add-approval-feedback task 2.1: migration 0006 and its queries, against the local Postgres. The
 * handler's use of them (Closed approval records its outcome, among others) is proved in
 * factory/orchestrator/test/commands-feedback.test.ts.
 */
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.ts";
import {
  closeApproval,
  closeAttempt,
  createWorkItem,
  listAttempts,
  listMessages,
  openApproval,
  openAttempt,
  openQuestionAttempt,
  recordComment,
  reopenApproval,
  stageComments,
  stageQuestions,
  type NewComment,
  type WorkItemRow,
} from "../src/queries.ts";
import { LedgerRecorder } from "../src/recorder.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { init, result } from "./messages.ts";

const REPOSITORY = "miklospocsaji/vocab";
const OWNER = "miklospocsaji";

let db: TestDatabase;
let nextCommentId = 8_000_000_001;

beforeAll(async () => {
  db = await createTestDatabase("approval_feedback");
  await migrate(db.pool);
  return () => db.close();
});

afterEach(async () => {
  await db.pool.query("TRUNCATE work_items, attempts, messages, events, approvals, tasks, comments CASCADE");
});

async function workItem(state = "awaiting-proposal-approval"): Promise<WorkItemRow> {
  return createWorkItem(db.pool, { repository: REPOSITORY, issueNumber: 12, changeId: "add-thing", branch: "add-thing", state });
}

function comment(item: WorkItemRow, overrides: Partial<NewComment> = {}): NewComment {
  return {
    workItemId: item.id,
    repository: REPOSITORY,
    issueNumber: item.issueNumber,
    githubCommentId: nextCommentId++,
    author: OWNER,
    verb: "revise",
    body: "/revise Use SQLite.",
    outcome: "applied",
    stateMet: "awaiting-proposal-approval",
    ...overrides,
  };
}

describe("migration 0006: approval outcomes", () => {
  it("reads approvals closed before the migration as approved, and leaves open ones without an outcome", async () => {
    const old = await createTestDatabase("approval_feedback_backfill");
    const before = await mkdtemp(join(tmpdir(), "ledger-migrations-"));
    try {
      const all = resolve(import.meta.dirname, "../migrations");
      for (const file of (await readdir(all)).filter((name) => name < "0006")) await cp(join(all, file), join(before, file));
      await migrate(old.pool, before);
      const { rows } = await old.pool.query<{ id: string }>("INSERT INTO work_items (repository, issue_number, change_id, branch, state) VALUES ($1, 11, 'add-a', 'add-a', 'pr-open'), ($1, 12, 'add-b', 'add-b', 'awaiting-proposal-approval') RETURNING id", [REPOSITORY]);
      const [first, second] = rows.map((row) => row.id);
      await old.pool.query("INSERT INTO approvals (work_item_id, state, task_token, resolved_at, resolved_by) VALUES ($1, 'closed', 't1', now(), $2)", [first, OWNER]);
      await old.pool.query("INSERT INTO approvals (work_item_id, state, task_token) VALUES ($1, 'open', 't2')", [second]);
      await old.pool.query("INSERT INTO attempts (work_item_id, state, role, n) VALUES ($1, 'proposal', 'proposal-author', 1)", [first]);

      expect(await migrate(old.pool)).toEqual(["0006_approval_feedback", "0007_resume"]);

      const approvals = await old.pool.query<{ task_token: string; outcome: string | null }>("SELECT task_token, outcome FROM approvals ORDER BY id");
      expect(approvals.rows).toEqual([
        { task_token: "t1", outcome: "approved" },
        { task_token: "t2", outcome: null },
      ]);
      // Attempts from before name no comments.
      const attempts = await old.pool.query<{ comment_ids: string[] }>("SELECT comment_ids FROM attempts");
      expect(attempts.rows).toEqual([{ comment_ids: [] }]);
    } finally {
      await rm(before, { recursive: true, force: true });
      await old.close();
    }
  });

  it("refuses a closed approval without an outcome, and an open one with an outcome", async () => {
    const item = await workItem();
    const approval = await openApproval(db.pool, { workItemId: item.id, taskToken: "t" });

    await expect(db.pool.query("UPDATE approvals SET state = 'closed', resolved_at = now(), resolved_by = $2 WHERE id = $1", [approval.id, OWNER])).rejects.toThrow(/approvals_outcome_closed/);
    await expect(db.pool.query("UPDATE approvals SET outcome = 'approved' WHERE id = $1", [approval.id])).rejects.toThrow(/approvals_outcome_closed/);
    await expect(db.pool.query("UPDATE approvals SET outcome = 'maybe' WHERE id = $1", [approval.id])).rejects.toThrow(/outcome/);
  });

  it("closes an approval with its outcome, and reopening clears it", async () => {
    const item = await workItem();
    await openApproval(db.pool, { workItemId: item.id, taskToken: "t" });

    const revised = await closeApproval(db.pool, item.id, OWNER, "revise");
    expect(revised).toMatchObject({ state: "closed", outcome: "revise", resolvedBy: OWNER });

    const reopened = await reopenApproval(db.pool, revised?.id ?? "");
    expect(reopened).toMatchObject({ state: "open", outcome: null, resolvedBy: null });

    expect(await closeApproval(db.pool, item.id, OWNER, "approved")).toMatchObject({ state: "closed", outcome: "approved" });
  });
});

describe("migration 0006: the comments an attempt was given", () => {
  it("stores an attempt's comment ids in the order given, and none by default", async () => {
    const item = await workItem("proposal");
    const first = await recordComment(db.pool, comment(item));
    const second = await recordComment(db.pool, comment(item));

    const plain = await openAttempt(db.pool, { workItemId: item.id, state: "proposal", role: "proposal-author" });
    await closeAttempt(db.pool, plain.id, { outcome: "failed", failureReason: "error" });
    const given = await openAttempt(db.pool, { workItemId: item.id, state: "proposal", role: "proposal-author", commentIds: [first?.id ?? "", second?.id ?? ""] });

    expect(plain.commentIds).toEqual([]);
    expect(given.commentIds).toEqual([first?.id, second?.id]);
    expect((await listAttempts(db.pool, item.id)).map((attempt) => attempt.commentIds)).toEqual([[], [first?.id, second?.id]]);
  });
});

describe("stageComments and stageQuestions", () => {
  it("lists the stage's applied commands, oldest first, apart from other stages and other outcomes", async () => {
    const item = await workItem();
    const revise1 = await recordComment(db.pool, comment(item, { body: "/revise one" }));
    await recordComment(db.pool, comment(item, { body: "/revise busy", outcome: "busy", stateMet: "proposal" }));
    await recordComment(db.pool, comment(item, { body: "/revise refused", outcome: "refused" }));
    const question = await recordComment(db.pool, comment(item, { verb: "question", body: "/question why?" }));
    await recordComment(db.pool, comment(item, { body: "/revise design", stateMet: "awaiting-design-approval" }));
    const revise2 = await recordComment(db.pool, comment(item, { body: "/revise two" }));

    expect((await stageComments(db.pool, item.id, "proposal")).map((row) => row.id)).toEqual([revise1?.id, question?.id, revise2?.id]);
    expect((await stageComments(db.pool, item.id, "design")).map((row) => row.body)).toEqual(["/revise design"]);
  });

  it("joins each of the stage's questions with the attempt that answered it", async () => {
    const item = await workItem();
    const answered = await recordComment(db.pool, comment(item, { verb: "question", body: "/question one" }));
    const failed = await recordComment(db.pool, comment(item, { verb: "question", body: "/question two" }));
    const pending = await recordComment(db.pool, comment(item, { verb: "question", body: "/question three" }));
    await recordComment(db.pool, comment(item, { verb: "question", body: "/question design", stateMet: "awaiting-design-approval" }));

    const a1 = await openAttempt(db.pool, { workItemId: item.id, state: "proposal-question", role: "proposal-author", commentIds: [answered?.id ?? ""] });
    await closeAttempt(db.pool, a1.id, { outcome: "succeeded", result: { answer: "Because." } });
    const a2 = await openAttempt(db.pool, { workItemId: item.id, state: "proposal-question", role: "proposal-author", commentIds: [failed?.id ?? ""] });
    await closeAttempt(db.pool, a2.id, { outcome: "failed", failureReason: "max-turns" });

    const questions = await stageQuestions(db.pool, item.id, "proposal");

    expect(questions.map((q) => [q.comment.id, q.attempt?.id, q.attempt?.outcome, q.attempt?.result])).toEqual([
      [answered?.id, a1.id, "succeeded", { answer: "Because." }],
      [failed?.id, a2.id, "failed", null],
      [pending?.id, undefined, undefined, undefined],
    ]);
  });

  it("finds the work item's open question attempt, and only that", async () => {
    const item = await workItem();
    const proposal = await openAttempt(db.pool, { workItemId: item.id, state: "proposal", role: "proposal-author" });
    expect(await openQuestionAttempt(db.pool, item.id)).toBeUndefined();

    const question = await openAttempt(db.pool, { workItemId: item.id, state: "design-question", role: "architect" });
    expect((await openQuestionAttempt(db.pool, item.id))?.id).toBe(question.id);

    await closeAttempt(db.pool, question.id, { outcome: "succeeded", result: { answer: "x" } });
    expect(await openQuestionAttempt(db.pool, item.id)).toBeUndefined();
    expect(proposal.endedAt).toBeNull();
  });
});

describe("LedgerRecorder: a session bound to its attempt", () => {
  it("records into the given attempt, even while a newer attempt of the same role is open", async () => {
    const item = await workItem();
    const question = await openAttempt(db.pool, { workItemId: item.id, state: "proposal-question", role: "proposal-author" });
    // A /revise during the answer: Proposal opens an attempt of the same role.
    const revision = await openAttempt(db.pool, { workItemId: item.id, state: "proposal", role: "proposal-author" });
    const recorder = new LedgerRecorder(db.pool);

    await recorder.record(item.id, "proposal-author", init("ANTHROPIC_API_KEY"), question.id);
    await recorder.record(item.id, "proposal-author", result({ input: 10, output: 5, cacheRead: 0, cacheCreation: 0 }, 0.02), question.id);
    await recorder.record(item.id, "proposal-author", init("ANTHROPIC_API_KEY"));

    expect((await listMessages(db.pool, question.id)).map((message) => message.type)).toEqual(["system", "result"]);
    expect((await listMessages(db.pool, revision.id)).map((message) => message.type)).toEqual(["system"]);
    const attempts = await listAttempts(db.pool, item.id);
    expect(attempts.find((attempt) => attempt.id === question.id)).toMatchObject({ costUsdEstimate: 0.02, authMode: "api-key" });
    expect(attempts.find((attempt) => attempt.id === revision.id)?.costUsdEstimate).toBeNull();
  });
});
