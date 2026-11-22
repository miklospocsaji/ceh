# Tasks

M3.5, change 3 of 3 (`docs/m3.5-owner-commands.md`, section 10), built after `add-approval-feedback`. Built by a local Claude Code session in `ceh`; no factory role changes the factory. Unit tests run in `pnpm check` with `FakeForge`, fake SDK sessions, fake Step Functions clients and the real local ledger. Each task's tests are written first and fail for the right reason before its code; `pnpm check` is green after every task that writes code. Every deploy, AWS write and GitHub write is confirmed with the owner first.

Scenarios carried unchanged inside MODIFIED requirements keep their existing tests and are not listed below: Labelling an issue starts an execution, Other labels are ignored, Installation token is scoped to the repository, Expiring token is refreshed, Token failures do not leak the token, Commits are authored by the factory's bot. They must still pass, and the coverage run of task 4.6 checks them.

## Step 0: Before building

- [ ] 0.1 Spike, confirmed with the owner first and with no production code, as in `design.md` ("Step 0"): stop an execution while a `.sync` worker task runs, and while a build task runs. Record the stop times, stop codes and signals in `design.md`, then delete the throwaway state machine. If a task does not stop, stop here and settle the fallback with the owner. Scenario: Stopped execution stops its running task (recorded by hand here; proved again in task 4.4).

## Step 1: Worker and GitHub App Forge

No GitHub App change: `issues.closed` is part of the Issues events the App already receives, and `getIssue` gives the issue's state.

### GitHub App requests

Found in `add-approval-feedback`'s cloud check (`design.md`, "GitHub App requests").

- [ ] 1.1 Failing tests for `createInstallationTokenProvider` and `appCommitter` with an injected `fetch` and sleep. Scenarios:
  - Token request is retried after a network error
  - Token request is not retried after a refusal
  - Network failure names its code

  Also: the bot lookup is retried the same way; a 5xx is retried; a cause whose `code` is not a plain code is left out; the four carried scenarios of "The factory acts as its GitHub App" still pass.
- [ ] 1.2 Write the retries and the code in `factory/forge/src/github-app.ts`.
- [ ] 1.3 Failing worker tests, then the code in `factory/worker/src/main.ts`. Scenarios:
  - Command that fails before its handler is answered
  - Command that cannot reach GitHub is logged

### Handlers

- [ ] 1.4 Failing command-handler tests with a fake Step Functions client (stop, describe, start). Scenarios:
  - Abort during the build stops the execution (handler half)
  - Abort while awaiting approval closes the approval
  - Abort with nothing running is answered
  - Resume starts a new execution (handler half)
  - Resume while running is answered
  - Resume on a closed issue is refused
  - Resume with the pull request open is answered
  - Resume with no work item is answered
  - Commands on a stopped work item point to resume
  - Revise during the build points to abort
  - Local work item points to the run command

  Also: a `--closed` task on a work item that is not running does nothing.
- [ ] 1.5 Write the `/abort`, `/resume` and `--closed` branches, replacing their interim replies, and `command --closed` in the worker.
- [ ] 1.6 Failing tests for Adopt (`intake --resume`) and the entry states. Scenarios:
  - Resume at an approval asks again
  - Resume after approval asks for no second approval
  - Resume after an execution failed outside the factory (handler half: Adopt answers `plan`)
  - Resume during the build skips finished tasks (handler half: Adopt answers the unfinished tasks; Step skips the done ones)

  Also: Design for a work item in `design-review` runs only the reviewer; Adopt for a `pr-open` work item answers exit 4.
- [ ] 1.7 Write Adopt in `intake.ts` and the entry checks in Design.
- [ ] 1.8 Failing tests for retry counting and the duplicate comment. Scenarios:
  - Aborted attempt does not count
  - Resumed escalation gets fresh retries
  - Escalation records where the work item stopped
  - Relabelling does not create a second work item (its text changed: the comment)
