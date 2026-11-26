/**
 * What a `/resume` means to the states after it (add-work-item-resume design, "Retry counts" and
 * "Owner guidance"), read from the ledger only:
 * - An attempt closed `aborted` never counts toward a retry limit.
 * - A `/resume` of an escalated work item gives its escalated state a fresh set of retries:
 *   attempts before it no longer count. A `/resume` of an aborted work item does not: its failed
 *   attempts still count, so an abort cannot be used to retry for free.
 * - The `/resume` text reaches the first role that runs after it, once.
 */
import { listAttempts, listComments, type AttemptRow, type CommentRow, type Db } from "@ceh/factory-ledger";
import { commandText } from "./feedback.ts";

/** The question sessions, which run beside the execution: they never take the guidance. */
const QUESTION_STATES: readonly string[] = ["proposal-question", "design-question"];

/** The work item's latest applied `/resume`. */
export async function latestResume(db: Db, workItemId: string): Promise<CommentRow | undefined> {
  return (await listComments(db, workItemId)).filter((comment) => comment.verb === "resume" && comment.outcome === "applied").at(-1);
}

/** When the retry counts start again: the latest applied `/resume` that met the work item escalated. */
export async function retriesSince(db: Db, workItemId: string): Promise<Date | undefined> {
  const resumes = (await listComments(db, workItemId)).filter((comment) => comment.verb === "resume" && comment.outcome === "applied" && comment.stateMet === "escalated");
  return resumes.at(-1)?.receivedAt;
}

/** Whether an attempt counts toward a retry limit counted from `since`: not aborted, and started after it. */
export function counts(attempt: AttemptRow, since: Date | undefined): boolean {
  return attempt.outcome !== "aborted" && (since === undefined || attempt.startedAt > since);
}

/** The `/resume` text for the role about to run, and the comment its attempt names. */
export interface ResumeGuidance {
  text: string;
  commentId: string;
}

/**
 * The latest `/resume`'s text, while no role has run since it; undefined for a `/resume` without
 * text, or once a role (not a question session) has started an attempt after it.
 */
export async function resumeGuidance(db: Db, workItemId: string): Promise<ResumeGuidance | undefined> {
  const resume = await latestResume(db, workItemId);
  if (resume === undefined) return undefined;
  const text = commandText(resume);
  if (text === "") return undefined;
  const since = (await listAttempts(db, workItemId)).some((attempt) => !QUESTION_STATES.includes(attempt.state) && attempt.startedAt > resume.receivedAt);
  return since ? undefined : { text, commentId: resume.id };
}
