/**
 * add-owner-commands task 2.1: the command handler's ledger records (design, "Command handler"
 * and "Ledger"): one comment row per owner command, redeliveries applied once, the interventions
 * count, and commands on one work item decided one at a time under its lock. FakeForge, a fake
 * TaskTokens and the real ledger.
 */
import { FakeForge } from "@ceh/factory-forge/testing";
import {
  countInterventions,
  createWorkItem,
  findOpenApproval,
  listComments,
  migrate,
  openApproval,
  setWorkItemState,
  type ApprovalKind,
  type WorkItemRow,
} from "@ceh/factory-ledger";
import { createTestDatabase, type TestDatabase } from "@ceh/factory-ledger/testing";
import { testTarget } from "@ceh/factory-target/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadRole, type Role } from "@ceh/factory-roles";
import { cloudApprover, cloudReviser, type TaskTokens } from "../src/approval.ts";
import { handleCommand, InvalidCommand, type CommandContext, type CommandOutcome } from "../src/commands/handle.ts";

const TARGET = testTarget();
const OWNER = TARGET.owner;
const CHANGE_ID = "add-import-kindle-vocab-db";
const ISSUE = 12;
const BARE_ISSUE = 13;
const TOKEN = "AQB8AAAAKgAAAAMAAAAAAAAAAeTaskToken";

class FakeTaskTokens implements TaskTokens {
  readonly successes: { taskToken: string; output: string }[] = [];
  /** How long SendTaskSuccess takes, so two handlers overlap. */
  delayMs = 0;

  async succeed(taskToken: string, output: string): Promise<void> {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    this.successes.push({ taskToken, output });
  }

  fail(): Promise<void> {
    return Promise.resolve();
  }
}

let db: TestDatabase;
let forge: FakeForge;
let taskTokens: FakeTaskTokens;
let roles: { proposalAuthor: Role; architect: Role };

beforeAll(async () => {
  roles = { proposalAuthor: await loadRole("proposal-author", TARGET), architect: await loadRole("architect", TARGET) };
  db = await createTestDatabase("commands_ledger");
  await migrate(db.pool);
  return () => db.close();
});

beforeEach(() => {
  forge = new FakeForge({
    issues: [
      { number: ISSUE, title: "Import Kindle vocab.db", body: "Import the lookups." },
      { number: BARE_ISSUE, title: "Something else", body: "x" },
    ],
  });
  taskTokens = new FakeTaskTokens();
});

afterEach(async () => {
  await db.pool.query("TRUNCATE work_items, attempts, messages, events, approvals, tasks CASCADE");
});

function context(): CommandContext {
  const base = { db: db.pool, forge, target: TARGET };
  return {
    ...base,
    approve: cloudApprover({ ...base, taskTokens }),
    revise: cloudReviser({ ...base, taskTokens }),
    // No session runs in these tests: a question would need the forge's remote.
    question: { runRole: () => Promise.reject(new Error("no session in these tests")), proposalAuthor: roles.proposalAuthor, architect: roles.architect },
  };
}

/** Seeds an owner comment on the forge and returns its id. */
function posted(body: string, issue = ISSUE, author = OWNER): number {
  return forge.addComment({ issueNumber: issue, author, body }).id;
}

async function workItemIn(state: string): Promise<WorkItemRow> {
  return createWorkItem(db.pool, { repository: TARGET.repository, issueNumber: ISSUE, changeId: CHANGE_ID, branch: CHANGE_ID, state });
}

async function awaiting(kind: ApprovalKind = "proposal"): Promise<WorkItemRow> {
  const workItem = await workItemIn(kind === "design" ? "awaiting-design-approval" : "awaiting-proposal-approval");
  await openApproval(db.pool, { workItemId: workItem.id, taskToken: TOKEN, kind });
  return workItem;
}

/** The replies the factory posted on the issue, not the owner's comments. */
const replies = (issue = ISSUE): string[] => forge.comments.filter((c) => c.issueNumber === issue).map((c) => c.body);

interface CommentRecord {
  github_comment_id: string;
  work_item_id: string | null;
  issue_number: number;
  state_met: string | null;
  outcome: string;
}

