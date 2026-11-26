# orchestration Specification

## Purpose
The work-item lifecycle: the states a work item moves through from issue to release, their transitions, retries and stopping points, and what the ledger records for each.

## Requirements

### Requirement: Intake creates a work item
Running the factory for an issue SHALL create one work item in the ledger, linked to the issue, and a branch named after the work item's change id. An issue with an empty body SHALL be rejected.

#### Scenario: Work item and branch are created
- **WHEN** the owner runs `pnpm factory run --issue 12 --until proposal` for an open issue titled "Import Kindle vocab.db"
- **THEN** the ledger holds one work item for issue 12 with change id `add-import-kindle-vocab-db`, and a branch of that name exists on the remote

#### Scenario: Issue without a requirement is rejected
- **WHEN** the issue body is empty
- **THEN** no work item and no branch are created, the issue gets a comment asking for a stated requirement, and the CLI exits non-zero

### Requirement: Change ids are derived deterministically
Intake SHALL derive the change id from the issue title as `<verb>-<slug>`. If the first word of the title is one of `add`, `fix`, `change`, `remove`, `improve`, `refactor`, that word is the verb and the slug is the rest of the title. Otherwise the verb is `add` and the slug is the whole title. The slug SHALL be lower-case kebab-case, and the id at most 40 characters, cut at a word boundary. A taken id SHALL get a numeric suffix.

#### Scenario: Leading verb is kept
- **WHEN** the issue title is "Fix duplicate lookups on re-import"
- **THEN** the change id is `fix-duplicate-lookups-on-re-import`

#### Scenario: Colliding id gets a suffix
- **WHEN** another work item already uses the change id `add-import-kindle-vocab-db`
- **THEN** the new work item uses `add-import-kindle-vocab-db-2`

### Requirement: Proposal produces a valid change
The Proposal state SHALL run the proposal-author role on the work item's branch, and SHALL accept its output only if `openspec validate <id> --strict` passes and the role's result passes its schema. An attempt that fails either check SHALL be retried with the failure evidence in the prompt, up to 3 attempts per run, where an owner's revision starts a new run. After that, the work item SHALL be marked `escalated` and the issue SHALL get a comment with the last failure.

#### Scenario: Valid proposal is committed and pushed
- **WHEN** the proposal-author role produces a change that passes strict validation
- **THEN** the runner commits the change folder on the work item's branch and pushes it

#### Scenario: Invalid proposal is retried with evidence
- **WHEN** an attempt produces a change that fails strict validation
- **THEN** the next attempt's prompt contains the validation errors, and the ledger records the failed attempt with its reason

#### Scenario: Three failed attempts escalate
- **WHEN** three attempts in a row fail validation
- **THEN** the work item is `escalated`, the issue gets a comment with the last validation errors, and the CLI exits non-zero

#### Scenario: Revision gets its own attempts
- **WHEN** a proposal that succeeded at attempt 3 is revised, and the revision's first attempt fails validation
- **THEN** the work item is not escalated, and attempt 5 runs with the validation errors

### Requirement: Run stops at the requested state
A local run SHALL stop at the requested point: `--until proposal` after a valid proposal is pushed, `--until design` after the design is accepted, `--until plan` after the plan is stored, `--until pr` after the pull request opens. It SHALL stop at any open approval, which `pnpm factory approve --issue <n>` closes. After Proposal, it SHALL post a summary comment (why, what changes, affected capabilities, complexity, open questions) and leave the work item `awaiting-proposal-approval`.

#### Scenario: Summary comment is posted
- **WHEN** a run with `--until proposal` completes
- **THEN** the issue has a comment listing the change id, affected capabilities, complexity and open questions, and the work item state is `awaiting-proposal-approval`

#### Scenario: Local run reaches the pull request
- **WHEN** the owner runs `pnpm factory approve --issue 12` for a `small` work item awaiting proposal approval, then `pnpm factory run --issue 12 --until pr`
- **THEN** the plan's tasks are built in order, each is ticked in `tasks.md`, a pull request is open from the change branch, and the work item is `pr-open`

### Requirement: Runs are resumable
Running the factory again for an issue that already has a work item SHALL continue that work item and SHALL NOT create a second one. If the work item is already at or past the requested state, no agent SHALL run.

#### Scenario: Re-run after completion does nothing
- **WHEN** the owner runs the same command again for an issue whose work item is `awaiting-proposal-approval`
- **THEN** no agent runs, no new attempt is recorded, and the CLI reports the current state

### Requirement: Every run is recorded with its cost
The ledger SHALL record, for every work item:
- each attempt: state, role, start and end time, outcome and failure reason
- each SDK message: token usage
- each attempt's estimated cost in USD and the auth mode used (`api-key` or `subscription`)

The total estimated cost of a work item SHALL be queryable.

#### Scenario: Cost is visible after a run
- **WHEN** a run with `--until proposal` completes
- **THEN** the ledger reports a non-zero token count and an estimated cost for the work item, and the auth mode of each attempt

### Requirement: The factory acts as its GitHub App
Outside local runs, the Forge SHALL authenticate with the factory's GitHub App installation tokens, requested for the target's repository only with `contents: write`, `issues: write`, `pull_requests: write` and `metadata: read`, and refreshed before any call within five minutes of expiry. Tokens SHALL never appear in error messages, logs, command lines, remote URLs or git config. Commits the factory pushes SHALL be authored and committed by the App's bot user.

#### Scenario: Installation token is scoped to the repository
- **WHEN** the token provider requests an installation token
- **THEN** the request is signed with a JWT for the App, names only the target's repository, and asks only for `contents: write`, `issues: write`, `pull_requests: write` and `metadata: read`

