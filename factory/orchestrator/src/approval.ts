/**
 * The owner's approvals in the cloud, and escalation of a crashed worker (add-cloud-proposal-run
 * and add-build-loop designs, "Worker states"):
 * - AwaitApproval stores the task token, then posts the summary, so the owner cannot reply to a
 *   summary before its token exists. It serves the proposal and, for a `large` change, the design.
 * - `/approve`, through the `command` task's handler, closes the open approval, of either kind,
 *   and resumes the execution with its token. If resuming fails, the approval is reopened, so the
 *   owner can try again. A resumed design approval is confirmed on the issue here; a proposal's is
 *   confirmed by Approved, which follows.
 * - Approved records the outcome and routes the work item on its complexity; Escalate marks the
 *   work item and says why, by a fixed code.
 * Like the other handlers, these are plain async functions with no AWS-specific control flow:
 * Step Functions is behind `TaskTokens`.
 */
import { DesignResult, ProposalResult } from "@ceh/factory-artifacts";
import {
  closeApproval,
  findWorkItemByIssue,
  listAttempts,
  listAttemptUsage,
  openApproval,
  reopenApproval,
  setWorkItemState,
  type ApprovalKind,
  type AttemptRow,
  type AuthMode,
  type Db,
  type WorkItemRow,
} from "@ceh/factory-ledger";
import { readComplexity } from "./change-files.ts";
import { designApprovedReply } from "./commands/replies.ts";
import { escalateWith } from "./escalation.ts";
import type { EscalationReason } from "./exit-codes.ts";
import type { HandlerContext, Transition, WorkItemState } from "./handler.ts";
import { renderDesignSummary, renderProposalSummary, type ProposalCost } from "./summary.ts";

/** Resumes or fails a paused Step Functions task: SendTaskSuccess and SendTaskFailure. */
export interface TaskTokens {
  succeed(taskToken: string, output: string): Promise<void>;
  fail(taskToken: string, error: string, cause: string): Promise<void>;
}

const PROPOSAL: WorkItemState = "proposal";
const AWAITING: WorkItemState = "awaiting-proposal-approval";
const AWAITING_DESIGN: WorkItemState = "awaiting-design-approval";
const APPROVED: WorkItemState = "proposal-approved";
const ESCALATED: WorkItemState = "escalated";

/** A state's input that does not fit the work item; the worker exits 2. */
export class NotApplicable extends Error {
  override readonly name = "NotApplicable";
}

export interface AwaitApprovalContext extends HandlerContext {
  /** The change's `proposal.md` from the pushed branch, if it can be read. */
  readProposal?: (workItem: WorkItemRow) => Promise<string | undefined>;
}

/**
 * Stores an open approval of the given kind with the task token, then posts the summary with
 * the cost and the approval instruction. The work item stays where it is: for a proposal
 * `awaiting-proposal-approval`, for a design `awaiting-design-approval`.
 */
export async function awaitApproval(ctx: AwaitApprovalContext, workItem: WorkItemRow, taskToken: string, kind: ApprovalKind = "proposal"): Promise<WorkItemRow> {
  const awaiting = kind === "design" ? AWAITING_DESIGN : AWAITING;
  if (workItem.state !== awaiting) {
    throw new NotApplicable(`work item ${workItem.changeId} is ${workItem.state}, not ${awaiting}`);
  }
  const body = kind === "design" ? await designSummary(ctx, workItem) : await proposalSummary(ctx, workItem);
  await openApproval(ctx.db, { workItemId: workItem.id, taskToken, kind });
  await ctx.forge.comment(workItem.issueNumber, body);
  return workItem;
}

async function proposalSummary(ctx: AwaitApprovalContext, workItem: WorkItemRow): Promise<string> {
  const { result, whatChanged } = await proposalResult(ctx, workItem);
  const cost = await proposalCost(ctx, workItem);
  const proposal = await ctx.readProposal?.(workItem);
  return renderProposalSummary({
    changeId: workItem.changeId,
    branch: workItem.branch,
    result,
    ...(proposal === undefined ? {} : { proposal }),
    cost,
    askForApproval: true,
    ...(whatChanged === undefined ? {} : { whatChanged }),
  });
}

