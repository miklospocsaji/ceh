# Proposal

## Why

The proposal author and the architect read only the issue. The owner's answers to a proposal's open questions, and any other feedback, reach them only by editing the issue body, and a proposal already written never sees that edit. The owner also cannot ask why a proposal or design says what it says, short of reading the branch and guessing (`docs/m3.5-owner-commands.md`, section 1). This is the second M3.5 change (section 10), built on `add-owner-commands`. It is what the owner meets on every work item, so it comes before `add-work-item-resume`.

## What Changes

- **`/revise <text>` while a proposal or a `large` design awaits approval** (section 4):
  - The `command` task resumes the paused approval's token with `{ "decision": "revise" }`, closes the approval with the outcome `revise`, and puts the work item back in `proposal` (or `design`). A Choice after AwaitApproval (AwaitDesignApproval) sends the same execution back to Proposal (Design). `/approve` now resumes with `{ "decision": "approve" }`.
  - The author runs again on the branch head, so the owner's own edits on the branch are kept. Its input adds, fenced as the owner's feedback, **all** the owner's applied `/revise` comments for that stage, oldest first, and the stage's `/question`s with their answers. Its prompt says to answer what was asked, change only what the feedback touches, and move answered open questions out of the open questions. Its result says what changed.
  - A new commit follows, the summary is posted again with "What changed", and the approval is asked again.
  - Only the revised role sees the comments; later roles see only the artifacts.
  - A revised proposal may change `x-complexity`; Approved routes on the new value.
  - A revision is a new attempt of the same state (`n` goes on), with its own count of 3 attempts, and its cost counts toward the work item's.
  - At most 5 revisions per stage: the 6th is refused with a reply that suggests a new issue. A `/revise` without text is refused.
- **`/question <text>` while a proposal or a `large` design awaits approval** (section 5):
  - The execution is not touched: the approval stays open with its token. The `command` task runs the answer itself and posts it, naming the commit it read.
  - The answer is a read-only session of the awaiting stage's author (proposal author or architect): the role's model and prompt with a question overlay, the tools `Read`, `Grep` and `Glob` only, no writable paths, no `WebFetch`, structured output `{ answer }`, a fresh clone of the branch head, 10 turns and $0.30.
  - Its input: the issue, the change files at the branch head, the stage's `/revise` comments, earlier questions and answers of the stage, and the new question.
  - One question at a time per work item, at most 10 per stage; a `/question` without text is refused. An `/approve` or `/revise` during an answer goes through at once.
  - The answer is an attempt in state `proposal-question` or `design-question`, linked to its comment.
- **Replies outside an approval** (section 6): `/revise` and `/question` with no work item, during `build`, or with the pull request open are answered and change nothing; while a role runs they get the busy reply (already in `add-owner-commands`).
- **The summary comment** ends with the commands that apply: "Reply `/approve`, `/revise` with your answers or the changes you want, or `/question` to ask about it."
- **Ledger** (migration `0006_approval_feedback.sql`): approvals gain an outcome (`approved` or `revise`); attempts gain `comment_ids`, the commands the role was given.
- **Budget:** a `/revise` or `/question` is refused when the work item's estimated cost so far plus the session's budget would exceed the target's per-work-item budget ($5 for `vocab`).
- Local runs: `pnpm factory command` applies `/revise` and `/question` to a local work item; `pnpm factory run` then goes on with the revision.

Out of scope:
- `/abort`, `/resume` and the closed issue (`add-work-item-resume`)
- `/restart`, sending an approved proposal back (left out of M3.5 by the owner)
- questions while a role runs, or about an escalated or aborted work item ("why did the build fail?")
- revising a `medium` design, which the design reviewer decides; the owner can only `/abort` it (next change)
- keeping a role's transcript between sessions: an answer comes from the artifacts, as a new colleague would give it
- enforcing the per-work-item budget elsewhere (M6); only the two new commands check it

## Capabilities

### New Capabilities

### Modified Capabilities
- `orchestration`: `/revise` and `/question` in the command handler, the decision Choices after both approval waits, the revision limits, the approval outcomes, the question attempts, the summary's commands.
- `roles`: the revision input and prompt of the proposal author and the architect, the read-only question mode of both, the owner's comments fenced as data.

## Impact

- `factory/orchestrator`: the `/revise` and `/question` branches of the command handler; Proposal and Design take the stage's comments; the summary's "What changed" and commands; `state-machine.ts` gains two Choices.
- `factory/roles`: the question mode built from a role config, overlays for revision and question in `factory/roles/`, prompt sections for the owner's feedback; the authors' prompts ask them to record their reasons.
- `factory/artifacts`: `whatChanged` on the proposal and design results, a `QuestionAnswer` schema.
- `factory/ledger`: migration `0006_approval_feedback.sql` and its queries.
- `factory/cli`: local revision and question through `pnpm factory command`.
- `infra`: the state machine's definition changes; no new resources or IAM.
- Docs: amendments to ADR 0015 and ADR 0002, `CLAUDE.md`.
- Running cost: each revision is a full author session (up to $1.50), each answer up to $0.30, all within the work item's $5.
- Tagged `large`: two capabilities, a ledger migration, a state machine change, and owner text reaching role prompts (a security boundary).