#### Scenario: Expiring token is refreshed
- **WHEN** the Forge makes a call less than five minutes before its current token expires
- **THEN** a new installation token is requested first, and the call uses the new token

#### Scenario: Token failures do not leak the token
- **WHEN** a GitHub call or a push fails with an authentication error
- **THEN** the error message and every log line name the failure without containing the token or the App's private key

#### Scenario: Commits are authored by the factory's bot
- **WHEN** the worker commits and pushes a proposal or a task
- **THEN** the pushed commit's author and committer are the App's bot user, not the owner

### Requirement: GitHub App requests are retried after network errors
The installation token request and the bot user's lookup SHALL each be tried up to 3 times, with a backoff, when the request fails with a network error or GitHub answers with a 5xx status, and SHALL not be tried again after any other answer. A network error SHALL be reported with its error code, such as `UND_ERR_CONNECT_TIMEOUT`, when it has one, and with nothing else from the underlying error.

#### Scenario: Token request is retried after a network error
- **WHEN** the first installation token request fails with a network error and the second gets a token
- **THEN** the provider returns that token, after two requests and one backoff wait

#### Scenario: Token request is not retried after a refusal
- **WHEN** GitHub answers the installation token request with 401
- **THEN** the provider rejects with `unauthorized` after one request

#### Scenario: Network failure names its code
- **WHEN** all 3 installation token requests fail with a connect timeout
- **THEN** the error message says the request failed 3 times and names `UND_ERR_CONNECT_TIMEOUT`, and contains neither the JWT nor the App's private key

### Requirement: The worker runs one state per task
The worker SHALL take a state and an issue number (`factory-worker <state> --issue <n>`, plus `--task <id>` for `step`) and SHALL run that state's handler for the issue's work item. It SHALL apply pending ledger migrations before the handler runs. A work item already past the state SHALL be left unchanged, and no role SHALL run.

#### Scenario: Worker runs Intake for an issue
- **WHEN** the worker runs `intake` for an open issue with a stated requirement
- **THEN** the ledger holds the work item in state `proposal`, its branch exists on the remote, and the worker exits 0

#### Scenario: Worker advances a proposal
- **WHEN** the worker runs `proposal` for a work item in state `proposal`, and the role produces a valid change
- **THEN** the change is pushed to the work item's branch from a fresh clone, the work item is `awaiting-proposal-approval`, and the worker exits 0

#### Scenario: Repeated worker task does nothing
- **WHEN** the worker runs `proposal` for a work item that is already `awaiting-proposal-approval`
- **THEN** no role runs, no attempt is recorded, the branch is unchanged, and the worker exits 0

### Requirement: The worker reports by exit code
The worker SHALL exit with 0 when the state advanced or had nothing to do, 3 when the work item escalated, 4 when the run should end without a work item to continue, 2 without running a role for invalid input, and 1 on any other error. It SHALL use these codes for the routes after Proposal: 10 when `Approved` skips Design, 11 when Design waits for the owner, 20 when `step` has prepared a build, 21 when `step` asks for a build after a wait, and 13 when `step` found a design flaw.

#### Scenario: Worker reports an escalation
- **WHEN** the worker runs `proposal` and all three attempts fail validation
- **THEN** the work item is `escalated`, the issue has the escalation comment, and the worker exits 3

#### Scenario: Worker reports a rejected issue
- **WHEN** the worker runs `intake` for an issue with an empty body
- **THEN** no work item or branch is created, the issue has the comment asking for a requirement, and the worker exits 4

#### Scenario: Unknown state is refused
- **WHEN** the worker is started with the state `deploy`, with `proposal` for an issue that has no work item, or with `step` and no `--task`
- **THEN** no role runs, nothing is cloned or recorded, and the worker exits 2 with a message naming the problem

### Requirement: Labelling an issue starts a work item
When the label `factory` is added to an open issue, the factory SHALL start a Step Functions execution for it, whose states run in the factory worker. An issue SHALL never have more than one work item, and a later execution for the same issue SHALL end without changing it, with a comment that `/resume` continues the work item. Other labels SHALL be ignored.

#### Scenario: Labelling an issue starts an execution
- **WHEN** the owner adds the label `factory` to an open issue with a stated requirement
- **THEN** one execution starts for the issue, the ledger holds one work item for it with the execution's ARN, and the work item's branch exists on the remote

#### Scenario: Relabelling does not create a second work item
- **WHEN** the label `factory` is removed from an issue that has a work item and added again, or the same delivery is redelivered
- **THEN** the new execution, if one starts, ends successfully at Intake, no role runs, the ledger still holds one work item with the original execution's ARN, and the issue gets one comment saying `/resume` continues the work item

#### Scenario: Other labels are ignored
- **WHEN** a label other than `factory` is added to an issue
- **THEN** no execution starts and no work item is created

### Requirement: Webhooks are verified
The webhook endpoint SHALL act only on deliveries whose `X-Hub-Signature-256` matches the App's webhook secret. It SHALL NOT read or write the ledger.

#### Scenario: Unsigned webhook is rejected
- **WHEN** a request without a valid signature reaches the webhook endpoint
- **THEN** the endpoint answers 401, and no execution or worker task starts

### Requirement: Proposal approval waits for the owner
After a valid proposal is pushed, the execution SHALL pause in Proposal approval. The worker SHALL store the approval's task token in the ledger before it posts the summary comment. The summary SHALL list what M1's summary lists, plus the attempt's tokens, estimated cost and auth mode, and after a revision what changed, and SHALL end with the commands that apply: `/approve`, `/revise` and `/question`.

#### Scenario: Execution waits for approval
- **WHEN** the Proposal state of an execution succeeds
- **THEN** the execution is paused in Proposal approval, the work item is `awaiting-proposal-approval`, the ledger holds an open approval stored before the summary comment was posted, and no worker task is running