async function designSummary(ctx: AwaitApprovalContext, workItem: WorkItemRow): Promise<string> {
  const accepted = (await listAttempts(ctx.db, workItem.id)).filter((attempt) => attempt.state === "design" && attempt.outcome === "succeeded").at(-1);
  if (accepted === undefined) throw new Error(`work item ${workItem.changeId} has no succeeded design attempt`);
  const result = DesignResult.parse(accepted.result);
  const whatChanged = revisedWhatChanged(accepted, result.whatChanged);
  return renderDesignSummary({
    changeId: workItem.changeId,
    branch: workItem.branch,
    result,
    cost: await stateCost(ctx, workItem, ["design", "design-review"]),
    ...(whatChanged === undefined ? {} : { whatChanged }),
  });
}

/**
 * - `resumed`: the approval of `approval`'s kind is closed by `by`, and the execution resumed. A
 *   design's approval is confirmed on the issue here; if that comment failed, `commentError` says why.
 * - `nothing-awaits`: there was no open approval; nothing changed.
 * - `resume-failed`: resuming failed; the approval of `approval`'s kind is open again.
 */
export type ApproveOutcome =
  | { kind: "resumed"; workItem: WorkItemRow; approval: ApprovalKind; commentError?: unknown }
  | { kind: "nothing-awaits"; workItem: WorkItemRow }
  | { kind: "resume-failed"; workItem: WorkItemRow; approval: ApprovalKind; error: unknown };

/**
 * Applies the owner's `/approve` to a work item awaiting approval; `by` is the owner's login. It
 * writes through `db`: the command handler's transaction, which holds the work item's lock.
 */
export type Approver = (workItem: WorkItemRow, by: string, db: Db) => Promise<ApproveOutcome>;

export interface ApproveContext extends HandlerContext {
  taskTokens: TaskTokens;
}

/**
 * The output an approved approval's task gets: the decision `approve`, on which the Choice after
 * AwaitApproval (AwaitDesignApproval) goes on (add-approval-feedback design, "State machine").
 */
export const APPROVAL_OUTPUT = JSON.stringify({ decision: "approve" });

/**
 * The effect of the owner's `/approve` in the cloud, for the command handler: closes the open
 * approval, of either kind, and resumes the execution with its token. If resuming fails, the
 * approval is reopened, so the owner can send `/approve` again. The handler checks the state and
 * posts the reply; only a design's confirmation is posted here.
 */
export async function approve(ctx: ApproveContext, workItem: WorkItemRow, by: string): Promise<ApproveOutcome> {
  // A work item no longer awaiting (escalated, say) may still hold an approval whose token is dead.
  if (workItem.state !== AWAITING && workItem.state !== AWAITING_DESIGN) {
    throw new NotApplicable(`work item ${workItem.changeId} is ${workItem.state}, not awaiting approval`);
  }
  const approval = await closeApproval(ctx.db, workItem.id, by, "approved");
  if (approval === undefined) return { kind: "nothing-awaits", workItem };

  try {
    await ctx.taskTokens.succeed(approval.taskToken, APPROVAL_OUTPUT);
  } catch (error) {
    await reopenApproval(ctx.db, approval.id);
    return { kind: "resume-failed", workItem, approval: approval.kind, error };
  }
  if (approval.kind !== "design") return { kind: "resumed", workItem, approval: approval.kind };
  try {
    await ctx.forge.comment(workItem.issueNumber, designApprovedReply(workItem));
  } catch (commentError) {
    // The execution has resumed: the approval went through, whatever the comment.
    return { kind: "resumed", workItem, approval: approval.kind, commentError };
  }
  return { kind: "resumed", workItem, approval: approval.kind };
}

/** `approve` with Step Functions, as the `command` worker task applies it. */
export function cloudApprover(ctx: ApproveContext): Approver {
  return (workItem, by, db) => approve({ ...ctx, db }, workItem, by);
}

export interface ApprovedContext extends HandlerContext {
  /** A file of the change folder on the work item's branch, by its path in the folder; undefined if absent. */
  readChangeFile: (workItem: WorkItemRow, path: string) => Promise<string | undefined>;
}

