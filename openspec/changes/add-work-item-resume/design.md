# Design

## Overview

Settled in `docs/m3.5-owner-commands.md`, sections 6, 7 and 9. Built on `add-owner-commands`; independent of `add-approval-feedback`, which is built first.

```
Start ─▶ StartChoice ─┬─ resume = false ─▶ Intake ─▶ … (as today)
                      └─ resume = true  ─▶ Adopt (intake --resume, waitForTaskToken
                                                  → { exitCode, entry, changeId, tasks })
                                                ─▶ EntryChoice ─┬─ proposal          ─▶ Proposal
                                                                ├─ await-approval    ─▶ AwaitApproval
                                                                ├─ approved          ─▶ Approved
                                                                ├─ design            ─▶ Design
                                                                ├─ await-design      ─▶ AwaitDesignApproval
                                                                ├─ plan              ─▶ Plan
                                                                └─ build             ─▶ BuildTasks

/abort:  command task ─▶ lock ─▶ StopExecution ─▶ close attempts and approval `aborted`
                       ─▶ state `aborted`, stopped_in ─▶ unlock ─▶ reply
/resume: command task ─▶ lock ─▶ checks (DescribeExecution ended, issue open, no PR)
                       ─▶ StartExecution issue-<n>-resume-<comment id> ─▶ unlock ─▶ reply
issues.closed ─▶ webhook ─▶ command --issue <n> --closed ─▶ as /abort, if running
```

## Components

### Step 0: the stop spike

Before any code, and with no production code: on a throwaway state machine with the AWS CLI, run the worker task definition with a `sleep` command override in one `ecs:runTask.sync` state and the build task definition in another, and stop each execution while the task runs. Record in this file how long the ECS task takes to stop, its stop code and reason, and whether the container gets SIGTERM before SIGKILL. Then delete the state machine. If the task does not stop, stop and settle the fallback with the owner (the `command` task calling `ecs:StopTask` on the execution's running task is the likely one).

### Command handler: `/abort` and `--closed`

Under the work-item lock:

1. No work item, or `aborted`, `escalated`, `pr-open`: "nothing runs" (for `--closed`: no comment).
2. `DescribeExecution` on the work item's execution ARN. If it is running, `StopExecution` with error `factory.Aborted` and a fixed cause naming the comment id (never the comment's text).
3. Close open attempts `aborted`, an open approval `aborted`; `stopped_in` = the current state; state = `aborted` (compare-and-set from the state read under the lock).
4. Record the comment `applied`; commit; reply. `--closed` has no comment row: it posts one fixed comment and records nothing in `comments`.

A work item with no execution ARN (a local run) gets the "use `pnpm factory run`" reply.

### Command handler: `/resume`

Under the lock: refuse with the replies of the spec unless the work item exists, is not `pr-open`, the issue is open (`getIssue`), and `DescribeExecution` says its execution is not `RUNNING`. Then `StartExecution` with name `issue-<n>-resume-<comment id>` and input `{ issueNumber, resume: true }`. `ExecutionAlreadyExists` (a redelivery) counts as started. Record the comment `applied`; its text is the guidance. The new ARN is stored by Adopt, not here, so a start that never ran leaves the old ARN and `/resume` can be repeated.

### Adopt (`intake --resume`, `factory/orchestrator/src/intake.ts`)

A waitForTaskToken task, like Plan, since its answer is more than an exit code. For the issue's work item:

- the entry state is `stopped_in` for `aborted` and `escalated` work items, and the state itself otherwise
- store the new execution ARN; set the state to the entry's state (compare-and-set), and clear `stopped_in`
- answer `{ exitCode: 0, entry, changeId, tasks }`, with `tasks` the unfinished live task ids for `build`, and `[]` otherwise
- a work item that is `pr-open` or has no entry answers `exitCode: 4` (Ended)

Entry mapping (section 7): `intake`, `proposal` → `proposal`; `awaiting-proposal-approval` → `await-approval`; `proposal-approved` → `approved`; `design`, `design-review` → `design`; `awaiting-design-approval` → `await-design`; `plan` → `plan`; `build` → `build`.

