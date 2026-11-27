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

/abort:  command task ─▶ lock ─▶ StopExecution ─▶ StopTask (a token task still running)
                       ─▶ close attempts and approval `aborted`
                       ─▶ state `aborted`, stopped_in ─▶ unlock ─▶ reply
/resume: command task ─▶ lock ─▶ checks (DescribeExecution ended, issue open, no PR)
                       ─▶ StartExecution issue-<n>-resume-<comment id> ─▶ unlock ─▶ reply
issues.closed ─▶ webhook ─▶ command --issue <n> --closed ─▶ as /abort, if running
```

## Components

### Step 0: the stop spike

Before any code, and with no production code: on a throwaway state machine with the AWS CLI, run the worker task definition with a `sleep` command override in one `ecs:runTask.sync` state and the build task definition in another, and stop each execution while the task runs. Record in this file how long the ECS task takes to stop, its stop code and reason, and whether the container gets SIGTERM before SIGKILL. Then delete the state machine. If the task does not stop, stop and settle the fallback with the owner (the `command` task calling `ecs:StopTask` on the execution's running task is the likely one).

#### Spike result (task 0.1, 2026-11-22)

The owner approved the spike, plus a third case that design did not ask for: a `waitForTaskToken` worker task, since Plan and Adopt are token tasks. A throwaway role and state machine `ceh-spike-stop` ran the stack's two boundary-check task definitions. These have the worker's and the build task's images, roles, security groups and subnets, but an entry point ECS lets a command override. The build case ran inside an inline Map, as BuildTasks does. Each task ran `node -e` as PID 1, as the real entry points do. The script logged a heartbeat every 5 s, logged SIGTERM without exiting, and would have exited on its own after 10 min. Each execution was stopped 60 s after its task was `RUNNING`. Both resources were deleted afterwards, and no task was left running.

| Case | `StopExecution` (UTC) | SIGTERM logged | ECS `stoppingAt` | `executionStoppedAt`, exit 137 | Task `STOPPED` | Stop code and reason |
| --- | --- | --- | --- | --- | --- | --- |
| `.sync` worker task | 18:25:43.5 | +1.8 s | +0.9 s | +42.9 s | +66.7 s | `UserInitiated`, "The Task state in AWS Step Functions execution [<arn>] which was managing this resource was aborted" |
| `.sync` build task in a Map | 18:25:32.7 | +2.5 s | +1.0 s | +43.6 s | +67.9 s | the same |
| `waitForTaskToken` worker task | 18:25:38.7 | none | none | — | still `RUNNING` after 180 s, so stopped by hand with `ecs stop-task` | (manual) `UserInitiated`, "spike: manual stop": SIGTERM +1.0 s, `stoppingAt` +0.5 s, `executionStoppedAt` +42.1 s, exit 137, `STOPPED` +65.4 s after `stop-task` |

- **`.sync` tasks stop:** Step Functions calls `StopTask` about 1 s after `StopExecution`. Both the worker and the build task were `STOPPED` in about 67 s, within the scenario's two minutes. The execution's status is `ABORTED` with the error passed to `StopExecution`.
- **Signals:** the container gets SIGTERM within about 2 s, then SIGKILL (exit 137). The last heartbeat came 26 s after SIGTERM and the next one never did, so SIGKILL came 26 to 31 s after SIGTERM. That matches the default stop timeout of 30 s (the task definitions set no `stopTimeout` and no init process). The real entry points install no SIGTERM handler. Node as PID 1 with no handler ignores SIGTERM, so a real worker or build task runs on until SIGKILL, about 30 s after the stop, and can still write in that time. Compare-and-set state updates and attempts closed `aborted` are what guard against that, as designed.
- **Token tasks do not stop:** stopping the execution leaves a `waitForTaskToken` ECS task running. Its later `SendTaskSuccess` fails, since the execution has ended. This matters for **Plan**, whose planner session runs inside its token task for minutes and spends model budget, and for Adopt, which is short. It does not matter for AwaitApproval and AwaitDesignApproval: their task stores the token, posts the summary and exits, so nothing runs while they wait. **Settled with the owner (2026-11-22): the fallback.** After `StopExecution`, the `command` task stops the execution's running ECS task itself (see "Command handler: `/abort` and `--closed`", step 3), and the spike's scenario covers Plan.

### Command handler: `/abort` and `--closed`

Under the work-item lock:

1. No work item, or `aborted`, `escalated`, `pr-open`: "nothing runs" (for `--closed`: no comment).
2. `DescribeExecution` on the work item's execution ARN. If it is running, `StopExecution` with error `factory.Aborted` and a fixed cause naming the comment id (never the comment's text).
3. If step 2 stopped the execution: `GetExecutionHistory` in reverse order, to the latest `TaskSubmitted` event. If no later `TaskSucceeded`, `TaskFailed` or `TaskTimedOut` event closed it, `ecs:StopTask` its `TaskArn`, with the cluster taken from that ARN and a fixed reason naming the comment id. This step stops a token task (Plan, Adopt), which `StopExecution` leaves running. For a `.sync` task it repeats Step Functions' own `StopTask`, which is harmless. Only one task runs at a time (the Map's `MaxConcurrency` is 1), so the latest submitted task is the running one. A failed `StopTask` is logged with its error code, and the abort goes on: the task's late writes are refused by compare-and-set.
4. Close open attempts `aborted`, an open approval `aborted`; `stopped_in` = the current state; state = `aborted` (compare-and-set from the state read under the lock).
5. Record the comment `applied`; commit; reply. `--closed` has no comment row: it posts one fixed comment and records nothing in `comments`.

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

Retry limits count failed attempts since the latest of: the run's start (as today, and `add-approval-feedback`'s revisions) and the work item's last applied `/resume` that met it `escalated` (`comments.state_met`). Attempts closed `aborted` are not counted. A `/resume` of an aborted work item resets nothing: the failed attempts before the abort still count, so an abort cannot be used to retry for free (scenario "Aborted attempt does not count": one failed attempt and one aborted leave two more). The same rule applies to the design-flaw count: Adopt resets it for an escalated work item only, so a work item escalated for its third design flaw gets a fresh count on resume. In the build loop, an escalated resume restarts the task's limits and its last label, while its committed tests and the last failure's evidence carry over.

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

The worker's task role gains `states:StartExecution` on the state machine's ARN; `states:StopExecution`, `states:DescribeExecution` and `states:GetExecutionHistory` on `arn:aws:states:<region>:<account>:execution:<state machine name>:*`; and `ecs:StopTask` on `arn:aws:ecs:<region>:<account>:task/<cluster name>/*`. IAM cannot narrow `StopTask` to one execution's task, so the code stops only the task ARN it read from that execution's history. The state machine's ARN is already a dependency of the worker's policy (SendTaskSuccess), so no cycle is added. The worker gets the state machine ARN in its environment (`FACTORY_STATE_MACHINE_ARN`).

## Decisions

- **Adopt is a token task.** BuildTasks needs `$changeId` and `$tasks`, which a `.sync` task cannot return, so Adopt answers like Plan does.
- **`/abort` on an ended execution marks the work item `aborted`** (with `stopped_in`), rather than answering "nothing runs", so `/status` never shows a running state that nothing runs. Decided here; the owner is told.
- **`/abort` stops a token task itself** (owner, 2026-11-22, after the stop spike): `StopExecution` leaves a `waitForTaskToken` ECS task running, so `/abort` stops the execution's latest unclosed task with `ecs:StopTask`. The worker may stop any task in the factory's cluster. The alternatives were rejected: Plan polling for the abort, which is more moving parts and covers only the states that check, and accepting the gap, which lets the planner commit after the abort.
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

- **ADR 0016 Resuming work items (new):** `/resume` only; a new execution per resume with Intake adopting the work item; entry from the work item's state or `stopped_in`; aborted as paused, closing the issue as the final stop; aborted attempts never count, resuming an escalated work item resets its retries (resuming an aborted one does not); compare-and-set state updates; the stop spike's result.
- **ADR 0015 amendment:** `/abort`, `/resume` and the closed issue.
- **ADR 0002 amendment:** the start Choice and Adopt; the worker stopping and starting executions.
- **ADR 0003 amendment:** `aborted`, `stopped_in`, and the M3.5 tables and columns together.
- **Brief:** tick M3.5 in section 7.

## Owner prerequisites

- Approval of the spike's AWS writes (a throwaway state machine and two short tasks; a few cents).
- Approval of the deploy, with no execution paused that must stay unchanged.
- The M3.5 exit run (section 11): a fresh `vocab` issue whose proposal will ask at least one open question; a second GitHub account for the non-owner `/approve`; approval of every GitHub write; model spend of roughly $3–5 within the work item's $5.

## Cloud results (task 4.3, 2026-11-26)

- **Diff and deploy:** `pnpm image:build` and `pnpm infra:diff` were run and reviewed by the owner, then `pnpm infra:deploy`. The worker is at revision 13. The first worker task after the deploy was #27's Intake, which exited 0, so migration 0007 applied.
- **Test:** `factory/orchestrator/test/resume.cloud.test.ts` filed the throwaway `vocab` issue #27, "[cloud test] Count lookups per weekday", as the owner, and drove it with `gh`. Its 4 tests passed in 889 s. The change was `add-cloud-test-count-lookups-per-weekday`, `small`, with one task. All times are UTC.
  - **Proposal:** labelled at 20:50:39, then Intake and Proposal. The summary was posted at 20:54:35, and `/approve` at 20:54:46 was answered at 20:55:46. Plan ran from 20:56:23 to 20:57:03. The test author's build task for task 1.1 started at 20:58:00.
  - **`/abort` (comment 7203257539), during that build:** commented at 20:58:25. The webhook started the `command` task at 20:58:28, and the reply came at 20:58:54 (+29 s), "stopped it in `build`". The execution was `ABORTED` with `factory.Aborted` at 20:58:54, and the build task reached `STOPPED`. `/status` (20:59:38, answered +33 s) gave `aborted`, 0 of 1 tasks done, 3 attempts, $0.20.
  - **`/resume` (comment 7203289874):** commented at 21:00:25, and the reply came at 21:00:53 (+28 s), "resumes from `build`". The execution `issue-27-resume-7203289874` started at 21:00:53 with `{ issueNumber: 27, resume: true }`. It went Start, StartChoice, Adopt (24 s), AdoptExit, BuildTasks, and was building task 1.1 again by 21:02:11. Task 1.1 was unfinished, so it was rightly built again.
  - **Closing the issue:** closed at 21:02:45. The webhook started one `command --issue 27 --closed` task at 21:02:47. The closed-issue comment came at 21:03:07 (+22 s), "in `build`; it is `aborted` now", the execution was `ABORTED` at 21:03:07, and its build task stopped.
  - **Reopening and `/resume` (comment 7203360442):** reopened at 21:03:49. The webhook ignored `issues.reopened`: no task started and no comment was posted. `/resume` at 21:04:21 got its reply at 21:04:44 (+23 s). `issue-27-resume-7203360442` entered BuildTasks through Adopt at 21:05:12, without Intake, Proposal, AwaitApproval or Plan, and no second approval was asked for.
- **Clean-up:** the test closed #27 at 21:05:24. That closed-issue task aborted the last execution at 21:05:55 (+31 s) and posted its comment. Its `Step` task had already exited, and no task was left running in the cluster. #27 stays closed, and its change branch is left in `vocab`.
- **Cost:** $0.20 at the abort, from `/status`: the proposal, the plan and the first build attempt so far. The two short build attempts after each resume are not counted there. The ledger can't be read from the laptop, so the total is in the Anthropic console.

## Cloud results (task 4.4, 2026-11-26)

- **Test:** `factory/worker/test/stop.cloud.test.ts`. It creates a throwaway role and state machine `ceh-stop-test-ddb0eded` on the stack's boundary-check task definitions, with three cases: a `.sync` worker task, a `.sync` build task in an inline Map, and a `waitForTaskToken` worker task as Plan runs. Each task runs `node` as PID 1 with a script that logs SIGTERM and does not exit. Each execution is stopped 20 s after its task is `RUNNING`, with the abort's own sequence: DescribeExecution, StopExecution with `factory.Aborted`, the history newest first, `latestOpenTask` and `clusterOf` from the orchestrator, then StopTask. The test passed in 139 s, and the test added `@aws-sdk/client-iam` (3.1161.0) as a worker dev dependency for the role. Afterwards the role and the state machine were gone, and no task was left running.
- **Results (UTC):** in every case `latestOpenTask` found the running task in the history, and the execution ended `ABORTED` with `factory.Aborted`.

  | Case | ECS `stoppingAt` | `executionStoppedAt` | Task `STOPPED` | Stop code, reason, exit |
  | --- | --- | --- | --- | --- |
  | `.sync` worker task | 21:18:29.5 | +41.5 s | +64.5 s | `UserInitiated`, the abort's cause, 137 |
  | `.sync` build task in a Map | 21:18:24.4 | +42.3 s | +65.5 s | `UserInitiated`, the abort's cause, 137 |
  | `waitForTaskToken` worker task | 21:18:24.6 | +42.0 s | +64.9 s | `UserInitiated`, the abort's cause, 137 |

  `stoppingAt` comes within about 1 s of StopExecution, so every task was `STOPPED` in about 66 s, within the scenario's two minutes. The `waitForTaskToken` task, which the spike saw left running, is now stopped by the abort's StopTask. Each `.sync` task's reason is also the abort's cause, so the abort's StopTask reached ECS before Step Functions' own one, which is harmless. As in the spike, SIGKILL comes about 30 s after SIGTERM (exit 137).

## Exit run (task 4.5, 2026-11-26)

M3.5's exit (`docs/m3.5-owner-commands.md`, section 11) ran on `vocab` issue #28, "Count lookups per hour of the day". It ended in pull request [#29](https://github.com/miklospocsaji/vocab/pull/29), opened by `ceh-app[bot]`, whose `check` passed. Wall time from the label (21:36:18 UTC) to the pull request (22:00:10) was 23 min 52 s. No one edited the branch, the code or the tests. The owner's interventions were the 10 comments below, two of them sent on purpose to be refused or ignored. Cost from the pull request's table: $0.62. That is proposal author 3 attempts $0.44 (the proposal, the answer and the revision), planner $0.04, test author 2 attempts $0.08 (one aborted before its session ran) and implementer $0.06. Comment links are `https://github.com/miklospocsaji/vocab/issues/28#issuecomment-<id>`.

1. **`/question`, then a `/revise` that answers the open question.** The proposal (`add-count-lookups-per-hour-of-the-day`, `small`, $0.17) was posted at 21:39:44, 3 min 26 s after the label. It listed the planted open question (which time zone decides a lookup's hour) and two it found itself: zod contracts, and the capability.
   - The `/question` ([7203946390](https://github.com/miklospocsaji/vocab/issues/28#issuecomment-7203946390), 21:40:05) was answered at 21:40:52 (+47 s), with the approval still open.
   - The `/revise` ([7203983145](https://github.com/miklospocsaji/vocab/issues/28#issuecomment-7203983145), 21:42:27) answered all three: UTC, no zod contracts, `vocab-import`. It got its reply at 21:42:59 (+32 s).
   - The revised summary came at 21:45:06 (+2 min 39 s). It opens with "What changed", and its open questions say "None". The proposal author committed `4b72b46` on top of `011d6ef`. Its `proposal.md` names the UTC hour and adds a scenario with exact UTC timestamps.
2. **Busy `/revise`.** `/revise also count minutes` ([7203993702](https://github.com/miklospocsaji/vocab/issues/28#issuecomment-7203993702), 21:43:07) was sent during the rewrite. It got the busy reply at 21:43:36 (+29 s), "`proposal` is running, so your `/revise` was not applied and is not kept", and minutes appear nowhere in the revision.
3. **Ignored comments.** Neither of these got a reply or started a task, and the execution's last event stayed the `AwaitApproval` submission of 21:44:38.
   - The owner's "Looks good, thanks" ([7204041273](https://github.com/miklospocsaji/vocab/issues/28#issuecomment-7204041273)): `ignored: no command on the comment's first line`.
   - `/approve` from `miklospocsaji-weknow` ([7204048300](https://github.com/miklospocsaji/vocab/issues/28#issuecomment-7204048300)): `ignored: /approve from miklospocsaji-weknow, who is not the owner`.
4. **`/status`.**
   - Awaiting approval ([7204058803](https://github.com/miklospocsaji/vocab/issues/28#issuecomment-7204058803), 21:47:16): answered at 21:47:45 (+29 s) with `awaiting-proposal-approval`, no plan yet, 3 attempts, $0.44.
   - During Build ([7204101745](https://github.com/miklospocsaji/vocab/issues/28#issuecomment-7204101745), 21:49:55): answered at 21:50:25 (+30 s) with `build`, task 1.1, 0 of 1 tasks done, 4 attempts, $0.48.
5. **`/abort` and `/resume` during Build.** `/approve` ([7204071123](https://github.com/miklospocsaji/vocab/issues/28#issuecomment-7204071123), 21:48:01) was answered at 21:49:02 (+61 s) with `small`, skipping Design. Plan made one task, 1.1, and its test author's build task was submitted at 21:50:59.
   - **`/abort`** ([7204122849](https://github.com/miklospocsaji/vocab/issues/28#issuecomment-7204122849), 21:51:07) was answered at 21:51:30 (+23 s): "stopped it in `build`". The execution was `ABORTED` with `factory.Aborted` at 21:51:30. The abort's StopTask stopped the build task while it was still `PENDING` (`UserInitiated`, "Aborted by the owner's comment 7204122849"), so no session ran.
   - **`/resume Keep the two functions in one file, lookups-per-hour.ts.`** ([7204145155](https://github.com/miklospocsaji/vocab/issues/28#issuecomment-7204145155), 21:52:28) was answered at 21:53:00 (+32 s): "resumes from `build`", and "the next role gets your text as guidance".
   - The new execution `issue-28-resume-7204145155` went Start, StartChoice, Adopt (26 s), then BuildTasks. It skipped Intake, Proposal, AwaitApproval and Plan, and asked for no second `/approve`. Test author attempt 2 then implementer attempt 1 built 1.1, which was ticked, and OpenPullRequest opened #29 at 22:00:10. The execution succeeded at 22:00:39.
   - The guidance reached the test author's `input.json` as `ownerGuidance`, and the implementer's had none, as designed. The test author kept the approved plan's file name, `reading-hours.ts`, rather than the guidance's `lookups-per-hour.ts`.
- **Deviation from task 4.5:** Plan made a single task, so no task was done when the owner sent `/abort`. The run therefore shows a resume in the middle of a task, not one that skips a finished task. Section 11's criterion holds as written, since no task done before the abort was rebuilt. Skipping finished tasks is proved by the unit tests of task 1.6 (Adopt answers the unfinished tasks, and Step skips the done ones) and by the ASL tests of task 3.1, not by a cloud run.
