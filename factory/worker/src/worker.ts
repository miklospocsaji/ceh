/**
 * The worker: `factory-worker <state> --issue <n>` runs one state's handler for the issue's
 * work item and reports the outcome by exit code (`WORKER_EXIT`), which the state machine
 * routes on. Every dependency is passed in; `main.ts` wires in the real ones.
 *
 * - The ledger is waited for first (up to 180 s, while a paused Aurora resumes), then migrations
 *   run, as in the CLI (`migrate()` takes an advisory lock).
 * - `intake` needs no clone. `proposal` clones the repository afresh into the task's home
 *   and adds the work item's worktree there, unless the work item is past Proposal, in which
 *   case nothing is cloned and no role runs.
 * - The cloud states (add-cloud-proposal-run): `intake --execution` ends with exit 4 for an
 *   issue whose work item belongs to another execution. `await-approval` stores the task token
 *   and posts the summary; any error in it fails the paused task with SendTaskFailure, since
 *   Step Functions does not watch that task. `approved` records the approval and routes on the
 *   complexity, and `escalate` marks the work item after an infrastructure failure.
 * - `command --issue <n> --comment <id>` (add-owner-commands): one owner command, which the
 *   webhook starts with the comment's id only. The handler reads the comment, checks its author and
 *   issue (exit 2 if either is wrong), decides it by the work item's state and replies once; an
 *   `/approve` resumes the execution with the approval's token. It exits 0 whatever the command's
 *   outcome, and 1 when resuming failed (the reply says so) or anything else failed, after posting
 *   a fixed reply, so the owner is never left without an answer.
 * - The states after Proposal (add-build-loop): `design`, `plan` (a waitForTaskToken task that
 *   resumes the execution with the change id and the unfinished task ids), `step --task <id>`,
 *   which prepares the task's next build in the artifact store, and `open-pr`. Each clones afresh.
 */
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ForgeError, type Forge } from "@ceh/factory-forge";
import { findWorkItemByIssue, migrate, waitForLedger, type WorkItemRow } from "@ceh/factory-ledger";
import {
  approve,
  approved,
  awaitApproval,
  changeFileReader,
  CommandFailed,
  commandFailedReply,
  handleCommand,
  InvalidCommand,
  design,
  ensureWorktree,
  escalateWorkItem,
  intake,
  NotApplicable,
  openPr,
  plan,
  proposal,
  step,
  WORKER_EXIT,
  type ArtifactStore,
  type GitIdentity,
  type StepContext,
  type StepResult,
  type TaskTokens,
  type Transition,
} from "@ceh/factory-orchestrator";
import type { Role, RunRole } from "@ceh/factory-roles";
import type { Target } from "@ceh/factory-target";
import type pg from "pg";
import { ENV, parseWorkerArgs, USAGE, type WorkerArgs, type WorkerState } from "./config.ts";

export { WORKER_EXIT } from "@ceh/factory-orchestrator";

/** What AwaitApproval reports with SendTaskFailure: fixed text, never an error's message. */
export const AWAIT_APPROVAL_FAILURE = { error: "factory.AwaitApprovalFailed", cause: "The await-approval worker task failed; see its log." } as const;
/** What Plan reports with SendTaskFailure: fixed text, never an error's message. */
export const PLAN_FAILURE = { error: "factory.PlanFailed", cause: "The plan worker task failed; see its log." } as const;

/** The states the state machine runs as waitForTaskToken tasks, and what they report on failure. */
const TOKEN_STATES: Partial<Record<WorkerState, { error: string; cause: string }>> = { "await-approval": AWAIT_APPROVAL_FAILURE, plan: PLAN_FAILURE };

export type WorkerIdentity = GitIdentity;

/** The roles the states after Proposal run or name. */
export interface WorkerRoles {
  architect: Role;
  designReviewer: Role;
  planner: Role;
  testAuthor: Role;
  implementer: Role;
  classifier: Role;
}

export interface WorkerDeps {
  /** The repository this worker serves, from FACTORY_TARGET (ADR 0014). */
  target: Target;
  /** A pool, since migrations take a client of their own. */
  db: pg.Pool;
  forge: Forge;
  runRole: RunRole;
  /** The proposal-author role, from the image. */
  role: Role;
  /** The roles after Proposal, from the image. */
  roles: WorkerRoles;
  /** The artifact store the worker and the build task share. */
  store: ArtifactStore;
  /** What the build container clones, with no token. */
  cloneUrl: string;
  /** The task's temp home: the clone and the worktrees live here. */
  home: string;
  /** The author and committer of the factory's commits: the App's bot user. */
  committer?: WorkerIdentity;
  /** Step Functions, for the states that resume or fail a paused task. */
  taskTokens?: TaskTokens;
  /** The task token of AwaitApproval or Plan, from FACTORY_TASK_TOKEN. */
  taskToken?: string;
  out: (text: string) => void;
  err: (text: string) => void;
}

