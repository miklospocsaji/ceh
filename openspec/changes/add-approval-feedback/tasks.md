# Tasks

M3.5, change 2 of 3 (`docs/m3.5-owner-commands.md`, section 10), built after `add-owner-commands`. Built by a local Claude Code session in `ceh`; no factory role changes the factory. Unit tests run in `pnpm check` with `FakeForge`, fake SDK sessions, a fake `TaskTokens` and the real local ledger. Each task's tests are written first and fail for the right reason before its code; `pnpm check` is green after every task that writes code. Every deploy, AWS write and GitHub write is confirmed with the owner first.

Scenarios carried unchanged inside MODIFIED requirements keep their existing tests and are not listed below: Valid proposal is committed and pushed, Invalid proposal is retried with evidence, Three failed attempts escalate, Execution waits for approval, Small change skips Design, Medium change gets the agent review, Requested changes reach the architect, Three rejected designs escalate, Issue text is fenced as data. They must still pass, and the coverage run of task 4.4 checks them.

## Step 1: Worker and GitHub App Forge

No Forge or GitHub App change: the handler uses `getComment`, `comment` and `clone`, which exist.

### Roles

- [x] 1.1 Failing tests for `whatChanged` on `ProposalResult` and `DesignResult` and the new `QuestionAnswer` schema in `factory/artifacts`. No scenario on its own.
- [x] 1.2 Write the schemas.
- [x] 1.3 Failing tests for `questionRole` and the question overlay, with a fake session. Scenarios:
  - Question session has only read tools
  - Question session cannot write even when asked
- [x] 1.4 Write `factory/roles/src/question.ts` and `factory/roles/overlays/question.md`.
- [x] 1.5 Failing prompt tests. Scenarios:
  - Revision prompt carries the owner's feedback
  - Owner comment is fenced as data
- [x] 1.6 Write `ownerFeedback` in `renderPrompt` and `factory/roles/overlays/revision.md`. Ask the proposal author and the architect, in their prompts, to record the reasons for their choices (section 5); no scenario.

### Handlers

- [x] 1.7 Failing Proposal and Design tests with fake sessions. Scenarios:
  - Revise sends the proposal back to its author (handler half: attempt 2's input, the commit)
  - Revise sends the design back to the architect (handler half)
  - Revised proposal keeps the owner's branch edits
  - Revision result says what changed
  - Revision gets its own attempts
  - Revision attempt names its comments
  - Later roles do not see the owner's comments
- [x] 1.8 Write the revision run in `proposal.ts` and `design.ts`, and the "What changed" section and the commands in `summary.ts`. Scenario: Summary shows the cost (its text changed).
- [x] 1.9 Failing command-handler tests. Scenarios:
  - Revise without text is refused
  - Sixth revision is refused
  - Revision over the budget is refused
  - Question about the proposal is answered
  - Question about the design is answered by the architect
  - Question that asks for a change changes nothing
  - Question without text is refused
  - Question while another is answered gets the busy reply
  - Eleventh question is refused
  - Failed answer can be asked again
  - Approval during a question goes through
  - Revise during the build is answered
  - Question with the pull request open is answered
  - Question attempt is recorded with its comment
- [x] 1.10 Write the `/revise` and `/question` branches of the command handler, replacing their interim replies.
- [x] 1.11 Failing CLI test, then the code. Scenario: Local revision runs on the next run.

## Step 2: Network and data stack

No network or IAM change.

- [x] 2.1 Failing tests against the local Postgres for migration 0006 and its queries. Scenario: Closed approval records its outcome. Also: approvals closed before the migration read `approved`; a closed approval without an outcome is refused.
- [x] 2.2 Write `factory/ledger/migrations/0006_approval_feedback.sql` and the queries.
- [x] 2.3 Amend ADR 0015 (`/revise`, `/question`, the limits and the budget check).

## Step 3: State machine and Lambdas

The webhook does not change.

- [x] 3.1 Failing tests for `definition()` with the ASL simulator. Scenarios:
  - Approval decision routes the execution
  - Revised proposal routes on its new complexity (with the handler's route)
  - Large design waits for the owner (its text changed)
- [x] 3.2 Write the two Choices in `state-machine.ts`, and `{ "decision": "approve" }` in the `/approve` branch. Amend ADR 0002.

## Step 4: Deploy and cloud check

The M3.5 exit run (section 11) follows the third change. This step checks the revision loop and a question in the cloud.

- [ ] 4.1 `pnpm image:build`, then `pnpm infra:diff`. It must show the state machine's new definition and new images, and no replacement of a stateful resource. Show it to the owner.
- [ ] 4.2 Owner confirms, with no execution paused at an approval; `pnpm infra:deploy`. The first worker task applies migration 0006.
- [ ] 4.3 On a throwaway `vocab` issue the owner agrees to, whose proposal lists an open question: the owner asks a `/question`, then answers the open question with `/revise`. Confirm the answer arrives with the approval open, and the revised proposal reflects the answer, no longer lists the question, and is posted with "What changed". Then `/approve`. Record cost and timings in `design.md` under "Cloud results". Run `pnpm test:cloud`.
- [ ] 4.4 Run `pnpm check`, `pnpm gates coverage --change add-approval-feedback --tests factory`, and `pnpm test:live` for one real question session within its $0.30. Update `CLAUDE.md` ("Cloud runs": `/revise` and `/question`). The change is archived at M3.5's exit.
