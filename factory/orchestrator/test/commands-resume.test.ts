/**
 * add-work-item-resume task 1.4: the command handler's `/abort`, `/resume` and closed-issue
 * branches (design, "Command handler: /abort and --closed" and "Command handler: /resume"), and the
 * replies on a stopped work item, with a FakeForge, fake Step Functions and ECS clients and the
 * real ledger.
 */
import { FakeForge } from "@ceh/factory-forge/testing";
import {
  createWorkItem,
  findOpenApproval,
  findWorkItemByIssue,
  listAttempts,
  listComments,
  markTaskDone,
  migrate,
  openApproval,
  openAttempt,
  closeAttempt,
  storePlan,
  type WorkItemRow,
} from "@ceh/factory-ledger";
import { createTestDatabase, type TestDatabase } from "@ceh/factory-ledger/testing";
import { loadRole, type Role } from "@ceh/factory-roles";
import { testTarget } from "@ceh/factory-target/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cloudApprover, cloudReviser, type TaskTokens } from "../src/approval.ts";
import { ABORT_ERROR } from "../src/commands/executions.ts";
import { handleCommand, handleIssueClosed, type CommandContext, type CommandOutcome } from "../src/commands/handle.ts";
import { localApprover, localReviser } from "../src/run.ts";
import { CLUSTER, event, EXECUTION, executionAlreadyExists, FakeEcsTasks, FakeExecutions, submitted, taskArn } from "./fake-executions.ts";

const TARGET = testTarget();
const OWNER = TARGET.owner;
const CHANGE_ID = "add-import-kindle-vocab-db";
const ISSUE = 12;
const BARE_ISSUE = 13;
const CLOSED_ISSUE = 14;
const TOKEN = "AQB8AAAAKgAAAAMAAAAAAAAAAeTaskToken";
const PLAN_TASK = taskArn("plan0123456789");
const BUILD_TASK = taskArn("build0123456789");

const RUNNING_STATES = ["intake", "proposal", "awaiting-proposal-approval", "proposal-approved", "design", "design-review", "awaiting-design-approval", "plan", "build"] as const;

class NoTaskTokens implements TaskTokens {
  succeed(): Promise<void> {
    return Promise.reject(new Error("no task token in these tests"));
  }
  fail(): Promise<void> {
    return Promise.resolve();
  }
}

let db: TestDatabase;
let forge: FakeForge;
let executions: FakeExecutions;
let ecsTasks: FakeEcsTasks;
let roles: { proposalAuthor: Role; architect: Role };

beforeAll(async () => {
  roles = { proposalAuthor: await loadRole("proposal-author", TARGET), architect: await loadRole("architect", TARGET) };
  db = await createTestDatabase("commands_resume");
  await migrate(db.pool);
  return () => db.close();
});

beforeEach(() => {
  forge = new FakeForge({
    issues: [
      { number: ISSUE, title: "Import Kindle vocab.db", body: "Import the lookups." },
      { number: BARE_ISSUE, title: "Something else", body: "x" },
      { number: CLOSED_ISSUE, title: "Closed one", body: "x", state: "closed" },
    ],
  });
  executions = new FakeExecutions();
  ecsTasks = new FakeEcsTasks();
});

afterEach(async () => {
  await db.pool.query("TRUNCATE work_items, attempts, messages, events, approvals, tasks, comments CASCADE");
});

function context(overrides: Partial<CommandContext> = {}, local = false): CommandContext {
  const base = { db: db.pool, forge, target: TARGET };
  const taskTokens = new NoTaskTokens();
  return {
    ...base,
    approve: cloudApprover({ ...base, taskTokens }),
    revise: cloudReviser({ ...base, taskTokens }),
    question: { runRole: () => Promise.reject(new Error("no session in these tests")), proposalAuthor: roles.proposalAuthor, architect: roles.architect },
    // `pnpm factory command` has no Step Functions or ECS client.
    ...(local ? {} : { executions, ecsTasks }),
    ...overrides,
  };
}

/** The owner's command, seeded on the forge and handled as the `command` task would. */
async function command(body: string, issue = ISSUE, overrides: Partial<CommandContext> = {}, local = false): Promise<CommandOutcome & { commentId: number }> {
  const { id } = forge.addComment({ issueNumber: issue, author: OWNER, body });
  return { ...(await handleCommand(context(overrides, local), issue, id)), commentId: id };
}

