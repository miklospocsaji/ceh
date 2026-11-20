/**
 * A `/question`'s answer (add-approval-feedback design, "Command handler: /question"), after the
 * command's transaction has committed its attempt: a fresh clone of the branch head, the stage
 * author's read-only question session, the attempt closed with `{ answer }` or as failed, and one
 * reply. The execution and the approval are never touched here.
 */
import { tmpdir } from "node:os";
import { QuestionAnswer } from "@ceh/factory-artifacts";
import { closeAttempt, findOpenApproval, findWorkItemByIssue, type AttemptRow, type Stage, type WorkItemRow } from "@ceh/factory-ledger";
import { AttemptFailed, questionRole, renderQuestionPrompt, type Role } from "@ceh/factory-roles";
import { changeFiles, changeFolder, exists } from "../change-files.ts";
import { stageFeedback } from "../feedback.ts";
import { freshCheckout } from "../git.ts";
import type { CommandContext } from "./handle.ts";
import type { Command } from "./parse.ts";
import { answerFailedReply, answerReply } from "./replies.ts";

/** A question whose attempt is open, decided under the lock, to be answered after the commit. */
export interface PendingQuestion {
  command: Command;
  workItem: WorkItemRow;
  stage: Stage;
  author: Role;
  attempt: AttemptRow;
  /** The approval open when the question was asked; undefined for a local run, which has none. */
  approvalId: string | undefined;
}

/**
 * Answers the question and posts the one reply. A session that ends without a valid answer is a
 * failed attempt with a reply to ask again. Any other failure is also a failed attempt with that
 * reply, and is returned, so the worker exits non-zero; it never rejects.
 */
export async function answerQuestion(ctx: CommandContext, pending: PendingQuestion): Promise<unknown> {
  const { command, workItem, stage, attempt } = pending;
  let answer: string;
  let commit: string;
  try {
    ({ answer, commit } = await runSession(ctx, pending));
  } catch (error) {
    const reason = error instanceof AttemptFailed ? error.reason : "error";
    await closeAttempt(ctx.db, attempt.id, { outcome: "failed", failureReason: reason }).catch(() => undefined);
    await ctx.forge.comment(workItem.issueNumber, answerFailedReply(command, stage));
    return error instanceof AttemptFailed ? undefined : error;
  }
  await closeAttempt(ctx.db, attempt.id, { outcome: "succeeded", result: { answer } });

  // An /approve or /revise may have gone through meanwhile; the answer then says so.
  const now = await findWorkItemByIssue(ctx.db, ctx.target.repository, workItem.issueNumber);
  const open = now === undefined ? undefined : await findOpenApproval(ctx.db, now.id);
  const stillOpen = now?.state === workItem.state && open?.id === pending.approvalId;
  await ctx.forge.comment(workItem.issueNumber, answerReply({ command, workItem, stage, answer, commit, stillOpen, state: now?.state ?? workItem.state }));
  return undefined;
}

async function runSession(ctx: CommandContext, pending: PendingQuestion): Promise<{ answer: string; commit: string }> {
  const { command, workItem, stage, author, attempt } = pending;
  const checkout = await freshCheckout(ctx.forge, workItem.branch, ctx.question.home ?? tmpdir());
  try {
    const issue = await ctx.forge.getIssue(workItem.issueNumber);
    const files = (await exists(`${checkout.worktree}/${changeFolder(workItem.changeId)}`)) ? await changeFiles(checkout.worktree, workItem.changeId) : [];
    const { feedback } = await stageFeedback(ctx.db, workItem.id, stage);
    const prompt = renderQuestionPrompt({
      changeId: workItem.changeId,
      commit: checkout.commit,
      issue: { title: issue.title, body: issue.body },
      changeFiles: files,
      ownerFeedback: feedback,
      question: command.text,
    });
    const result = await ctx.question.runRole(questionRole(author), {
      id: workItem.id,
      changeId: workItem.changeId,
      worktree: checkout.worktree,
      issue: { title: issue.title, body: issue.body },
      changeFiles: files,
      specs: [],
      prompt,
      attemptId: attempt.id,
    });
    const parsed = QuestionAnswer.safeParse(result);
    if (!parsed.success) throw new AttemptFailed("invalid-result", "the answer is not { answer }");
    return { answer: parsed.data.answer, commit: checkout.commit };
  } finally {
    await checkout.dispose();
  }
}