/** Input the worker refuses with exit 2. */
class InvalidInput extends Error {}

export async function runWorker(argv: string[], deps: WorkerDeps): Promise<number> {
  const args = parseWorkerArgs(argv);
  if (!args.ok) {
    deps.err(`factory-worker: ${args.message}\n\n${USAGE}`);
    return WORKER_EXIT.invalid;
  }
  const failure = TOKEN_STATES[args.state];
  const taskToken = failure === undefined ? undefined : deps.taskToken;
  if (failure !== undefined && (taskToken === undefined || taskToken === "")) {
    deps.err(`factory-worker: ${args.state} needs the task token in ${ENV.taskToken}\n`);
    return WORKER_EXIT.invalid;
  }

  // Set once the paused task has been resumed, so a later failure does not also fail it.
  const token: TaskToken | undefined = taskToken === undefined ? undefined : { value: taskToken, resumed: false };
  let code: number;
  try {
    // A paused Aurora resumes on the first connection; inside the try, so a ledger that never
    // answers still fails a paused task below.
    await waitForLedger(deps.db);
    await migrate(deps.db);
    code = await runState(args, deps, token);
  } catch (error) {
    if (error instanceof InvalidInput || error instanceof NotApplicable || error instanceof InvalidCommand) {
      deps.err(`factory-worker: ${error.message}\n`);
      code = WORKER_EXIT.invalid;
    } else {
      deps.err(`factory-worker: ${args.state} for issue #${String(args.issueNumber)} failed: ${error instanceof Error ? error.message : String(error)}\n`);
      code = WORKER_EXIT.error;
    }
  }
  // Nothing else ends a paused task: Step Functions does not watch it.
  if (token !== undefined && failure !== undefined && !token.resumed && code !== WORKER_EXIT.ok) await failTask(token.value, failure, deps);
  return code;
}

interface TaskToken {
  value: string;
  resumed: boolean;
}