/** What each complexity goes through after Proposal approval, for the comment. */
const NEXT_STEP = {
  small: "it skips Design and goes to Plan",
  medium: "it goes to Design, then the design reviewer",
  large: "it goes to Design, then waits for your design approval",
} as const;

/**
 * Approved: confirms the approval on the issue, moves the work item to `proposal-approved`, and
 * routes it on the change's `x-complexity`: `small` to Plan, the others to Design. A missing or
 * unknown complexity escalates. A work item there already is routed again with no second
 * comment, so a retried Approved gives the same route. The comment comes before the state, so a
 * crash in between repeats the comment rather than losing it.
 */
export async function approved(ctx: ApprovedContext, workItem: WorkItemRow): Promise<Transition> {
  if (workItem.state !== APPROVED && workItem.state !== AWAITING) {
    throw new NotApplicable(`work item ${workItem.changeId} is ${workItem.state}, not ${AWAITING}`);
  }
  const reading = readComplexity(await ctx.readChangeFile(workItem, ".openspec.yaml"));

  let current = workItem;
  if (workItem.state === AWAITING) {
    const next = reading.ok ? ` As a \`${reading.complexity}\` change, ${NEXT_STEP[reading.complexity]}.` : "";
    await ctx.forge.comment(workItem.issueNumber, `The proposal \`${workItem.changeId}\` is approved. The work item is now \`${APPROVED}\`.${next}`);
    current = await setWorkItemState(ctx.db, workItem.id, APPROVED);
  }

  if (!reading.ok) {
    return escalateWith(
      ctx,
      current,
      `The factory escalated \`${workItem.changeId}\` to the owner: ${reading.problem}. Set \`x-complexity\` to \`small\`, \`medium\` or \`large\` on the branch \`${workItem.branch}\` and start the work item again.`,
      `unknown x-complexity: ${reading.problem}`,
    );
  }
  return { kind: "advance", workItem: current, route: reading.complexity === "small" ? "plan" : "design" };
}

const ESCALATION_SUMMARY: Record<EscalationReason, string> = {
  "worker-failed": "a worker task failed or could not start, and its retries are used up",
  "worker-refused": "a worker task refused its input",
};

/**
 * Escalate: the state machine's answer to an infrastructure failure. Marks the work item
 * `escalated`, if there is one, and comments with the fixed reason code. A work item escalated
 * already is left as it is, with no second comment.
 */
export async function escalateWorkItem(ctx: HandlerContext, issueNumber: number, reason: EscalationReason): Promise<WorkItemRow | undefined> {
  const workItem = await findWorkItemByIssue(ctx.db, ctx.target.repository, issueNumber);
  if (workItem?.state === ESCALATED) return workItem;
  const subject = workItem === undefined ? "this issue" : `\`${workItem.changeId}\``;
  await ctx.forge.comment(
    issueNumber,
    `The factory escalated ${subject} to the owner after an infrastructure failure (\`${reason}\`): ${ESCALATION_SUMMARY[reason]}. The Step Functions execution has the details.`,
  );
  return workItem === undefined ? undefined : setWorkItemState(ctx.db, workItem.id, ESCALATED);
}

/**
 * The result of the work item's last succeeded proposal attempt, stored in the ledger, and what it
 * changed if it was a revision.
 */
export async function proposalResult(ctx: Pick<HandlerContext, "db">, workItem: WorkItemRow): Promise<{ result: ProposalResult; whatChanged: string | undefined }> {
  const succeeded = (await listAttempts(ctx.db, workItem.id)).filter((attempt) => attempt.state === PROPOSAL && attempt.outcome === "succeeded");
  const last = succeeded.at(-1);
  if (last === undefined) throw new Error(`work item ${workItem.changeId} has no succeeded proposal attempt`);
  const result = ProposalResult.parse(last.result);
  return { result, whatChanged: revisedWhatChanged(last, result.whatChanged) };
}

/** A revision's `whatChanged`: only an attempt given the owner's comments is a revision. */
function revisedWhatChanged(attempt: AttemptRow, whatChanged: string | undefined): string | undefined {
  return attempt.commentIds.length > 0 ? whatChanged : undefined;
}

