## ADDED Requirements

### Requirement: Owner commands are read from a comment's first line
A comment SHALL be a command only if it was created on an issue of the target (not a pull request) by the target's owner, and its first line, trimmed, starts with `/`. The verb SHALL be the text after `/` up to the first whitespace; the known verbs are lowercase, and any other verb is unknown. The rest of the comment SHALL be the command's text. Every other comment SHALL start nothing and get no reply: no command, a command below the first line, a non-owner's comment, or an edited comment.

#### Scenario: Comment without a command is ignored
- **WHEN** the owner comments "Looks good to me, thanks." on an issue whose work item awaits proposal approval
- **THEN** no worker task starts, no comment is posted, and the approval stays open

#### Scenario: Command below the first line is ignored
- **WHEN** the owner comments "As discussed:" followed by a second line `/approve`
- **THEN** no worker task starts, no comment is posted, and the approval stays open

#### Scenario: Command from another user is ignored
- **WHEN** a user other than the owner comments `/status` on an issue of the target
- **THEN** no worker task starts and no comment is posted, and the webhook's log names the user and the verb

#### Scenario: Edited comment is ignored
- **WHEN** the owner edits an existing comment so that its first line becomes `/approve`
- **THEN** no worker task starts and no comment is posted

### Requirement: An owner command runs in the command worker task
For each owner command the webhook SHALL start one `factory-worker command --issue <n> --comment <comment id>` task, passing the comment id and never the comment's text. The `command` task SHALL read the comment through the Forge by its id, and SHALL act on it only if its author is the owner and it belongs to the given issue.

#### Scenario: Owner command starts the command task
- **WHEN** the owner comments `/status` on issue 12
- **THEN** the webhook starts one worker task with the command `command --issue 12 --comment <the comment's id>`, and its overrides hold no part of the comment's text

#### Scenario: Command task checks the comment's author and issue
- **WHEN** the `command` task reads a comment whose author is not the owner, or which belongs to another issue than `--issue`
- **THEN** nothing is recorded, no comment is posted, no execution changes, and the task exits 2

### Requirement: Every owner command gets one reply
Every owner command SHALL get exactly one reply comment on its issue, saying what was done or why nothing was done, decided by the work item's state. `/status` and `/help` SHALL be answered in every state. An unknown verb SHALL be answered "unknown command", naming the verb, with the `/help` text.

#### Scenario: Unknown command gets the help text
- **WHEN** the owner comments `/aprove` on an issue whose work item awaits proposal approval
- **THEN** the issue gets one comment saying `/aprove` is an unknown command and listing the commands, and the approval stays open

### Requirement: Commands that arrive while a role runs are not kept
An `/approve`, `/revise` or `/question` that arrives while the work item is in `intake`, `proposal`, `proposal-approved`, `design`, `design-review` or `plan` SHALL get the busy reply: "`<state>` is running, so your `/<verb>` was not applied and is not kept. Send it again when the factory asks for your approval.", quoting the command's first line. It SHALL NOT be applied later.

#### Scenario: Command while a role runs gets the busy reply
- **WHEN** the owner comments `/approve` while the work item is in `proposal`, and the proposal later comes to await approval
- **THEN** the issue gets one comment saying `proposal` is running and the `/approve` was not applied and is not kept, quoting `/approve`, and the work item stays `awaiting-proposal-approval` with its approval open

### Requirement: `/approve` outside an approval is answered
`/approve` with no work item, during `build`, or for an escalated work item SHALL be answered that nothing awaits approval, naming the state, and the reply MAY add the command that applies there; with the pull request open, that the pull request is open for review, with its link. No execution SHALL change.

#### Scenario: Approval during the build is answered
- **WHEN** the owner comments `/approve` while the work item is in `build`
- **THEN** no execution changes, and the issue gets one comment saying nothing awaits approval and naming the state `build`

#### Scenario: Approval with the pull request open is answered
- **WHEN** the owner comments `/approve` on an issue whose work item is `pr-open`
- **THEN** no execution changes, and the issue gets one comment saying the pull request is open for review, with its link

### Requirement: `/status` says where the work item stands
`/status` SHALL reply with the work item's change id and state, its current step (for `build`, the task being built), the tasks done out of the plan's, the number of attempts, the estimated cost so far, and what the factory waits for. With no work item, it SHALL say so and that labelling the issue `factory` starts one. It SHALL change nothing but the ledger's record of the command.

#### Scenario: Status while awaiting approval
- **WHEN** the owner comments `/status` while the work item awaits proposal approval after one proposal attempt that cost $0.80
- **THEN** the reply names the change id, the state `awaiting-proposal-approval`, 1 attempt, about $0.80, and that the factory waits for the owner's approval of the proposal

#### Scenario: Status during the build
- **WHEN** the owner comments `/status` while task 1.3 of a plan of five tasks is being built, with tasks 1.1 and 1.2 done
- **THEN** the reply names the state `build`, task 1.3 as the current step, 2 of 5 tasks done, the attempts so far and the cost so far, and that nothing waits for the owner

#### Scenario: Status with no work item
- **WHEN** the owner comments `/status` on an issue of the target that has no work item
- **THEN** the reply says the issue has no work item and that labelling it `factory` starts one

### Requirement: `/help` lists the commands
`/help` SHALL reply with each command, when it applies and what it does, in one short table, in every state.

