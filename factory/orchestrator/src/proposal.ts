/**
 * Proposal: runs the proposal-author role on the work item's worktree until it produces a
 * change that passes `openspec validate --strict` and a result that passes its schema, then
 * commits the change folder and pushes the branch. Failed attempts are retried with their
 * evidence, up to MAX_PROPOSAL_ATTEMPTS in a run; after that, or at once on an
 * `auth-mode-mismatch` (ADR 0006), the work item escalates and the issue gets a comment.
 *
 * A run after the owner's `/revise` is a revision (add-approval-feedback): the worktree starts
 * from the branch head, so the owner's own pushes are kept; the author gets the stage's `/revise`
 * comments and answered questions; its attempts are counted from the latest `/revise`; its result
 * must say what changed; and its commit says it revises the proposal.
 */
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { ProposalResult } from "@ceh/factory-artifacts";
import { closeAttempt, listAttempts, openAttempt, setWorkItemState, type AttemptRow, type WorkItemRow } from "@ceh/factory-ledger";
import { AttemptFailed, type RetryEvidence, type Role, type RunRole, type WorkItem } from "@ceh/factory-roles";
import { changeFiles, currentSpecs, exists } from "./change-files.ts";
import { renderEvidence } from "./evidence.ts";
import { NO_WHAT_CHANGED, revisionRun, saysWhatChanged, stageFeedback, type AttemptFailure } from "./feedback.ts";
import { commitChange, ensureWorktree, resetToRemoteHead, type GitIdentity } from "./git.ts";
import type { HandlerContext, Transition, WorkItemState } from "./handler.ts";

const run = promisify(execFile);

/** The factory's pinned openspec, never one from the worktree. */
const OPENSPEC = resolve(import.meta.dirname, "../../../node_modules/.bin/openspec");

/** Attempts per run of Proposal (the first, or a revision) before the work item escalates. */
export const MAX_PROPOSAL_ATTEMPTS = 3;

const PROPOSAL: WorkItemState = "proposal";
const NEXT: WorkItemState = "awaiting-proposal-approval";
const ESCALATED: WorkItemState = "escalated";

export interface ProposalContext extends HandlerContext {
  /** Runs one attempt of a role; the real one is `createRunner` with a LedgerRecorder. */
  runRole: RunRole;
  /** The proposal-author role. */
  role: Role;
  /** The local clone the work item's worktree is added to. */
  repo: string;
  /** The factory's home directory; defaults to `factoryHome()`. */
  home?: string;
  /** The author and committer of the proposal commit; defaults to `FACTORY_GIT_IDENTITY`. */
  committer?: GitIdentity;
}