/** Every comment row, oldest first; none while the table does not exist yet. */
async function commentRows(): Promise<CommentRecord[]> {
  const { rows: table } = await db.pool.query<{ t: string | null }>("SELECT to_regclass('comments')::text AS t");
  if (table[0]?.t == null) return [];
  return (await db.pool.query<CommentRecord>("SELECT github_comment_id, work_item_id, issue_number, state_met, outcome FROM comments ORDER BY id")).rows;
}

const rowOf = async (githubCommentId: number): Promise<CommentRecord[]> => (await commentRows()).filter((row) => row.github_comment_id === String(githubCommentId));

describe("handleCommand: the ledger's record of a command", () => {
  it("Scenario: Command is recorded with its outcome", async () => {
    const workItem = await workItemIn("proposal");
    const id = posted("/approve");

    await handleCommand(context(), ISSUE, id);

    const rows = await listComments(db.pool, workItem.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workItemId: workItem.id,
      repository: TARGET.repository,
      issueNumber: ISSUE,
      githubCommentId: id,
      author: OWNER,
      verb: "approve",
      body: "/approve",
      outcome: "busy",
      stateMet: "proposal",
    });
  });

  it("records the body as read at receipt, the verb as written, and every outcome", async () => {
    const workItem = await awaiting();
    const status = posted("/status\nAnd how much so far?");
    const typo = posted("/Approve");
    const later = posted("/abort make it shorter");

    await handleCommand(context(), ISSUE, status);
    await handleCommand(context(), ISSUE, typo);
    await handleCommand(context(), ISSUE, later);

    expect((await listComments(db.pool, workItem.id)).map(({ verb, body, outcome, stateMet }) => ({ verb, body, outcome, stateMet }))).toEqual([
      { verb: "status", body: "/status\nAnd how much so far?", outcome: "applied", stateMet: "awaiting-proposal-approval" },
      { verb: "Approve", body: "/Approve", outcome: "unknown", stateMet: "awaiting-proposal-approval" },
      { verb: "abort", body: "/abort make it shorter", outcome: "refused", stateMet: "awaiting-proposal-approval" },
    ]);
  });

  it("records an applied /approve as applied, and one whose resume failed as refused", async () => {
    const workItem = await awaiting();
    const failing = { ...context(), approve: cloudApprover({ db: db.pool, forge, target: TARGET, taskTokens: { succeed: () => Promise.reject(new Error("TaskTimedOut")), fail: () => Promise.resolve() } }) };

    await handleCommand(failing, ISSUE, posted("/approve"));
    await handleCommand(context(), ISSUE, posted("/approve"));

    expect((await listComments(db.pool, workItem.id)).map((row) => row.outcome)).toEqual(["refused", "applied"]);
    expect(taskTokens.successes).toHaveLength(1);
  });

  it("records a command on an issue with no work item, with no work item and no state", async () => {
    const id = posted("/status", BARE_ISSUE);

    await handleCommand(context(), BARE_ISSUE, id);

    expect(await rowOf(id)).toEqual([{ github_comment_id: String(id), work_item_id: null, issue_number: BARE_ISSUE, state_met: null, outcome: "applied" }]);
  });

  it("records nothing for a comment it refuses to act on", async () => {
    await awaiting();

    await expect(handleCommand(context(), ISSUE, posted("/approve", ISSUE, "someone-else"))).rejects.toBeInstanceOf(InvalidCommand);
    await expect(handleCommand(context(), ISSUE, posted("/approve", BARE_ISSUE))).rejects.toBeInstanceOf(InvalidCommand);
    await expect(handleCommand(context(), ISSUE, posted("Looks good."))).rejects.toBeInstanceOf(InvalidCommand);
    // The owner's own command on the issue, after them, is the only one recorded.
    const status = posted("/status");
    await handleCommand(context(), ISSUE, status);

    expect((await commentRows()).map((row) => row.github_comment_id)).toEqual([String(status)]);
  });
});