### Entry states

Each entry state must accept a work item already in its own state, as Approved does:

- **Proposal** already runs for `proposal`; open attempts are closed `aborted` by the abort, so the role runs again.
- **AwaitApproval / AwaitDesignApproval** already require their awaiting state; the dead token's approval was closed `aborted`, so a new one opens and the summary is posted again.
- **Design** accepts `design` and `design-review`. For `design-review` with a succeeded design attempt after the run's start, it runs only the reviewer.
- **Plan** accepts `plan`, as today.
- **Step** already skips a task ticked in `tasks.md` and done in the ledger.

### Retry counts

Retry limits count failed attempts since the latest of: the run's start (as today, and `add-approval-feedback`'s revisions) and the work item's last applied `/resume`. Attempts closed `aborted` are not counted. The same rule applies to the design-flaw count, so a work item escalated for its third design flaw gets a fresh count on resume.

### Owner guidance

`renderPrompt` and `renderTaskPrompt` take the `/resume` text as one more owner-feedback block (the fence of `add-approval-feedback`'s design, or the same helper if this change is built alone). The first attempt of the entry state after a resume gets it; for Build it goes in `BuildInput.ownerGuidance` in the artifact store, never in the execution. An escalated work item's evidence is its last failed attempt's, as for a retry.

### Ledger (`0007_resume.sql`)

```sql
ALTER TABLE work_items ADD COLUMN stopped_in text;    -- the state at abort or escalation; null otherwise
-- attempts.outcome gains 'aborted' (no failure reason)
ALTER TABLE attempts DROP CONSTRAINT attempts_outcome_check;  -- name as found in the migrated schema
ALTER TABLE attempts ADD CONSTRAINT attempts_outcome_check CHECK (outcome IN ('succeeded', 'failed', 'aborted'));
-- the open/closed CHECK of 0001 is replaced to allow `aborted` with no failure reason
-- approvals.outcome gains 'aborted'
```

`setWorkItemState(db, id, to, { from })` becomes compare-and-set: `UPDATE … WHERE id = $1 AND state = $from`, rejecting when no row changed. Every handler passes the state it read. Escalation sets `stopped_in`.

### Webhook

`issues.closed` on an issue of the repository: one RunTask of `["command", "--issue", "<n>", "--closed"]`. The command task does nothing when there is no running work item. `issues.reopened` is ignored.

### Duplicate Intake

A relabel's Intake still answers `duplicate` (exit 4), and now comments once: "This issue already has the work item `<id>` (`<state>`). Reply `/resume` to continue it." A webhook redelivery starts no execution, so it posts nothing.

### GitHub App requests (`factory/forge/src/github-app.ts`)

Found in `add-approval-feedback`'s cloud check (its `design.md`, "Cloud results"): a `command` task's first network call, the installation token request, failed with `fetch failed` about 10 s after the container started, and the owner's `/question` was lost with no reply. The cause could not be found, because the error's `cause` is dropped.

- **Retries.** `createInstallationTokenProvider`'s request and `appCommitter`'s lookup are tried up to 3 times, waiting 2 s and then 5 s, when `fetch` rejects or the status is 5xx. Any other answer (401, 403, 404, 422, or a 2xx without a token) is final at once. Both requests are safe to repeat: a second token or a second `GET /users/<bot>` changes nothing. Retries are not added to the Forge's other calls, since a comment or a push repeated after a connection reset could be done twice. A sleep is injected, so tests do not wait. Worst case, about 3 × 10 s of connect timeouts plus 7 s of waits, about 40 s, is well inside every state's timeout.
- **The error's code.** A rejected `fetch` carries the reason in `cause.code` (for example `UND_ERR_CONNECT_TIMEOUT`, `ENOTFOUND`, `ECONNRESET`). The message takes that code only when it matches `^[A-Z][A-Z0-9_]*$`, and nothing else from the cause, so the scrubbing stays as it is. Example: `GitHub App: requesting an installation token failed 3 times: fetch failed (UND_ERR_CONNECT_TIMEOUT)`.
- **A `command` task that fails during setup.** `main.ts` builds the Forge (`appCommitter`) before `runWorker`, so today a setup failure reaches only the top-level catch, and the `command` branch's fixed reply is never tried. For `command`, a setup failure now tries `commandFailedReply()` through a Forge without a committer (a comment needs no commit identity), whose token provider retries as above. If that fails too, the task logs `factory-worker: command for issue #<n>, comment <id>: GitHub could not be reached; the command was neither recorded nor answered` and exits 1. No retry layer is added around the `command` task itself: it is started by the webhook's RunTask, and GitHub does not redeliver a webhook that was answered 2xx. A GitHub outage longer than the retries therefore still loses the command, and the log says so.

### Stack

The worker's task role gains `states:StartExecution` on the state machine's ARN, and `states:StopExecution` and `states:DescribeExecution` on `arn:aws:states:<region>:<account>:execution:<state machine name>:*`. The state machine's ARN is already a dependency of the worker's policy (SendTaskSuccess), so no cycle is added. The worker gets the state machine ARN in its environment (`FACTORY_STATE_MACHINE_ARN`).

## Decisions

- **Adopt is a token task.** BuildTasks needs `$changeId` and `$tasks`, which a `.sync` task cannot return, so Adopt answers like Plan does.
- **`/abort` on an ended execution marks the work item `aborted`** (with `stopped_in`), rather than answering "nothing runs", so `/status` never shows a running state that nothing runs. Decided here; the owner is told.
- **Compare-and-set on every state update**, so a stopped task that still writes cannot undo an abort. It also guards today's handlers against duplicate tasks.
- **No comment row for a closed issue**: closing is not a command. Its comment is fixed text.
- **Local work items** answer `/abort` and `/resume` with "use `pnpm factory run`": they have no execution to stop or start. Decided here; the owner is told.

- **Retries only where repeating is harmless:** the token request and the bot lookup, not comments or pushes. Decided here after the cloud check of `add-approval-feedback`; the owner moved the work into this change.

## Risks

- **A stopped build task's patch.** The build task writes its outcome to the artifact store; a resumed Step ignores an outcome whose attempt is closed `aborted` and prepares a new build.
- **A stopped worker mid-push.** The branch may have a commit whose ledger attempt is `aborted`. The resumed role starts from the branch head, so the commit is kept and the role sees it; for a build task, Step finds the task not done in the ledger and builds it again on top.
- **Executions started before the deploy run the old definition**, without the start Choice. Only new executions can be resumed into, so this is safe; a `/abort` on an old execution still works.
- **Two `/resume`s at once** are ordered by the lock; the second meets a running execution and gets "running".

## Contracts

No contracts path in `ceh`; the changed types are `BuildInput.ownerGuidance` and the Adopt output.

## Decisions that need an ADR

- **ADR 0016 Resuming work items (new):** `/resume` only; a new execution per resume with Intake adopting the work item; entry from the work item's state or `stopped_in`; aborted as paused, closing the issue as the final stop; aborted attempts never count, resumes reset retries; compare-and-set state updates; the stop spike's result.
- **ADR 0015 amendment:** `/abort`, `/resume` and the closed issue.
- **ADR 0002 amendment:** the start Choice and Adopt; the worker stopping and starting executions.
- **ADR 0003 amendment:** `aborted`, `stopped_in`, and the M3.5 tables and columns together.
- **Brief:** tick M3.5 in section 7.

## Owner prerequisites

- Approval of the spike's AWS writes (a throwaway state machine and two short tasks; a few cents).
- Approval of the deploy, with no execution paused that must stay unchanged.
- The M3.5 exit run (section 11): a fresh `vocab` issue whose proposal will ask at least one open question; a second GitHub account for the non-owner `/approve`; approval of every GitHub write; model spend of roughly $3–5 within the work item's $5.