#### Scenario: Summary shows the cost
- **WHEN** the summary comment is posted for a cloud run
- **THEN** it shows the proposal's token count, estimated cost in USD and the auth mode `api-key`, and ends with "Reply `/approve`, `/revise` with your answers or the changes you want, or `/question` to ask about it."

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

### Requirement: Infrastructure failures escalate
A worker task that fails to start or exits with an error SHALL be retried with backoff, up to 2 retries. After that, a worker task SHALL mark the work item `escalated` and comment on the issue naming the failure, and the execution SHALL fail.

#### Scenario: Worker crash escalates the work item
- **WHEN** the Proposal worker task exits with code 1 on its first run and on both retries
- **THEN** the work item is `escalated`, the issue has a comment naming the infrastructure failure, and the execution ends failed

#### Scenario: Escalated proposal ends the execution
- **WHEN** the Proposal worker task exits with code 3
- **THEN** no retry runs, and the execution ends failed with the work item `escalated`

### Requirement: Executions carry only pointers
A role's validated result SHALL be stored in the ledger on its attempt, and a build's outputs SHALL be stored in the artifact store with their keys on the attempt. State inputs and outputs SHALL carry only pointers: the issue number, the change id, task ids, exit codes and task tokens.

#### Scenario: Proposal result is stored in the ledger
- **WHEN** a proposal attempt succeeds in the worker
- **THEN** the attempt in the ledger holds the result, and it passes the proposal result schema

#### Scenario: Execution history holds no artifacts or secrets
- **WHEN** an execution has opened its pull request
- **THEN** no event in its history contains the proposal, design or task text, the issue body, a patch, gate output, the Anthropic API key, a GitHub token, the App's private key, the webhook secret or the ledger password

### Requirement: The ledger accepts connections only from the worker
The ledger SHALL have no public address and SHALL accept connections only from the worker's security group, over TLS.

#### Scenario: Ledger is closed to everything but the worker
- **WHEN** the factory stack is synthesised
- **THEN** the cluster's instances are not publicly accessible, and the only ingress rule on the ledger's security group is port 5432 from the worker's security group

### Requirement: Complexity decides the design route
After Proposal approval, the work item's route SHALL follow the change's `x-complexity`: `small` goes to Plan, `medium` to Design followed by the design reviewer, and `large` to Design followed by the owner's approval. A missing or unknown value SHALL escalate the work item.

#### Scenario: Small change skips Design
- **WHEN** a `small` change's proposal is approved
- **THEN** no architect or design reviewer runs, and the work item is in Plan

#### Scenario: Medium change gets the agent review
- **WHEN** a `medium` change's design passes strict validation
- **THEN** the design reviewer runs in a fresh session, and the work item goes to Plan once it returns `approve`

#### Scenario: Large design waits for the owner
- **WHEN** a `large` change's design passes strict validation
- **THEN** no design reviewer runs, the execution pauses with an open design approval, and the issue gets a comment with the design summary ending with the `/approve`, `/revise` and `/question` commands

### Requirement: Design is produced and reviewed
The Design state SHALL run the architect and accept its output only if the change passes `openspec validate <id> --strict` and the result passes its schema. A design reviewer's `changes-requested` SHALL send its findings to the architect's next attempt. Design SHALL escalate after 3 architect attempts in a run; a design flaw and an owner's revision each start a new run. An accepted design SHALL be committed and pushed.

#### Scenario: Requested changes reach the architect
- **WHEN** the design reviewer returns `changes-requested` with a blocker finding
- **THEN** the architect's next attempt has the finding in its prompt, and the reviewer runs again on the new design

#### Scenario: Three rejected designs escalate
- **WHEN** the architect's third attempt is also answered with `changes-requested`
- **THEN** the work item is `escalated`, and the issue gets a comment with the last findings

### Requirement: Plan produces checked tasks
The Plan state SHALL run the planner, accept its output only if `validatePlan` passes and the change passes strict validation, retry with the evidence up to 3 attempts, and then escalate. An accepted plan's tasks SHALL be stored in the ledger, and `tasks.md` committed and pushed. Plan SHALL return the ids of the unfinished tasks, in order, to the execution.

#### Scenario: Plan stores its tasks
- **WHEN** the planner's output passes `validatePlan`
- **THEN** the ledger holds one task per entry in `tasks.json`, with its scenarios and files, `tasks.md` is on the branch, and the execution's next state receives the task ids in order

### Requirement: Each task is built tests-first
For each task, in order, the build loop SHALL run the test author in the build container until the red gate passes, then the implementer until the green gate passes. The test author's patch SHALL be committed before the implementer starts, and the implementer SHALL start from that commit. A failed red gate SHALL retry the test author with the gate's result, up to 3 attempts, and then escalate.

#### Scenario: Tests are committed before code
- **WHEN** a task's test author passes the red gate
- **THEN** its tests are committed and pushed, and the implementer's input names that commit as its base

#### Scenario: Red gate failure retries the test author
- **WHEN** the test author's tests fail to load
- **THEN** the next test author attempt has the red gate's result in its prompt

### Requirement: Build outputs are re-checked before commit
The worker SHALL apply a build's patch only if every path in it is inside the role's writable globs. A patch that fails this check SHALL fail the attempt with reason `diff-check`, and nothing from it SHALL be committed.

#### Scenario: Forged patch is refused
- **WHEN** a build outcome reports a passed diff check but its patch changes `package.json`
- **THEN** the worker commits nothing, and the attempt is recorded as failed with reason `diff-check`, naming `package.json`

