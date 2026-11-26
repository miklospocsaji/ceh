# 0016 Resuming work items

Status: accepted (2026-11-26; owner decisions of 2026-11-15, `docs/m3.5-owner-commands.md` sections 7, 9 and 12, and of 2026-11-22 after the stop spike; add-work-item-resume)

## Context

Until M3.5 a work item whose execution was stopped or failed could not go on. Relabelling its issue started an execution whose Intake answered `duplicate`, so the only way on was a new issue that repeated Intake, Proposal, the approval, Design and Plan (M3's exit run, #11). The owner also could not stop a work item from the issue (`docs/m3.5-owner-commands.md`, section 1).

A Step Functions execution cannot be restarted where it stopped, and Step Functions does not stop a `waitForTaskToken` ECS task with its execution (the stop spike of 2026-11-22, `add-work-item-resume` design, "Spike result").

## Decision

- **`/resume` continues, relabelling starts.** Only the owner's `/resume [guidance]` continues a work item, when its execution has ended (`aborted`, `escalated`, or stopped or failed outside the factory), its issue is open and its pull request is not. Relabelling still ends in a `duplicate` Intake, which now comments once that `/resume` continues the work item.
- **A new execution per resume, and Intake adopts the work item.** The `command` task starts `issue-<n>-resume-<comment id>` with input `{ issueNumber, resume: true }`; a name taken already (a redelivery) counts as started. A Choice at the start of the state machine sends it to Adopt (`intake --resume`), a `waitForTaskToken` task like Plan, which stores the new execution's ARN and answers `{ exitCode, entry, changeId, tasks }`. The new ARN is stored by Adopt, not by the command, so a start that never ran leaves the old ARN and `/resume` can be sent again.
- **Entry from the work item's state, or `stopped_in`.** An aborted or escalated work item records the state it stopped in. The entries: `intake` and `proposal` → Proposal; `awaiting-proposal-approval` → AwaitApproval, with a new token and the summary posted again; `proposal-approved` → Approved; `design` and `design-review` → Design; `awaiting-design-approval` → AwaitDesignApproval; `plan` → Plan; `build` → BuildTasks with the unfinished tasks from the ledger. Every entry state accepts a work item in its own state. Nothing already approved is asked for again, and no finished task is built again. A `pr-open` work item, or one with no entry (escalated before this change, with no `stopped_in`), answers exit 4 and the execution ends. Adopt also closes, as `aborted`, any attempt or approval a dead execution left open.
- **`/abort` pauses.** While the work item runs, the `command` task, under the work item's lock, stops its execution (`StopExecution`, error `factory.Aborted`, a fixed cause naming the comment id, never its text). Then it stops the execution's latest submitted ECS task that no later task event closed (`ecs:StopTask`), since a `waitForTaskToken` task such as Plan runs on otherwise. For a `.sync` task that repeats Step Functions' own StopTask, which is harmless. It closes the open attempts and the open approval `aborted`, and makes the work item `aborted`. A failed StopTask is logged and the abort goes on. An `/abort` on an execution that had already ended still marks the work item `aborted`, so `/status` never shows a running state that nothing runs.
- **Closing the issue is the final stop.** `issues.closed` runs `command --issue <n> --closed`, which aborts a running work item as `/abort` does and comments once. It records no command. `/resume` on a closed issue is refused; reopening the issue makes it work again, and reopening alone starts nothing.
- **Aborted attempts never count; an escalated resume resets retries.** An attempt closed `aborted` counts toward no retry limit. A `/resume` that met the work item `escalated` gives its escalated state a fresh set of retries, counted from the `/resume`, and resets the design-flaw count. A `/resume` of an aborted work item resets nothing: the failed attempts before the abort still count, so an abort cannot be used to retry for free.
- **The `/resume` text reaches the next role, once.** The first role that runs after the resume gets it, fenced as the owner's feedback. A build role gets it through `BuildInput.ownerGuidance` in the artifact store, never in the execution. The attempt names the comment it was given.
- **Compare-and-set state updates.** Every state update applies only from the state its writer read, and is refused otherwise. A stopped worker runs on until SIGKILL, about 30 s after the stop (the spike), and its late write must not undo an abort.
- **Local work items** have no execution: their `/abort` and `/resume` are answered with `pnpm factory run`.
- **IAM.** The worker may `states:StartExecution` on its state machine only, `states:StopExecution`, `states:DescribeExecution` and `states:GetExecutionHistory` on that state machine's executions only, and `ecs:StopTask` on the factory cluster's tasks. IAM cannot narrow StopTask to one execution's task, so the code stops only the task ARN it read from that execution's history.

### The stop spike (2026-11-22)

On a throwaway state machine with the stack's boundary-check task definitions, each execution stopped 60 s after its task was running:

| Case | SIGTERM | Task `STOPPED` | Stop code |
| --- | --- | --- | --- |
| `.sync` worker task | +1.8 s | +66.7 s | `UserInitiated` (Step Functions' own StopTask, about 1 s after StopExecution) |
| `.sync` build task in a Map | +2.5 s | +67.9 s | the same |
| `waitForTaskToken` worker task | none | still running after 180 s | stopped by hand with `ecs stop-task` |

The container gets SIGTERM, then SIGKILL after the default 30 s stop timeout (exit 137). The entry points install no SIGTERM handler, so a task runs on until SIGKILL. Hence the abort's own StopTask, and compare-and-set.

## Alternatives

| Option | For | Against |
| --- | --- | --- |
| **New execution per resume, Intake adopts (chosen)** | Step Functions keeps one definition per execution; the ledger already knows where the work item is; every entry state is idempotent already, or nearly | Each entry state must accept its own state; a resumed execution's history starts from Adopt |
| Redrive the stopped execution | No new execution; the history stays in one place | Only within 14 days; it restarts the state that stopped on the definition the execution started with, so a fix deployed meanwhile is not used, and it cannot enter where the ledger says the work item is (after a design flaw, say) |
| Resume by relabelling | No new command | Relabelling is how a work item starts; a redelivered `labeled` would resume a work item the owner aborted |
| Plan polling for an abort, instead of StopTask | No ECS permission | More moving parts, and covers only the states that poll; Adopt and any later token task would need it too |
| Accepting that Plan runs on after an abort | Nothing to build | The planner could commit and spend budget after the owner said stop |

## Consequences

- A resumed work item has more than one execution; its ledger row names the latest. The execution history of one work item is split across them.
- Executions started before this change's deploy have no start Choice. They can still be aborted; only new executions can be resumed into.
- The worker may stop any task in the factory's cluster, not only its own execution's. The code stops only the task named in that execution's history.
- A stopped build task's late outcome is ignored: its attempt is closed `aborted`, and a resumed Step writes a new build. A stopped worker's last commit, if any, stays on the branch, and the next role starts from the branch head.
- After an escalated resume, the proposal author, architect and planner get the owner's guidance but not the last failed attempt's evidence: the ledger keeps their failure reasons, not their evidence. Build roles get both.
