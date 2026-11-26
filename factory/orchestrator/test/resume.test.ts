/**
 * add-work-item-resume tasks 1.6, 1.8 and 1.10: Adopt (`intake --resume`) and the entry states,
 * retry counts after an abort or a resume, and the `/resume` guidance reaching the next role. On
 * the work-item fixture (a temp remote, a FakeForge, the real ledger), with the command handler's
 * `/abort` and `/resume` against fake Step Functions and ECS clients.
 */
import { createWorkItem, findOpenApproval, findWorkItemByIssue, LedgerRecorder, listAttempts, listComments, markTaskDone, openAttempt, setWorkItemState, type WorkItemRow } from "@ceh/factory-ledger";
import { AttemptFailed, loadRole, type Role } from "@ceh/factory-roles";
import { testTarget } from "@ceh/factory-target/testing";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { approved, awaitApproval, cloudApprover, cloudReviser, type TaskTokens } from "../src/approval.ts";
import { handleCommand, type CommandContext, type CommandOutcome } from "../src/commands/handle.ts";
import { design } from "../src/design.ts";
import { changeFileReader } from "../src/git.ts";
import { adopt, intake, type Adoption } from "../src/intake.ts";
import { plan } from "../src/plan.ts";
import { proposal } from "../src/proposal.ts";
import { step } from "../src/step.ts";
import { COMMANDS_INSTRUCTION } from "../src/summary.ts";
import { buildTask, classified, CODE, codeFor, currentWorkItem, TESTS, testsFor, useBuildHarness } from "./build-harness.ts";
import { EXECUTION, FakeEcsTasks, FakeExecutions, NEW_EXECUTION } from "./fake-executions.ts";
import type { FakeBuildStep } from "./fake-build-runner.ts";
import { CHANGE_FILES, createFakeRoleRunner, type FakeStep } from "./fake-role-runner.ts";
import { BOT, ISSUE, plannedWorkItem, planPaths, planStep, proposedWorkItem, useWorkItemFixture } from "./work-item-fixture.ts";

const TARGET = testTarget();
const f = useWorkItemFixture("resume");
const builds = useBuildHarness(f);

const GREEN_OUTPUT = "AssertionError: expected [ 'cat' ] to deeply equal []";
const failedGreen = (): FakeBuildStep => ({ ...CODE, outcome: "failed", reason: "green", output: GREEN_OUTPUT });
const BUG = classified("bug", "parseLookups returns the fixture's words.");
const QUESTION = "The spec does not say what an empty title becomes.";
const GUIDANCE = 'Treat an empty title as "Untitled"';

/** A proposal with no delta spec: it fails strict validation. */
const NO_DELTA: FakeStep = { files: { "proposal.md": CHANGE_FILES.proposal } };
const VALID: FakeStep = { files: { "proposal.md": CHANGE_FILES.proposal, ".openspec.yaml": CHANGE_FILES.metadata, "specs/vocab-import/spec.md": CHANGE_FILES.spec } };
const DESIGN_STEP: FakeStep = {
  files: { "design.md": "# Design\n\n## Overview\n\nRead vocab.db with node:sqlite.\n" },
  result: { summary: "Read vocab.db with node:sqlite.", contracts: [], adrNeeded: [], openQuestions: [] },
};
const APPROVE_REVIEW: FakeStep = { result: { verdict: "approve", findings: [] } };
/** An attempt that fails whatever the worktree holds. */
const MAX_TURNS: FakeStep = { fail: new AttemptFailed("max-turns", "The session reached its turn limit.") };

class NoTaskTokens implements TaskTokens {
  succeed(): Promise<void> {
    return Promise.reject(new Error("no task token in these tests"));
  }
  fail(): Promise<void> {
    return Promise.resolve();
  }
}

let executions: FakeExecutions;
let roles: { proposalAuthor: Role; architect: Role; designReviewer: Role; planner: Role };

beforeAll(async () => {
  roles = {
    proposalAuthor: await loadRole("proposal-author", TARGET),
    architect: await loadRole("architect", TARGET),
    designReviewer: await loadRole("design-reviewer", TARGET),
    planner: await loadRole("planner", TARGET),
  };
});

