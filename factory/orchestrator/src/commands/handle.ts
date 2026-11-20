/**
 * The `command` task's handler (add-owner-commands design, "Command handler"): one owner command,
 * read from the forge by its comment id, decided by the work item's state, answered once.
 *
 * 1. The comment is read through the Forge. One not by the target's owner (compared ignoring
 *    case), on another issue than the task's, missing, or holding no command is InvalidCommand:
 *    nothing is recorded, done or posted. The webhook's check is the gate; this is the proof.
 * 2. In one transaction: the issue's work item is locked (`SELECT … FOR UPDATE`), so commands on
 *    one work item are decided one at a time; the comment is recorded, and a comment recorded
 *    already ends here as a `duplicate`, with no effect and no reply; the command is decided by
 *    the table below, its effect applied and its outcome recorded. No role session runs here.
 * 3. After the commit, the one reply is posted. A crash in between leaves the command applied and
 *    unanswered, and a redelivery does not repeat it: `/status` shows where it stands. A
 *    `/question` (add-approval-feedback) opens its attempt under the lock, and its session runs
 *    after the commit, so an `/approve` or `/revise` meanwhile goes through at once; its reply is
 *    the answer.
 *
 * | Work item state                  | /approve                       | /revise, /question            | /abort, /resume   | /status, /help | unknown |
 * | none                             | refused: nothing awaits        | refused: nothing awaits       | not yet available | applied        | unknown |
 * | intake … plan (a role runs)      | busy                           | busy                          | not yet available | applied        | unknown |
 * | awaiting-{proposal,design}-appr. | applied (refused if none open) | applied, or refused (limits)  | not yet available | applied        | unknown |
 * | build, escalated                 | refused: nothing awaits        | refused: nothing awaits       | not yet available | applied        | unknown |
 * | pr-open                          | refused: the PR is open        | refused: the PR is open       | not yet available | applied        | unknown |
 *
 * The busy check comes before "not yet available", so the owner learns the more useful fact first.
 */
import { ForgeError, type IssueComment } from "@ceh/factory-forge";
import {
  closeAttempt,
  findOpenApproval,
  inTransaction,
  lockWorkItem,
  openAttempt,
  openQuestionAttempt,
  recordComment,
  setCommentOutcome,
  stageComments,
  stageQuestions,
  workItemCost,
  type CommentOutcome,
  type CommentRow,
  type Stage,
  type WorkItemRow,
} from "@ceh/factory-ledger";
import { QUESTION_BUDGET_USD, type Role, type RunRole } from "@ceh/factory-roles";
import type { Approver, Reviser } from "../approval.ts";
import { MAX_QUESTIONS, MAX_REVISIONS } from "../feedback.ts";
import type { HandlerContext } from "../handler.ts";
import { parseCommand, type Command, type KnownVerb } from "./parse.ts";
import { answerQuestion, type PendingQuestion } from "./question.ts";
import {
  busyReply,
  helpReply,
  notYetAvailableReply,
  nothingAwaitsReply,
  overBudgetReply,
  pullRequestOpenReply,
  questionBusyReply,
  questionLimitReply,
  questionNeedsTextReply,
  resumeFailedReply,
  revisedReply,
  reviseFailedReply,
  reviseNeedsTextReply,
  revisionLimitReply,
  statusReply,
  unknownReply,
} from "./replies.ts";
import { statusFigures } from "./status.ts";

export type { Approver as CommandApprover } from "../approval.ts";

/** What a `/question` needs: the authors whose question mode answers it, and a runner. */
export interface QuestionContext {
  /** Runs the question session; it records into the question's attempt, named on the work item. */
  runRole: RunRole;
  proposalAuthor: Role;
  architect: Role;
  /** Where the fresh clone for an answer goes; defaults to the system's temp directory. */
  home?: string;
}