- [ ] 1.9 Write the counting from the last resume, `stopped_in` on escalation, and the duplicate Intake's comment.
- [ ] 1.10 Failing prompt and build-input tests, then the code. Scenario: Resume guidance reaches the next role.

## Step 2: Network and data stack

No network change.

- [ ] 2.1 Failing tests against the local Postgres for migration 0007 and the compare-and-set update. Scenario: Late write after abort is refused. Also: an `aborted` attempt has no failure reason; an approval closes `aborted`; existing rows are unchanged.
- [ ] 2.2 Write `factory/ledger/migrations/0007_resume.sql` and `setWorkItemState(…, { from })`; pass the expected state from every handler.
- [ ] 2.3 Failing CDK assertion tests, then the stack: the worker's three Step Functions actions and `FACTORY_STATE_MACHINE_ARN`. Scenario: Worker may control only its own executions.
- [ ] 2.4 Write ADR 0016 (resuming work items), with the spike's result, and amend ADR 0003 (the M3.5 ledger) and ADR 0015 (`/abort`, `/resume`, the closed issue).

## Step 3: State machine and Lambdas

- [ ] 3.1 Failing tests for `definition()` with the ASL simulator: the start Choice, Adopt as a token task, the entry Choice into each of the seven entry states, Adopt's exit 4 to Ended, and BuildTasks taking Adopt's `changeId` and `tasks`. Scenarios:
  - Resume during the build skips finished tasks (definition half)
  - Resume after an execution failed outside the factory (definition half)
- [ ] 3.2 Write them in `state-machine.ts`. Amend ADR 0002.
- [ ] 3.3 Failing webhook tests, then the route. Scenarios:
  - Closing the issue stops the work item (webhook half: one `command --issue <n> --closed` task)
  - Reopened issue can be resumed (webhook half: `issues.reopened` starts nothing; the `/resume` does)

## Step 4: Deploy and the M3.5 exit run

- [ ] 4.1 `pnpm image:build`, then `pnpm infra:diff`. It must show the state machine's new definition, the worker's new policy and environment, and new images, and no replacement of a stateful resource. Show it to the owner.
- [ ] 4.2 Owner confirms, with no execution paused that must stay unchanged; `pnpm infra:deploy`. The first worker task applies migration 0007.
- [ ] 4.3 Failing cloud tests, then run them with `pnpm test:cloud`: `/abort` and `/resume` against the deployed stack on a throwaway issue the owner agrees to. Scenarios:
  - Abort during the build stops the execution
  - Resume starts a new execution
  - Closing the issue stops the work item
  - Reopened issue can be resumed
- [ ] 4.4 Cloud test from the spike, against the deployed stack. Scenario: Stopped execution stops its running task.
- [ ] 4.5 Exit run (`docs/m3.5-owner-commands.md`, section 11). The owner files a fresh `vocab` issue whose proposal will ask an open question, and labels it `factory`. Confirm, in order:
  1. A `/question` about the proposal is answered with the approval still open; a `/revise` answering the open question gives a revised proposal that reflects the answer and no longer lists it.
  2. A `/revise` sent while the proposal is being rewritten gets the busy reply and changes nothing.
  3. A comment with no command, and a `/approve` from the second account, produce no reply and no task.
  4. `/status` answers while awaiting approval, and again during Build.
  5. After `/approve`, the owner `/abort`s during Build after at least one task is done, then `/resume`s. The work item reaches a pull request opened by `ceh-app[bot]`, with no task rebuilt that was done before the abort and no second `/approve`.

  Record the comments' links, the reply latencies, the interventions count, cost and wall time in `design.md` under "Exit run".
- [ ] 4.6 Run `pnpm check` and `pnpm gates coverage` with `--tests factory` and `--tests infra` for each of the three M3.5 changes. Tick M3.5 in the brief, update `CLAUDE.md` (no "cannot be resumed" note; the commands under "Cloud runs"), and archive the three changes in order: `pnpm exec openspec archive add-owner-commands --yes`, then `add-approval-feedback`, then `add-work-item-resume`.