export async function proposal(ctx: ProposalContext, item: WorkItemRow): Promise<Transition> {
  if (item.state !== PROPOSAL) return { kind: "advance", workItem: item };
  const { db, forge, runRole, role } = ctx;

  const worktree = await ensureWorktree({
    repo: ctx.repo,
    changeId: item.changeId,
    branch: item.branch,
    ...(ctx.home === undefined ? {} : { home: ctx.home }),
  });
  const stage = await stageFeedback(db, item.id, "proposal");
  const { revision, since } = await revisionRun(db, item.id, PROPOSAL, stage);
  if (revision) await resetToRemoteHead(worktree, item.branch, item.changeId);
  await scaffold(worktree, item.changeId);
  const issue = await forge.getIssue(item.issueNumber);

  // A crash can leave an attempt open; it counts as failed, and toward the run's limit.
  const all = (await listAttempts(db, item.id)).filter((attempt) => attempt.state === PROPOSAL);
  for (const attempt of all.filter(isOpen)) await closeAttempt(db, attempt.id, { outcome: "failed", failureReason: "error" });
  const previous = all.filter((attempt) => since === undefined || attempt.startedAt > since);

  let used = previous.length;
  let last: AttemptFailure | undefined;
  while (used < MAX_PROPOSAL_ATTEMPTS) {
    used += 1;
    const evidence: RetryEvidence | undefined = last === undefined ? undefined : { reason: last.reason, evidence: last.evidence };
    const workItem: WorkItem = {
      id: item.id,
      changeId: item.changeId,
      worktree,
      issue: { title: issue.title, body: issue.body },
      changeFiles: await changeFiles(worktree, item.changeId),
      specs: await currentSpecs(worktree),
      ...(revision ? { ownerFeedback: stage.feedback } : {}),
    };

    const attempt = await openAttempt(db, { workItemId: item.id, state: PROPOSAL, role: role.name, ...(revision ? { commentIds: stage.commentIds } : {}) });
    let result: unknown;
    try {
      result = await runRole(role, workItem, evidence);
    } catch (error) {
      if (!(error instanceof AttemptFailed)) {
        await closeAttempt(db, attempt.id, { outcome: "failed", failureReason: "error" });
        throw error;
      }
      await closeAttempt(db, attempt.id, { outcome: "failed", failureReason: error.reason });
      last = error;
      if (error.reason === "auth-mode-mismatch") break;
      continue;
    }
    // Capabilities are the target's own, so no list checks them: the result must name exactly
    // the change's delta specs (add-target-repositories, "Capabilities are the target's own").
    const mismatch = await capabilityMismatch(worktree, item.changeId, result);
    if (mismatch !== undefined) {
      await closeAttempt(db, attempt.id, { outcome: "failed", failureReason: "invalid-result" });
      last = { reason: "invalid-result", evidence: mismatch };
      continue;
    }
    if (revision && !saysWhatChanged(result)) {
      await closeAttempt(db, attempt.id, { outcome: "failed", failureReason: NO_WHAT_CHANGED.reason });
      last = NO_WHAT_CHANGED;
      continue;
    }
    // The validated result stays on its attempt, so later states (the summary in the cloud) read it from the ledger.
    await closeAttempt(db, attempt.id, { outcome: "succeeded", result });

    await commitChange({
      worktree,
      changeId: item.changeId,
      ...(ctx.committer === undefined ? {} : { identity: ctx.committer }),
      message: revision
        ? `docs(${item.changeId}): revise the proposal\n\nRevised by the ${role.name} role after the owner's /revise on issue #${String(item.issueNumber)}.`
        : `docs(${item.changeId}): propose the change\n\nWritten by the ${role.name} role for issue #${String(item.issueNumber)}.`,
    });
    await forge.pushBranch({ worktree, branch: item.branch });
    return { kind: "advance", workItem: await setWorkItemState(db, item.id, NEXT), result };
  }

  return escalate(ctx, item, used, last);
}

async function escalate(ctx: ProposalContext, item: WorkItemRow, used: number, last: AttemptFailure | undefined): Promise<Transition> {
  const reason = last === undefined ? `no attempts left (${String(used)} used)` : last.reason;
  const summary =
    last?.reason === "auth-mode-mismatch"
      ? `The proposal attempt failed with \`auth-mode-mismatch\`, which is never retried.`
      : `The proposal failed ${String(used)} attempts in a row${last === undefined ? "" : `; the last one failed with \`${last.reason}\``}.`;
  const body = [
    `The factory escalated \`${item.changeId}\` to the owner. ${summary}`,
    ...(last === undefined ? [] : ["Evidence from the last attempt:", renderEvidence(last.evidence)]),
  ].join("\n\n");
  await ctx.forge.comment(item.issueNumber, body);
  const workItem = await setWorkItemState(ctx.db, item.id, ESCALATED);
  return { kind: "escalate", workItem, reason: `proposal escalated after ${String(used)} attempt(s): ${reason}` };
}

/** How the result's capabilities differ from the folders under the change's `specs/`; undefined if they agree. */
async function capabilityMismatch(worktree: string, changeId: string, result: unknown): Promise<string | undefined> {
  const parsed = ProposalResult.safeParse(result);
  if (!parsed.success) return undefined;
  const named = new Set(parsed.data.capabilities);
  const entries = await readdir(join(worktree, "openspec/changes", changeId, "specs"), { withFileTypes: true }).catch(() => []);
  const written = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  const problems = [
    ...[...named].filter((name) => !written.has(name)).map((name) => `The result names the capability \`${name}\`, but the change has no delta spec \`specs/${name}/spec.md\`.`),
    ...[...written].filter((name) => !named.has(name)).map((name) => `The change has a delta spec for \`${name}\`, but the result's capabilities leave it out.`),
  ];
  return problems.length === 0 ? undefined : `${problems.join("\n")}\nName exactly the capabilities the change has delta specs for.`;
}

/** `openspec new change <id>`, unless the change folder exists already (a re-run). */
async function scaffold(worktree: string, changeId: string): Promise<void> {
  if (await exists(join(worktree, "openspec/changes", changeId))) return;
  const env = { ...process.env, OPENSPEC_TELEMETRY: "0", PATH: [dirname(process.execPath), process.env["PATH"] ?? ""].join(delimiter) };
  await run(OPENSPEC, ["new", "change", changeId], { cwd: worktree, env });
}

function isOpen(attempt: AttemptRow): boolean {
  return attempt.endedAt === null;
}