### Requirement: Failed tasks are classified and routed
After a failed green gate, the worker SHALL run the failure classifier and route the task on its label: `bug` and `flaky` retry the task, `design-flaw` returns the change to Design, and `spec-ambiguity` and `infra` escalate as below. An implementer attempt that fails before the gates (turn cap, budget, diff check) SHALL count as `bug` without a classifier call.

#### Scenario: Spec ambiguity goes to the owner
- **WHEN** the classifier returns `spec-ambiguity`
- **THEN** the work item is `escalated`, and the issue gets a comment with the classifier's evidence as a question

#### Scenario: Infrastructure failure waits and retries
- **WHEN** the classifier returns `infra` for the third time in a task
- **THEN** the build ran again after a wait twice before, and now the work item is `escalated` with a comment naming the infrastructure failure

### Requirement: Bugs are retried with evidence
On `bug`, the worker SHALL retry the implementer with the gates' result and the classifier's evidence, up to 3 implementer attempts per task, and then escalate. On the first `flaky` in a task, it SHALL re-run only the gates on the same patch; a later `flaky` SHALL count as `bug`.

#### Scenario: Bug is retried with evidence
- **WHEN** a task's green gate fails and the classifier returns `bug`
- **THEN** the implementer's next attempt has the failing checks' output and the classifier's evidence in its prompt, and the ledger records the failed attempt with its classification

#### Scenario: Three failed implementer attempts escalate
- **WHEN** a task's third implementer attempt fails its green gate with `bug`
- **THEN** the work item is `escalated`, the issue gets a comment with the task and the last gate output, and the execution ends failed

#### Scenario: Flaky failure re-runs the gates only
- **WHEN** the classifier returns `flaky` for the first time in a task
- **THEN** the build container re-runs the green gate on the same patch, and no implementer session runs

### Requirement: Design flaws send the change back to Design
On `design-flaw`, the work item SHALL return to Design with the classifier's evidence in the architect's prompt, go through its design route again, and then re-plan. The re-plan SHALL keep the ticked tasks, and the build loop SHALL continue with the unfinished ones. A third design flaw in one work item SHALL escalate it.

#### Scenario: Design flaw re-plans the unfinished tasks
- **WHEN** task 1.3 of a `medium` change fails with `design-flaw` after tasks 1.1 and 1.2 are ticked
- **THEN** the architect runs with the evidence, the reviewer runs, the planner re-plans, tasks 1.1 and 1.2 stay ticked and are not rebuilt, and the build loop continues with the new plan's unfinished tasks

### Requirement: Passed tasks are ticked and committed
When a task's green gate passes, the worker SHALL tick that task's line in `tasks.md` and commit it with the implementer's patch, as the App's bot, and push. A task that is already ticked SHALL be skipped by the build loop.

#### Scenario: Task is ticked with its code
- **WHEN** task 1.2's green gate passes
- **THEN** one new commit on the branch holds the implementer's changes and `- [x] 1.2`, and the ledger marks task 1.2 done with that commit

#### Scenario: Ticked task is not rebuilt
- **WHEN** the build loop reaches a task that is already ticked
- **THEN** no role runs for it, and the loop moves on

### Requirement: A pull request opens when every task is done
When every task of the plan is ticked, the worker SHALL open one pull request from the change branch to the target's default branch, or reuse the open one. Its body SHALL list the tasks, each role's tokens and estimated cost, and the issue. The issue SHALL get a comment linking it, and the work item SHALL become `pr-open`.

#### Scenario: Pull request is opened once
- **WHEN** the open-PR state runs twice for a work item whose tasks are all ticked
- **THEN** exactly one pull request exists for the branch, its body lists the tasks and the cost, and the issue has one comment linking it

#### Scenario: Pull request targets the default branch
- **WHEN** the open-PR state runs for a target whose default branch is `main`
- **THEN** the pull request's base is `main`

### Requirement: Build sessions are recorded in the ledger
The worker SHALL record each build attempt's SDK messages, tokens, estimated cost and auth mode from its `messages.jsonl`, exactly as a session in the worker is recorded. An attempt whose build task produced no outcome SHALL be recorded as failed with reason `no-outcome`.

#### Scenario: Build cost reaches the ledger
- **WHEN** an implementer attempt has run in the build container and been recorded
- **THEN** the ledger holds its messages with token counts, its estimated cost and its auth mode, and the work item's total cost includes it

### Requirement: Build tasks hold only the model credential
The build task SHALL receive only the API key as a secret, SHALL have a task role that can only read and write `work-items/*` in the artifact bucket, and SHALL have a security group with no ingress that the ledger does not admit. The artifact bucket SHALL block public access and refuse requests without TLS.

#### Scenario: Build task cannot reach the factory's secrets
- **WHEN** the factory stack is synthesised
- **THEN** the build task definition's only secret is the API key, its task role allows only `s3:GetObject` and `s3:PutObject` on `work-items/*` in the artifact bucket, and the ledger's security group has no rule for the build task's security group

### Requirement: Build tasks have room for their checks
The build task SHALL have 8 GB of memory, SHALL run Node with a 4 GB heap (`NODE_OPTIONS=--max-old-space-size=4096`) so the heap does not depend on Node's estimate, and SHALL write no core dumps (a core ulimit of 0), so an aborted process cannot leave gigabytes in the clone.

#### Scenario: Build task has room for its checks and writes no core dumps
- **WHEN** the factory stack is synthesised
- **THEN** the build task definition has 8 GB of memory, its container sets `NODE_OPTIONS` to `--max-old-space-size=4096`, and its core ulimit is 0, soft and hard