beforeEach(() => {
  executions = new FakeExecutions();
});

const base = () => ({ db: f.db.pool, forge: f.forge, target: TARGET });

function commandContext(): CommandContext {
  const taskTokens = new NoTaskTokens();
  return {
    ...base(),
    approve: cloudApprover({ ...base(), taskTokens }),
    revise: cloudReviser({ ...base(), taskTokens }),
    question: { runRole: () => Promise.reject(new Error("no session")), proposalAuthor: roles.proposalAuthor, architect: roles.architect },
    executions,
    ecsTasks: new FakeEcsTasks(),
  };
}

/** The owner's command on the fixture's issue, as the `command` task handles it. */
async function owner(body: string): Promise<CommandOutcome & { commentId: number }> {
  const { id } = f.forge.addComment({ issueNumber: ISSUE.number, author: TARGET.owner, body });
  return { ...(await handleCommand(commandContext(), ISSUE.number, id)), commentId: id };
}

/** The work item, as a cloud execution's: it gets that execution's ARN. */
async function inTheCloud(workItem: WorkItemRow): Promise<WorkItemRow> {
  await f.db.pool.query("UPDATE work_items SET execution_arn = $2 WHERE id = $1", [workItem.id, EXECUTION]);
  return currentWorkItem(f);
}

async function abortNow(): Promise<void> {
  const outcome = await owner("/abort");
  expect(outcome.outcome).toBe("applied");
}

/** `/resume` once the execution has ended, then Adopt in the new execution. */
async function resume(text = ""): Promise<Adoption> {
  if (executions.statuses.get(EXECUTION) === undefined) executions.statuses.set(EXECUTION, "FAILED");
  const outcome = await owner(`/resume ${text}`.trim());
  expect(outcome.outcome).toBe("applied");
  return adopt(base(), { issueNumber: ISSUE.number, executionArn: NEW_EXECUTION });
}

function entered(adoption: Adoption): Extract<Adoption, { kind: "entered" }> {
  if (adoption.kind !== "entered") throw new Error(`not adopted: ${adoption.reason}`);
  return adoption;
}

function roleContext(steps: FakeStep[]) {
  const fake = createFakeRoleRunner(new LedgerRecorder(f.db.pool), steps);
  return { runRole: fake.runRole, calls: fake.calls };
}

async function approvedWorkItem(complexity: string): Promise<WorkItemRow> {
  const transition = await approved({ ...base(), readChangeFile: changeFileReader({ repo: f.repo, home: f.home }) }, await proposedWorkItem(f, complexity));
  if (transition.kind !== "advance") throw new Error(`approved did not advance: ${JSON.stringify(transition)}`);
  return transition.workItem;
}

