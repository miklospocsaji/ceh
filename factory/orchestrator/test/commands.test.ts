/**
 * add-owner-commands tasks 1.6 and 1.7: the command handler and its state table (design,
 * "Command handler"), `/status` and `/help`, with a FakeForge, a fake TaskTokens and the real
 * ledger. The ledger's comment rows, the work-item lock and redeliveries come with tasks 2.1 and
 * 2.2, and are proved there.
 */
import { FakeForge } from "@ceh/factory-forge/testing";
import {
  closeAttempt,
  createWorkItem,
  findOpenApproval,
  findWorkItemByIssue,
  markTaskDone,
  migrate,
  openApproval,
  openAttempt,
  setWorkItemState,
  storePlan,
  type ApprovalKind,
  type ApprovalRow,
  type WorkItemRow,
} from "@ceh/factory-ledger";
import { createTestDatabase, type TestDatabase } from "@ceh/factory-ledger/testing";
import { testTarget } from "@ceh/factory-target/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadRole, type Role } from "@ceh/factory-roles";
import { cloudApprover, cloudReviser, type TaskTokens } from "../src/approval.ts";
import { handleCommand, InvalidCommand, type CommandContext, type CommandOutcome } from "../src/commands/handle.ts";
import { KNOWN_VERBS } from "../src/commands/parse.ts";

const TARGET = testTarget();
const OWNER = TARGET.owner;
const CHANGE_ID = "add-import-kindle-vocab-db";
const ISSUE = 12;
/** An issue of the target with no work item. */
const BARE_ISSUE = 13;
const TOKEN = "AQB8AAAAKgAAAAMAAAAAAAAAAeTaskToken";

const BUSY_STATES = ["intake", "proposal", "proposal-approved", "design", "design-review", "plan"] as const;
const ALL_STATES = [
  ...BUSY_STATES,
  "awaiting-proposal-approval",
  "awaiting-design-approval",
  "build",
  "escalated",
  "pr-open",
] as const;

class FakeTaskTokens implements TaskTokens {
  readonly successes: { taskToken: string; output: string }[] = [];
  /** Rejects the next SendTaskSuccess with this error, then clears it. */
  failNextSuccess: Error | undefined;

