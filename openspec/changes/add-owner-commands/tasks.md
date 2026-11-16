# Tasks

M3.5, change 1 of 3 (`docs/m3.5-owner-commands.md`, section 10). Built by a local Claude Code session in `ceh`; no factory role changes the factory. Unit tests run in `pnpm check` with `FakeForge`, fake Step Functions and ECS clients and the real local ledger (`pnpm db:up`). Each task's tests are written first and fail for the right reason before its code; `pnpm check` is green after every task that writes code. Every deploy, AWS write and GitHub write is confirmed with the owner first.

Scenarios carried unchanged inside MODIFIED requirements keep their existing tests and are not listed below, apart from the one whose text changed: Owner's approval resumes the execution, Approval from another user is ignored, Approval with nothing awaiting is answered, Stack settings come from the target config, Stack is tagged for ceh. They must still pass, and the coverage run of task 4.4 checks them.

## Step 1: Worker and GitHub App Forge

### GitHub App

- [x] 1.1 With the owner, confirm in the `ceh-app` settings that the App has Issues read and write and is subscribed to Issue comment and Issues events. No change is expected; record the result here. No scenario.
  - Result (2026-11-15, confirmed by the owner in the App's settings): repository permissions are Issues read and write, Contents read and write, Pull requests read and write and Metadata read-only, as in ADR 0009. The App is subscribed to the Issues and Issue comment events, and its webhook is active with the deployed webhook's URL. No change was made.

### Forge

- [ ] 1.2 Failing contract tests for `getComment(id)` on `FakeForge` and `GitHubForge` (against the fake GitHub API): it returns the id, issue number, author and body; a missing comment rejects with `not-found`; the token never appears in its errors. No scenario of this change.
- [ ] 1.3 Write `IssueComment` and `getComment` in `factory/forge`.

### Parsing and replies

- [ ] 1.4 Failing tests for `parseCommand`: first line only, trimmed; verb up to the first whitespace; text over the following lines; lowercase known verbs; anything else unknown; a body without a leading `/` is not a command. No scenario on its own; the webhook and handler scenarios below rest on it.
- [ ] 1.5 Write `factory/orchestrator/src/commands/parse.ts` and `replies.ts` (the fixed reply templates and the help table).

### Command handler

- [ ] 1.6 Failing handler tests, with `FakeForge`, a fake `TaskTokens` and the real ledger (the ledger rows come in task 2.2, so these tests fail until then too). Scenarios:
  - Command task checks the comment's author and issue
  - Unknown command gets the help text
  - Command while a role runs gets the busy reply
  - Approval during the build is answered
  - Approval with the pull request open is answered
  - Failed resume is reported on the issue
  - Owner's approval resumes the execution (handler half, carried)
  - Approval with nothing awaiting is answered (carried)
- [ ] 1.7 Failing tests for `/status` and `/help`. Scenarios:
  - Status while awaiting approval
  - Status during the build
  - Status with no work item
  - Help lists the commands
- [ ] 1.8 Write `commands/handle.ts` and `commands/status.ts`; fold `approve()` into the `/approve` branch. Until the later M3.5 changes land, `/revise` and `/question` outside a busy state, and `/abort` and `/resume` in every state, get the interim "not yet available" reply (design, "Interim replies"); a test covers it, with no scenario.

### Worker and local CLI

- [ ] 1.9 Failing worker tests: `command --issue <n> --comment <id>` runs the handler and exits 0; `command` without `--comment` exits 2; `approve` is now an unknown state; a crash posts the fixed "did not go through" reply and exits 1. No new scenario; Command task checks the comment's author and issue (worker half: exit 2).
- [ ] 1.10 Write the `command` entry in `factory/worker` and remove `approve` and `APPROVE_FAILED_COMMENT`.
- [ ] 1.11 Failing CLI tests with a `FakeForge` and the local ledger. Scenarios:
  - Local command answers on the issue
  - Local approval by command
- [ ] 1.12 Write `pnpm factory command` in `factory/cli`.

## Step 2: Network and data stack

No network change: the worker, the webhook and their security groups stay as they are.

- [ ] 2.1 Failing tests against the local Postgres for migration 0005 and its queries. Scenarios:
  - Command is recorded with its outcome
  - Redelivered command is applied once
  - Interventions count only commands that act
  - Two approvals at once resume the execution once (two handler calls on two connections, started together)
- [ ] 2.2 Write `factory/ledger/migrations/0005_comments.sql`, `lockWorkItem`, `recordComment`, `listComments` and `countInterventions`.
- [ ] 2.3 Write ADR 0015 (owner commands), following `design.md` and `docs/m3.5-owner-commands.md` sections 2 and 12, and amend ADR 0009 (issue comments read by id; no new permission or event). Add the M3.5 decisions to brief section 8.

## Step 3: State machine and Lambdas

The state machine does not change in this change; its definition tests stay green.

- [ ] 3.1 Failing webhook tests, with fake Step Functions and ECS clients. Scenarios:
  - Comment without a command is ignored
  - Command below the first line is ignored
  - Command from another user is ignored
  - Owner command starts the command task
  - Edited comment is ignored
  - Approval from another user is ignored (carried)

  Also: a command on a pull request starts nothing; `issues.labeled` is unchanged.
- [ ] 3.2 Write the route in `factory/orchestrator/src/lambda/webhook.ts`, using `parseCommand`.
- [ ] 3.3 Failing CDK assertion tests, then any stack change they need: the webhook may still only start this state machine, run the worker family and pass its roles, and has no access to the ledger's secret. Scenario: Stack settings come from the target config (carried; its text now says commands). Amend ADR 0002 (commands resume executions through the `command` task).

## Step 4: Deploy and cloud check

The M3.5 exit run (section 11) follows the third change. This step proves what this change ships (section 10: "a non-command and a non-owner command produce nothing, and `/status` answers in the cloud").

- [ ] 4.1 `pnpm image:build`, then `pnpm infra:diff`. It must show new images and the webhook's code, and no replacement of the ledger, the bucket or any other stateful resource. Show it to the owner.
- [ ] 4.2 Owner confirms, with no execution paused that must stay unchanged; `pnpm infra:deploy`. The first worker task applies migration 0005.
- [ ] 4.3 On a throwaway `vocab` issue the owner agrees to, labelled `factory`, with the execution paused at proposal approval:
  - the owner comments "Looks good to me, thanks." and a comment with `/approve` on its second line; a second account comments `/approve`. Confirm in the webhook log and the cluster's tasks that none started a task, and that the issue got no reply.
  - the owner comments `/status`. Confirm the reply arrives within about two minutes and names `awaiting-proposal-approval`.
  - the owner comments `/approve`. Confirm the execution resumes, as before.

  Record the timings in `design.md` under "Cloud results". Run `pnpm test:cloud`.
- [ ] 4.4 Run `pnpm check` and `pnpm gates coverage --change add-owner-commands --tests factory` and `--tests infra`. Update `CLAUDE.md` (the `command` task replaces `approve` under "Cloud runs"; `pnpm factory command` under "Commands"). The change is archived at M3.5's exit, after `add-work-item-resume`.
