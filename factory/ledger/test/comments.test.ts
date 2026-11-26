/**
 * add-owner-commands task 2.1: migration 0005 and its queries, against the local Postgres. The
 * handler's use of them (the scenarios) is proved in factory/orchestrator/test/commands-ledger.test.ts.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.ts";
import {
  countInterventions,
  createWorkItem,
  listComments,
  lockWorkItem,
  recordComment,
  setCommentOutcome,
  setWorkItemState,
  type CommentOutcome,
  type NewComment,
  type WorkItemRow,
} from "../src/queries.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";

const REPOSITORY = "miklospocsaji/vocab";
const OWNER = "miklospocsaji";

let db: TestDatabase;
let nextCommentId = 9_000_000_001;

beforeAll(async () => {
  db = await createTestDatabase("comments");
  await migrate(db.pool);
  return () => db.close();
});

afterEach(async () => {
  await db.pool.query("TRUNCATE work_items, attempts, messages, events, approvals, tasks CASCADE");
});

async function workItem(issueNumber = 12, state = "awaiting-proposal-approval"): Promise<WorkItemRow> {
  const changeId = `add-thing-${String(issueNumber)}`;
  return createWorkItem(db.pool, { repository: REPOSITORY, issueNumber, changeId, branch: changeId, state });
}

function comment(item: WorkItemRow | undefined, overrides: Partial<NewComment> = {}): NewComment {
  return {
    workItemId: item?.id ?? null,
    repository: REPOSITORY,
    issueNumber: item?.issueNumber ?? 13,
    githubCommentId: nextCommentId++,
    author: OWNER,
    verb: "approve",
    body: "/approve",
    outcome: "applied",
    stateMet: item?.state ?? null,
    ...overrides,
  };
}

describe("comments: recordComment", () => {
  it("records a comment with its work item, author, verb, body, outcome and the state it met", async () => {
    const item = await workItem();
    const input = comment(item, { verb: "status", body: "/status\nwhere are we?", outcome: "applied" });

    const row = await recordComment(db.pool, input);

    expect(row).toMatchObject({
      workItemId: item.id,
      repository: REPOSITORY,
      issueNumber: 12,
      githubCommentId: input.githubCommentId,
      author: OWNER,
      verb: "status",
      body: "/status\nwhere are we?",
      outcome: "applied",
      stateMet: "awaiting-proposal-approval",
    });
    expect(row?.id).toEqual(expect.any(String));
    expect(row?.receivedAt).toBeInstanceOf(Date);
    expect(await listComments(db.pool, item.id)).toEqual([row]);
  });

  it("records a comment on an issue with no work item, with no work item and no state", async () => {
    const row = await recordComment(db.pool, comment(undefined, { verb: "status", body: "/status" }));

    expect(row).toMatchObject({ workItemId: null, issueNumber: 13, stateMet: null });
  });

  it("keeps GitHub comment ids beyond 32 bits exactly", async () => {
    const row = await recordComment(db.pool, comment(undefined, { githubCommentId: 3_587_451_920_113 }));

    expect(row?.githubCommentId).toBe(3_587_451_920_113);
  });

  it("records a comment id once: a second record of it returns undefined and changes nothing", async () => {
    const item = await workItem();
    const first = comment(item, { outcome: "applied" });
    const recorded = await recordComment(db.pool, first);

    expect(await recordComment(db.pool, { ...first, outcome: "refused", body: "/approve edited" })).toBeUndefined();

    expect(await listComments(db.pool, item.id)).toEqual([recorded]);
  });

  it("refuses an outcome other than applied, busy, refused or unknown", async () => {
    await expect(recordComment(db.pool, comment(undefined, { outcome: "queued" as CommentOutcome }))).rejects.toThrow(/outcome/);
  });

  it("sets a recorded comment's outcome", async () => {
    const item = await workItem();
    const row = await recordComment(db.pool, comment(item, { outcome: "applied" }));
    expect(row).toBeDefined();
    if (row === undefined) return;

    const updated = await setCommentOutcome(db.pool, row.id, "refused");

    expect(updated).toEqual({ ...row, outcome: "refused" });
    expect(await listComments(db.pool, item.id)).toEqual([updated]);
  });
});

describe("comments: listComments", () => {
  it("lists a work item's comments oldest first, and no other work item's", async () => {
    const item = await workItem(12);
    const other = await workItem(14);
    const first = await recordComment(db.pool, comment(item, { verb: "status", body: "/status" }));
    await recordComment(db.pool, comment(other));
    const second = await recordComment(db.pool, comment(item, { verb: "help", body: "/help" }));

    expect(await listComments(db.pool, item.id)).toEqual([first, second]);
  });
});

describe("comments: countInterventions", () => {
  it("counts applied /approve, /revise, /abort and /resume only", async () => {
    const item = await workItem();
    for (const verb of ["approve", "revise", "abort", "resume"]) await recordComment(db.pool, comment(item, { verb, body: `/${verb}`, outcome: "applied" }));
    // Applied, but changing nothing.
    for (const verb of ["question", "status", "help"]) await recordComment(db.pool, comment(item, { verb, body: `/${verb}`, outcome: "applied" }));
    // Acting verbs that did not act.
    for (const outcome of ["busy", "refused"] as const) await recordComment(db.pool, comment(item, { verb: "approve", outcome }));
    await recordComment(db.pool, comment(item, { verb: "Approve", body: "/Approve", outcome: "unknown" }));
    // Another work item's.
    await recordComment(db.pool, comment(await workItem(14), { verb: "approve", outcome: "applied" }));

    expect(await countInterventions(db.pool, item.id)).toBe(4);
  });

  it("is 0 for a work item without comments", async () => {
    expect(await countInterventions(db.pool, (await workItem()).id)).toBe(0);
  });
});

describe("comments: lockWorkItem", () => {
  it("returns the issue's work item, or undefined when it has none", async () => {
    const item = await workItem();
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      expect(await lockWorkItem(client, REPOSITORY, 12)).toEqual(item);
      expect(await lockWorkItem(client, REPOSITORY, 99)).toBeUndefined();
      expect(await lockWorkItem(client, "someone/other", 12)).toBeUndefined();
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("holds the work item until the transaction ends: a second lock waits, then sees what the first wrote", async () => {
    const item = await workItem();
    const first = await db.pool.connect();
    const second = await db.pool.connect();
    try {
      await first.query("BEGIN");
      await second.query("BEGIN");
      await lockWorkItem(first, REPOSITORY, 12);

      let waited: WorkItemRow | undefined | "pending" = "pending";
      const secondLock = lockWorkItem(second, REPOSITORY, 12).then((row) => {
        waited = row;
        return row;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(waited).toBe("pending");

      await setWorkItemState(first, item.id, "proposal-approved", { from: "awaiting-proposal-approval" });
      await first.query("COMMIT");

      expect((await secondLock)?.state).toBe("proposal-approved");
      await second.query("COMMIT");
    } finally {
      // A failed assertion leaves both transactions open; never return them to the pool so.
      for (const client of [first, second]) {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    }
  });
});
