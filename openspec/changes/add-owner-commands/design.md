# Design

## Overview

The detailed decisions are settled in `docs/m3.5-owner-commands.md` (sections 2, 3, 6, 8 and 9). This design says where they land in the code, and what this first of three changes ships.

```
GitHub issue_comment.created ──▶ webhook (no ledger, no token)
   first line starts with "/" and author = owner?  ── no ──▶ 204, log only
                    │ yes
                    ▼
   RunTask: factory-worker command --issue <n> --comment <id>      (replaces `approve`)
                    │
                    ▼
   command task: Forge.getComment(id) ─▶ check author and issue ─▶ parse verb
        ─▶ BEGIN; lock work item row (SELECT … FOR UPDATE)
              insert comment row (ON CONFLICT (github_comment_id) DO NOTHING → done, no reply)
              decide by (verb, work-item state)   ── /approve: close approval, SendTaskSuccess
              record outcome
           COMMIT
        ─▶ post the one reply
```

Nothing changes in the state machine. `/approve` keeps its effect: the same `approve()` logic, now called from the command handler.

## Components

### Parsing (`factory/orchestrator/src/commands/parse.ts`)

`parseCommand(body: string): Command | undefined`:

- the first line is the text up to the first `\n` (or `\r\n`), trimmed
- no leading `/` → `undefined` (not a command)
- `verb` = the characters after `/` up to the first whitespace, as written; `text` = the rest of the first line, trimmed, plus the following lines, trimmed as a whole
- `KNOWN_VERBS = ["approve", "revise", "question", "abort", "resume", "status", "help"]`; any other verb (`Approve`, `aprove`, `` `/` `` alone) is `unknown`

The webhook uses the same function on the delivered body, so it and the worker cannot disagree on what is a command. The webhook needs only "is it a command"; the worker re-parses the body it reads through the Forge.

### Forge

`getComment(commentId: number): Promise<IssueComment>` with `IssueComment = { id, issueNumber, author, body, createdAt }`. `GitHubForge` calls `GET /repos/{owner}/{repo}/issues/comments/{id}` and takes the issue number from `issue_url`. A missing comment rejects with `not-found`. `FakeForge` stores the comments it is given and those the factory posts. Both pass the shared contract test.

### Command handler (`factory/orchestrator/src/commands/handle.ts`)

`handleCommand(ctx: CommandContext, issueNumber, commentId): Promise<CommandOutcome>`:

1. Read the comment through the Forge. Wrong author (case-insensitive compare with `target.owner`) or another issue → `InvalidInput` (exit 2), nothing recorded. Not a command (a race with an edit, or a hand-started task) → the same.
2. In one transaction: find the work item by repository and issue and lock its row (`SELECT … FOR UPDATE`); insert the comment row. If the comment id exists already, roll back and return `duplicate`: no reply.
3. Decide from the table below, apply the effect, and set the comment row's outcome. Commit.
4. Post the reply, outside the transaction.

`/approve`'s effect is today's `approve()`, minus its own lookup: close the approval with the owner's login, `SendTaskSuccess`, reopen it if that fails. Holding the row lock across one `SendTaskSuccess` call is acceptable: it takes well under a second, and no role session ever runs under the lock.

| Work item state | `/approve` | `/revise`, `/question`, `/abort`, `/resume` | `/status`, `/help` | unknown |
| --- | --- | --- | --- | --- |
| no work item | refused: nothing awaits; no work item | refused: not yet available | applied | unknown |
| `intake`, `proposal`, `proposal-approved`, `design`, `design-review`, `plan` | busy | `/revise`, `/question`: busy; `/abort`, `/resume`: not yet available | applied | unknown |
| `awaiting-proposal-approval`, `awaiting-design-approval` | applied (or refused when no approval is open) | refused: not yet available | applied | unknown |
| `build`, `escalated` | refused: nothing awaits, naming the state | refused: not yet available | applied | unknown |
| `pr-open` | refused: the PR is open, with its link | refused: not yet available | applied | unknown |

The busy check comes before "not yet available", so the owner learns the more useful fact first.

### Interim replies