/** Tokens, estimated cost and auth modes over all the work item's proposal attempts. */
export async function proposalCost(ctx: HandlerContext, workItem: WorkItemRow): Promise<ProposalCost> {
  return stateCost(ctx, workItem, [PROPOSAL]);
}

/** Tokens, estimated cost and auth modes over the work item's attempts in the given states. */
export async function stateCost(ctx: HandlerContext, workItem: WorkItemRow, states: readonly string[]): Promise<ProposalCost> {
  const attempts = (await listAttempts(ctx.db, workItem.id)).filter((attempt) => states.includes(attempt.state));
  const ids = new Set(attempts.map((attempt) => attempt.id));
  const usage = (await listAttemptUsage(ctx.db, workItem.id)).filter((row) => ids.has(row.attemptId));
  const sum = (key: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens") => usage.reduce((total, row) => total + row[key], 0);
  const authModes = [...new Set(attempts.flatMap((attempt) => (attempt.authMode === null ? [] : [attempt.authMode])))] as AuthMode[];
  return {
    tokens: { inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), cacheReadTokens: sum("cacheReadTokens"), cacheCreationTokens: sum("cacheCreationTokens") },
    usd: attempts.reduce((total, attempt) => total + (attempt.costUsdEstimate ?? 0), 0),
    authModes,
  };
}

/**
 * - `revised`: the approval of `approval`'s kind is closed as `revise`, the work item is back in
 *   `proposal` or `design`, and the execution resumed with the decision `revise`.
 * - `nothing-awaits`: there was no open approval; nothing changed.
 * - `resume-failed`: resuming failed; the approval is open again and the state restored.
 */
export type ReviseOutcome =
  | { kind: "revised"; workItem: WorkItemRow; approval: ApprovalKind }
  | { kind: "nothing-awaits"; workItem: WorkItemRow }
  | { kind: "resume-failed"; workItem: WorkItemRow; approval: ApprovalKind; error: unknown };

/**
 * Applies the owner's `/revise` to a work item awaiting approval, after the command handler's
 * checks; `by` is the owner's login. It writes through `db`: the handler's transaction.
 */
export type Reviser = (workItem: WorkItemRow, by: string, db: Db) => Promise<ReviseOutcome>;

/**
 * The output a revised approval's task gets: a fixed word, so the execution history holds the
 * decision and never the comment (add-approval-feedback design, "State machine").
 */
export const REVISE_OUTPUT = JSON.stringify({ decision: "revise" });

/** Where a `/revise` sends the work item back to, by the state it awaits approval in. */
const REVISED_STATE: Record<string, WorkItemState> = { [AWAITING]: PROPOSAL, [AWAITING_DESIGN]: "design" };

/**
 * The effect of the owner's `/revise` in the cloud: closes the open approval as `revise`, puts the
 * work item back in `proposal` (or `design`), and resumes the execution with the decision
 * `revise`, which runs Proposal (or Design) again. If resuming fails, the approval is reopened and
 * the state restored, so the owner can send `/revise` again.
 */
export async function revise(ctx: ApproveContext, workItem: WorkItemRow, by: string): Promise<ReviseOutcome> {
  const back = REVISED_STATE[workItem.state];
  if (back === undefined) throw new NotApplicable(`work item ${workItem.changeId} is ${workItem.state}, not awaiting approval`);
  const approval = await closeApproval(ctx.db, workItem.id, by, "revise");
  if (approval === undefined) return { kind: "nothing-awaits", workItem };
  const moved = await setWorkItemState(ctx.db, workItem.id, back);
  try {
    await ctx.taskTokens.succeed(approval.taskToken, REVISE_OUTPUT);
  } catch (error) {
    await reopenApproval(ctx.db, approval.id);
    await setWorkItemState(ctx.db, workItem.id, workItem.state);
    return { kind: "resume-failed", workItem, approval: approval.kind, error };
  }
  return { kind: "revised", workItem: moved, approval: approval.kind };
}

/** `revise` with Step Functions, as the `command` worker task applies it. */
export function cloudReviser(ctx: ApproveContext): Reviser {
  return (workItem, by, db) => revise({ ...ctx, db }, workItem, by);
}
