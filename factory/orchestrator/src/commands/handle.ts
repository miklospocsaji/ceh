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
 *    unanswered, and a redelivery does not repeat it: `/status` shows where it stands.
 *
 * | Work item state                  | /approve                      | /revise, /question | /abort, /resume   | /status, /help | unknown |
 * | none                             | refused: nothing awaits       | not yet available  | not yet available | applied        | unknown |
 * | intake … plan (a role runs)      | busy                          | busy               | not yet available | applied        | unknown |
 * | awaiting-{proposal,design}-appr. | applied (refused if none open) | not yet available | not yet available | applied        | unknown |
 * | build, escalated                 | refused: nothing awaits       | not yet available  | not yet available | applied        | unknown |
 * | pr-open                          | refused: the PR is open       | not yet available  | not yet available | applied        | unknown |
 *
 * The busy check comes before "not yet available", so the owner learns the more useful fact first.
 */
import { ForgeError, type IssueComment } from "@ceh/factory-forge";
import { inTransaction, lockWorkItem, recordComment, setCommentOutcome, type CommentOutcome, type WorkItemRow } from "@ceh/factory-ledger";
import type { Approver } from "../approval.ts";
import type { HandlerContext } from "../handler.ts";
import { parseCommand, type Command, type KnownVerb } from "./parse.ts";
import {
  busyReply,
  helpReply,
  notYetAvailableReply,
  nothingAwaitsReply,
  pullRequestOpenReply,
  resumeFailedReply,
  statusReply,
  unknownReply,
} from "./replies.ts";
import { statusFigures } from "./status.ts";

export type { Approver as CommandApprover } from "../approval.ts";

export interface CommandContext extends HandlerContext {
  /** Applies an `/approve` to a work item awaiting approval: SendTaskSuccess in the cloud, the local approval in a local run. */
  approve: Approver;
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
  /** An `/approve` whose resume failed: the approval is open again and the reply says so. */
  error?: unknown;
  /** An applied `/approve` of a design whose confirmation could not be posted. */
  commentError?: unknown;
}

/** The states in which a role runs, so a command that needs the owner's turn is busy. */
const RUNNING: readonly string[] = ["intake", "proposal", "proposal-approved", "design", "design-review", "plan"];
/** The commands the busy reply covers; the others have their own answer in a running state. */
const BUSY_VERBS: readonly KnownVerb[] = ["approve", "revise", "question"];
const AWAITING: readonly string[] = ["awaiting-proposal-approval", "awaiting-design-approval"];

type Decision = Pick<CommandOutcome, "error" | "commentError"> & { outcome: CommentOutcome; reply: string | undefined };

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
      const decision = await decide({ ...ctx, db: tx }, command, workItem);
      if (decision.outcome !== recorded.outcome) await setCommentOutcome(tx, recorded.id, decision.outcome);
      return { workItem, decision };
    });
    const { workItem, decision } = decided;
    if (decision === undefined) return { outcome: "duplicate", command, workItem };
    if (decision.reply !== undefined) await ctx.forge.comment(issueNumber, decision.reply);
    const { outcome, error, commentError } = decision;
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

async function decide(ctx: CommandContext, command: Command, workItem: WorkItemRow | undefined): Promise<Decision> {
  const { verb } = command;
  if (verb === "unknown") return { outcome: "unknown", reply: unknownReply(command) };
  if (verb === "help") return { outcome: "applied", reply: helpReply() };
  if (verb === "status") return { outcome: "applied", reply: statusReply(await statusFigures(ctx, workItem)) };

  const state = workItem?.state;
  if (state !== undefined && RUNNING.includes(state) && BUSY_VERBS.includes(verb)) return { outcome: "busy", reply: busyReply(state, command) };
  if (verb !== "approve") return { outcome: "refused", reply: notYetAvailableReply(command) };
  return decideApprove(ctx, workItem);
}

async function decideApprove(ctx: CommandContext, workItem: WorkItemRow | undefined): Promise<Decision> {
  if (workItem === undefined) return { outcome: "refused", reply: nothingAwaitsReply(undefined) };
  if (workItem.state === "pr-open") {
    const pr = await ctx.forge.findPullRequest(workItem.branch);
    return { outcome: "refused", reply: pullRequestOpenReply(workItem, pr?.url) };
  }
  if (!AWAITING.includes(workItem.state)) return { outcome: "refused", reply: nothingAwaitsReply(workItem) };

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