### Requirement: Commits and pull requests say what they hold
A design commit that adds or changes files under the target's contracts path SHALL be a `feat` commit, `feat(<change id>): design the change and its contracts`; one that changes only `design.md` stays `docs(<change id>): design the change`. The pull request's cost note SHALL follow the auth modes its attempts ran in: in `api-key` mode the cost was charged to the factory's API key, in `subscription` mode no money was charged per token.

#### Scenario: Design that adds contracts is committed as a feature
- **WHEN** the architect writes `design.md` and a file under the target's contracts path, and the design is accepted
- **THEN** the design commit holds both files, and its subject is `feat(<change id>): design the change and its contracts`

#### Scenario: Pull request says what its cost means
- **WHEN** a pull request opens for a work item whose attempts all ran in `api-key` mode
- **THEN** its cost note says the cost was charged to the factory's API key, and does not say that no money was charged

### Requirement: Work items are keyed by repository
The ledger SHALL record each work item's repository, and SHALL hold at most one work item per repository and issue number, and at most one per repository and change id. Work items that existed before the repository was recorded SHALL belong to `miklospocsaji/vocab`. Every handler SHALL find a work item by its target's repository and the issue number, never by the issue number alone.

#### Scenario: Existing work items are backfilled
- **WHEN** the migration runs on a ledger that holds work items without a repository
- **THEN** each of them has the repository `miklospocsaji/vocab`, and its id, issue number, change id and state are unchanged

#### Scenario: Two repositories can hold the same issue number
- **WHEN** a work item exists for issue 12 of one repository, and Intake runs for issue 12 of another whose title gives the same change id
- **THEN** the ledger holds two work items, one per repository, with the same issue number and the same change id

#### Scenario: Second work item for the same issue is refused
- **WHEN** a second work item is created for an issue number, or a change id, that its repository already has
- **THEN** the ledger refuses it, and the first work item is unchanged

### Requirement: The worker serves its configured target
The worker SHALL take its target's name from `FACTORY_TARGET` and the target's repository, default branch, owner and contracts path from that target's config. It SHALL clone only that repository. A missing or unknown target SHALL be refused as invalid input before any state runs.

#### Scenario: Worker without a target is refused
- **WHEN** the worker starts with no `FACTORY_TARGET`, or with one that has no folder under `targets/`
- **THEN** no role runs, nothing is cloned or recorded, and the worker exits 2 with a message naming `FACTORY_TARGET`

#### Scenario: Worker works on its target's repository
- **WHEN** the worker runs `proposal` with `FACTORY_TARGET=vocab` for a work item in state `proposal`
- **THEN** the clone's `origin` is `miklospocsaji/vocab`, the role is loaded for the `vocab` target, and the build input it later writes names the target `vocab`

### Requirement: Local runs work on a clone of the target
The CLI's `run`, `approve` and `cost` commands SHALL take `--target <name>`, which defaults to the only target when there is one. A local run SHALL work on a clone of the target's repository under the factory home, made if it is missing, with its worktrees and artifact store beside it. It SHALL NOT read or change the checkout it is run from, beyond the factory's own code and `.env.local`.

#### Scenario: Local run works on a clone of the target
- **WHEN** the owner runs `pnpm factory run --issue 12 --until proposal` in the `ceh` checkout, with `vocab` as the only target
- **THEN** the target's repository is cloned to `<factory home>/targets/vocab/repo`, the work item's worktree is under `<factory home>/targets/vocab/worktrees/`, the work item's repository is `miklospocsaji/vocab`, and the `ceh` checkout has no new branch, worktree or file

#### Scenario: Ambiguous or unknown target is a usage error
- **WHEN** the CLI runs without `--target` while `targets/` holds two targets, or with `--target nosuch`
- **THEN** it exits 2 without touching the ledger or GitHub, and its message lists the known targets

### Requirement: The stack is configured by its target
The factory stack SHALL take the repository and the owner from its target's config: the webhook SHALL accept only that repository's deliveries and only that owner's commands. The worker and build task definitions SHALL set `FACTORY_TARGET`, and the build task definition SHALL run the target's build image. Every resource SHALL be tagged `project=ceh`. The stack SHALL keep the name `Factory`.

#### Scenario: Stack settings come from the target config
- **WHEN** the factory stack is synthesised for the `vocab` target
- **THEN** the webhook's repository and owner are the target's, the worker, boundary-check and build containers set `FACTORY_TARGET=vocab`, the worker container has no `FACTORY_GITHUB_REPOSITORY`, and the build task's image is built from the assembled `vocab` build Dockerfile

#### Scenario: Stack is tagged for ceh
- **WHEN** the factory stack is synthesised
- **THEN** the stack's name is `Factory`, its resources carry the tag `project=ceh`, and none carries `project=vocab-factory`

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

### Requirement: `/revise` sends the awaiting proposal back to its author
An owner's `/revise <text>` while the work item awaits proposal approval SHALL close the approval with the outcome `revise`, put the work item back in `proposal`, and resume the execution with the decision `revise`, which runs Proposal again in the same execution. The author SHALL start from the branch head, and its new commit SHALL be followed by the summary, with what changed, and a new approval.

#### Scenario: Revise sends the proposal back to its author
- **WHEN** the owner comments `/revise Use SQLite, not CSV, for the export` on an issue whose work item awaits proposal approval after proposal attempt 1
- **THEN** the approval is closed with the outcome `revise`, the execution runs Proposal again, attempt 2's prompt holds the comment, a new commit is on the branch, the summary is posted again with a "What changed" section, and a new approval is open

#### Scenario: Revised proposal keeps the owner's branch edits
- **WHEN** the owner has pushed a commit editing `proposal.md` on the work item's branch, then comments `/revise …`
- **THEN** the proposal author's worktree starts from that commit, and the owner's edit is still in `proposal.md` after the revision unless the comment asked to change it