export interface CommandContext extends HandlerContext {
  /** Applies an `/approve` to a work item awaiting approval: SendTaskSuccess in the cloud, the local approval in a local run. */
  approve: Approver;
  /** Applies a `/revise` that passed its checks: SendTaskSuccess with the decision `revise` in the cloud, the state alone locally. */
  revise: Reviser;
  question: QuestionContext;
}

/** A comment the task must not act on; the worker exits 2. */
export class InvalidCommand extends Error {
  override readonly name = "InvalidCommand";
}

/** Handling a command failed after it was read; `command` names it for the fixed reply. */
export class CommandFailed extends Error {
  override readonly name = "CommandFailed";
  readonly command: Command;

  constructor(command: Command, cause: unknown) {
    super(`/${command.written} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.command = command;
  }
}

/**
 * What the command came to: the outcome the ledger records, or `duplicate` for a comment
 * recorded already, which changed nothing and was not answered again.
 */
export interface CommandOutcome {
  outcome: CommentOutcome | "duplicate";
  command: Command;
  /** The issue's work item as the command met it. */
  workItem: WorkItemRow | undefined;
  /** An `/approve` or `/revise` whose resume failed, or a `/question` whose session failed on something else than its own limits. */
  error?: unknown;
  /** An applied `/approve` of a design whose confirmation could not be posted. */
  commentError?: unknown;
}

/** The states in which a role runs, so a command that needs the owner's turn is busy. */
const RUNNING: readonly string[] = ["intake", "proposal", "proposal-approved", "design", "design-review", "plan"];
/** The commands the busy reply covers; the others have their own answer in a running state. */
const BUSY_VERBS: readonly KnownVerb[] = ["approve", "revise", "question"];
const AWAITING: readonly string[] = ["awaiting-proposal-approval", "awaiting-design-approval"];
/** How long an open question attempt keeps a work item busy; older ones were left by a crash. */
export const QUESTION_STALE_MS = 30 * 60 * 1000;

type Decision = Pick<CommandOutcome, "error" | "commentError"> & { outcome: CommentOutcome; reply: string | undefined; question?: PendingQuestion };

/**
 * What a comment row holds until its decision is known, inside the transaction that records it,
 * so no one else ever sees it.
 */
const UNDECIDED: CommentOutcome = "refused";

export async function handleCommand(ctx: CommandContext, issueNumber: number, commentId: number): Promise<CommandOutcome> {
  const comment = await readComment(ctx, commentId);
  if (comment.author.toLowerCase() !== ctx.target.owner.toLowerCase()) {
    throw new InvalidCommand(`comment ${String(commentId)} is by ${comment.author}, not by the owner ${ctx.target.owner}`);
  }
  if (comment.issueNumber !== issueNumber) {
    throw new InvalidCommand(`comment ${String(commentId)} is on #${String(comment.issueNumber)}, not on issue #${String(issueNumber)}`);
  }
  const command = parseCommand(comment.body);
  if (command === undefined) throw new InvalidCommand(`comment ${String(commentId)} has no command on its first line`);

  try {
    const decided = await inTransaction(ctx.db, async (tx) => {
      const workItem = await lockWorkItem(tx, ctx.target.repository, issueNumber);
      const recorded = await recordComment(tx, {
        workItemId: workItem?.id ?? null,
        repository: ctx.target.repository,
        issueNumber,
        githubCommentId: comment.id,
        author: comment.author,
        verb: command.written,
        body: comment.body,
        outcome: UNDECIDED,
        stateMet: workItem?.state ?? null,
      });
      if (recorded === undefined) return { workItem, decision: undefined };
      const decision = await decide({ ...ctx, db: tx }, command, workItem, recorded);
      if (decision.outcome !== recorded.outcome) await setCommentOutcome(tx, recorded.id, decision.outcome);
      return { workItem, decision };
    });
    const { workItem, decision } = decided;
    if (decision === undefined) return { outcome: "duplicate", command, workItem };
    if (decision.reply !== undefined) await ctx.forge.comment(issueNumber, decision.reply);
    // A question's session runs after the commit, off the lock; its answer is the one reply.
    const error = decision.question === undefined ? decision.error : await answerQuestion(ctx, decision.question);
    const { outcome, commentError } = decision;
    return { outcome, command, workItem, ...(error === undefined ? {} : { error }), ...(commentError === undefined ? {} : { commentError }) };
  } catch (error) {
    throw new CommandFailed(command, error);
  }
}

async function readComment(ctx: CommandContext, commentId: number): Promise<IssueComment> {
  try {
    return await ctx.forge.getComment(commentId);
  } catch (error) {
    if (error instanceof ForgeError && error.kind === "not-found") throw new InvalidCommand(`comment ${String(commentId)} not found`);
    throw error;
  }
}

async function decide(ctx: CommandContext, command: Command, workItem: WorkItemRow | undefined, recorded: CommentRow): Promise<Decision> {
  const { verb } = command;
  if (verb === "unknown") return { outcome: "unknown", reply: unknownReply(command) };
  if (verb === "help") return { outcome: "applied", reply: helpReply() };
  if (verb === "status") return { outcome: "applied", reply: statusReply(await statusFigures(ctx, workItem)) };

  const state = workItem?.state;
  if (state !== undefined && RUNNING.includes(state) && BUSY_VERBS.includes(verb)) return { outcome: "busy", reply: busyReply(state, command) };
  switch (verb) {
    case "approve":
      return decideApprove(ctx, workItem);
    case "revise":
      return decideRevise(ctx, command, workItem);
    case "question":
      return decideQuestion(ctx, command, workItem, recorded);
    default:
      return { outcome: "refused", reply: notYetAvailableReply(command) };
  }
}

async function decideApprove(ctx: CommandContext, workItem: WorkItemRow | undefined): Promise<Decision> {
  const refused = await notAwaiting(ctx, workItem);
  if (refused !== undefined) return refused;
  if (workItem === undefined) throw new Error("unreachable: no work item awaits");

  // The approval is closed with the owner's login as the target spells it.
  const result = await ctx.approve(workItem, ctx.target.owner, ctx.db);
  switch (result.kind) {
    case "resumed":
      // A proposal's approval is confirmed by Approved, which the execution runs next; a design's
      // by the approver. Either way, that confirmation is the one reply.
      return { outcome: "applied", reply: undefined, ...(result.commentError === undefined ? {} : { commentError: result.commentError }) };
    case "nothing-awaits":
      return { outcome: "refused", reply: nothingAwaitsReply(workItem) };
    case "resume-failed":
      return { outcome: "refused", reply: resumeFailedReply(workItem, result.approval), error: result.error };
  }
}

/**
 * `/revise` (add-approval-feedback design, "Command handler: /revise"): refused without text,
 * after the stage's 5th applied revision, or when the cost so far plus the author's per-attempt
 * budget exceeds the target's; otherwise the reviser closes the approval as `revise`, moves the
 * work item back and resumes the execution.
 */
async function decideRevise(ctx: CommandContext, command: Command, workItem: WorkItemRow | undefined): Promise<Decision> {
  const refused = await notAwaiting(ctx, workItem);
  if (refused !== undefined) return refused;
  if (workItem === undefined) throw new Error("unreachable: no work item awaits");
  const stage = stageOf(workItem);

  if (command.text === "") return { outcome: "refused", reply: reviseNeedsTextReply(command) };
  const revisions = (await stageComments(ctx.db, workItem.id, stage)).filter((comment) => comment.verb === "revise");
  if (revisions.length >= MAX_REVISIONS) return { outcome: "refused", reply: revisionLimitReply(command, workItem, stage, MAX_REVISIONS) };
  const overBudget = await budgetRefusal(ctx, command, workItem, authorOf(ctx, stage).maxBudgetUsd);
  if (overBudget !== undefined) return overBudget;

  const result = await ctx.revise(workItem, ctx.target.owner, ctx.db);
  switch (result.kind) {
    case "revised":
      return { outcome: "applied", reply: revisedReply(workItem, stage) };
    case "nothing-awaits":
      return { outcome: "refused", reply: nothingAwaitsReply(workItem) };
    case "resume-failed":
      return { outcome: "refused", reply: reviseFailedReply(workItem, stage), error: result.error };
  }
}

/**
 * `/question` (add-approval-feedback design, "Command handler: /question"): refused without text,
 * after the stage's 10th question, or over the budget; busy while another question's attempt is
 * open, unless that one is older than 30 minutes, which is then closed as abandoned. Otherwise its
 * attempt is opened here, under the lock, and the session runs after the commit.
 */
async function decideQuestion(ctx: CommandContext, command: Command, workItem: WorkItemRow | undefined, recorded: CommentRow): Promise<Decision> {
  const refused = await notAwaiting(ctx, workItem);
  if (refused !== undefined) return refused;
  if (workItem === undefined) throw new Error("unreachable: no work item awaits");
  const stage = stageOf(workItem);

  if (command.text === "") return { outcome: "refused", reply: questionNeedsTextReply(command) };
  const open = await openQuestionAttempt(ctx.db, workItem.id);
  if (open !== undefined) {
    if (Date.now() - open.startedAt.getTime() < QUESTION_STALE_MS) return { outcome: "busy", reply: questionBusyReply(command) };
    await closeAttempt(ctx.db, open.id, { outcome: "failed", failureReason: "abandoned" });
  }
  const asked = (await stageQuestions(ctx.db, workItem.id, stage)).filter(({ attempt }) => attempt?.outcome !== "failed");
  if (asked.length >= MAX_QUESTIONS) return { outcome: "refused", reply: questionLimitReply(command, workItem, stage, MAX_QUESTIONS) };
  const overBudget = await budgetRefusal(ctx, command, workItem, QUESTION_BUDGET_USD);
  if (overBudget !== undefined) return overBudget;

  const author = authorOf(ctx, stage);
  const approval = await findOpenApproval(ctx.db, workItem.id);
  const attempt = await openAttempt(ctx.db, { workItemId: workItem.id, state: `${stage}-question`, role: author.name, commentIds: [recorded.id] });
  return { outcome: "applied", reply: undefined, question: { command, workItem, stage, author, attempt, approvalId: approval?.id } };
}

/** The reply for a `/approve`, `/revise` or `/question` when nothing awaits approval; undefined when something does. */
async function notAwaiting(ctx: CommandContext, workItem: WorkItemRow | undefined): Promise<Decision | undefined> {
  if (workItem === undefined) return { outcome: "refused", reply: nothingAwaitsReply(undefined) };
  if (workItem.state === "pr-open") {
    const pr = await ctx.forge.findPullRequest(workItem.branch);
    return { outcome: "refused", reply: pullRequestOpenReply(workItem, pr?.url) };
  }
  if (!AWAITING.includes(workItem.state)) return { outcome: "refused", reply: nothingAwaitsReply(workItem) };
  return undefined;
}

/** The refusal when the work item's cost so far plus a session's budget exceeds the target's budget. */
async function budgetRefusal(ctx: CommandContext, command: Command, workItem: WorkItemRow, sessionUsd: number): Promise<Decision | undefined> {
  const cost = await workItemCost(ctx.db, workItem.id);
  if (cost + sessionUsd <= ctx.target.budgetUsd) return undefined;
  return { outcome: "refused", reply: overBudgetReply(command, cost, sessionUsd, ctx.target.budgetUsd) };
}

function stageOf(workItem: WorkItemRow): Stage {
  return workItem.state === "awaiting-design-approval" ? "design" : "proposal";
}

function authorOf(ctx: CommandContext, stage: Stage): Role {
  return stage === "design" ? ctx.question.architect : ctx.question.proposalAuthor;
}
