/**
 * The read-only question mode of an author role (add-approval-feedback design, "Question mode"):
 * the author's name, model, prompt and auth mode, with the question overlay after its prompt, the
 * tools Read, Grep and Glob only, no writable paths, no WebFetch, 10 turns and $0.30, and the
 * structured output `{ answer }`. Read-only comes from the tool list and the empty writable list,
 * which the runner's path guard enforces, never from the overlay's words; the read guard of
 * ADR 0007 still confines reads to the clone.
 */
import { QuestionAnswer } from "@ceh/factory-artifacts";
import { RoleConfigSchema, type Role } from "./config.ts";
import { fence, overlay, ownerFeedbackSections, ownerText, untrusted, type OwnerFeedback, type PromptArtifact, type PromptIssue } from "./prompt.ts";

/** A question session's turn cap. */
export const QUESTION_MAX_TURNS = 10;
/** A question session's budget, in USD. */
export const QUESTION_BUDGET_USD = 0.3;
const READ_TOOLS = ["Read", "Grep", "Glob"];

/** The question mode of `author`, the proposal author or the architect. */
export function questionRole(author: Role): Role {
  const config = RoleConfigSchema.parse({
    name: author.name,
    model: author.model,
    runsIn: "worker",
    tools: READ_TOOLS,
    allow: READ_TOOLS,
    writable: [],
    skills: [],
    maxTurns: QUESTION_MAX_TURNS,
    maxBudgetUsd: QUESTION_BUDGET_USD,
    resultSchema: "question-answer",
    authMode: author.authMode,
  });
  return { ...config, prompt: `${author.prompt}\n\n${overlay("question")}`, schema: QuestionAnswer };
}

export interface QuestionPromptInput {
  changeId: string;
  /** The commit of the clone the session reads, which the answer names. */
  commit: string;
  issue: PromptIssue;
  /** The files in `openspec/changes/<changeId>/` at `commit`. */
  changeFiles: PromptArtifact[];
  /** The stage's `/revise` comments and earlier questions with their answers. */
  ownerFeedback: OwnerFeedback;
  /** The new question: the `/question` comment's text. */
  question: string;
}

/** A question session's prompt: the change at the commit, the issue, the stage's feedback so far and the question. */
export function renderQuestionPrompt(input: QuestionPromptInput): string {
  const { changeId, commit, issue, changeFiles, ownerFeedback, question } = input;
  return `${[
    `# Question about work item: ${changeId}`,
    `The change folder is \`openspec/changes/${changeId}/\`, read at commit \`${commit}\`. Your working directory is a clone at that commit.`,
    "## Issue",
    untrusted("issue title", issue.title),
    untrusted("issue body", issue.body),
    "## Change folder",
    ...(changeFiles.length === 0 ? ["The change folder has no files."] : changeFiles.map((file) => `### ${file.path}\n${fence(file.content)}`)),
    ...ownerFeedbackSections(ownerFeedback),
    "## The question",
    ownerText(question),
    "Answer it as structured output `{ answer }`. Change nothing.",
  ].join("\n\n")}\n`;
}