async function failTask(taskToken: string, failure: { error: string; cause: string }, deps: WorkerDeps): Promise<void> {
  try {
    await requireTaskTokens(deps).fail(taskToken, failure.error, failure.cause);
  } catch (error) {
    deps.err(`factory-worker: SendTaskFailure failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

function requireTaskTokens(deps: WorkerDeps): TaskTokens {
  if (deps.taskTokens === undefined) throw new Error("no Step Functions client configured");
  return deps.taskTokens;
}

async function runState(args: WorkerArgs, deps: WorkerDeps, token: TaskToken | undefined): Promise<number> {
  const { state, issueNumber } = args;
  const { db, forge, target } = deps;
  const issue = `issue #${String(issueNumber)}`;
  switch (state) {
    case "intake":
    case "proposal":
      return report(state, issueNumber, await runHandler(args, deps), deps);
    case "await-approval": {
      const workItem = await requireWorkItem(deps, issueNumber);
      const kind = args.kind ?? "proposal";
      await awaitApproval({ db, forge, target, readProposal: (item) => readProposal(item, deps) }, workItem, token?.value ?? "", kind);
      deps.out(`factory-worker: await-approval for ${issue}: work item ${workItem.changeId} awaits the owner's ${kind} approval\n`);
      return WORKER_EXIT.ok;
    }
    case "command":
      return runCommand(args, deps);
    case "approved": {
      const transition = await approved({ db, forge, target, readChangeFile: (item, path) => readChangeFile(item, path, deps) }, await requireWorkItem(deps, issueNumber));
      const code = report(state, issueNumber, transition, deps);
      return transition.kind === "advance" && transition.route === "plan" ? WORKER_EXIT.skipDesign : code;
    }
    case "design": {
      const workItem = await requireWorkItem(deps, issueNumber);
      const repo = await freshClone(deps);
      const transition = await design({ db, forge, target, runRole: deps.runRole, ...deps.roles, repo, home: deps.home, ...committer(deps) }, workItem);
      const code = report(state, issueNumber, transition, deps);
      return transition.kind === "advance" && transition.route === "owner-review" ? WORKER_EXIT.ownerDesignReview : code;
    }
    case "plan":
      return runPlan(args, deps, token);
    case "step": {
      if (args.taskId === undefined) throw new InvalidInput("step needs --task");
      const workItem = await requireWorkItem(deps, issueNumber);
      const repo = await freshClone(deps);
      const result = await step({ ...stepContext(deps), repo }, workItem, args.taskId);
      return reportStep(issueNumber, args.taskId, result, deps);
    }
    case "open-pr":
      return report(state, issueNumber, await openPr({ db, forge, target }, await requireWorkItem(deps, issueNumber)), deps);
    case "escalate": {
      if (args.reason === undefined) throw new InvalidInput("escalate needs --reason");
      const workItem = await escalateWorkItem({ db, forge, target }, issueNumber, args.reason);
      deps.out(`factory-worker: escalate for ${issue}: ${workItem === undefined ? "no work item" : `work item ${workItem.changeId} is ${workItem.state}`} (${args.reason})\n`);
      return WORKER_EXIT.ok;
    }
  }
}

/** One owner command; see the module comment for its exit codes. */
async function runCommand(args: WorkerArgs, deps: WorkerDeps): Promise<number> {
  const { issueNumber, commentId } = args;
  if (commentId === undefined) throw new InvalidInput("command needs --comment");
  const { db, forge, target } = deps;
  const subject = `command for issue #${String(issueNumber)}, comment ${String(commentId)}`;
  let outcome;
  try {
    outcome = await handleCommand({ db, forge, target, approve: (workItem, by, tx) => approve({ db: tx, forge, target, taskTokens: requireTaskTokens(deps) }, workItem, by) }, issueNumber, commentId);
  } catch (error) {
    if (error instanceof InvalidCommand) throw error;
    // Fixed text only: no error's message reaches GitHub.
    const written = error instanceof CommandFailed ? error.command.written : undefined;
    await forge.comment(issueNumber, commandFailedReply(written)).catch((commentError: unknown) => {
      deps.err(`factory-worker: ${subject}: replying to the failure failed: ${messageOf(commentError)}\n`);
    });
    throw error;
  }
  const command = `/${outcome.command.written}`;
  const workItem = outcome.workItem === undefined ? "no work item" : `work item ${outcome.workItem.changeId} in ${outcome.workItem.state}`;
  if (outcome.commentError !== undefined) deps.err(`factory-worker: ${subject}: the confirmation comment failed: ${messageOf(outcome.commentError)}\n`);
  if (outcome.error !== undefined) {
    deps.err(`factory-worker: ${subject}: ${command} could not resume ${workItem}: ${messageOf(outcome.error)}\n`);
    return WORKER_EXIT.error;
  }
  deps.out(`factory-worker: ${subject}: ${command} ${outcome.outcome} (${workItem})\n`);
  return WORKER_EXIT.ok;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function committer(deps: WorkerDeps): { committer?: WorkerIdentity } {
  return deps.committer === undefined ? {} : { committer: deps.committer };
}

function stepContext(deps: WorkerDeps): Omit<StepContext, "repo"> {
  const { testAuthor, implementer, classifier } = deps.roles;
  return { db: deps.db, forge: deps.forge, target: deps.target, runRole: deps.runRole, testAuthor, implementer, classifier, store: deps.store, cloneUrl: deps.cloneUrl, home: deps.home, ...committer(deps) };
}

/**
 * Plan, as a waitForTaskToken task: on an accepted plan (or a repeated Plan), the execution
 * resumes with `{ exitCode: 0, changeId, tasks }`; on an escalation with exit code 3 and no
 * tasks. Any error is reported with SendTaskFailure by runWorker.
 */
async function runPlan(args: WorkerArgs, deps: WorkerDeps, token: TaskToken | undefined): Promise<number> {
  if (token === undefined) throw new InvalidInput(`plan needs the task token in ${ENV.taskToken}`);
  const workItem = await requireWorkItem(deps, args.issueNumber);
  const repo = await freshClone(deps);
  const { planner, testAuthor, implementer } = deps.roles;
  const transition = await plan(
    { db: deps.db, forge: deps.forge, target: deps.target, runRole: deps.runRole, planner, planPaths: { implementer: implementer.writable, testAuthor: testAuthor.writable }, repo, home: deps.home, ...committer(deps) },
    workItem,
  );
  const code = report("plan", args.issueNumber, transition, deps);
  if (transition.kind !== "advance" && transition.kind !== "escalate") return code;
  const exitCode = transition.kind === "advance" ? WORKER_EXIT.ok : WORKER_EXIT.escalated;
  const tasks = transition.kind === "advance" ? (transition.tasks ?? []) : [];
  await requireTaskTokens(deps).succeed(token.value, JSON.stringify({ exitCode, changeId: workItem.changeId, tasks }));
  token.resumed = true;
  return code;
}

function reportStep(issueNumber: number, taskId: string, result: StepResult, deps: WorkerDeps): number {
  const subject = `step for issue #${String(issueNumber)}, task ${taskId}`;
  switch (result.kind) {
    case "done":
      deps.out(`factory-worker: ${subject}: done\n`);
      return WORKER_EXIT.ok;
    case "build":
      deps.out(`factory-worker: ${subject}: the next build is ready${result.afterWait ? ", after a wait" : ""}\n`);
      return result.afterWait ? WORKER_EXIT.buildAfterWait : WORKER_EXIT.build;
    case "design-flaw":
      deps.out(`factory-worker: ${subject}: a design flaw; work item ${result.workItem.changeId} goes back to Design\n`);
      return WORKER_EXIT.designFlaw;
    case "escalate":
      deps.err(`factory-worker: ${subject}: work item ${result.workItem.changeId} escalated: ${result.reason}\n`);
      return WORKER_EXIT.escalated;
  }
}

async function requireWorkItem(deps: WorkerDeps, issueNumber: number): Promise<WorkItemRow> {
  const workItem = await findWorkItemByIssue(deps.db, deps.target.repository, issueNumber);
  if (workItem === undefined) throw new InvalidInput(`issue #${String(issueNumber)} has no work item; run intake first`);
  return workItem;
}

/** A file of the pushed change folder, from a fresh clone and the work item's worktree; undefined if it is absent. */
async function readChangeFile(workItem: WorkItemRow, path: string, deps: WorkerDeps): Promise<string | undefined> {
  const repo = await freshClone(deps);
  return changeFileReader({ repo, home: deps.home })(workItem, path);
}

/** The pushed `proposal.md`, from a fresh clone and the work item's worktree; undefined if it cannot be read. */
async function readProposal(workItem: WorkItemRow, deps: WorkerDeps): Promise<string | undefined> {
  try {
    const repo = await freshClone(deps);
    const worktree = await ensureWorktree({ repo, changeId: workItem.changeId, branch: workItem.branch, home: deps.home });
    return await readFile(join(worktree, "openspec/changes", workItem.changeId, "proposal.md"), "utf8");
  } catch (error) {
    deps.err(`factory-worker: reading proposal.md of ${workItem.changeId} failed, so the summary leaves it out: ${error instanceof Error ? error.message : String(error)}\n`);
    return undefined;
  }
}

async function runHandler(args: WorkerArgs, deps: WorkerDeps): Promise<Transition> {
  const { state, issueNumber } = args;
  const { db, forge, target } = deps;
  switch (state) {
    case "intake":
      try {
        return await intake({ db, forge, target }, { issueNumber, ...(args.executionArn === undefined ? {} : { executionArn: args.executionArn }) });
      } catch (error) {
        if (error instanceof ForgeError && error.kind === "not-found") throw new InvalidInput(`issue #${String(issueNumber)} not found`);
        throw error;
      }
    default: {
      const workItem = await findWorkItemByIssue(db, target.repository, issueNumber);
      if (workItem === undefined) throw new InvalidInput(`issue #${String(issueNumber)} has no work item; run intake first`);
      // Past Proposal (or escalated): the handler returns at once, so clone nothing.
      if (workItem.state !== "proposal") return proposal({ db, forge, target, runRole: deps.runRole, role: deps.role, repo: deps.home }, workItem);

      const repo = await freshClone(deps);
      return proposal(
        {
          db,
          forge,
          target,
          runRole: deps.runRole,
          role: deps.role,
          repo,
          home: deps.home,
          ...(deps.committer === undefined ? {} : { committer: deps.committer }),
        },
        workItem,
      );
    }
  }
}

/** `<home>/repo`, cloned from the forge; any clone or worktrees from before are removed first. */
async function freshClone(deps: WorkerDeps): Promise<string> {
  const repo = join(deps.home, "repo");
  await rm(repo, { recursive: true, force: true });
  await rm(join(deps.home, "worktrees"), { recursive: true, force: true });
  await mkdir(deps.home, { recursive: true });
  await deps.forge.clone(repo);
  return repo;
}

function report(state: WorkerState, issueNumber: number, transition: Transition, deps: WorkerDeps): number {
  const issue = `issue #${String(issueNumber)}`;
  switch (transition.kind) {
    case "advance":
      deps.out(`factory-worker: ${state} for ${issue}: work item ${transition.workItem.changeId} is ${transition.workItem.state}\n`);
      return WORKER_EXIT.ok;
    case "reject":
      deps.err(`factory-worker: ${state} for ${issue}: rejected: ${transition.reason}\n`);
      return WORKER_EXIT.ended;
    case "escalate":
      deps.err(`factory-worker: ${state} for ${issue}: work item ${transition.workItem.changeId} escalated: ${transition.reason}\n`);
      return WORKER_EXIT.escalated;
    case "duplicate":
      deps.out(`factory-worker: ${state} for ${issue}: work item ${transition.workItem.changeId} belongs to another execution; this one ends\n`);
      return WORKER_EXIT.ended;
  }
}