#### Scenario: Revised proposal routes on its new complexity
- **WHEN** a revision changes the change's `x-complexity` from `small` to `medium`, and the owner then approves
- **THEN** Approved routes the work item to Design, not to Plan

### Requirement: `/revise` sends an awaiting design back to the architect
An owner's `/revise <text>` while the work item awaits design approval SHALL close the approval with the outcome `revise`, put the work item back in `design`, and resume the execution with the decision `revise`, which runs Design again in the same execution. The design summary SHALL be posted again with what changed, and a new design approval opened.

#### Scenario: Revise sends the design back to the architect
- **WHEN** the owner comments `/revise Keep the parser in the domain package` on an issue whose `large` work item awaits design approval
- **THEN** the design approval is closed with the outcome `revise`, the architect runs again with the comment in its prompt, a new design commit is pushed, and the issue gets the design summary with "What changed" and a new design approval

### Requirement: Revisions are limited
A `/revise` without text SHALL be refused with a reply. A stage SHALL take at most 5 applied revisions; a 6th `/revise` SHALL be refused with a reply that suggests a new issue. A `/revise` SHALL be refused when the work item's estimated cost so far plus the author's per-attempt budget exceeds the target's per-work-item budget. A refused `/revise` SHALL change nothing.

#### Scenario: Revise without text is refused
- **WHEN** the owner comments `/revise` with nothing after the verb
- **THEN** the issue gets a reply saying `/revise` needs the answers or changes wanted, and the approval stays open

#### Scenario: Sixth revision is refused
- **WHEN** the owner comments `/revise …` on a proposal that has been revised 5 times
- **THEN** the issue gets a reply saying the limit of 5 revisions is reached and suggesting a new issue, and the approval stays open

#### Scenario: Revision over the budget is refused
- **WHEN** the work item's estimated cost is $4.00, the proposal author's per-attempt budget is $1.50 and the target's budget is $5
- **THEN** a `/revise` gets a reply naming the cost so far and the budget, and the approval stays open

### Requirement: Approval waits route on the owner's decision
AwaitApproval and AwaitDesignApproval SHALL be followed by a Choice on the decision the task token was resumed with: `revise` SHALL go back to Proposal (Design), and `approve` SHALL go on to Approved (Plan). The execution history SHALL carry only the decision, never the comment's text.

#### Scenario: Approval decision routes the execution
- **WHEN** AwaitApproval is resumed with `{ "decision": "revise" }`, and later with `{ "decision": "approve" }`
- **THEN** the execution enters Proposal the first time and Approved the second, and no event in its history holds the `/revise` comment's text

### Requirement: Approvals record how they were closed
A closed approval SHALL record its outcome: `approved` for `/approve`, `revise` for `/revise`. Approvals closed before this change SHALL read as `approved`.

#### Scenario: Closed approval records its outcome
- **WHEN** a proposal is revised once and then approved
- **THEN** the work item's first approval is closed with the outcome `revise` and the second with `approved`, both by the owner's login

### Requirement: `/question` is answered while the approval stays open
An owner's `/question <text>` while a proposal or design awaits approval SHALL be answered by a read-only session of that stage's author in the `command` task, on a fresh clone of the branch head. The execution and the approval SHALL be left as they are. The reply SHALL hold the answer and name the commit it read.

#### Scenario: Question about the proposal is answered
- **WHEN** the owner comments `/question Why is the importer in the domain package?` while the proposal awaits approval
- **THEN** the issue gets a reply with the proposal author's answer naming the branch head's commit, the approval is still open with its token, and the execution is still paused

#### Scenario: Question about the design is answered by the architect
- **WHEN** the owner comments `/question …` while a `large` design awaits approval
- **THEN** the answer comes from a question session of the architect, and the design approval stays open

#### Scenario: Question that asks for a change changes nothing
- **WHEN** the owner comments `/question Can you fix the typo in the proposal?`
- **THEN** the branch is unchanged, nothing is committed or pushed, and the answer points to `/revise`

### Requirement: Questions are limited and one at a time
A `/question` without text SHALL be refused. A work item SHALL answer one question at a time: a `/question` while another is being answered SHALL get the busy reply. A stage SHALL take at most 10 questions, and a `/question` SHALL be refused when the work item's cost so far plus $0.30 exceeds the target's budget. A failed answer SHALL be a failed attempt with a reply to ask again.

#### Scenario: Question without text is refused
- **WHEN** the owner comments `/question` with nothing after the verb
- **THEN** the issue gets a reply saying `/question` needs the question, and no session runs

#### Scenario: Question while another is answered gets the busy reply
- **WHEN** the owner comments a second `/question` while the first one's answer is being written
- **THEN** the second gets the busy reply quoting its first line, and only one question session runs

#### Scenario: Eleventh question is refused
- **WHEN** the owner comments `/question …` on a proposal that has had 10 questions
- **THEN** the issue gets a reply saying the limit of 10 questions is reached, and no session runs

#### Scenario: Failed answer can be asked again
- **WHEN** the question session ends without a valid answer
- **THEN** the question's attempt is recorded as failed, the issue gets a reply saying the question was not answered and can be asked again, and the approval stays open

### Requirement: Approval and revision go through during a question
A question SHALL NOT lock the work item while its answer is written: an `/approve` or `/revise` arriving meanwhile SHALL be applied at once. The answer SHALL still be posted, naming the commit it read.

#### Scenario: Approval during a question goes through
- **WHEN** the owner comments `/approve` while the answer to a `/question` is being written
- **THEN** the execution resumes at once, and the answer is posted afterwards naming the commit it read

