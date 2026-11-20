/**
 * add-approval-feedback tasks 1.7 and 1.9 (and the handler half of 2.1): `/revise` and
 * `/question` while a proposal or a `large` design awaits approval, with a FakeForge on a real
 * remote, a fake TaskTokens, fake sessions and the real local ledger.
 */
import { writeFileSync } from "node:fs";
import {
  closeAttempt,
  createWorkItem,
  findOpenApproval,
  findWorkItemByIssue,
  LedgerRecorder,
  listAttempts,
  listComments,
  openAttempt,
  recordComment,
  workItemCost,
  type ApprovalRow,
  type WorkItemRow,
} from "@ceh/factory-ledger";
import { AttemptFailed, loadRole, renderPrompt, type Role, type RunRole } from "@ceh/factory-roles";
import { testTarget } from "@ceh/factory-target/testing";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { approved, awaitApproval, cloudApprover, cloudReviser, type TaskTokens } from "../src/approval.ts";
import { handleCommand, type CommandContext, type CommandOutcome } from "../src/commands/handle.ts";
import { design, type DesignContext } from "../src/design.ts";
import { changeFileReader } from "../src/git.ts";
import { intake } from "../src/intake.ts";
import { plan } from "../src/plan.ts";
import { proposal, type ProposalContext } from "../src/proposal.ts";
import { COMMANDS_INSTRUCTION } from "../src/summary.ts";
import { CHANGE_FILES, createFakeRoleRunner, validResult, type FakeCall, type FakeStep } from "./fake-role-runner.ts";
import { BOT, CHANGE, CHANGE_ID, git, ISSUE, planPaths, planStep, proposalStep, proposedWorkItem, remoteHead, SPEC, useWorkItemFixture } from "./work-item-fixture.ts";

const TARGET = testTarget();
const OWNER = TARGET.owner;
const TOKEN = "AQB8AAAAKgAAAAMAAAAAAAAAAeFirstToken";
const TOKEN_2 = "AQB8AAAAKgAAAAMAAAAAAAAAAeSecondToken";
const REVISE = "Use SQLite, not CSV, for the export";
const WHAT_CHANGED = "The export now writes SQLite instead of CSV.";
const REVISED_PROPOSAL = `${CHANGE_FILES.proposal}- Export the lookups to SQLite, not CSV.\n`;

const DESIGN_MD = ["# Design", "", "## Overview", "", "Read vocab.db with node:sqlite; the parser lives in the app package.", ""].join("\n");
const DESIGN_MD_2 = ["# Design", "", "## Overview", "", "Read vocab.db with node:sqlite; the parser lives in the domain package.", ""].join("\n");
const DESIGN_RESULT = { summary: "Read vocab.db with node:sqlite.", contracts: [], adrNeeded: [], openQuestions: [] };

const f = useWorkItemFixture("feedback");