`add-approval-feedback` and `add-work-item-resume` replace the "not yet available" cells. That reply is interim, so it is in no spec: the specs of the three M3.5 changes hold only what M3.5 ships, and no later change has to modify or remove a requirement that is not archived yet. Likewise the busy reply covers `/approve`, `/revise` and `/question` only: in the busy states `/abort` stops the work item and `/resume` answers "running" once `add-work-item-resume` lands (section 6).

### Replies (`factory/orchestrator/src/commands/replies.ts`)

Fixed templates, one per outcome, with only these values filled in: the verb, the quoted first line (fenced as inline code, cut to 200 characters), the change id, the state, the PR link, and the `/status` figures. No error message reaches a reply. The help text is one table built from the same list of verbs the parser uses.

### `/status` (`factory/orchestrator/src/commands/status.ts`)

From the ledger only, no Step Functions call: the work item's change id and state; the current step (for `build`, the first pending task's id and title); tasks done of the live (not superseded) tasks; the number of attempts; the work item's estimated cost (the existing total-cost query); and what it waits for, from the state: approval of the proposal or design, review of the PR, the owner (escalated), or nothing while a role runs.

### Ledger (`0005_comments.sql`)

```sql
CREATE TABLE comments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  work_item_id bigint REFERENCES work_items (id),        -- null: the issue has no work item
  repository text NOT NULL,
  issue_number integer NOT NULL,
  github_comment_id bigint NOT NULL UNIQUE,              -- a redelivery is a no-op
  author text NOT NULL,
  verb text NOT NULL,                                    -- as written; unknown verbs too
  body text NOT NULL,                                    -- stored at receipt
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  outcome text NOT NULL CHECK (outcome IN ('applied', 'busy', 'refused', 'unknown')),
  state_met text                                         -- the work item's state, null without one
);
CREATE INDEX comments_work_item_idx ON comments (work_item_id, received_at);
```

Queries: `lockWorkItem(tx, repository, issue)`, `recordComment`, `listComments(workItemId)`, `countInterventions(workItemId)` (applied `approve`, `revise`, `abort`, `resume`).

The body is the owner's own text, stored in the ledger, which is already the store for issue-derived data. It is never put into the execution history or a task override.

### Worker (`factory/worker`)

`command --issue <n> --comment <id>` replaces `approve --issue <n> --by <login>`. The worker's argument parser refuses `command` without `--comment` (exit 2). Exit codes: 0 when the command was handled (whatever its outcome) or was a duplicate; 2 for invalid input; 1 on any other error, after posting a fixed reply ("Your `/<verb>` did not go through: the factory failed while handling it. Send it again."), as `approve` does today. The `approve` state and `APPROVE_FAILED_COMMENT` go.

### Webhook (`factory/orchestrator/src/lambda/webhook.ts`)

`issue_comment.created` on an issue of the repository, whose body's first line starts with `/` and whose author is the owner: one RunTask with `["command", "--issue", "<n>", "--comment", "<id>"]`. A non-owner's command is logged with the login and verb and answered 204. `issue_comment.edited` and `.deleted` are ignored. `issues.labeled` is unchanged.

### Local CLI (`factory/cli`)

`pnpm factory command --issue <n> --comment <id> [--target <name>]` builds the same `CommandContext` as `run` (local ledger, the target's Forge with the owner's `gh` token) with no task tokens. A local `/approve` uses `approveLocally()`'s effect instead of `SendTaskSuccess`, closing the approval with the owner's login rather than `local`.

### Stack (`infra/factory-stack.ts`)

No new resources and no IAM change: the webhook already may run the worker family and pass its roles, and the worker already may send task success and failure. Only the webhook's code changes. The CDK tests keep asserting that the webhook cannot read the ledger's secret.

## Decisions

- **One `command` task for every verb**, instead of one task per verb. It keeps the webhook free of the ledger and of verb logic, and the start-up cost (about a minute) is the same.
- **The worker re-checks the author and issue** from the comment it reads by id, rather than trusting the webhook: the webhook's check is the gate, the worker's is the proof.
- **Busy before "not yet available"**: see the table.
- **Exactly one reply, at most once.** The comment row and the decision commit before the reply. A crash between the commit and the reply leaves the command applied without a reply, and a redelivery does not repeat it. This is preferred over a reply before the commit, which could announce something that did not happen. `/status` shows the outcome.
- **Verbs are case-sensitive.** `/Approve` is an unknown command and gets the help text, so it never passes silently.