### Requirement: `/revise` and `/question` outside an approval are answered
`/revise` and `/question` with no work item, during `build`, or for an escalated work item SHALL be answered that nothing awaits approval, naming the state; with the pull request open, that the pull request is open for review. No session SHALL run and no execution SHALL change.

#### Scenario: Revise during the build is answered
- **WHEN** the owner comments `/revise …` while the work item is in `build`
- **THEN** the issue gets a reply saying nothing awaits approval and naming `build`, and no role runs

#### Scenario: Question with the pull request open is answered
- **WHEN** the owner comments `/question …` on an issue whose work item is `pr-open`
- **THEN** the issue gets a reply saying the pull request is open for review, and no session runs

### Requirement: Revision and question attempts are recorded
A revised author's attempt SHALL record the ids of the comments it was given. A question's answer SHALL be an attempt in state `proposal-question` or `design-question`, with the question's comment, the result `{ answer }`, its messages and its cost, which count toward the work item's.

#### Scenario: Question attempt is recorded with its comment
- **WHEN** a `/question` about a proposal has been answered
- **THEN** the ledger holds a succeeded attempt in state `proposal-question` naming the comment, with the answer as its result and a non-zero cost in the work item's total

#### Scenario: Revision attempt names its comments
- **WHEN** a proposal has been revised twice
- **THEN** the third proposal attempt names both `/revise` comments, oldest first

### Requirement: Local runs take revisions and questions
`pnpm factory command` SHALL apply `/revise` and `/question` to a local work item: a revision moves the work item back to `proposal` or `design` for the next `pnpm factory run`, and a question is answered at once.

#### Scenario: Local revision runs on the next run
- **WHEN** the owner comments `/revise …` on a local work item awaiting proposal approval, runs `pnpm factory command` for it, then `pnpm factory run --issue 12 --until proposal`
- **THEN** the proposal author runs again with the comment, and the run stops at the proposal approval again

### Requirement: `/abort` stops a running work item
An owner's `/abort` while the work item is between `intake` and `build` SHALL stop its execution and the ECS task it runs, close its open attempts with the outcome `aborted` and its open approval with the outcome `aborted`, record the state it was in as `stopped_in`, and make it `aborted`. If the execution had already ended, the work item SHALL become `aborted` the same way. The reply SHALL say how to resume.

#### Scenario: Abort during the build stops the execution
- **WHEN** the owner comments `/abort` while task 1.2 is being built
- **THEN** the execution is stopped, the open implementer attempt is closed `aborted`, the work item is `aborted` with `stopped_in` = `build`, and the issue gets one reply saying the work item is aborted and `/resume` continues it

#### Scenario: Abort while awaiting approval closes the approval
- **WHEN** the owner comments `/abort` while the proposal awaits approval
- **THEN** the execution is stopped, the approval is closed with the outcome `aborted`, and the work item is `aborted` with `stopped_in` = `awaiting-proposal-approval`

#### Scenario: Abort during Plan stops its task
- **WHEN** the owner comments `/abort` while Plan's planner session runs
- **THEN** the execution is stopped, Plan's ECS task is stopped, the planner attempt is closed `aborted`, and the work item is `aborted` with `stopped_in` = `plan`

#### Scenario: Abort with nothing running is answered
- **WHEN** the owner comments `/abort` on an issue whose work item is `aborted`, `escalated` or `pr-open`, or that has no work item
- **THEN** nothing changes, and the issue gets one reply saying nothing runs

### Requirement: Aborting stops the running task
Aborting a work item SHALL stop the worker or build task its execution is running. Step Functions stops a `.sync` task with the execution. It does not stop a `waitForTaskToken` task (Plan, Adopt), so the abort SHALL stop the execution's latest submitted ECS task itself, when no later event of the execution closed it. A task that writes after the stop SHALL NOT change the work item's state: every state update SHALL apply only from the state its writer expects.

#### Scenario: Stopped execution stops its running task
- **WHEN** an execution is aborted while its Build state runs a build task, again while a worker state runs, and again while Plan runs
- **THEN** the build task, the worker task and Plan's task each stop within two minutes

#### Scenario: Late write after abort is refused
- **WHEN** a Proposal worker that was stopped finishes its attempt after the work item became `aborted`
- **THEN** the work item stays `aborted`, and the worker's state update is refused

### Requirement: `/resume` continues a stopped work item
An owner's `/resume [guidance]` SHALL start a new execution named `issue-<n>-resume-<comment id>` with input `{ issueNumber, resume: true }`, when the work item's execution has ended, its issue is open and its pull request is not open. Otherwise it SHALL be answered and change nothing: "running" while the execution runs, refused on a closed issue, "the PR is open", or "no work item; label the issue `factory`".

#### Scenario: Resume starts a new execution
- **WHEN** the owner comments `/resume` on an open issue whose work item is `aborted`
- **THEN** one execution named `issue-<n>-resume-<comment id>` starts with input `{ issueNumber, resume: true }`, and the issue gets one reply saying the work item resumes

#### Scenario: Resume while running is answered
- **WHEN** the owner comments `/resume` while the work item's execution is running
- **THEN** no execution starts, and the issue gets a reply saying the work item is running

#### Scenario: Resume on a closed issue is refused
- **WHEN** the owner comments `/resume` on a closed issue whose work item is `aborted`
- **THEN** no execution starts, and the reply says to reopen the issue first

#### Scenario: Resume with the pull request open is answered
- **WHEN** the owner comments `/resume` on an issue whose work item is `pr-open`
- **THEN** no execution starts, and the reply says the pull request is open

#### Scenario: Resume with no work item is answered
- **WHEN** the owner comments `/resume` on an issue of the target with no work item
- **THEN** no execution starts, and the reply says there is no work item and that labelling the issue `factory` starts one