async function workItemIn(state: string, options: { issue?: number; executionArn?: string | null } = {}): Promise<WorkItemRow> {
  const executionArn = options.executionArn === undefined ? EXECUTION : options.executionArn;
  return createWorkItem(db.pool, {
    repository: TARGET.repository,
    issueNumber: options.issue ?? ISSUE,
    changeId: CHANGE_ID,
    branch: CHANGE_ID,
    state,
    ...(executionArn === null ? {} : { executionArn }),
  });
}

/** A stopped work item, as an abort or an escalation leaves it. */
async function stoppedIn(state: "aborted" | "escalated", stopped: string, options: { issue?: number; executionArn?: string | null } = {}): Promise<WorkItemRow> {
  const workItem = await workItemIn(stopped, options);
  await db.pool.query("UPDATE work_items SET state = $2, stopped_in = $3 WHERE id = $1", [workItem.id, state, stopped]);
  executions.statuses.set(EXECUTION, state === "aborted" ? "ABORTED" : "FAILED");
  return (await findWorkItemByIssue(db.pool, TARGET.repository, options.issue ?? ISSUE)) ?? workItem;
}

const replies = (issue = ISSUE): string[] => forge.comments.filter((c) => c.issueNumber === issue).map((c) => c.body);
const current = async (issue = ISSUE) => findWorkItemByIssue(db.pool, TARGET.repository, issue);

/** A two-task plan with 1.1 done and an implementer attempt open for 1.2. */
async function buildingTask12(workItem: WorkItemRow): Promise<string> {
  const planner = await openAttempt(db.pool, { workItemId: workItem.id, state: "plan", role: "planner" });
  await closeAttempt(db.pool, planner.id, { outcome: "succeeded", result: {} });
  await storePlan(db.pool, {
    workItemId: workItem.id,
    planAttemptId: planner.id,
    tasks: ["1.1", "1.2", "1.3"].map((id) => ({ id, title: `Task ${id}`, dependsOn: [], files: [], scenarios: [], tests: [] })),
  });
  await markTaskDone(db.pool, workItem.id, "1.1", "1".repeat(40));
  const attempt = await openAttempt(db.pool, { workItemId: workItem.id, state: "build", role: "implementer", taskId: "1.2" });
  return attempt.id;
}

