import {
  abortOpenAttempts,
  adoptWorkItem,
  closeApproval,
  createWorkItem,
  findWorkItemByChangeId,
  findWorkItemByIssue,
  inTransaction,
  IssueHasWorkItem,
  listTasks,
  setWorkItemState,
  type WorkItemRow,
} from "@ceh/factory-ledger";
import { deriveChangeId } from "./change-id.ts";
import type { HandlerContext, Transition, WorkItemState } from "./handler.ts";

/** The input of the Intake state: only the issue, since no work item exists yet. */
export interface IntakeItem {
  issueNumber: number;
  /** The Step Functions execution running this Intake; absent in a local run. */
  executionArn?: string;
}

/** Posted on an issue that states no requirement. */
export const MISSING_REQUIREMENT_COMMENT =
  "The factory cannot start on this issue: its description is empty. Please state the requirement (what should change and why) in the issue body, then run the factory again.";

const INTAKE: WorkItemState = "intake";
const NEXT: WorkItemState = "proposal";

/**
 * Intake: checks that the issue states a requirement, derives the change id, creates the
 * work item in the ledger and the branch on the remote, and moves the work item to Proposal.
 *
 * Idempotent: the ledger row is written first, in state `intake`, and the branch second.
 * A re-run after a crash between the two finds the row and only creates the branch, so it
 * never leaves an orphan branch or derives a second change id.
 *
 * In the cloud, the work item belongs to the execution that created it. Intake for another
 * execution (the issue relabelled, or a delivery repeated) returns `duplicate` and changes
 * nothing; so does one whose insert loses to a concurrent Intake on the repository's unique
 * issue number. The work item belongs to the target's repository: another repository may hold
 * the same issue number and the same change id. A relabelled issue's Intake comments once that
 * `/resume` continues the work item (add-work-item-resume).
 */
export async function intake(ctx: HandlerContext, item: IntakeItem): Promise<Transition> {
  const { db, forge } = ctx;
  const { repository } = ctx.target;

  const existing = await findWorkItemByIssue(db, repository, item.issueNumber);
  if (existing !== undefined) return isOtherExecution(existing, item) ? duplicate(ctx, existing) : finish(ctx, existing);

  const issue = await forge.getIssue(item.issueNumber);
  if (issue.body.trim() === "") {
    await forge.comment(issue.number, MISSING_REQUIREMENT_COMMENT);
    return { kind: "reject", reason: `issue #${String(issue.number)} states no requirement: its body is empty` };
  }

  const changeId = await deriveChangeId(
    issue.title,
    async (id) => (await findWorkItemByChangeId(db, repository, id)) !== undefined || (await forge.branchExists(id)),
  );
  let created: WorkItemRow;
  try {
    created = await createWorkItem(db, {
      repository,
      issueNumber: issue.number,
      changeId,
      branch: changeId,
      state: INTAKE,
      ...(item.executionArn === undefined ? {} : { executionArn: item.executionArn }),
    });
  } catch (error) {
    if (!(error instanceof IssueHasWorkItem)) throw error;
    const winner = await findWorkItemByIssue(db, repository, item.issueNumber);
    if (winner === undefined) throw error;
    return isOtherExecution(winner, item) ? duplicate(ctx, winner) : finish(ctx, winner);
  }
  return finish(ctx, created);
}

/** The input of Adopt (`intake --resume`): the issue, and the execution a `/resume` started. */
export interface AdoptItem {
  issueNumber: number;
  executionArn: string;
}

/** The states a resumed execution enters, as the state machine's entry Choice names them. */
export type Entry = "proposal" | "await-approval" | "approved" | "design" | "await-design" | "plan" | "build";
export const ENTRIES: readonly Entry[] = ["proposal", "await-approval", "approved", "design", "await-design", "plan", "build"];

/**
 * - `entered`: the work item belongs to the new execution and is in the entry's state; `tasks` are
 *   its unfinished task ids for `build`, and empty otherwise.
 * - `ended`: there is nothing to resume (no work item, its pull request is open, or no entry);
 *   the execution ends (exit 4).
 */
export type Adoption = { kind: "entered"; workItem: WorkItemRow; entry: Entry; tasks: string[] } | { kind: "ended"; reason: string };