### Requirement: A resumed execution enters where the work item stopped
On resume, Intake SHALL adopt the work item, storing the new execution's ARN, and the execution SHALL enter the state for the work item's state, or `stopped_in`: Proposal for `intake` and `proposal`, AwaitApproval, Approved, Design for `design` and `design-review`, AwaitDesignApproval, Plan, or BuildTasks with the unfinished tasks. Every entry state SHALL accept a work item in its own state.

#### Scenario: Resume during the build skips finished tasks
- **WHEN** a work item aborted in `build` with tasks 1.1 and 1.2 done is resumed
- **THEN** the new execution enters BuildTasks, no role runs for tasks 1.1 and 1.2, the build goes on with task 1.3, and the work item reaches `pr-open`

#### Scenario: Resume at an approval asks again
- **WHEN** a work item aborted while awaiting proposal approval is resumed
- **THEN** the new execution enters AwaitApproval, a new approval is open with a new token, and the summary is posted again

#### Scenario: Resume after approval asks for no second approval
- **WHEN** a work item aborted in `design` after its proposal was approved is resumed
- **THEN** the new execution enters Design, the architect runs, and no proposal approval is asked for

#### Scenario: Resume after an execution failed outside the factory
- **WHEN** a work item is in `plan` and its execution was stopped in the AWS console, and the owner comments `/resume`
- **THEN** a new execution starts and enters Plan, and the planner runs

### Requirement: Aborted attempts and resumes reset retry counts
An attempt closed `aborted` SHALL NOT count toward any retry limit. Resuming an escalated work item SHALL give its escalated state a fresh set of retries, counted from the resume.

#### Scenario: Aborted attempt does not count
- **WHEN** a work item is aborted during its second proposal attempt, after one failed attempt, and is resumed
- **THEN** the proposal author may make two more attempts before the work item escalates

#### Scenario: Resumed escalation gets fresh retries
- **WHEN** a task escalated after three failed implementer attempts is resumed
- **THEN** the implementer runs again for that task, with up to three more attempts

### Requirement: Stopped work items record where they stopped
An escalation SHALL record the state the work item was in as `stopped_in`, as an abort does, so a resume knows where to enter.

#### Scenario: Escalation records where the work item stopped
- **WHEN** a work item escalates in `plan` after three failed planner attempts
- **THEN** the work item is `escalated` with `stopped_in` = `plan`

### Requirement: Closing the issue is the final stop
When a work item's issue is closed, the factory SHALL stop a running execution as `/abort` does and comment once that the work item stopped. `/resume` SHALL be refused while the issue is closed, and SHALL work again once the issue is reopened.

#### Scenario: Closing the issue stops the work item
- **WHEN** the owner closes an issue whose work item's execution is in Design
- **THEN** the webhook starts one `command --issue <n> --closed` task, the execution is stopped, the work item is `aborted` with `stopped_in` = `design`, and the issue gets one comment saying so

#### Scenario: Reopened issue can be resumed
- **WHEN** the owner reopens that issue and comments `/resume`
- **THEN** a new execution starts and enters Design

### Requirement: Replies on a stopped work item point to `/resume`
For an `aborted` or `escalated` work item, `/approve`, `/revise` and `/question` SHALL be answered that nothing awaits and that `/resume` continues the work item. During `build`, `/revise` and `/question` SHALL be answered that nothing awaits and that `/abort` or a new issue are the ways on.

#### Scenario: Commands on a stopped work item point to resume
- **WHEN** the owner comments `/approve` on an issue whose work item is `escalated`
- **THEN** nothing changes, and the reply says nothing awaits approval and that `/resume` continues the work item

#### Scenario: Revise during the build points to abort
- **WHEN** the owner comments `/revise …` while the work item is in `build`
- **THEN** nothing changes, and the reply names `/abort` and a new issue

### Requirement: Local work items point to the run command
`/abort` and `/resume` on a work item with no execution, from a local run, SHALL be answered that local runs continue with `pnpm factory run`, and SHALL change nothing.

#### Scenario: Local work item points to the run command
- **WHEN** the owner runs `pnpm factory command` for a `/resume` on an escalated local work item
- **THEN** nothing changes, and the reply names `pnpm factory run`

### Requirement: The worker controls only its own executions
The worker's task role SHALL be allowed `states:StopExecution`, `states:DescribeExecution` and `states:GetExecutionHistory` only on its state machine's executions, `states:StartExecution` only on its state machine, and `ecs:StopTask` only on the tasks of the factory's cluster.

#### Scenario: Worker may control only its own executions
- **WHEN** the factory stack is synthesised
- **THEN** the worker's task role allows `states:StartExecution` on the work-item state machine only, `states:StopExecution`, `states:DescribeExecution` and `states:GetExecutionHistory` on that state machine's executions only, and `ecs:StopTask` on the factory cluster's tasks only

### Requirement: A command that fails before its handler is answered
A `command` task that fails before its handler runs, for example while it sets up the GitHub App, SHALL still try to post the fixed reply that the command did not go through and can be sent again. If GitHub cannot be reached for that reply either, the task SHALL log one line naming the issue, the comment id and that the command was neither recorded nor answered, and SHALL exit 1. The owner then sends the command again.

#### Scenario: Command that fails before its handler is answered
- **WHEN** the `command` task for an owner's `/status` cannot look up the App's bot user, and GitHub answers again later
- **THEN** nothing is recorded, the issue gets one comment saying the `/status` did not go through and can be sent again, and the task exits 1

#### Scenario: Command that cannot reach GitHub is logged
- **WHEN** every request of the `command` task to GitHub fails with a network error
- **THEN** nothing is recorded, no comment is posted, the log names the issue, the comment id and that the command was neither recorded nor answered, and the task exits 1