describe("/abort", () => {
  it("Scenario: Abort during the build stops the execution", async () => {
    const workItem = await workItemIn("build");
    const attemptId = await buildingTask12(workItem);
    // The build Map's task for 1.2 runs; Step Functions stops a `.sync` task itself, and the abort's StopTask repeats it.
    executions.histories.set(EXECUTION, [event("TaskStarted"), submitted(BUILD_TASK), event("TaskScheduled"), event("TaskSucceeded"), submitted(taskArn("step0123"))]);

    const outcome = await command("/abort the plan is wrong");

    expect(outcome.outcome).toBe("applied");
    expect(executions.stops).toEqual([{ executionArn: EXECUTION, error: ABORT_ERROR, cause: expect.stringContaining(String(outcome.commentId)) as unknown }]);
    expect(executions.stops[0]?.cause).not.toContain("the plan is wrong");
    expect(ecsTasks.stops).toEqual([{ cluster: CLUSTER, taskArn: BUILD_TASK, reason: expect.stringContaining(String(outcome.commentId)) as unknown }]);
    const attempt = (await listAttempts(db.pool, workItem.id)).find((row) => row.id === attemptId);
    expect(attempt).toMatchObject({ outcome: "aborted", failureReason: null });
    expect(await current()).toMatchObject({ state: "aborted", stoppedIn: "build", executionArn: EXECUTION });
    expect(replies()).toHaveLength(1);
    expect(replies()[0]).toMatch(/aborted/i);
    expect(replies()[0]).toContain("`/resume`");
    expect((await listComments(db.pool, workItem.id)).map((row) => [row.verb, row.outcome, row.stateMet])).toEqual([["abort", "applied", "build"]]);
  });

  it("Scenario: Abort during Plan stops its task", async () => {
    const workItem = await workItemIn("plan");
    const planner = await openAttempt(db.pool, { workItemId: workItem.id, state: "plan", role: "planner" });
    // Plan is a waitForTaskToken task: StopExecution leaves it running, so the abort stops it.
    executions.histories.set(EXECUTION, [event("TaskStarted"), submitted(PLAN_TASK), event("TaskScheduled"), event("TaskSucceeded"), submitted(taskArn("design0123"))]);

    const outcome = await command("/abort");

    expect(outcome.outcome).toBe("applied");
    expect(executions.stops.map((stop) => stop.executionArn)).toEqual([EXECUTION]);
    expect(ecsTasks.stops).toEqual([{ cluster: CLUSTER, taskArn: PLAN_TASK, reason: expect.stringContaining(String(outcome.commentId)) as unknown }]);
    expect((await listAttempts(db.pool, workItem.id)).find((row) => row.id === planner.id)?.outcome).toBe("aborted");
    expect(await current()).toMatchObject({ state: "aborted", stoppedIn: "plan" });
    expect(replies()).toEqual([expect.stringContaining("`/resume`")]);
  });

  it("Scenario: Abort while awaiting approval closes the approval", async () => {
    const workItem = await workItemIn("awaiting-proposal-approval");
    await openApproval(db.pool, { workItemId: workItem.id, taskToken: TOKEN });

    const outcome = await command("/abort");

    expect(outcome.outcome).toBe("applied");
    expect(executions.stops.map((stop) => stop.executionArn)).toEqual([EXECUTION]);
    expect(await findOpenApproval(db.pool, workItem.id)).toBeUndefined();
    const { rows } = await db.pool.query<{ outcome: string; state: string }>("SELECT outcome, state FROM approvals WHERE work_item_id = $1", [workItem.id]);
    expect(rows).toEqual([{ outcome: "aborted", state: "closed" }]);
    expect(await current()).toMatchObject({ state: "aborted", stoppedIn: "awaiting-proposal-approval" });
    expect(replies()).toHaveLength(1);
  });

  it.each(["aborted", "escalated", "pr-open", undefined] as const)("Scenario: Abort with nothing running is answered (%s)", async (state) => {
    const issue = state === undefined ? BARE_ISSUE : ISSUE;
    if (state === "aborted" || state === "escalated") await stoppedIn(state, "plan");
    else if (state === "pr-open") await workItemIn("pr-open");
    const before = await current(issue);

    const outcome = await command("/abort", issue);

    expect(outcome.outcome).toBe("refused");
    expect(executions.stops).toEqual([]);
    expect(ecsTasks.stops).toEqual([]);
    expect(replies(issue)).toHaveLength(1);
    expect(replies(issue)[0]).toMatch(/nothing runs/i);
    expect(await current(issue)).toEqual(before);
  });

  it("stops no task when the latest submitted task was closed in the history", async () => {
    await workItemIn("proposal-approved");
    // Approved's task ended; the next one was not submitted yet.
    executions.histories.set(EXECUTION, [event("TaskSucceeded"), event("TaskStarted"), submitted(taskArn("approved0123"))]);

    expect((await command("/abort")).outcome).toBe("applied");

    expect(executions.stops).toHaveLength(1);
    expect(ecsTasks.stops).toEqual([]);
    expect(await current()).toMatchObject({ state: "aborted", stoppedIn: "proposal-approved" });
  });

  it("marks a work item whose execution had already ended aborted, stopping nothing", async () => {
    const workItem = await workItemIn("plan");
    const planner = await openAttempt(db.pool, { workItemId: workItem.id, state: "plan", role: "planner" });
    executions.statuses.set(EXECUTION, "FAILED");
    executions.histories.set(EXECUTION, [submitted(PLAN_TASK)]);

    const outcome = await command("/abort");

    expect(outcome.outcome).toBe("applied");
    expect(executions.described).toEqual([EXECUTION]);
    expect(executions.stops).toEqual([]);
    expect(ecsTasks.stops).toEqual([]);
    expect((await listAttempts(db.pool, workItem.id)).find((row) => row.id === planner.id)?.outcome).toBe("aborted");
    expect(await current()).toMatchObject({ state: "aborted", stoppedIn: "plan" });
    expect(replies()).toEqual([expect.stringContaining("`/resume`")]);
  });

  it("logs a failed StopTask and goes on with the abort", async () => {
    await workItemIn("plan");
    executions.histories.set(EXECUTION, [submitted(PLAN_TASK)]);
    const failure = new Error("AccessDeniedException: not authorized to perform ecs:StopTask");
    ecsTasks.failNextStop = failure;

    const outcome = await command("/abort");

    expect(outcome.outcome).toBe("applied");
    expect(outcome.stopTaskError).toBe(failure);
    expect(await current()).toMatchObject({ state: "aborted", stoppedIn: "plan" });
    expect(replies()).toHaveLength(1);
    expect(replies()[0]).not.toContain("AccessDenied");
  });
});