describe("Adopt and the entry states", { timeout: 60_000 }, () => {
  it("Scenario: Resume at an approval asks again", async () => {
    const workItem = await inTheCloud(await proposedWorkItem(f, "medium"));
    await awaitApproval(base(), workItem, "token-1");
    await abortNow();

    const adoption = entered(await resume());

    expect(adoption).toMatchObject({ entry: "await-approval", tasks: [], workItem: { state: "awaiting-proposal-approval", executionArn: NEW_EXECUTION, stoppedIn: null } });
    await awaitApproval(base(), adoption.workItem, "token-2");
    const { rows } = await f.db.pool.query<{ task_token: string; state: string; outcome: string | null }>("SELECT task_token, state, outcome FROM approvals ORDER BY id");
    expect(rows).toEqual([
      { task_token: "token-1", state: "closed", outcome: "aborted" },
      { task_token: "token-2", state: "open", outcome: null },
    ]);
    expect(f.forge.comments.filter((comment) => comment.body.includes(COMMANDS_INSTRUCTION))).toHaveLength(2);
  });

  it("Scenario: Resume after approval asks for no second approval", async () => {
    const approvedItem = await inTheCloud(await approvedWorkItem("medium"));
    await setWorkItemState(f.db.pool, approvedItem.id, "design", { from: "proposal-approved" });
    await openAttempt(f.db.pool, { workItemId: approvedItem.id, state: "design", role: roles.architect.name });
    await abortNow();

    const adoption = entered(await resume());
    expect(adoption).toMatchObject({ entry: "design", workItem: { state: "design" } });
    const fake = roleContext([DESIGN_STEP, APPROVE_REVIEW]);
    const transition = await design({ ...base(), ...fake, architect: roles.architect, designReviewer: roles.designReviewer, repo: f.repo, home: f.home, committer: BOT }, adoption.workItem);

    expect(transition).toMatchObject({ kind: "advance", route: "plan", workItem: { state: "plan" } });
    expect(fake.calls.map((call) => call.role)).toEqual(["architect", "design-reviewer"]);
    expect(await findOpenApproval(f.db.pool, approvedItem.id)).toBeUndefined();
    expect((await f.db.pool.query("SELECT 1 FROM approvals")).rows).toEqual([]);
  });

  it("Scenario: Resume after an execution failed outside the factory", async () => {
    const approvedItem = await inTheCloud(await approvedWorkItem("small"));
    await setWorkItemState(f.db.pool, approvedItem.id, "plan", { from: "proposal-approved" });
    // The dead execution's planner attempt is still open; nothing aborted it.
    const dead = await openAttempt(f.db.pool, { workItemId: approvedItem.id, state: "plan", role: roles.planner.name });
    executions.statuses.set(EXECUTION, "ABORTED");

    const adoption = entered(await resume());

    expect(adoption).toMatchObject({ entry: "plan", tasks: [], workItem: { state: "plan", executionArn: NEW_EXECUTION } });
    expect((await listAttempts(f.db.pool, approvedItem.id)).find((attempt) => attempt.id === dead.id)?.outcome).toBe("aborted");
    const fake = roleContext([planStep()]);
    const transition = await plan({ ...base(), ...fake, planner: roles.planner, planPaths: await planPaths(), repo: f.repo, home: f.home, committer: BOT }, adoption.workItem);
    expect(transition).toMatchObject({ kind: "advance", workItem: { state: "build" }, tasks: ["1.1", "1.2"] });
    expect(fake.calls.map((call) => call.role)).toEqual(["planner"]);
  });

  it("Scenario: Resume during the build skips finished tasks", async () => {
    const workItem = await inTheCloud(await plannedWorkItem(f));
    await markTaskDone(f.db.pool, workItem.id, "1.1", "1".repeat(40));
    await abortNow();

    const adoption = entered(await resume());

    expect(adoption).toMatchObject({ entry: "build", tasks: ["1.2"], workItem: { state: "build" } });
    const h = builds.create([]);
    expect(await step(h.ctx, await currentWorkItem(f), "1.1")).toMatchObject({ kind: "done" });
    expect(h.build.calls).toEqual([]);
    expect(await step(h.ctx, await currentWorkItem(f), "1.2")).toMatchObject({ kind: "build" });
  });

  it("runs only the reviewer for a work item resumed in design-review", async () => {
    const workItem = await inTheCloud(await approvedWorkItem("medium"));
    // The owner aborts while the design reviewer's session runs.
    const first = roleContext([DESIGN_STEP, { ...APPROVE_REVIEW, during: abortNow }]);
    const designCtx = { ...base(), architect: roles.architect, designReviewer: roles.designReviewer, repo: f.repo, home: f.home, committer: BOT };
    await expect(design({ ...designCtx, ...first }, workItem)).rejects.toThrow();
    expect(await currentWorkItem(f)).toMatchObject({ state: "aborted", stoppedIn: "design-review" });

    const adoption = entered(await resume());

    expect(adoption).toMatchObject({ entry: "design", workItem: { state: "design-review" } });
    const second = roleContext([APPROVE_REVIEW]);
    expect(await design({ ...designCtx, ...second }, adoption.workItem)).toMatchObject({ kind: "advance", route: "plan" });
    expect(second.calls.map((call) => call.role)).toEqual(["design-reviewer"]);
  });

  it("ends a resume of a work item whose pull request is open, and of an issue with no work item", async () => {
    expect(await adopt(base(), { issueNumber: ISSUE.number, executionArn: NEW_EXECUTION })).toMatchObject({ kind: "ended" });

    await createWorkItem(f.db.pool, { repository: TARGET.repository, issueNumber: ISSUE.number, changeId: "add-x", branch: "add-x", state: "pr-open", executionArn: EXECUTION });
    expect(await adopt(base(), { issueNumber: ISSUE.number, executionArn: NEW_EXECUTION })).toMatchObject({ kind: "ended" });
    expect((await currentWorkItem(f)).executionArn).toBe(EXECUTION);
  });

  it("answers the same for a repeated Adopt of the same execution", async () => {
    const workItem = await inTheCloud(await plannedWorkItem(f));
    await abortNow();
    const first = entered(await resume());

    const again = entered(await adopt(base(), { issueNumber: ISSUE.number, executionArn: NEW_EXECUTION }));

    expect([again.entry, again.tasks, again.workItem.state]).toEqual([first.entry, first.tasks, first.workItem.state]);
    expect((await findWorkItemByIssue(f.db.pool, TARGET.repository, ISSUE.number))?.id).toBe(workItem.id);
  });
});

