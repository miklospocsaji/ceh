/**
 * The owner's feedback on a stage (add-approval-feedback design, "Proposal and Design"): what
 * awaits approval is a stage, the proposal or a `large` change's design, and the owner's commands
 * belong to the stage whose approval they met (`comments.state_met`). Only the stage's author
 * gets them: the proposal author the proposal's, the architect the design's.
 */
import { listAttempts, stageComments, stageQuestions, type AttemptRow, type CommentRow, type Db, type FailureReason, type Stage } from "@ceh/factory-ledger";
import type { OwnerFeedback } from "@ceh/factory-roles";
import { parseCommand } from "./commands/parse.ts";

/** Applied revisions per stage before a `/revise` is refused. */
export const MAX_REVISIONS = 5;
/** Questions per stage before a `/question` is refused. */
export const MAX_QUESTIONS = 10;

/** The text of an owner command, after its verb. */
export function commandText(comment: CommentRow): string {
  return parseCommand(comment.body)?.text ?? "";
}

export interface StageFeedback {
  /** The stage's applied `/revise` comments, oldest first. */
  revisions: CommentRow[];
  /** The revisions and the answered questions, as the role's prompt shows them. */
  feedback: OwnerFeedback;
  /** The ids of the comments in `feedback`, oldest first: what the role's attempt names. */
  commentIds: string[];
}

/** The stage's applied `/revise` comments and its answered questions, oldest first. */
export async function stageFeedback(db: Db, workItemId: string, stage: Stage): Promise<StageFeedback> {
  const revisions = (await stageComments(db, workItemId, stage)).filter((comment) => comment.verb === "revise");
  const answered = (await stageQuestions(db, workItemId, stage)).flatMap(({ comment, attempt }) => {
    const answer = answerOf(attempt);
    return answer === undefined ? [] : [{ comment, answer }];
  });
  const commentIds = [...revisions.map((comment) => comment.id), ...answered.map(({ comment }) => comment.id)].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  return {
    revisions,
    feedback: {
      revisions: revisions.map((comment) => ({ text: commandText(comment) })),
      questions: answered.map(({ comment, answer }) => ({ question: { text: commandText(comment) }, answer })),
    },
    commentIds,
  };
}

/** A succeeded question attempt's answer. */
function answerOf(attempt: AttemptRow | undefined): string | undefined {
  if (attempt?.outcome !== "succeeded") return undefined;
  const answer = (attempt.result as { answer?: unknown } | null)?.answer;
  return typeof answer === "string" ? answer : undefined;
}

/**
 * Whether a run of `state` is a revision: the stage has an applied `/revise` newer than the
 * state's last succeeded attempt. `since` is when the latest revision arrived: the run's attempts
 * are counted from it.
 */
export async function revisionRun(db: Db, workItemId: string, state: string, feedback: StageFeedback): Promise<{ revision: boolean; since: Date | undefined }> {
  const latest = feedback.revisions.at(-1);
  if (latest === undefined) return { revision: false, since: undefined };
  const succeeded = (await listAttempts(db, workItemId)).filter((attempt) => attempt.state === state && attempt.outcome === "succeeded").at(-1);
  const revision = succeeded?.endedAt == null || succeeded.endedAt < latest.receivedAt;
  return { revision, since: latest.receivedAt };
}

/** Whether a revision's result says what changed. */
export function saysWhatChanged(result: unknown): boolean {
  const whatChanged = (result as { whatChanged?: unknown } | null)?.whatChanged;
  return typeof whatChanged === "string" && whatChanged.trim() !== "";
}

/** Why an attempt failed, as the ledger records it, with its evidence for the next attempt: the runner's failures and the handlers' own. */
export interface AttemptFailure {
  reason: FailureReason;
  evidence: string;
}

/** A revision attempt whose result does not say what changed. */
export const NO_WHAT_CHANGED: AttemptFailure = {
  reason: "no-what-changed",
  evidence:
    "This run is a revision after the owner's `/revise`, but the result does not say what changed. Fill `whatChanged` with a few sentences, for the owner, on what this revision changed and where.",
};
