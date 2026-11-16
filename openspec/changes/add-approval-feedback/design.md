# Design

## Overview

Settled in `docs/m3.5-owner-commands.md`, sections 4 to 6. Built on `add-owner-commands`: both commands are new branches of the command handler, and only `/revise` touches the execution.

```
Proposal ─▶ AwaitApproval ─▶ ApprovalDecision ─┬─ approve ─▶ Approved ─▶ …
   ▲                                           └─ revise ──┐
   └───────────────────────────────────────────────────────┘
Design ─▶ (large, exit 11) AwaitDesignApproval ─▶ DesignApprovalDecision ─┬─ approve ─▶ Plan
   ▲                                                                      └─ revise ──┐
   └──────────────────────────────────────────────────────────────────────────────────┘

/question: command task ─▶ lock, check, open attempt, unlock ─▶ fresh clone ─▶ read-only session ─▶ reply
           (no Step Functions call; the approval and its token are untouched)
```

## Components

### Command handler: `/revise`

Under the work-item lock, in order:

1. State `awaiting-proposal-approval` or `awaiting-design-approval`, with an open approval; otherwise the replies of the state table (busy is already `add-owner-commands`').
2. Refuse (outcome `refused`, reply, nothing else) when: the text is empty; the stage already has 5 applied `/revise` comments; or the work item's estimated cost plus the author role's `maxBudgetUsd` exceeds `target.budget`.
3. Close the approval with outcome `revise` and the owner's login; set the work item to `proposal` (or `design`); record the comment `applied`.
4. `SendTaskSuccess(token, { "decision": "revise" })`. If it fails: reopen the approval, restore the state, set the comment's outcome to `refused`, reply that the revision did not go through and can be repeated.
5. Commit, then reply: the author runs again with the comment, and the factory will ask for approval again.

A stage is identified by the comments' `state_met`: `awaiting-proposal-approval` for the proposal, `awaiting-design-approval` for the design. `/approve` now sends `{ "decision": "approve" }` instead of `{}`.

### Command handler: `/question`

Under the lock: the same state check; refuse when the text is empty, the stage has 10 questions, or the cost plus $0.30 exceeds the budget; busy when the work item has an open `*-question` attempt younger than 30 minutes. An older open one is closed `failed` with reason `abandoned` first, so a crashed task cannot block questions for good. Then open an attempt in state `proposal-question` (or `design-question`), role = the author's name, `comment_ids = [this comment]`; record the comment `applied`; commit and release the lock.

Outside the lock: clone the branch head afresh, note its SHA, build the prompt (issue, change files, the stage's `/revise` comments, earlier Q&A of the stage, the question), run the question session, close the attempt with `{ answer }` or as failed, reply. The reply quotes the question's first line, gives the answer, names the SHA, and says the approval is still open. A failed session replies that the question was not answered and can be asked again.

### Question mode (`factory/roles/src/question.ts`)

`questionRole(author: Role): Role`: the author's `name`, `model`, `prompt` and `authMode`; `tools` and `allow` `[Read, Grep, Glob]`; `writable: []`; `maxTurns: 10`; `maxBudgetUsd: 0.3`; `resultSchema: "question-answer"`; `runsIn: worker`. The system prompt is the author's prompt followed by `factory/roles/overlays/question.md`, which says: answer from the artifacts, issue, specs and code; say when the artifacts record no reason; never claim to have changed anything; point to `/revise` for changes. Read-only comes from the tool list and the empty writable list, not from the overlay; the read guard of ADR 0007 still confines reads to the clone.

### Revision input (`factory/roles/src/prompt.ts`)

`renderPrompt` takes an optional `ownerFeedback: { revisions: Comment[]; questions: { question: Comment; answer: string }[] }`. Each comment is fenced with `untrusted("owner feedback", …, …, "the owner's feedback on the artifact")`, oldest first. On a revision the prompt adds `factory/roles/overlays/revision.md`: answer what was asked, change only what the feedback touches, move answered open questions out, fill `whatChanged`.

`ProposalResult` and `DesignResult` gain `whatChanged: z.string().optional()`. Proposal and Design fail a revision attempt (one whose input had revisions) whose `whatChanged` is missing or blank, with reason `no-what-changed`.

### Proposal and Design

A run of the state is a revision when the stage has applied `/revise` comments newer than the last succeeded attempt of the state. Attempts are counted from the start of the run: for Proposal, attempts after the last applied `/revise` of the stage; for Design, after the later of the last design flaw and the last applied `/revise`. The revision commit is `docs(<change id>): revise the proposal` (or the design's usual subject, with "revise"). Both run on a fresh clone of the branch head, as today, so the owner's pushes are kept.

### Summary (`factory/orchestrator/src/summary.ts`)

After a revision, a "What changed" section from the latest result's `whatChanged`. Both summaries end with: "Reply `/approve`, `/revise` with your answers or the changes you want, or `/question` to ask about it."

### State machine

`AwaitApproval` keeps `Output: { 'decision': $states.result.decision }` and goes to `ApprovalDecision`: `decision = 'revise'` → Proposal with `tries` reset, otherwise → Approved. Likewise `AwaitDesignApproval` → `DesignApprovalDecision`: `revise` → Design, otherwise → Plan. The decision is a fixed word, so the history still carries only pointers and decisions.

### Ledger (`0006_approval_feedback.sql`)

```sql
ALTER TABLE approvals ADD COLUMN outcome text CHECK (outcome IN ('approved', 'revise'));
UPDATE approvals SET outcome = 'approved' WHERE state = 'closed';
ALTER TABLE approvals ADD CONSTRAINT approvals_outcome_closed CHECK ((state = 'closed') = (outcome IS NOT NULL));
ALTER TABLE attempts ADD COLUMN comment_ids bigint[] NOT NULL DEFAULT '{}';   -- comments.id, oldest first
```

Queries: `closeApproval(…, outcome)`, `stageComments(workItemId, stage)`, `stageQuestions(workItemId, stage)` (joined with their attempts' answers), `openQuestionAttempt(workItemId)`.

### Local runs

`/revise` moves the work item back with no token; the next `pnpm factory run` runs the author. `/question` runs the session in the CLI's process, in the subscription mode of ADR 0006.

## Decisions

- **Each revision gets its own 3 attempts.** The documents say a revision is a new attempt with `n` going on, but not how it counts toward the retry limit. Counting from the run's start matches Design's existing reset after a design flaw. Decided here; the owner is told.
- **The budget check.** Section 4 says the $5 budget "applies anyway", but nothing enforces it before M6. The two commands check it before they start a session: cost so far plus the session's cap must stay within `target.budget`. It does not stop a role already running. Decided here; the owner is told.
- **`/approve` sends `{ "decision": "approve" }`** rather than `{}`, so the Choice never compares a missing field.
- **A stale question frees the work item after 30 minutes.** The answer is capped at 10 turns, so 30 minutes is far above a real answer's time.

## Risks

- **Executions started before the deploy run the old definition.** Step Functions keeps an execution on the definition it started with, so a `/revise` to such an execution would send it on to Approved with the work item in `proposal`; Approved then refuses it (exit 2) and the work item escalates. Deploy with no execution paused at an approval, or approve those first.
- **A revision loop costs money.** Five revisions of a proposal can spend up to $7.50 on the role alone; the budget check stops before $5.
- **Answers are not the author's memory.** Section 5 accepts that; the authors' prompts now ask them to record their reasons.

## Contracts

No contracts path in `ceh`; the changed types are `ProposalResult`, `DesignResult` and the new `QuestionAnswer`.

## Decisions that need an ADR

- **ADR 0015 amendment:** `/revise` and `/question`; read-only by construction; the limits and the budget check.
- **ADR 0002 amendment:** the decision Choices after both approval waits; questions answered outside the state machine.

## Owner prerequisites

- Approval of the deploy, with no execution paused at an approval.
- A throwaway `vocab` issue whose proposal will have an open question, for the cloud check, and approval of the GitHub writes on it.
- Model spend: the cloud check spends one revision and one answer, about $2.
