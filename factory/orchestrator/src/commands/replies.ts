/**
 * The replies to owner commands (add-owner-commands design, "Replies"): fixed templates, with only
 * these values filled in: the verb, the quoted first line, the change id, the state, the pull
 * request's link and the `/status` figures. No error message ever reaches a reply.
 */
import type { WorkItemRow } from "@ceh/factory-ledger";
import { KNOWN_VERBS, type Command, type KnownVerb } from "./parse.ts";

/** How much of a command's first line a reply quotes. */
export const QUOTE_LIMIT = 200;

/** What each command is for, as `/help` lists it (docs/m3.5-owner-commands.md, section 3). */
const HELP: Record<KnownVerb, { when: string; does: string }> = {
  approve: { when: "a proposal or design awaits your approval", does: "approves it, and the work item goes on" },
  revise: { when: "a proposal or design awaits your approval", does: "its author revises it after your text (answers or changes), then asks for your approval again" },
  question: { when: "a proposal or design awaits your approval", does: "its author answers your question; nothing changes, and the approval stays open" },
  abort: { when: "the work item's execution is running", does: "stops it; `/resume` continues it later" },
  resume: { when: "the work item has stopped, the issue is open and no pull request is open", does: "continues it from where it stopped, with your text as guidance" },
  status: { when: "always", does: "replies with the state, the current step, task progress, attempts, cost so far and what the factory waits for" },
  help: { when: "always", does: "replies with this table" },
};

/** Interim, until add-approval-feedback and add-work-item-resume land (design, "Interim replies"). */
const NOT_YET_AVAILABLE: readonly KnownVerb[] = ["revise", "question", "abort", "resume"];

/** The `/help` reply: one table, built from the parser's verbs. */
export function helpReply(): string {
  const rows = KNOWN_VERBS.map((verb) => `| \`/${verb}\` | ${HELP[verb].when} | ${HELP[verb].does} |`);
  return [
    "The factory takes these commands from the owner, on the first line of a comment on this issue:",
    "",
    "| Command | When | What it does |",
    "| --- | --- | --- |",
    ...rows,
    "",
    `${NOT_YET_AVAILABLE.map((verb) => `\`/${verb}\``).join(", ").replace(/, ([^,]*)$/, " and $1")} are not yet available.`,
  ].join("\n");
}

export function unknownReply(command: Command): string {
  return `${inlineCode(cut(`/${command.written}`))} is an unknown command, so nothing was done.\n\n${helpReply()}`;
}

/** The busy reply of docs/m3.5-owner-commands.md section 6, quoting the command's first line. */
export function busyReply(state: string, command: Command): string {
  return `${quote(command)}\n\n\`${state}\` is running, so your \`/${command.written}\` was not applied and is not kept. Send it again when the factory asks for your approval.`;
}

export function notYetAvailableReply(command: Command): string {
  return `${quote(command)}\n\n\`/${command.written}\` is not yet available: the factory cannot act on it yet. Nothing was done.`;
}

/** `/approve` with nothing to approve: no work item, no open approval, or a state that awaits none. */
export function nothingAwaitsReply(workItem: WorkItemRow | undefined): string {
  if (workItem === undefined) return "Nothing awaits approval on this issue: it has no factory work item. Labelling it `factory` starts one.";
  return `Nothing awaits approval: the work item \`${workItem.changeId}\` is \`${workItem.state}\`. \`/status\` says where it stands.`;
}

/** `/approve` once the pull request is open; `url` is undefined if the forge has no open one. */
export function pullRequestOpenReply(workItem: WorkItemRow, url: string | undefined): string {
  const link = url === undefined ? "" : `, at ${url}`;
  return `Nothing awaits approval: the pull request is open for review${link}. The work item \`${workItem.changeId}\` is \`${workItem.state}\`; review and merge it there.`;
}

export function resumeFailedReply(workItem: WorkItemRow, approval: "proposal" | "design"): string {
  const subject = approval === "design" ? `the design of \`${workItem.changeId}\`` : `the proposal \`${workItem.changeId}\``;
  return `Your approval of ${subject} did not go through: the factory could not resume the work item, so it still awaits your approval. Reply \`/approve\` again to retry.`;
}

export function designApprovedReply(workItem: WorkItemRow): string {
  return `The design of \`${workItem.changeId}\` is approved. The work item goes on to Plan.`;
}

/** What the `command` task posts when it fails; `written` is the verb, if the comment could be read. */
export function commandFailedReply(written?: string): string {
  const what = written === undefined ? "command" : `\`/${written}\``;
  return `Your ${what} did not go through: the factory failed while handling it. Send it again.`;
}

/** The `/status` figures, all from the ledger. */
export interface StatusFigures {
  changeId: string;
  state: string;
  /** For `build`, the task being built; otherwise the state. */
  step: string;
  /** Done and live tasks; undefined before a plan. */
  tasks: { done: number; total: number } | undefined;
  attempts: number;
  costUsd: number;
}

export function statusReply(figures: StatusFigures | undefined): string {
  if (figures === undefined) return "This issue has no factory work item. Labelling it `factory` starts one.";
  const { changeId, state, step, tasks, attempts, costUsd } = figures;
  return [
    `Status of \`${changeId}\`:`,
    "",
    `- State: \`${state}\``,
    `- Current step: ${step}`,
    `- Tasks: ${tasks === undefined ? "no plan yet" : `${String(tasks.done)} of ${String(tasks.total)} tasks done`}`,
    `- Attempts: ${String(attempts)} ${attempts === 1 ? "attempt" : "attempts"}`,
    `- Estimated cost so far: $${costUsd.toFixed(2)}`,
    "",
    waitsFor(state),
  ].join("\n");
}

function waitsFor(state: string): string {
  switch (state) {
    case "awaiting-proposal-approval":
      return "The factory waits for your approval of the proposal: reply `/approve`.";
    case "awaiting-design-approval":
      return "The factory waits for your approval of the design: reply `/approve`.";
    case "pr-open":
      return "The factory waits for your review of the pull request.";
    case "escalated":
      return "The factory waits for you: the work item is escalated.";
    default:
      return "Nothing waits for you: the factory is working on it.";
  }
}

function quote(command: Command): string {
  return `Re: ${inlineCode(cut(command.firstLine))}`;
}

function cut(text: string): string {
  return text.length > QUOTE_LIMIT ? text.slice(0, QUOTE_LIMIT) : text;
}

/** Markdown inline code that holds any backticks: a fence one longer than the longest run in it. */
function inlineCode(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  if (longest === 0) return `\`${text}\``;
  const fence = "`".repeat(longest + 1);
  return `${fence} ${text} ${fence}`;
}