## Risks

- **A reply per owner comment that starts with `/`.** A first line like `/tmp/foo is missing` gets an "unknown command" reply. Accepted (section 2): the owner learns the rule once.
- **Reply latency.** About a minute (Fargate start-up). Accepted in section 9.
- **Deploying with a paused execution.** The `approve` entry point goes. An execution paused at an approval during the deploy is approved through `command` after it; nothing in the paused execution names `approve`, so it continues.

## Contracts

No contracts path in `ceh`; the new types are the `Forge` interface's `IssueComment` and the ledger's comment row.

## Decisions that need an ADR

- **ADR 0015 Owner commands (new):** first-line owner-only `/<verb>`, everything else silent; one `command` worker task replacing `approve`; commands decided under a work-item lock and never queued; one reply per command; comments recorded with their body at receipt. Records the alternatives of section 2 of `docs/m3.5-owner-commands.md`. Amended by the two later M3.5 changes.
- **ADR 0002 amendment:** `/approve` and later commands resume executions through the `command` worker task.
- **ADR 0009 amendment:** the App reads issue comments by id; no new permission or event.
- **Brief section 8:** the M3.5 decisions of `docs/m3.5-owner-commands.md` section 12, as the document says.

## Owner prerequisites

- Approval of the deploy (`pnpm infra:deploy` with `-c budgetEmail=<address>`), with no execution paused that must stay unchanged.
- A throwaway `vocab` issue for the cloud check, and approval of the GitHub writes on it.
- A second GitHub account (or a collaborator) that can comment on `vocab` issues, for the non-owner check (exit criterion 3).

## Cloud results (task 4.3, 2026-11-20)

- **Diff and deploy:** `pnpm image:build` and `pnpm infra:diff` were run and reviewed by the owner, then `pnpm infra:deploy`. The worker is at revision 11. Migration 0005 was applied by the first worker task, issue #22's Intake.
- **Issue:** `vocab` #22, "Count lookups per language". Intake took 2 min 11 s, Proposal 1 min 24 s (change `add-count-lookups-per-language`, `small`). The execution paused at `AwaitApproval` at 14:32 UTC. The `await-approval` task exited 0 after posting the proposal comment.
- **Ignored comments:** none of the following started a task or got a reply. The execution's history did not change: its last event was still the `AwaitApproval` submission. Each comment's line in the webhook log:
  - The owner's `Looks good to me, thanks`: `ignored: no command on the comment's first line`.
  - The owner's `Approving below:` with `/approve` on its second line: `ignored: no command on the comment's first line`.
  - `/approve` from a second account (`miklospocsaji-weknow`): `ignored: /approve from miklospocsaji-weknow, who is not the owner`.
- **`/status`:** the reply came 49 s after the comment, naming `awaiting-proposal-approval`, no plan yet, 1 attempt and $0.15. The execution stayed paused.

  | Event | Time (UTC) |
  | --- | --- |
  | Comment | 16:29:12 |
  | Webhook started the `command` task | 16:29:17 (+5 s) |
  | Task started | 16:29:42 (+30 s) |
  | Reply posted | 16:30:01 (+49 s) |

  The task exited 0.
- **`/approve`:** commented at 16:31:14. The webhook started the `command` task 5 s later, and the execution resumed at 16:31:44 (+30 s). The approval reply came at 16:32:17 (+63 s): `proposal-approved`, `small`, skipping Design. `Approved` exited 10 at 16:32:41, which the state machine records as `TaskFailed` and catches, and the execution went on to Plan. Its own interim comment was ignored by the webhook (`no command on the comment's first line`).
- **End of the run:** the execution went on through Plan and Build and succeeded at 16:40:54, opening `vocab` pull request #23.
- **`pnpm test:cloud`:** run after #22's execution ended, so the webhook test saw no other worker tasks. 3 files, 5 tests passed in 170 s.