class FakeTaskTokens implements TaskTokens {
  readonly successes: { taskToken: string; output: string }[] = [];
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

let proposalAuthor: Role;
let architect: Role;
let designReviewer: Role;
let planner: Role;
let taskTokens: FakeTaskTokens;

beforeAll(async () => {
  [proposalAuthor, architect, designReviewer, planner] = await Promise.all(["proposal-author", "architect", "design-reviewer", "planner"].map((name) => loadRole(name, TARGET))) as [Role, Role, Role, Role];
});

beforeEach(() => {
  taskTokens = new FakeTaskTokens();
});

const base = () => ({ db: f.db.pool, forge: f.forge, target: TARGET });

/** The fake runner's steps and calls, for one handler run. */
function fake(steps: FakeStep[]): { runRole: RunRole; calls: FakeCall[] } {
  return createFakeRoleRunner(new LedgerRecorder(f.db.pool), steps);
}

function commandContext(runRole: RunRole = fake([]).runRole): CommandContext {
  return {
    ...base(),
    approve: cloudApprover({ ...base(), taskTokens }),
    revise: cloudReviser({ ...base(), taskTokens }),
    question: { runRole, proposalAuthor, architect, home: f.root },
  };
}

/** Seeds the owner's comment on the forge and handles it as the `command` task would. */
async function command(body: string, runRole?: RunRole): Promise<CommandOutcome> {
  const { id } = f.forge.addComment({ issueNumber: ISSUE.number, author: OWNER, body });
  return handleCommand(commandContext(runRole), ISSUE.number, id);
}

function proposalContext(runRole: RunRole): ProposalContext {
  return { ...base(), runRole, role: proposalAuthor, repo: f.repo, home: f.home, committer: BOT };
}

function designContext(runRole: RunRole): DesignContext {
  return { ...base(), runRole, architect, designReviewer, repo: f.repo, home: f.home, committer: BOT };
}

const replies = (): string[] => f.forge.comments.filter((c) => c.issueNumber === ISSUE.number).map((c) => c.body);
const current = async (): Promise<WorkItemRow> => (await findWorkItemByIssue(f.db.pool, TARGET.repository, ISSUE.number)) as WorkItemRow;

async function approvals(workItem: WorkItemRow): Promise<Pick<ApprovalRow, "kind" | "state" | "taskToken" | "resolvedBy" | "outcome">[]> {
  const { rows } = await f.db.pool.query<{ kind: "proposal" | "design"; state: "open" | "closed"; task_token: string; resolved_by: string | null; outcome: "approved" | "revise" | null }>(
    "SELECT kind, state, task_token, resolved_by, outcome FROM approvals WHERE work_item_id = $1 ORDER BY id",
    [workItem.id],
  );
  return rows.map((row) => ({ kind: row.kind, state: row.state, taskToken: row.task_token, resolvedBy: row.resolved_by, outcome: row.outcome }));
}

/** A proposal of the given complexity, pushed, with its summary posted and its approval open. */
async function awaitingProposal(complexity = "small", token = TOKEN): Promise<WorkItemRow> {
  const workItem = await proposedWorkItem(f, complexity);
  await awaitApproval(base(), workItem, token);
  return workItem;
}

/** A `large` change's design, pushed, with its summary posted and its design approval open. */
async function awaitingDesign(): Promise<WorkItemRow> {
  const workItem = await proposedWorkItem(f, "large");
  const routed = await approved({ ...base(), readChangeFile: changeFileReader({ repo: f.repo, home: f.home }) }, workItem);
  if (routed.kind !== "advance") throw new Error("approved did not advance");
  const designed = await design(designContext(fake([{ files: { "design.md": DESIGN_MD }, result: DESIGN_RESULT }]).runRole), routed.workItem);
  if (designed.kind !== "advance") throw new Error("design did not advance");
  await awaitApproval(base(), designed.workItem, TOKEN, "design");
  return designed.workItem;
}

/** The proposal author's revision step: an edited proposal.md, and a result that says what changed. */
const revisedStep = (whatChanged: string | null = WHAT_CHANGED, complexity = "small"): FakeStep => ({
  files: { "proposal.md": REVISED_PROPOSAL },
  result: { ...validResult(CHANGE_ID), complexity, ...(whatChanged === null ? {} : { whatChanged }) },
});

const promptOf = (call: FakeCall | undefined): string => (call === undefined ? "" : (call.item.prompt ?? renderPrompt(call.evidence === undefined ? call.item : { ...call.item, evidence: call.evidence })));

/** A promise and the function that settles it, to hold a fake session open. */
function gate(): { wait: Promise<void>; open: () => void; started: Promise<void>; start: () => void } {
  const opened = Promise.withResolvers<undefined>();
  const begun = Promise.withResolvers<undefined>();
  return {
    wait: opened.promise,
    open: () => {
      opened.resolve(undefined);
    },
    started: begun.promise,
    start: () => {
      begun.resolve(undefined);
    },
  };
}

describe("/revise of a proposal", { timeout: 60_000 }, () => {
  it("Scenario: Revise sends the proposal back to its author", async () => {
    const workItem = await awaitingProposal();
    const before = remoteHead(f);

    const outcome = await command(`/revise ${REVISE}`);

    // The command: the approval closed as revised, the execution resumed with the decision only.
    expect(outcome.outcome).toBe("applied");
    expect(await approvals(workItem)).toEqual([{ kind: "proposal", state: "closed", taskToken: TOKEN, resolvedBy: OWNER, outcome: "revise" }]);
    expect(taskTokens.successes).toEqual([{ taskToken: TOKEN, output: JSON.stringify({ decision: "revise" }) }]);
    expect(taskTokens.successes[0]?.output).not.toContain("SQLite");
    expect((await current()).state).toBe("proposal");
    expect(replies().at(-1)).toMatch(/proposal author/i);
    expect(replies().at(-1)).toMatch(/approval again/i);

    // Proposal runs again: attempt 2, with the comment in its prompt.
    const runner = fake([revisedStep()]);
    const transition = await proposal(proposalContext(runner.runRole), await current());

    expect(transition).toMatchObject({ kind: "advance", workItem: { state: "awaiting-proposal-approval" } });
    expect(runner.calls).toHaveLength(1);
    expect(promptOf(runner.calls[0])).toContain(REVISE);
    expect((await listAttempts(f.db.pool, workItem.id)).filter((a) => a.state === "proposal").map((a) => [a.n, a.outcome])).toEqual([
      [1, "succeeded"],
      [2, "succeeded"],
    ]);
    // A new commit on the branch.
    const head = remoteHead(f);
    expect(head).not.toBe(before);
    expect(git(f.remote, "log", "-1", "--format=%s", head)).toBe(`docs(${CHANGE_ID}): revise the proposal`);
    expect(git(f.remote, "show", `${head}:${CHANGE}/proposal.md`)).toContain("SQLite, not CSV");

    // AwaitApproval again: a new approval, and the summary with what changed.
    await awaitApproval(base(), await current(), TOKEN_2);
    expect(await findOpenApproval(f.db.pool, workItem.id)).toMatchObject({ state: "open", taskToken: TOKEN_2 });
    const summary = replies().at(-1) ?? "";
    expect(summary).toMatch(/^### What changed$/m);
    expect(summary).toContain(WHAT_CHANGED);
    expect(summary.trim().split("\n\n").at(-1)).toBe(COMMANDS_INSTRUCTION);
  });

  it("Scenario: Revised proposal keeps the owner's branch edits", async () => {
    const workItem = await awaitingProposal();
    // The owner pushes an edit to proposal.md on the work item's branch.
    const owner = `${f.root}/owner-clone`;
    git(f.root, "clone", "--quiet", "--branch", CHANGE_ID, f.remote, owner);
    const edited = `${CHANGE_FILES.proposal}- The owner's own line.\n`;
    writeFileSync(`${owner}/${CHANGE}/proposal.md`, edited);
    git(owner, "commit", "--quiet", "-am", "Owner edit");
    git(owner, "push", "--quiet", "origin", CHANGE_ID);
    const ownerCommit = remoteHead(f);

    await command("/revise Add a scenario for an empty vocab.db.");
    // The revision touches only the delta spec.
    const spec = `${SPEC}\n### Requirement: Empty files are accepted\nThe importer SHALL accept a vocab.db without lookups.\n\n#### Scenario: Empty vocab.db\n- **WHEN** the owner uploads a vocab.db with no lookups\n- **THEN** nothing is stored and no error is shown\n`;
    const runner = fake([{ files: { "specs/vocab-import/spec.md": spec }, result: { ...validResult(CHANGE_ID), whatChanged: "Added the empty-file scenario." } }]);
    await proposal(proposalContext(runner.runRole), await current());

    // The author started from the owner's commit, and the edit survived the revision.
    expect(runner.calls[0]?.item.changeFiles.find((file) => file.path === `${CHANGE}/proposal.md`)?.content).toBe(edited);
    const head = remoteHead(f);
    expect(git(f.remote, "rev-parse", `${head}~1`)).toBe(ownerCommit);
    expect(git(f.remote, "show", `${head}:${CHANGE}/proposal.md`)).toBe(edited.trimEnd());
    expect(workItem.id).toBe((await current()).id);
  });

  it("Scenario: Revision result says what changed", async () => {
    const workItem = await awaitingProposal();
    await command(`/revise ${REVISE}`);

    const runner = fake([revisedStep(null), revisedStep("   "), revisedStep()]);
    const transition = await proposal(proposalContext(runner.runRole), await current());

    expect(transition.kind).toBe("advance");
    const revisions = (await listAttempts(f.db.pool, workItem.id)).filter((a) => a.state === "proposal" && a.n > 1);
    expect(revisions.map((a) => [a.n, a.outcome, a.failureReason])).toEqual([
      [2, "failed", "no-what-changed"],
      [3, "failed", "no-what-changed"],
      [4, "succeeded", null],
    ]);
    expect(runner.calls[1]?.evidence?.reason).toBe("no-what-changed");
    expect(promptOf(runner.calls[1])).toMatch(/whatChanged/);
  });

  it("Scenario: Revision gets its own attempts", async () => {
    // A proposal that succeeded at attempt 3.
    const invalid: FakeStep = { files: { ...proposalStep("small").files, "specs/vocab-import/spec.md": CHANGE_FILES.specWithoutScenario } };
    const created = await intake(base(), { issueNumber: ISSUE.number });
    if (created.kind !== "advance") throw new Error("intake did not advance");
    const first = await proposal(proposalContext(fake([invalid, invalid, proposalStep("small")]).runRole), created.workItem);
    if (first.kind !== "advance") throw new Error("proposal did not advance");
    await awaitApproval(base(), first.workItem, TOKEN);

    await command(`/revise ${REVISE}`);
    const runner = fake([{ files: { "specs/vocab-import/spec.md": CHANGE_FILES.specWithoutScenario } }, { files: { "proposal.md": REVISED_PROPOSAL, "specs/vocab-import/spec.md": SPEC }, result: { ...validResult(CHANGE_ID), whatChanged: WHAT_CHANGED } }]);
    const transition = await proposal(proposalContext(runner.runRole), await current());

    expect(transition).toMatchObject({ kind: "advance", workItem: { state: "awaiting-proposal-approval" } });
    expect((await current()).state).toBe("awaiting-proposal-approval");
    const attempts = (await listAttempts(f.db.pool, first.workItem.id)).filter((a) => a.state === "proposal");
    expect(attempts.map((a) => [a.n, a.outcome])).toEqual([
      [1, "failed"],
      [2, "failed"],
      [3, "succeeded"],
      [4, "failed"],
      [5, "succeeded"],
    ]);
    // Attempt 5 runs with attempt 4's validation errors, and still with the owner's comment.
    expect(runner.calls[1]?.evidence?.reason).toBe("invalid-change");
    expect(promptOf(runner.calls[1])).toContain(REVISE);
  });

  it("Scenario: Revision attempt names its comments", async () => {
    const workItem = await awaitingProposal();
    await command("/revise First change.");
    await proposal(proposalContext(fake([revisedStep("First.")]).runRole), await current());
    await awaitApproval(base(), await current(), TOKEN_2);
    await command("/revise Second change.");
    const runner = fake([{ files: { "proposal.md": `${REVISED_PROPOSAL}- Second.\n` }, result: { ...validResult(CHANGE_ID), whatChanged: "Second." } }]);
    await proposal(proposalContext(runner.runRole), await current());

    const revises = (await listComments(f.db.pool, workItem.id)).filter((c) => c.verb === "revise");
    const attempts = (await listAttempts(f.db.pool, workItem.id)).filter((a) => a.state === "proposal");
    expect(attempts.map((a) => a.n)).toEqual([1, 2, 3]);
    expect(attempts[0]?.commentIds).toEqual([]);
    expect(attempts[1]?.commentIds).toEqual([revises[0]?.id]);
    expect(attempts[2]?.commentIds).toEqual([revises[0]?.id, revises[1]?.id]);
    // Both comments reach the third attempt, oldest first.
    const prompt = promptOf(runner.calls[0]);
    expect(prompt.indexOf("First change.")).toBeGreaterThan(-1);
    expect(prompt.indexOf("First change.")).toBeLessThan(prompt.indexOf("Second change."));
  });

  it("Scenario: Closed approval records its outcome", async () => {
    const workItem = await awaitingProposal();
    await command(`/revise ${REVISE}`);
    await proposal(proposalContext(fake([revisedStep()]).runRole), await current());
    await awaitApproval(base(), await current(), TOKEN_2);

    await command("/approve");

    expect(await approvals(workItem)).toEqual([
      { kind: "proposal", state: "closed", taskToken: TOKEN, resolvedBy: OWNER, outcome: "revise" },
      { kind: "proposal", state: "closed", taskToken: TOKEN_2, resolvedBy: OWNER, outcome: "approved" },
    ]);
  });

  it("Scenario: Later roles do not see the owner's comments", async () => {
    const secret = "Name the table vocab_lookups_by_owner.";
    const workItem = await awaitingProposal("medium");
    await command(`/revise ${secret}`);
    await proposal(proposalContext(fake([revisedStep(WHAT_CHANGED, "medium")]).runRole), await current());
    await awaitApproval(base(), await current(), TOKEN_2);
    await command("/approve");
    const routed = await approved({ ...base(), readChangeFile: changeFileReader({ repo: f.repo, home: f.home }) }, await current());
    expect(routed).toMatchObject({ kind: "advance", route: "design" });

    const later = fake([{ files: { "design.md": DESIGN_MD }, result: DESIGN_RESULT }, { result: { verdict: "approve", findings: [] } }, planStep()]);
    expect((await design(designContext(later.runRole), await current())).kind).toBe("advance");
    expect((await plan({ ...base(), runRole: later.runRole, planner, planPaths: await planPaths(), repo: f.repo, home: f.home, committer: BOT }, await current())).kind).toBe("advance");

    expect(later.calls.map((call) => call.role)).toEqual(["architect", "design-reviewer", "planner"]);
    for (const call of later.calls) {
      expect(promptOf(call), call.role).not.toContain(secret);
      expect(call.item.ownerFeedback, call.role).toBeUndefined();
    }
    expect(workItem.id).toBe((await current()).id);
  });
});

describe("/revise of a design", { timeout: 60_000 }, () => {
  it("Scenario: Revise sends the design back to the architect", async () => {
    const workItem = await awaitingDesign();
    const before = remoteHead(f);
    const comment = "Keep the parser in the domain package";

    expect((await command(`/revise ${comment}`)).outcome).toBe("applied");
    expect((await approvals(workItem)).at(-1)).toEqual({ kind: "design", state: "closed", taskToken: TOKEN, resolvedBy: OWNER, outcome: "revise" });
    expect(taskTokens.successes).toEqual([{ taskToken: TOKEN, output: JSON.stringify({ decision: "revise" }) }]);
    expect((await current()).state).toBe("design");

    const runner = fake([{ files: { "design.md": DESIGN_MD_2 }, result: { ...DESIGN_RESULT, whatChanged: "Moved the parser to the domain package." } }]);
    const transition = await design(designContext(runner.runRole), await current());

    expect(transition).toMatchObject({ kind: "advance", route: "owner-review", workItem: { state: "awaiting-design-approval" } });
    expect(runner.calls.map((call) => call.role)).toEqual(["architect"]);
    expect(promptOf(runner.calls[0])).toContain(comment);
    const head = remoteHead(f);
    expect(head).not.toBe(before);
    expect(git(f.remote, "log", "-1", "--format=%s", head)).toBe(`docs(${CHANGE_ID}): revise the design`);

    await awaitApproval(base(), await current(), TOKEN_2, "design");
    expect(await findOpenApproval(f.db.pool, workItem.id)).toMatchObject({ kind: "design", state: "open", taskToken: TOKEN_2 });
    const summary = replies().at(-1) ?? "";
    expect(summary).toMatch(/^## Design ready/m);
    expect(summary).toMatch(/^### What changed$/m);
    expect(summary).toContain("Moved the parser to the domain package.");
    expect(summary.trim().split("\n\n").at(-1)).toBe(COMMANDS_INSTRUCTION);
  });

  it("gives the architect only the design's comments, not the proposal's", async () => {
    const proposalComment = "Proposal-stage wording only.";
    // A large proposal revised once, then approved, designed and revised.
    await awaitingProposal("large");
    await command(`/revise ${proposalComment}`);
    await proposal(proposalContext(fake([revisedStep(WHAT_CHANGED, "large")]).runRole), await current());
    await awaitApproval(base(), await current(), TOKEN_2);
    await command("/approve");
    const routed = await approved({ ...base(), readChangeFile: changeFileReader({ repo: f.repo, home: f.home }) }, await current());
    if (routed.kind !== "advance") throw new Error("approved did not advance");
    await design(designContext(fake([{ files: { "design.md": DESIGN_MD }, result: DESIGN_RESULT }]).runRole), routed.workItem);
    await awaitApproval(base(), await current(), "AQB8AAAAKgAAAAMAAAAAAAAAAeThirdToken", "design");
    await command("/revise Design-stage change.");

    const runner = fake([{ files: { "design.md": DESIGN_MD_2 }, result: { ...DESIGN_RESULT, whatChanged: "Changed." } }]);
    await design(designContext(runner.runRole), await current());

    expect(promptOf(runner.calls[0])).toContain("Design-stage change.");
    expect(promptOf(runner.calls[0])).not.toContain(proposalComment);
  });
});

describe("/revise refusals", { timeout: 60_000 }, () => {
  it("Scenario: Revise without text is refused", async () => {
    const workItem = await awaitingProposal();

    const outcome = await command("/revise   ");

    expect(outcome.outcome).toBe("refused");
    expect(replies().at(-1)).toMatch(/`\/revise` needs the answers or changes/i);
    expect(await findOpenApproval(f.db.pool, workItem.id)).toMatchObject({ state: "open", taskToken: TOKEN });
    expect(taskTokens.successes).toEqual([]);
    expect((await current()).state).toBe("awaiting-proposal-approval");
  });

  it("Scenario: Sixth revision is refused", async () => {
    const workItem = await awaitingProposal();
    for (let i = 0; i < 5; i += 1) {
      await recordComment(f.db.pool, {
        workItemId: workItem.id,
        repository: TARGET.repository,
        issueNumber: ISSUE.number,
        githubCommentId: 7_000_000_000 + i,
        author: OWNER,
        verb: "revise",
        body: `/revise change ${String(i)}`,
        outcome: "applied",
        stateMet: "awaiting-proposal-approval",
      });
    }

    const outcome = await command("/revise One more change.");

    expect(outcome.outcome).toBe("refused");
    expect(replies().at(-1)).toMatch(/limit of 5 revisions/i);
    expect(replies().at(-1)).toMatch(/new issue/i);
    expect(await findOpenApproval(f.db.pool, workItem.id)).toMatchObject({ state: "open", taskToken: TOKEN });
    expect(taskTokens.successes).toEqual([]);
    expect((await current()).state).toBe("awaiting-proposal-approval");
  });

  it("Scenario: Revision over the budget is refused", async () => {
    const workItem = await awaitingProposal();
    // The proposal cost $4.00 so far; the author's per-attempt budget is $1.50, the target's $5.
    await f.db.pool.query("UPDATE attempts SET cost_usd_estimate = 4.00 WHERE work_item_id = $1", [workItem.id]);
    expect(proposalAuthor.maxBudgetUsd).toBe(1.5);
    expect(TARGET.budgetUsd).toBe(5);

    const outcome = await command(`/revise ${REVISE}`);

    expect(outcome.outcome).toBe("refused");
    expect(replies().at(-1)).toContain("$4.00");
    expect(replies().at(-1)).toContain("$5.00");
    expect(await findOpenApproval(f.db.pool, workItem.id)).toMatchObject({ state: "open", taskToken: TOKEN });
    expect(taskTokens.successes).toEqual([]);
  });

  it("reopens the approval and restores the state when resuming fails", async () => {
    const workItem = await awaitingProposal();
    taskTokens.failNextSuccess = new Error("TaskTimedOut: secret detail");

    const outcome = await command(`/revise ${REVISE}`);

    expect(outcome.outcome).toBe("refused");
    expect(await findOpenApproval(f.db.pool, workItem.id)).toMatchObject({ state: "open", taskToken: TOKEN });
    expect((await current()).state).toBe("awaiting-proposal-approval");
    expect(replies().at(-1)).toMatch(/did not go through/i);
    expect(replies().at(-1)).not.toContain("secret detail");
    // A refused /revise is not a revision of the stage.
    expect((await listComments(f.db.pool, workItem.id)).map((c) => c.outcome)).toEqual(["refused"]);
  });
});

describe("/question", { timeout: 60_000 }, () => {
  const ANSWER = "The issue asks for the import in the domain, and proposal.md records no other reason.";

  it("Scenario: Question about the proposal is answered", async () => {
    const workItem = await awaitingProposal();
    const head = remoteHead(f);
    const runner = fake([{ result: { answer: ANSWER } }]);

    const outcome = await command("/question Why is the importer in the domain package?", runner.runRole);

    expect(outcome.outcome).toBe("applied");
    expect(runner.calls.map((call) => call.role)).toEqual(["proposal-author"]);
    expect(runner.calls[0]?.item.prompt).toContain("Why is the importer in the domain package?");
    const reply = replies().at(-1) ?? "";
    expect(reply).toContain(ANSWER);
    expect(reply).toContain(head);
    expect(reply).toMatch(/still open/i);
    // The execution is untouched: still paused, its approval open with its token.
    expect(taskTokens.successes).toEqual([]);
    expect(await findOpenApproval(f.db.pool, workItem.id)).toMatchObject({ state: "open", taskToken: TOKEN });
    expect((await current()).state).toBe("awaiting-proposal-approval");
  });

  it("Scenario: Question about the design is answered by the architect", async () => {
    const workItem = await awaitingDesign();
    const runner = fake([{ result: { answer: "Because node:sqlite needs no native build." } }]);

    await command("/question Why node:sqlite?", runner.runRole);

    expect(runner.calls.map((call) => call.role)).toEqual(["architect"]);
    expect(runner.calls[0]?.config.writable).toEqual([]);
    expect(replies().at(-1)).toContain("Because node:sqlite needs no native build.");
    expect((await listAttempts(f.db.pool, workItem.id)).at(-1)).toMatchObject({ state: "design-question", role: "architect", outcome: "succeeded" });
    expect(await findOpenApproval(f.db.pool, workItem.id)).toMatchObject({ kind: "design", state: "open", taskToken: TOKEN });
    expect((await current()).state).toBe("awaiting-design-approval");
  });

  it("Scenario: Question that asks for a change changes nothing", async () => {
    const workItem = await awaitingProposal();
    const head = remoteHead(f);
    const branches = git(f.remote, "for-each-ref", "--format=%(refname)");
    const runner = fake([{ result: { answer: "I cannot change it from here; reply `/revise Fix the typo in proposal.md` to have it changed." } }]);

    await command("/question Can you fix the typo in the proposal?", runner.runRole);

    // A read-only session: no write tools, no write paths, and a prompt that points to /revise.
    expect([...(runner.calls[0]?.config.tools ?? [])].sort()).toEqual(["Glob", "Grep", "Read"]);
    expect(runner.calls[0]?.config.writable).toEqual([]);
    expect(runner.calls[0]?.config.prompt).toContain("/revise");
    // Nothing committed or pushed.
    expect(remoteHead(f)).toBe(head);
    expect(git(f.remote, "for-each-ref", "--format=%(refname)")).toBe(branches);
    expect(replies().at(-1)).toContain("/revise");
    expect((await current()).state).toBe("awaiting-proposal-approval");
    expect(await findOpenApproval(f.db.pool, workItem.id)).toMatchObject({ state: "open" });
  });

  it("Scenario: Question without text is refused", async () => {
    await awaitingProposal();
    const runner = fake([]);

    const outcome = await command("/question", runner.runRole);

    expect(outcome.outcome).toBe("refused");
    expect(runner.calls).toEqual([]);
    expect(replies().at(-1)).toMatch(/`\/question` needs the question/i);
  });

  it("Scenario: Question while another is answered gets the busy reply", async () => {
    await awaitingProposal();
    const hold = gate();
    const runner = fake([{ result: { answer: ANSWER }, during: async () => {
      hold.start();
      await hold.wait;
    } }]);

    const first = command("/question First question?", runner.runRole);
    await hold.started;
    const second = await command("/question Second question?", runner.runRole);
    hold.open();
    const firstOutcome = await first;

    expect(second.outcome).toBe("busy");
    expect(firstOutcome.outcome).toBe("applied");
    expect(runner.calls).toHaveLength(1);
    const busy = replies().find((reply) => reply.includes("Second question?")) ?? "";
    expect(busy).toContain("`/question Second question?`");
    expect(busy).toMatch(/not applied and is not kept/i);
    expect(replies().at(-1)).toContain(ANSWER);
  });

  it("closes a question attempt left open for more than 30 minutes as abandoned, then answers", async () => {
    const workItem = await awaitingProposal();
    const stale = await openAttempt(f.db.pool, { workItemId: workItem.id, state: "proposal-question", role: "proposal-author" });
    await f.db.pool.query("UPDATE attempts SET started_at = clock_timestamp() - interval '31 minutes' WHERE id = $1", [stale.id]);
    const runner = fake([{ result: { answer: ANSWER } }]);

    expect((await command("/question Still there?", runner.runRole)).outcome).toBe("applied");

    const questions = (await listAttempts(f.db.pool, workItem.id)).filter((a) => a.state === "proposal-question");
    expect(questions.map((a) => [a.outcome, a.failureReason])).toEqual([
      ["failed", "abandoned"],
      ["succeeded", null],
    ]);
  });

  it("Scenario: Eleventh question is refused", async () => {
    const workItem = await awaitingProposal();
    for (let i = 0; i < 10; i += 1) {
      const comment = await recordComment(f.db.pool, {
        workItemId: workItem.id,
        repository: TARGET.repository,
        issueNumber: ISSUE.number,
        githubCommentId: 7_100_000_000 + i,
        author: OWNER,
        verb: "question",
        body: `/question number ${String(i)}?`,
        outcome: "applied",
        stateMet: "awaiting-proposal-approval",
      });
      const attempt = await openAttempt(f.db.pool, { workItemId: workItem.id, state: "proposal-question", role: "proposal-author", commentIds: [comment?.id ?? ""] });
      await closeAttempt(f.db.pool, attempt.id, { outcome: "succeeded", result: { answer: `answer ${String(i)}` } });
    }
    const runner = fake([]);

    const outcome = await command("/question One more?", runner.runRole);

    expect(outcome.outcome).toBe("refused");
    expect(runner.calls).toEqual([]);
    expect(replies().at(-1)).toMatch(/limit of 10 questions/i);
  });

  it("Scenario: Failed answer can be asked again", async () => {
    const workItem = await awaitingProposal();
    const runner = fake([{ fail: new AttemptFailed("max-turns", "error_max_turns") }, { result: { answer: ANSWER } }]);

    await command("/question Why?", runner.runRole);

    expect((await listAttempts(f.db.pool, workItem.id)).at(-1)).toMatchObject({ state: "proposal-question", outcome: "failed", failureReason: "max-turns" });
    expect(replies().at(-1)).toMatch(/not answered/i);
    expect(replies().at(-1)).toMatch(/ask it again/i);
    expect(replies().at(-1)).not.toContain("error_max_turns");
    expect(await findOpenApproval(f.db.pool, workItem.id)).toMatchObject({ state: "open", taskToken: TOKEN });

    // Asked again, it is answered.
    expect((await command("/question Why?", runner.runRole)).outcome).toBe("applied");
    expect(replies().at(-1)).toContain(ANSWER);
  });

  it("Scenario: Approval during a question goes through", async () => {
    const workItem = await awaitingProposal();
    const head = remoteHead(f);
    const hold = gate();
    const runner = fake([{ result: { answer: ANSWER }, during: async () => {
      hold.start();
      await hold.wait;
    } }]);

    const question = command("/question Why?", runner.runRole);
    await hold.started;
    const approval = await command("/approve");
    // The execution resumed at once, while the answer is still being written.
    expect(approval.outcome).toBe("applied");
    expect(taskTokens.successes).toEqual([{ taskToken: TOKEN, output: expect.any(String) as unknown }]);
    expect(replies().some((reply) => reply.includes(ANSWER))).toBe(false);

    hold.open();
    expect((await question).outcome).toBe("applied");
    const answer = replies().at(-1) ?? "";
    expect(answer).toContain(ANSWER);
    expect(answer).toContain(head);
    expect(answer).not.toMatch(/still open/i);
    expect((await approvals(workItem)).at(-1)).toMatchObject({ state: "closed", outcome: "approved" });
  });

  it("Scenario: Question attempt is recorded with its comment", async () => {
    const workItem = await awaitingProposal();
    const costBefore = await workItemCost(f.db.pool, workItem.id);
    const runner = fake([{ result: { answer: ANSWER }, costUsd: 0.12 }]);

    await command("/question Why SQLite?", runner.runRole);

    const [comment] = (await listComments(f.db.pool, workItem.id)).filter((c) => c.verb === "question");
    expect(comment?.outcome).toBe("applied");
    const attempt = (await listAttempts(f.db.pool, workItem.id)).find((a) => a.state === "proposal-question");
    expect(attempt).toMatchObject({ role: "proposal-author", outcome: "succeeded", result: { answer: ANSWER }, commentIds: [comment?.id] });
    expect(attempt?.costUsdEstimate).toBeGreaterThan(0);
    expect(await workItemCost(f.db.pool, workItem.id)).toBeCloseTo(costBefore + 0.12, 6);
  });

  it("gives a later revision the stage's questions and answers", async () => {
    await awaitingProposal();
    await command("/question How would you handle duplicates?", fake([{ result: { answer: "Merge them by word and book." } }]).runRole);
    await command("/revise Do what you suggested about duplicates.");

    const runner = fake([revisedStep()]);
    await proposal(proposalContext(runner.runRole), await current());

    const prompt = promptOf(runner.calls[0]);
    expect(prompt).toContain("How would you handle duplicates?");
    expect(prompt).toContain("Merge them by word and book.");
    expect(prompt).toContain("Do what you suggested about duplicates.");
  });
});

describe("/revise and /question outside an approval", { timeout: 60_000 }, () => {
  async function workItemIn(state: string): Promise<WorkItemRow> {
    return createWorkItem(f.db.pool, { repository: TARGET.repository, issueNumber: ISSUE.number, changeId: CHANGE_ID, branch: CHANGE_ID, state });
  }

  it("Scenario: Revise during the build is answered", async () => {
    await workItemIn("build");
    const runner = fake([]);

    const outcome = await command(`/revise ${REVISE}`, runner.runRole);

    expect(outcome.outcome).toBe("refused");
    expect(replies()).toHaveLength(1);
    expect(replies()[0]).toMatch(/nothing awaits approval/i);
    expect(replies()[0]).toContain("`build`");
    expect(runner.calls).toEqual([]);
    expect(taskTokens.successes).toEqual([]);
    expect((await current()).state).toBe("build");
  });

  it("Scenario: Question with the pull request open is answered", async () => {
    await workItemIn("pr-open");
    const runner = fake([]);

    const outcome = await command("/question Why?", runner.runRole);

    expect(outcome.outcome).toBe("refused");
    expect(replies()).toHaveLength(1);
    expect(replies()[0]).toMatch(/pull request is open for review/i);
    expect(runner.calls).toEqual([]);
  });

  it.each([
    ["revise", "escalated"],
    ["question", "escalated"],
    ["question", "build"],
    ["revise", "pr-open"],
  ])("answers /%s in %s, running nothing", async (verb, state) => {
    await workItemIn(state);
    const runner = fake([]);

    expect((await command(`/${verb} something`, runner.runRole)).outcome).toBe("refused");
    expect(replies()).toHaveLength(1);
    expect(runner.calls).toEqual([]);
    expect((await current()).state).toBe(state);
  });

  it("answers /revise and /question with no work item", async () => {
    for (const verb of ["revise", "question"]) {
      const { id } = f.forge.addComment({ issueNumber: ISSUE.number, author: OWNER, body: `/${verb} x` });
      expect((await handleCommand(commandContext(), ISSUE.number, id)).outcome).toBe("refused");
    }
    expect(replies()).toHaveLength(2);
    for (const reply of replies()) expect(reply).toMatch(/no factory work item/i);
  });
});