describe("retry counts", { timeout: 60_000 }, () => {
  it("Scenario: Aborted attempt does not count", async () => {
    const created = await intake(base(), { issueNumber: ISSUE.number });
    if (created.kind !== "advance") throw new Error("intake did not advance");
    const workItem = await inTheCloud(created.workItem);
    const proposalCtx = { ...base(), role: roles.proposalAuthor, repo: f.repo, home: f.home, committer: BOT };
    // One failed attempt, then the owner aborts during the second.
    const first = roleContext([NO_DELTA, { ...VALID, during: abortNow }]);
    await expect(proposal({ ...proposalCtx, ...first }, workItem)).rejects.toThrow();
    expect((await listAttempts(f.db.pool, workItem.id)).map((attempt) => attempt.outcome)).toEqual(["failed", "aborted"]);

    const adoption = entered(await resume());
    expect(adoption).toMatchObject({ entry: "proposal", workItem: { state: "proposal" } });
    const second = roleContext([MAX_TURNS, MAX_TURNS, VALID]);
    const transition = await proposal({ ...proposalCtx, ...second }, adoption.workItem);

    expect(second.calls).toHaveLength(2);
    expect(transition).toMatchObject({ kind: "escalate", workItem: { state: "escalated", stoppedIn: "proposal" } });
  });

  it("Scenario: Resumed escalation gets fresh retries", async () => {
    await inTheCloud(await plannedWorkItem(f));
    const before = builds.create([TESTS, failedGreen(), failedGreen(), failedGreen()], [BUG, BUG, BUG]);
    expect((await buildTask(f, before, "1.1")).at(-1)).toMatchObject({ kind: "escalate", workItem: { state: "escalated", stoppedIn: "build" } });

    expect(entered(await resume())).toMatchObject({ entry: "build", tasks: ["1.1", "1.2"] });
    const after = builds.create([failedGreen(), failedGreen(), failedGreen()], [BUG, BUG, BUG]);
    const results = await buildTask(f, after, "1.1");

    expect(after.build.calls.map((call) => call.next.role)).toEqual(["implementer", "implementer", "implementer"]);
    expect(results.at(-1)).toMatchObject({ kind: "escalate" });
  });

  it("Scenario: Escalation records where the work item stopped", async () => {
    const approvedItem = await approvedWorkItem("small");
    const invalid = planStep(undefined, { tasks: [] });
    const fake = roleContext([invalid, invalid, invalid]);

    const transition = await plan({ ...base(), ...fake, planner: roles.planner, planPaths: await planPaths(), repo: f.repo, home: f.home, committer: BOT }, approvedItem);

    expect(fake.calls).toHaveLength(3);
    expect(transition).toMatchObject({ kind: "escalate", workItem: { state: "escalated", stoppedIn: "plan" } });
  });

  it("gives a work item escalated for its design flaws a fresh design-flaw count on resume", async () => {
    const workItem = await inTheCloud(await plannedWorkItem(f));
    await f.db.pool.query("UPDATE work_items SET design_flaws = 2 WHERE id = $1", [workItem.id]);
    await setWorkItemState(f.db.pool, workItem.id, "escalated", { from: "build" });

    expect(entered(await resume()).workItem).toMatchObject({ state: "build", designFlaws: 0 });
  });

  it("keeps an aborted work item's design-flaw count on resume", async () => {
    const workItem = await inTheCloud(await plannedWorkItem(f));
    await f.db.pool.query("UPDATE work_items SET design_flaws = 1 WHERE id = $1", [workItem.id]);
    await abortNow();

    expect(entered(await resume()).workItem).toMatchObject({ state: "build", designFlaws: 1 });
  });
});

