# Proposal

## Why

A work item whose execution was stopped or failed cannot be resumed. Relabelling its issue starts an execution whose Intake answers `duplicate`, so the only way on is a new issue that repeats Intake, Proposal, the approval, Design and Plan; M3's exit run had to do this with #11. The owner also cannot stop a work item from the issue (`docs/m3.5-owner-commands.md`, section 1). This is the third M3.5 change (section 10), built on `add-owner-commands`, and its last tasks are M3.5's exit run.

## What Changes

- **`/abort [reason]` while the work item's execution runs** (sections 3 and 9): the `command` task stops the execution. `StopExecution` also stops a running `.sync` ECS task, but not a `waitForTaskToken` task such as Plan's (the stop spike, 2026-11-22), so the `command` task then stops the execution's running ECS task itself (`ecs:StopTask`). The work item the work item becomes `aborted`, with the state it was in recorded as `stopped_in`. Its open attempt is closed with the new outcome `aborted`, and its open approval with the outcome `aborted`. Aborted means paused, not final.
- **`/resume [guidance]` when the work item's execution has ended** (`aborted`, `escalated`, or failed or stopped outside the factory), the issue is open and the pull request is not open yet (section 7):
  - The `command` task checks the execution has ended (`DescribeExecution`) and starts a new one, named `issue-<n>-resume-<comment id>`, with input `{ issueNumber, resume: true }`.
  - Intake adopts the work item: it stores the new execution's ARN and answers which state to enter. A Choice at the start of the state machine routes there.
  - Entry follows the work item's state, or `stopped_in`: `intake` and `proposal` → Proposal; `awaiting-proposal-approval` → AwaitApproval, with a new token and the summary posted again; `proposal-approved` → Approved; `design` and `design-review` → Design; `awaiting-design-approval` → AwaitDesignApproval; `plan` → Plan; `build` → BuildTasks with the unfinished tasks from the ledger. Every entry state accepts a work item in its own state.
  - No second `/approve` is asked for anything already approved, and no task done before is rebuilt.
  - The `/resume` text goes to the next role as owner guidance, next to the failure evidence of an escalation.
  - An `aborted` attempt never counts toward a retry limit, and resuming an escalated work item gives the escalated state a fresh set of retries.
- **Closing the issue is the final stop:** `issues.closed` runs `command --issue <n> --closed`, which aborts a running execution. `/resume` on a closed issue is refused; reopening the issue makes it work again.
- **Relabelling** a work item's issue still ends in a `duplicate` Intake, which now comments that `/resume` continues the work item.
- **Replies** on a stopped work item point to `/resume`, and `/revise` during the build points to `/abort` (section 6).
- **Ledger** (migration `0007_resume.sql`): `work_items.state` gains `aborted` and the new column `stopped_in`, set on abort and on escalation; `attempts.outcome` and the approvals' outcome gain `aborted`. A work item's state changes only from the state the writer expects, so a stopped worker finishing late cannot move an aborted work item.
- **IAM:** the worker may `states:StopExecution`, `states:DescribeExecution`, `states:GetExecutionHistory` and `states:StartExecution` on its own state machine and its executions only, and `ecs:StopTask` on the factory cluster's tasks only.
- **GitHub App requests survive a network blip** (found in `add-approval-feedback`'s cloud check, 2026-11-22, where a `/question`'s `command` task lost its first network call and the owner got no reply; moved here by the owner):
  - The installation token request and the bot user's lookup are tried up to 3 times, with a backoff, on a network error or a 5xx answer. Every worker task makes both at startup, and the `command` task has no Step Functions retry to fall back on.
  - A network error names its code (such as `UND_ERR_CONNECT_TIMEOUT`), and nothing else from the underlying error, so the next one can be diagnosed from the log without risking the JWT.
  - A `command` task that fails before its handler still tries the fixed "did not go through" reply. If GitHub cannot be reached at all, the log line names the issue and the comment, and the owner sends the command again.
- **Spike first:** confirm that stopping an execution stops the running `.sync` ECS task, for the worker and the build task.

Out of scope:
- resuming by relabelling (relabelling starts, `/resume` continues)
- `/restart` (left out of M3.5 by the owner)
- questions about an escalated or aborted work item ("why did the build fail?")
- reacting to a reopened issue by itself; the owner sends `/resume`
- local `/abort` and `/resume`: local runs have no execution, so the reply points to `pnpm factory run`

## Capabilities

### New Capabilities

### Modified Capabilities
- `orchestration`: `/abort`, `/resume` and the closed issue; retried GitHub App requests and the reply for a command that fails before its handler; `aborted` and `stopped_in`; the start Choice and Intake adopting a work item; every entry state accepting its own state; aborted attempts and fresh retries; the duplicate Intake's comment; the worker's new Step Functions permissions.
- `roles`: the `/resume` guidance in the next role's prompt.

## Impact

- `factory/orchestrator`: the `/abort`, `/resume` and closed-issue branches of the command handler; `intake --resume`; entry checks in AwaitApproval, Approved, Design, Plan and Step; retry counting from the last resume; `state-machine.ts` with the start Choice and the resume Intake; the webhook's `issues.closed` route.
- `factory/roles`: the owner's guidance in the prompt, for worker and build roles.
- `factory/artifacts`: the owner's guidance in the build input.
- `factory/ledger`: migration `0007_resume.sql`, compare-and-set state updates.
- `factory/forge`: retries and the error code in `createInstallationTokenProvider` and `appCommitter`.
- `factory/worker`: `command --closed`, a Step Functions client for stop, describe and start; the failure reply for a `command` task that fails during setup.
- `infra`: the worker's task role gains the three Step Functions actions, scoped to its state machine.
- Docs: ADR 0016 (resuming work items), amendments to ADR 0015, ADR 0002 and ADR 0003, the brief (M3.5 ticked), `CLAUDE.md`.
- Tagged `large`: two capabilities, a ledger migration, a state machine change, and new IAM.