#### Scenario: Help lists the commands
- **WHEN** the owner comments `/help`
- **THEN** the reply lists `/approve`, `/revise`, `/question`, `/abort`, `/resume`, `/status` and `/help`, each with when it applies and what it does

### Requirement: Owner commands are recorded in the ledger
The `command` task SHALL record each owner command it reads once, keyed by its GitHub comment id, with the work item (if any), the author, the verb, the body as read at receipt, the time received, its outcome (`applied`, `busy`, `refused` or `unknown`) and the work-item state it met. A second task for a comment already recorded SHALL change nothing and post no reply.

#### Scenario: Command is recorded with its outcome
- **WHEN** the owner's `/approve` arrives while the work item is in `proposal`
- **THEN** the ledger holds one comment row with the comment's id, the owner's login, the verb `approve`, its body, the outcome `busy` and the state `proposal`

#### Scenario: Redelivered command is applied once
- **WHEN** two `command` tasks run for the same `/approve` comment, one after the other
- **THEN** the execution is resumed once, the ledger holds one comment row for it, and the issue has one reply

### Requirement: Owner interventions are counted
Applied `/approve`, `/revise`, `/abort` and `/resume` commands SHALL count as owner interventions; `/question`, `/status` and `/help` SHALL NOT. The number of interventions per work item SHALL be queryable from the ledger.

#### Scenario: Interventions count only commands that act
- **WHEN** the owner has sent `/status`, a busy `/approve` and an applied `/approve` on a work item
- **THEN** the work item's intervention count is 1

### Requirement: Commands on one work item are decided in order
The `command` task SHALL decide a command and write its ledger rows while it holds a lock on the work item's row, so commands on one work item are applied one at a time in the order they take the lock. No role session SHALL run while the lock is held.

#### Scenario: Two approvals at once resume the execution once
- **WHEN** two `command` tasks for two different `/approve` comments run at the same time on a work item awaiting proposal approval
- **THEN** the task token is sent once, one comment row is `applied` and the other answered that nothing awaits approval, and the issue has one reply to each comment

### Requirement: Local runs take owner commands
`pnpm factory command --issue <n> --comment <id> [--target <name>]` SHALL run the `command` handler against the local ledger and the target's repository, with the same records and replies as in the cloud. An applied `/approve` of a local run SHALL close the open approval with the owner's login and move the work item on as `pnpm factory approve` does, so `pnpm factory run` goes on from there. `pnpm factory approve` SHALL stay.

#### Scenario: Local command answers on the issue
- **WHEN** the owner comments `/status` on an issue with a local work item and runs `pnpm factory command --issue 12 --comment <its id>`
- **THEN** the issue gets the status reply, and the local ledger holds the command with the outcome `applied`

#### Scenario: Local approval by command
- **WHEN** the owner comments `/approve` on an issue whose local work item awaits proposal approval and runs `pnpm factory command` for it
- **THEN** the approval is closed with the owner's login, the work item is `proposal-approved`, and `pnpm factory run --issue 12 --until plan` goes on from there

## MODIFIED Requirements

### Requirement: `/approve` resumes the execution
An owner's `/approve` command SHALL be applied by the `command` worker task, which resumes the execution with the open approval's token, for a proposal or a design approval; the confirming comment SHALL name the approval it closed. `/approve` from anyone else, or on a pull request, SHALL start nothing. With no open approval, it SHALL be answered with a comment and change nothing. If resuming fails, the approval SHALL be reopened and the issue SHALL get a comment saying so.

#### Scenario: Owner's approval resumes the execution
- **WHEN** the owner comments `/approve` on an issue whose work item is `awaiting-proposal-approval`
- **THEN** the execution resumes, the work item is `proposal-approved`, the approval is closed with the owner's login, and the issue gets a comment confirming the proposal approval

#### Scenario: Approval from another user is ignored
- **WHEN** a user other than the owner comments `/approve` on an issue awaiting approval
- **THEN** no worker task starts, the execution stays paused and the approval stays open

#### Scenario: Approval with nothing awaiting is answered
- **WHEN** the owner comments `/approve` on an issue whose work item has no open approval
- **THEN** no execution changes, and the issue gets a comment saying that nothing awaits approval and naming the work item's state

#### Scenario: Failed resume is reported on the issue
- **WHEN** the `command` task cannot resume the execution for an owner's `/approve`
- **THEN** the approval is open again, and the issue has a comment saying the approval did not go through and can be repeated

### Requirement: The stack is configured by its target
The factory stack SHALL take the repository and the owner from its target's config: the webhook SHALL accept only that repository's deliveries and only that owner's commands. The worker and build task definitions SHALL set `FACTORY_TARGET`, and the build task definition SHALL run the target's build image. Every resource SHALL be tagged `project=ceh`. The stack SHALL keep the name `Factory`.

#### Scenario: Stack settings come from the target config
- **WHEN** the factory stack is synthesised for the `vocab` target
- **THEN** the webhook's repository and owner are the target's, the worker, boundary-check and build containers set `FACTORY_TARGET=vocab`, the worker container has no `FACTORY_GITHUB_REPOSITORY`, and the build task's image is built from the assembled `vocab` build Dockerfile

#### Scenario: Stack is tagged for ceh
- **WHEN** the factory stack is synthesised
- **THEN** the stack's name is `Factory`, its resources carry the tag `project=ceh`, and none carries `project=vocab-factory`