  succeed(taskToken: string, output: string): Promise<void> {
    const error = this.failNextSuccess;
    if (error !== undefined) {
      this.failNextSuccess = undefined;
      return Promise.reject(error);
    }
    this.successes.push({ taskToken, output });
    return Promise.resolve();
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
  db = await createTestDatabase("commands");
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

interface Posted {
  author?: string;
  issue?: number;
}

/** Seeds the comment on the forge, then handles it as the `command` task would. */
async function command(body: string, { author = OWNER, issue = ISSUE }: Posted = {}, handledFor = issue): Promise<CommandOutcome> {
  const { id } = forge.addComment({ issueNumber: issue, author, body });
  return handleCommand(context(), handledFor, id);
}

async function workItemIn(state: string): Promise<WorkItemRow> {
  return createWorkItem(db.pool, { repository: TARGET.repository, issueNumber: ISSUE, changeId: CHANGE_ID, branch: CHANGE_ID, state });
}

/** A work item awaiting the owner's approval of the given kind, with its approval open. */
async function awaiting(kind: ApprovalKind = "proposal"): Promise<WorkItemRow> {
  const workItem = await workItemIn(kind === "design" ? "awaiting-design-approval" : "awaiting-proposal-approval");
  await openApproval(db.pool, { workItemId: workItem.id, taskToken: TOKEN, kind });
  return workItem;
}

async function approvals(workItem: WorkItemRow): Promise<Pick<ApprovalRow, "kind" | "state" | "taskToken" | "resolvedBy">[]> {
  const { rows } = await db.pool.query<{ kind: ApprovalKind; state: "open" | "closed"; task_token: string; resolved_by: string | null }>(
    "SELECT kind, state, task_token, resolved_by FROM approvals WHERE work_item_id = $1 ORDER BY id",
    [workItem.id],
  );
  return rows.map((row) => ({ kind: row.kind, state: row.state, taskToken: row.task_token, resolvedBy: row.resolved_by }));
}

const replies = (issue = ISSUE): string[] => forge.comments.filter((c) => c.issueNumber === issue).map((c) => c.body);

async function stateOf(): Promise<string | undefined> {
  return (await findWorkItemByIssue(db.pool, TARGET.repository, ISSUE))?.state;
}

describe("handleCommand: whose comment it acts on", () => {
  it("Scenario: Command task checks the comment's author and issue", async () => {
    const workItem = await awaiting();

    // Another user's /approve.
    await expect(command("/approve", { author: "someone-else" })).rejects.toBeInstanceOf(InvalidCommand);
    // The owner's /approve, but on another issue than the task was started for.
    await expect(command("/approve", { issue: BARE_ISSUE }, ISSUE)).rejects.toBeInstanceOf(InvalidCommand);

    expect(forge.comments).toEqual([]);
    expect(taskTokens.successes).toEqual([]);
    expect(await approvals(workItem)).toEqual([expect.objectContaining({ state: "open", resolvedBy: null })]);
    expect(await stateOf()).toBe("awaiting-proposal-approval");
  });

  it("refuses a comment that is not a command, and a comment that does not exist", async () => {
    const workItem = await awaiting();

    await expect(command("Looks good to me, thanks.")).rejects.toBeInstanceOf(InvalidCommand);
    await expect(command("As discussed:\n/approve")).rejects.toBeInstanceOf(InvalidCommand);
    await expect(handleCommand(context(), ISSUE, 404)).rejects.toBeInstanceOf(InvalidCommand);

    expect(forge.comments).toEqual([]);
    expect(taskTokens.successes).toEqual([]);
    expect(await approvals(workItem)).toEqual([expect.objectContaining({ state: "open" })]);
  });

  it("compares the author with the target's owner ignoring case, as GitHub logins are", async () => {
    await awaiting();

    const outcome = await command("/approve", { author: OWNER.toUpperCase() });

    expect(outcome.outcome).toBe("applied");
    expect(taskTokens.successes).toHaveLength(1);
  });
});

describe("handleCommand: /approve", () => {
  it("Scenario: Owner's approval resumes the execution", async () => {
    const workItem = await awaiting();

    const outcome = await command("/approve");

    expect(outcome).toMatchObject({ outcome: "applied", command: { verb: "approve" } });
    expect(taskTokens.successes.map((success) => success.taskToken)).toEqual([TOKEN]);
    expect(await approvals(workItem)).toEqual([{ kind: "proposal", state: "closed", taskToken: TOKEN, resolvedBy: OWNER }]);
    // Approved, which the resumed execution runs next, confirms the proposal approval: the one reply.
    expect(forge.comments).toEqual([]);
  });

  it("confirms a design approval itself, naming the design", async () => {
    const workItem = await awaiting("design");

    const outcome = await command("/approve");

    expect(outcome.outcome).toBe("applied");
    expect(taskTokens.successes.map((success) => success.taskToken)).toEqual([TOKEN]);
    expect(await approvals(workItem)).toEqual([expect.objectContaining({ kind: "design", state: "closed", resolvedBy: OWNER })]);
    expect(replies()).toHaveLength(1);
    expect(replies()[0]).toContain(CHANGE_ID);
    expect(replies()[0]).toMatch(/\bdesign\b.*\bapproved\b/i);
  });

  it("Scenario: Approval with nothing awaiting is answered", async () => {
    // Awaiting by its state, but the approval is not open (a second /approve, say).
    await workItemIn("awaiting-proposal-approval");

    const outcome = await command("/approve");

    expect(outcome.outcome).toBe("refused");
    expect(taskTokens.successes).toEqual([]);
    expect(replies()).toHaveLength(1);
    expect(replies()[0]).toMatch(/nothing awaits approval/i);
    expect(replies()[0]).toContain("`awaiting-proposal-approval`");

    // An issue with no work item is answered too.
    const bare = await command("/approve", { issue: BARE_ISSUE });

    expect(bare).toMatchObject({ outcome: "refused", workItem: undefined });
    expect(replies(BARE_ISSUE)).toHaveLength(1);
    expect(replies(BARE_ISSUE)[0]).toMatch(/nothing awaits approval/i);
    expect(replies(BARE_ISSUE)[0]).toMatch(/no (factory )?work item/i);
  });

  it("Scenario: Approval during the build is answered", async () => {
    await workItemIn("build");

    const outcome = await command("/approve");

    expect(outcome.outcome).toBe("refused");
    expect(taskTokens.successes).toEqual([]);
    expect(replies()).toHaveLength(1);
    expect(replies()[0]).toMatch(/nothing awaits approval/i);
    expect(replies()[0]).toContain("`build`");
    expect(await stateOf()).toBe("build");
  });

  it("answers an /approve on an escalated work item that nothing awaits approval, naming the state", async () => {
    await workItemIn("escalated");

    const outcome = await command("/approve");

    expect(outcome.outcome).toBe("refused");
    expect(taskTokens.successes).toEqual([]);
    expect(replies()).toEqual([expect.stringMatching(/nothing awaits approval/i)]);
    expect(replies()[0]).toContain("`escalated`");
  });

  it("Scenario: Approval with the pull request open is answered", async () => {
    await workItemIn("pr-open");
    forge.setBranch(CHANGE_ID, "1111111111111111111111111111111111111111");
    const pr = await forge.openPullRequest({ head: CHANGE_ID, base: "master", title: `${CHANGE_ID}: Import Kindle vocab.db`, body: "Closes #12" });

    const outcome = await command("/approve");

    expect(outcome.outcome).toBe("refused");
    expect(taskTokens.successes).toEqual([]);
    expect(replies()).toHaveLength(1);
    expect(replies()[0]).toMatch(/pull request is open for review/i);
    expect(replies()[0]).toContain(pr.url);
    expect(await stateOf()).toBe("pr-open");
  });

  it("Scenario: Failed resume is reported on the issue", async () => {
    const workItem = await awaiting();
    taskTokens.failNextSuccess = new Error("ThrottlingException: Rate exceeded");

    const outcome = await command("/approve");

    expect(outcome.outcome).not.toBe("applied");
    expect(outcome.error).toBeInstanceOf(Error);
    expect(await approvals(workItem)).toEqual([{ kind: "proposal", state: "open", taskToken: TOKEN, resolvedBy: null }]);
    expect(replies()).toHaveLength(1);
    expect(replies()[0]).toMatch(/did not go through/i);
    expect(replies()[0]).toMatch(/\bproposal\b/);
    expect(replies()[0]).toMatch(/`\/approve`/);
    expect(replies()[0]).not.toContain("Throttling");
    expect(await stateOf()).toBe("awaiting-proposal-approval");

    // The owner sends it again, and it goes through.
    expect((await command("/approve")).outcome).toBe("applied");
    expect(taskTokens.successes.map((success) => success.taskToken)).toEqual([TOKEN]);
  });
});

describe("handleCommand: commands that arrive while a role runs", () => {
  it("Scenario: Command while a role runs gets the busy reply", async () => {
    const workItem = await workItemIn("proposal");

    const outcome = await command("/approve");

    expect(outcome.outcome).toBe("busy");
    expect(replies()).toHaveLength(1);
    const [reply] = replies();
    expect(reply).toContain("`proposal` is running, so your `/approve` was not applied and is not kept.");
    expect(reply).toMatch(/send it again when the factory asks for your approval/i);
    // It quotes the command's first line, so the owner sees which comment it means.
    expect(reply).toMatch(/`\/approve`/);

    // The proposal later comes to await approval; the busy /approve is not applied then.
    await setWorkItemState(db.pool, workItem.id, "awaiting-proposal-approval", { from: "proposal" });
    await openApproval(db.pool, { workItemId: workItem.id, taskToken: TOKEN });

    expect(taskTokens.successes).toEqual([]);
    expect(await stateOf()).toBe("awaiting-proposal-approval");
    expect(await findOpenApproval(db.pool, workItem.id)).toMatchObject({ state: "open", taskToken: TOKEN });
    expect(replies()).toHaveLength(1);
  });

  it.each(BUSY_STATES.flatMap((state) => ["approve", "revise", "question"].map((verb) => [verb, state] as const)))(
    "answers /%s in %s with the busy reply",
    async (verb, state) => {
      await workItemIn(state);

      const outcome = await command(`/${verb} please`);

      expect(outcome.outcome).toBe("busy");
      expect(taskTokens.successes).toEqual([]);
      expect(replies()).toHaveLength(1);
      expect(replies()[0]).toContain(`\`${state}\` is running, so your \`/${verb}\` was not applied and is not kept.`);
      expect(replies()[0]).toContain(`\`/${verb} please\``);
      expect(await stateOf()).toBe(state);
    },
  );

  it("quotes at most 200 characters of the first line, and never a later line", async () => {
    await workItemIn("design");
    const firstLine = `/revise ${"x".repeat(300)}`;

    await command(`${firstLine}\nThe second line stays out of the reply.`);

    const [reply = ""] = replies();
    expect(reply).toContain(firstLine.slice(0, 200));
    expect(reply).not.toContain(firstLine.slice(0, 201));
    expect(reply).not.toContain("second line");
  });

  it("quotes a first line holding backticks as inline code that still renders", async () => {
    await workItemIn("plan");

    await command("/question why `node:sqlite`?");

    expect(replies()[0]).toContain("`` /question why `node:sqlite`? ``");
  });
});

describe("handleCommand: unknown commands", () => {
  it("Scenario: Unknown command gets the help text", async () => {
    const workItem = await awaiting();

    const outcome = await command("/aprove");

    expect(outcome).toMatchObject({ outcome: "unknown", command: { verb: "unknown", written: "aprove" } });
    expect(replies()).toHaveLength(1);
    const [reply = ""] = replies();
    expect(reply).toContain("`/aprove`");
    expect(reply).toMatch(/unknown command/i);
    for (const verb of KNOWN_VERBS) expect(reply).toContain(`\`/${verb}\``);
    expect(taskTokens.successes).toEqual([]);
    expect(await approvals(workItem)).toEqual([expect.objectContaining({ state: "open" })]);
  });

  it.each([...ALL_STATES, undefined])("answers an unknown verb in %s with the help text", async (state) => {
    if (state !== undefined) await workItemIn(state);

    const outcome = await command("/Approve");

    expect(outcome.outcome).toBe("unknown");
    expect(replies()).toEqual([expect.stringMatching(/unknown command/i)]);
    expect(replies()[0]).toContain("`/Approve`");
  });
});

/** Gives an attempt an estimated cost, as the recorder does from the session's result. */
async function setCost(attemptId: string, usd: number): Promise<void> {
  await db.pool.query("UPDATE attempts SET cost_usd_estimate = $2, auth_mode = 'api-key' WHERE id = $1", [attemptId, usd]);
}

const TASK_TITLES = ["Parse the lookups", "Parse the books", "Merge duplicate lookups", "Count the lookups", "Export to CSV"];

describe("/status", () => {
  it("Scenario: Status while awaiting approval", async () => {
    const workItem = await awaiting();
    const attempt = await openAttempt(db.pool, { workItemId: workItem.id, state: "proposal", role: "proposal-author" });
    await closeAttempt(db.pool, attempt.id, { outcome: "succeeded", result: {} });
    await setCost(attempt.id, 0.8);

    const outcome = await command("/status");

    expect(outcome.outcome).toBe("applied");
    expect(replies()).toHaveLength(1);
    const [reply = ""] = replies();
    expect(reply).toContain(CHANGE_ID);
    expect(reply).toContain("`awaiting-proposal-approval`");
    expect(reply).toMatch(/\b1 attempt\b/);
    expect(reply).toContain("$0.80");
    expect(reply).toMatch(/waits for your approval of the proposal/i);
    // Nothing changes but the reply.
    expect(taskTokens.successes).toEqual([]);
    expect(await approvals(workItem)).toEqual([expect.objectContaining({ state: "open" })]);
    expect(await stateOf()).toBe("awaiting-proposal-approval");
  });

  it("Scenario: Status during the build", async () => {
    const workItem = await workItemIn("build");
    const planner = await openAttempt(db.pool, { workItemId: workItem.id, state: "plan", role: "planner" });
    await closeAttempt(db.pool, planner.id, { outcome: "succeeded", result: {} });
    await setCost(planner.id, 0.5);
    await storePlan(db.pool, {
      workItemId: workItem.id,
      planAttemptId: planner.id,
      tasks: TASK_TITLES.map((title, index) => ({ id: `1.${String(index + 1)}`, title, dependsOn: [], files: [], scenarios: [], tests: [] })),
    });
    for (const [taskId, sha] of [
      ["1.1", "1".repeat(40)],
      ["1.2", "2".repeat(40)],
    ] as const) {
      const build = await openAttempt(db.pool, { workItemId: workItem.id, state: "build", role: "implementer", taskId });
      await closeAttempt(db.pool, build.id, { outcome: "succeeded" });
      await setCost(build.id, 0.375);
      await markTaskDone(db.pool, workItem.id, taskId, sha);
    }

    const outcome = await command("/status");

    expect(outcome.outcome).toBe("applied");
    expect(replies()).toHaveLength(1);
    const [reply = ""] = replies();
    expect(reply).toContain("`build`");
    expect(reply).toContain("1.3");
    expect(reply).toContain("Merge duplicate lookups");
    expect(reply).toMatch(/\b2 of 5 tasks done\b/i);
    expect(reply).toMatch(/\b3 attempts\b/);
    expect(reply).toContain("$1.25");
    expect(reply).toMatch(/nothing waits for you/i);
  });

  it("Scenario: Status with no work item", async () => {
    const outcome = await command("/status", { issue: BARE_ISSUE });

    expect(outcome).toMatchObject({ outcome: "applied", workItem: undefined });
    expect(replies(BARE_ISSUE)).toHaveLength(1);
    const [reply = ""] = replies(BARE_ISSUE);
    expect(reply).toMatch(/no (factory )?work item/i);
    expect(reply).toMatch(/label(ling)? (it|the issue) `factory`/i);
  });

  it.each(ALL_STATES)("answers in %s, saying what the factory waits for", async (state) => {
    await workItemIn(state);

    const outcome = await command("/status");

    expect(outcome.outcome).toBe("applied");
    expect(replies()).toHaveLength(1);
    expect(replies()[0]).toContain(`\`${state}\``);
    expect(replies()[0]).toMatch(/\bwaits? for\b/i);
    expect(await stateOf()).toBe(state);
  });

  it("names what each state waits for", async () => {
    const waits: Record<string, RegExp> = {
      "awaiting-design-approval": /waits for your approval of the design/i,
      "pr-open": /waits for your review of the pull request/i,
      escalated: /waits for you/i,
      proposal: /nothing waits for you/i,
    };
    for (const [state, expected] of Object.entries(waits)) {
      await db.pool.query("TRUNCATE work_items, attempts, messages, events, approvals, tasks CASCADE");
      forge.comments.length = 0;
      await workItemIn(state);

      await command("/status");

      expect(replies()[0], state).toMatch(expected);
    }
  });
});

describe("/help", () => {
  it("Scenario: Help lists the commands", async () => {
    const outcome = await command("/help");

    expect(outcome.outcome).toBe("applied");
    expect(replies()).toHaveLength(1);
    const rows = (replies()[0] ?? "").split("\n").filter((line) => line.startsWith("| `/"));
    expect(rows.map((row) => /^\| `\/([a-z]+)/.exec(row)?.[1])).toEqual([...KNOWN_VERBS]);
    for (const row of rows) {
      // The command, when it applies and what it does: three cells, none empty.
      const cells = row.split("|").slice(1, -1).map((cell) => cell.trim());
      expect(cells, row).toHaveLength(3);
      for (const cell of cells) expect(cell, row).not.toBe("");
    }
  });

  it.each([...ALL_STATES, undefined])("answers in %s", async (state) => {
    if (state !== undefined) await workItemIn(state);

    expect((await command("/help")).outcome).toBe("applied");
    expect(replies()).toHaveLength(1);
    expect(replies()[0]).toContain("`/status`");
  });
});