describe("handleCommand: redeliveries", () => {
  it("Scenario: Redelivered command is applied once", async () => {
    // A design approval, whose confirmation the command task posts itself.
    const workItem = await awaiting("design");
    const id = posted("/approve");

    const first = await handleCommand(context(), ISSUE, id);
    const second = await handleCommand(context(), ISSUE, id);

    expect(first.outcome).toBe("applied");
    expect(second.outcome).toBe("duplicate");
    expect(taskTokens.successes).toEqual([{ taskToken: TOKEN, output: JSON.stringify({ decision: "approve" }) }]);
    expect(await listComments(db.pool, workItem.id)).toHaveLength(1);
    expect(replies()).toHaveLength(1);
    expect(replies()[0]).toContain("design");
  });

  it("answers a redelivered /status once, also on an issue with no work item", async () => {
    await workItemIn("proposal");
    const onWorkItem = posted("/status");
    const onBareIssue = posted("/status", BARE_ISSUE);

    for (let i = 0; i < 2; i++) {
      await handleCommand(context(), ISSUE, onWorkItem);
      await handleCommand(context(), BARE_ISSUE, onBareIssue);
    }

    expect(replies(ISSUE)).toHaveLength(1);
    expect(replies(BARE_ISSUE)).toHaveLength(1);
    expect(await commentRows()).toHaveLength(2);
  });

  it("answers a busy command once when it is redelivered after the work item has moved on", async () => {
    const workItem = await workItemIn("proposal");
    const id = posted("/approve");

    await handleCommand(context(), ISSUE, id);
    await setWorkItemState(db.pool, workItem.id, "awaiting-proposal-approval", { from: "proposal" });
    await openApproval(db.pool, { workItemId: workItem.id, taskToken: TOKEN });
    const redelivered = await handleCommand(context(), ISSUE, id);

    // The busy /approve is not kept: its redelivery does not approve either.
    expect(redelivered.outcome).toBe("duplicate");
    expect(taskTokens.successes).toEqual([]);
    expect(await findOpenApproval(db.pool, workItem.id)).toBeDefined();
    expect(replies()).toHaveLength(1);
  });
});

describe("handleCommand: owner interventions", () => {
  it("Scenario: Interventions count only commands that act", async () => {
    const workItem = await workItemIn("proposal");

    await handleCommand(context(), ISSUE, posted("/status"));
    await handleCommand(context(), ISSUE, posted("/approve"));
    await setWorkItemState(db.pool, workItem.id, "awaiting-proposal-approval", { from: "proposal" });
    await openApproval(db.pool, { workItemId: workItem.id, taskToken: TOKEN });
    await handleCommand(context(), ISSUE, posted("/approve"));

    expect((await listComments(db.pool, workItem.id)).map((row) => `${row.verb}:${row.outcome}`)).toEqual(["status:applied", "approve:busy", "approve:applied"]);
    expect(await countInterventions(db.pool, workItem.id)).toBe(1);
  });
});

describe("handleCommand: commands on one work item, one at a time", () => {
  it("Scenario: Two approvals at once resume the execution once", async () => {
    // A design approval, so each comment gets its own reply from the command task.
    const workItem = await awaiting("design");
    const one = posted("/approve");
    const two = posted("/approve");
    taskTokens.delayMs = 200;

    // Two handlers, each on its own connection from the pool, started together.
    const outcomes: CommandOutcome[] = await Promise.all([handleCommand(context(), ISSUE, one), handleCommand(context(), ISSUE, two)]);

    expect(taskTokens.successes).toEqual([{ taskToken: TOKEN, output: JSON.stringify({ decision: "approve" }) }]);
    expect(outcomes.map((outcome) => outcome.outcome).sort()).toEqual(["applied", "refused"]);
    const rows = await listComments(db.pool, workItem.id);
    expect(rows.map((row) => row.outcome).sort()).toEqual(["applied", "refused"]);
    expect(new Set(rows.map((row) => row.githubCommentId))).toEqual(new Set([one, two]));
    // One reply to each: the design's confirmation, and nothing awaits approval.
    expect(replies()).toHaveLength(2);
    expect(replies().filter((reply) => /nothing awaits/i.test(reply))).toHaveLength(1);
  });

  it("decides a second command only after the first has committed", async () => {
    await awaiting("design");
    taskTokens.delayMs = 200;
    const order: string[] = [];
    const status = posted("/status");

    // A /status that arrives while the /approve holds the lock waits for it, though it is the quicker.
    const approving = handleCommand(context(), ISSUE, posted("/approve")).then((outcome) => {
      order.push("approve");
      return outcome;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const asking = handleCommand(context(), ISSUE, status).then((outcome) => {
      order.push("status");
      return outcome;
    });
    await Promise.all([approving, asking]);

    expect(order).toEqual(["approve", "status"]);
    expect((await rowOf(status)).map((row) => row.outcome)).toEqual(["applied"]);
  });
});