describe("/resume", () => {
  it("Scenario: Resume starts a new execution", async () => {
    const before = await stoppedIn("aborted", "build");

    const outcome = await command("/resume Treat an empty title as \"Untitled\"");

    expect(outcome.outcome).toBe("applied");
    expect(executions.described).toEqual([EXECUTION]);
    expect(executions.starts).toEqual([{ name: `issue-${String(ISSUE)}-resume-${String(outcome.commentId)}`, input: expect.any(String) as unknown }]);
    expect(JSON.parse(executions.starts[0]?.input ?? "null")).toEqual({ issueNumber: ISSUE, resume: true });
    expect(replies()).toHaveLength(1);
    expect(replies()[0]).toMatch(/resum/i);
    // Adopt stores the new execution's ARN, not the command: a start that never ran can be repeated.
    expect(await current()).toEqual(before);
    expect((await listComments(db.pool, before.id)).map((row) => [row.verb, row.outcome, row.stateMet])).toEqual([["resume", "applied", "aborted"]]);
  });

  it("resumes an escalated work item, and one whose execution failed outside the factory", async () => {
    await stoppedIn("escalated", "plan");

    expect((await command("/resume")).outcome).toBe("applied");
    expect(executions.starts).toHaveLength(1);

    await db.pool.query("UPDATE work_items SET state = 'plan', stopped_in = NULL");
    executions.statuses.set(EXECUTION, "ABORTED");
    expect((await command("/resume")).outcome).toBe("applied");
    expect(executions.starts).toHaveLength(2);
  });

  it("counts a start whose name is taken already as started", async () => {
    await stoppedIn("aborted", "design");
    executions.failNextStart = executionAlreadyExists();

    const outcome = await command("/resume");

    expect(outcome.outcome).toBe("applied");
    expect(replies()).toEqual([expect.stringMatching(/resum/i)]);
  });

  it("Scenario: Resume while running is answered", async () => {
    await workItemIn("plan");

    const outcome = await command("/resume");

    expect(outcome.outcome).toBe("refused");
    expect(executions.starts).toEqual([]);
    expect(replies()).toHaveLength(1);
    expect(replies()[0]).toMatch(/running/i);
  });

  it("Scenario: Resume on a closed issue is refused", async () => {
    await stoppedIn("aborted", "design", { issue: CLOSED_ISSUE });

    const outcome = await command("/resume", CLOSED_ISSUE);

    expect(outcome.outcome).toBe("refused");
    expect(executions.starts).toEqual([]);
    expect(replies(CLOSED_ISSUE)).toHaveLength(1);
    expect(replies(CLOSED_ISSUE)[0]).toMatch(/reopen/i);
  });

  it("Scenario: Resume with the pull request open is answered", async () => {
    await workItemIn("pr-open");
    executions.statuses.set(EXECUTION, "SUCCEEDED");

    const outcome = await command("/resume");

    expect(outcome.outcome).toBe("refused");
    expect(executions.starts).toEqual([]);
    expect(replies()).toHaveLength(1);
    expect(replies()[0]).toMatch(/pull request is open/i);
  });

  it("Scenario: Resume with no work item is answered", async () => {
    const outcome = await command("/resume", BARE_ISSUE);

    expect(outcome.outcome).toBe("refused");
    expect(executions.starts).toEqual([]);
    expect(replies(BARE_ISSUE)).toHaveLength(1);
    expect(replies(BARE_ISSUE)[0]).toMatch(/no (factory )?work item/i);
    expect(replies(BARE_ISSUE)[0]).toMatch(/label(ling)? (it|the issue) `factory`/i);
  });
});