/** Where a resume enters for the state a work item is in, or stopped in, and the state that entry runs in. */
const ENTRY: Partial<Record<string, { entry: Entry; state: WorkItemState }>> = {
  // Intake writes the row before the branch: Adopt creates the branch, if it is missing, and goes to Proposal.
  intake: { entry: "proposal", state: "proposal" },
  proposal: { entry: "proposal", state: "proposal" },
  "awaiting-proposal-approval": { entry: "await-approval", state: "awaiting-proposal-approval" },
  "proposal-approved": { entry: "approved", state: "proposal-approved" },
  design: { entry: "design", state: "design" },
  "design-review": { entry: "design", state: "design-review" },
  "awaiting-design-approval": { entry: "await-design", state: "awaiting-design-approval" },
  plan: { entry: "plan", state: "plan" },
  build: { entry: "build", state: "build" },
};

const STOPPED: readonly string[] = ["aborted", "escalated"];

/**
 * Adopt (`intake --resume`; add-work-item-resume design, "Adopt"): the execution a `/resume`
 * started takes the issue's work item over. The entry is the work item's state, or for an aborted
 * or escalated one the state it stopped in. A dead execution may have left an attempt or an
 * approval open (one stopped outside the factory): they are closed `aborted`, so they count for
 * nothing and a new approval can open. Then the new execution's ARN is stored and the work item
 * moves to its entry's state (compare-and-set), clearing `stopped_in`; an escalated one's
 * design-flaw count starts again. A repeated Adopt of the same execution answers the same.
 */
export async function adopt(ctx: HandlerContext, item: AdoptItem): Promise<Adoption> {
  const workItem = await findWorkItemByIssue(ctx.db, ctx.target.repository, item.issueNumber);
  if (workItem === undefined) return { kind: "ended", reason: `issue #${String(item.issueNumber)} has no work item to resume` };
  const source = STOPPED.includes(workItem.state) ? workItem.stoppedIn : workItem.state;
  const target = source === null ? undefined : ENTRY[source];
  if (target === undefined) {
    const stopped = workItem.stoppedIn === null ? "" : `, stopped in ${workItem.stoppedIn}`;
    return { kind: "ended", reason: `work item ${workItem.changeId} is ${workItem.state}${stopped}, where no resume enters` };
  }

  let adopted = workItem;
  if (workItem.executionArn !== item.executionArn || workItem.state !== target.state) {
    if (source === "intake") await ctx.forge.createBranch(workItem.branch);
    adopted = await inTransaction(ctx.db, async (tx) => {
      await abortOpenAttempts(tx, workItem.id);
      await closeApproval(tx, workItem.id, ctx.target.owner, "aborted");
      return adoptWorkItem(tx, workItem.id, { from: workItem.state, to: target.state, executionArn: item.executionArn, freshDesignFlaws: workItem.state === "escalated" });
    });
  }
  const tasks = target.entry === "build" ? (await listTasks(ctx.db, adopted.id)).filter((task) => task.status === "pending").map((task) => task.taskId) : [];
  return { kind: "entered", workItem: adopted, entry: target.entry, tasks };
}

/** A relabelled issue's Intake: one comment that `/resume` continues the work item, and nothing else. */
async function duplicate(ctx: HandlerContext, workItem: WorkItemRow): Promise<Transition> {
  await ctx.forge.comment(
    workItem.issueNumber,
    `This issue already has the work item \`${workItem.changeId}\` (\`${workItem.state}\`), so labelling it again starts nothing new. Reply \`/resume\` to continue it.`,
  );
  return { kind: "duplicate", workItem };
}

/** A cloud Intake whose execution did not create the work item. A local run owns any work item. */
function isOtherExecution(workItem: WorkItemRow, item: IntakeItem): boolean {
  return item.executionArn !== undefined && workItem.executionArn !== item.executionArn;
}

/** Creates the branch (a no-op if it exists) and advances a work item still in Intake. */
async function finish(ctx: HandlerContext, workItem: WorkItemRow): Promise<Transition> {
  if (workItem.state !== INTAKE) return { kind: "advance", workItem };
  await ctx.forge.createBranch(workItem.branch);
  return { kind: "advance", workItem: await setWorkItemState(ctx.db, workItem.id, NEXT, { from: INTAKE }) };
}