describe("the /resume guidance", { timeout: 60_000 }, () => {
  it("Scenario: Resume guidance reaches the next role", async () => {
    await inTheCloud(await plannedWorkItem(f));
    const before = builds.create([TESTS, failedGreen()], [classified("spec-ambiguity", QUESTION)]);
    expect((await buildTask(f, before, "1.1")).at(-1)).toMatchObject({ kind: "escalate" });

    entered(await resume(GUIDANCE));
    const resumeComment = (await listComments(f.db.pool, (await currentWorkItem(f)).id)).find((comment) => comment.verb === "resume");
    const books = testsFor("app/domain/test/books.test.ts", "app/domain/src/books.ts", "Books are imported");
    const after = builds.create([CODE, books, codeFor("app/domain/src/books.ts")]);
    expect((await buildTask(f, after, "1.1")).at(-1)).toMatchObject({ kind: "done" });
    expect((await buildTask(f, after, "1.2")).at(-1)).toMatchObject({ kind: "done" });

    const [implementer, ...next] = after.build.calls;
    expect(implementer?.next.role).toBe("implementer");
    expect(implementer?.input.ownerGuidance).toBe(GUIDANCE);
    expect(implementer?.input.evidence?.evidence).toContain(QUESTION);
    expect(next.map((call) => call.input.ownerGuidance)).toEqual([undefined, undefined]);
    // The attempt names the /resume it was given; the store, not the execution, holds the text.
    const attempts = (await listAttempts(f.db.pool, (await currentWorkItem(f)).id)).filter((attempt) => attempt.role === "implementer");
    expect(attempts.at(-2)?.commentIds).toEqual([resumeComment?.id]);
    expect(attempts.at(-1)?.commentIds).toEqual([]);
  });

  it("gives a worker role the /resume text on the first attempt after the resume only", async () => {
    const created = await intake(base(), { issueNumber: ISSUE.number });
    if (created.kind !== "advance") throw new Error("intake did not advance");
    await inTheCloud(created.workItem);
    await abortNow();

    const adoption = entered(await resume("Use SQLite, not CSV."));
    const fake = roleContext([NO_DELTA, VALID]);
    await proposal({ ...base(), ...fake, role: roles.proposalAuthor, repo: f.repo, home: f.home, committer: BOT }, adoption.workItem);

    expect(fake.calls.map((call) => call.item.ownerGuidance)).toEqual([{ text: "Use SQLite, not CSV." }, undefined]);
    const attempts = await listAttempts(f.db.pool, adoption.workItem.id);
    expect(attempts.map((attempt) => attempt.commentIds.length)).toEqual([1, 0]);
  });

  it("gives no guidance for a /resume without text", async () => {
    const workItem = await inTheCloud(await plannedWorkItem(f));
    await abortNow();
    entered(await resume());

    const h = builds.create([TESTS]);
    await step(h.ctx, await currentWorkItem(f), "1.1");
    await h.build.runBuild({ changeId: workItem.changeId, taskId: "1.1" });

    expect(h.build.calls[0]?.input.ownerGuidance).toBeUndefined();
  });
});