describe("replies on a stopped or building work item", () => {
  it("Scenario: Commands on a stopped work item point to resume", async () => {
    await stoppedIn("escalated", "build");

    const outcome = await command("/approve");

    expect(outcome.outcome).toBe("refused");
    expect(replies()).toHaveLength(1);
    expect(replies()[0]).toMatch(/nothing awaits approval/i);
    expect(replies()[0]).toContain("`/resume`");
    expect((await current())?.state).toBe("escalated");
  });

  it.each(["aborted", "escalated"] as const)("points /revise and /question on an %s work item to /resume", async (state) => {
    await stoppedIn(state, "awaiting-proposal-approval");

    for (const body of ["/revise Use SQLite.", "/question Why CSV?", "/approve"]) expect((await command(body)).outcome).toBe("refused");

    expect(replies()).toHaveLength(3);
    for (const reply of replies()) expect(reply).toContain("`/resume`");
  });

  it("Scenario: Revise during the build points to abort", async () => {
    await workItemIn("build");

    const revise = await command("/revise Use SQLite.");
    const question = await command("/question Why CSV?");

    expect([revise.outcome, question.outcome]).toEqual(["refused", "refused"]);
    for (const reply of replies()) {
      expect(reply).toMatch(/nothing awaits/i);
      expect(reply).toContain("`/abort`");
      expect(reply).toMatch(/new issue/i);
    }
    expect((await current())?.state).toBe("build");
  });

  it("names the stopped work item's /resume in /status, and /help has no command that is not yet available", async () => {
    await stoppedIn("aborted", "plan");

    await command("/status");
    await command("/help");

    expect(replies()[0]).toContain("`aborted`");
    expect(replies()[0]).toContain("`/resume`");
    expect(replies()[1]).not.toMatch(/not yet available/i);
  });
});

describe("local work items", () => {
  function localContext(): Partial<CommandContext> {
    const base = { db: db.pool, forge, target: TARGET };
    const local = { ...base, runRole: () => Promise.reject(new Error("no session")), role: roles.proposalAuthor, repo: "/nonexistent", architect: roles.architect } as unknown as Parameters<typeof localApprover>[0];
    return { approve: localApprover(local), revise: localReviser() };
  }

  it("Scenario: Local work item points to the run command", async () => {
    await stoppedIn("escalated", "plan", { executionArn: null });

    const outcome = await command("/resume", ISSUE, localContext(), true);

    expect(outcome.outcome).toBe("refused");
    expect(replies()).toHaveLength(1);
    expect(replies()[0]).toContain("pnpm factory run");
    expect((await current())?.state).toBe("escalated");
  });

  it("answers /abort on a local work item the same way, changing nothing", async () => {
    await workItemIn("plan", { executionArn: null });

    const outcome = await command("/abort", ISSUE, localContext(), true);

    expect(outcome.outcome).toBe("refused");
    expect(replies()).toEqual([expect.stringContaining("pnpm factory run")]);
    expect((await current())?.state).toBe("plan");
  });
});

describe("a closed issue (command --closed)", () => {
  it("stops a running work item as /abort does and comments once, recording no command", async () => {
    const workItem = await workItemIn("design");
    const architect = await openAttempt(db.pool, { workItemId: workItem.id, state: "design", role: "architect" });
    executions.histories.set(EXECUTION, [submitted(taskArn("design0123"))]);

    const outcome = await handleIssueClosed(context(), ISSUE);

    expect(outcome.outcome).toBe("aborted");
    expect(executions.stops).toEqual([{ executionArn: EXECUTION, error: ABORT_ERROR, cause: expect.stringMatching(/closed/i) as unknown }]);
    expect(ecsTasks.stops.map((stop) => stop.taskArn)).toEqual([taskArn("design0123")]);
    expect((await listAttempts(db.pool, workItem.id)).find((row) => row.id === architect.id)?.outcome).toBe("aborted");
    expect(await current()).toMatchObject({ state: "aborted", stoppedIn: "design" });
    expect(replies()).toHaveLength(1);
    expect(replies()[0]).toMatch(/closed/i);
    expect(replies()[0]).toContain("`/resume`");
    expect(await listComments(db.pool, workItem.id)).toEqual([]);
  });

  it.each(["aborted", "escalated", "pr-open", "local", undefined] as const)("does nothing for a work item that is not running (%s)", async (state) => {
    if (state === "aborted" || state === "escalated") await stoppedIn(state, "plan");
    else if (state === "pr-open") await workItemIn("pr-open");
    else if (state === "local") await workItemIn("plan", { executionArn: null });
    const before = await current();

    const outcome = await handleIssueClosed(context(), ISSUE);

    expect(outcome.outcome).toBe("nothing");
    expect(executions.stops).toEqual([]);
    expect(ecsTasks.stops).toEqual([]);
    expect(replies()).toEqual([]);
    expect(await current()).toEqual(before);
  });

  it.each(RUNNING_STATES)("aborts a work item in %s", async (state) => {
    await workItemIn(state);

    expect((await handleIssueClosed(context(), ISSUE)).outcome).toBe("aborted");
    expect(await current()).toMatchObject({ state: "aborted", stoppedIn: state });
  });
});
