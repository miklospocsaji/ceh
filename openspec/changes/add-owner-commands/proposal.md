# Proposal

## Why

In M3 the factory ignores every issue comment except `/approve`. The owner cannot ask where a work item stands without the AWS console, a typo in `/approve` passes silently, and there is no way in for the commands M3.5 settles (`docs/m3.5-owner-commands.md`). This change is the foundation the other two M3.5 changes build on (section 10 there): a single path by which an owner's command reaches the factory, is recorded and is answered once. It is useful on its own: `/status` and `/help` answer, and every command meets the state table of section 6.

## What Changes

- **Commands are first-line `/<verb>`, owner only** (section 2). A comment counts only if its first line, trimmed, starts with `/`, and only if the target's `owner` wrote it on an issue (not a pull request). Everything else is ignored with no reply and no task: comments without a command, a command below the first line, a non-owner's command (shown only in the webhook log), and edited comments.
- **The webhook starts one `command` worker task per owner command**, `factory-worker command --issue <n> --comment <comment id>`. It passes only the comment id, never its text. The `approve` worker task goes; `/approve` moves onto `command` unchanged in effect.
- **The `command` worker task** reads the comment through the Forge by id, checks its author and issue again, parses the verb, records it in the ledger, decides under a lock on the work item, and replies exactly once.
- **The state table of section 6, as far as this change goes:**
  - `/approve` approves while a proposal or design awaits approval, as today.
  - `/status` replies with the work item's state, its current step, task progress, attempts, cost so far and what the factory waits for.
  - `/help` replies with the command table, short.
  - an unknown verb gets "unknown command" and the `/help` text.
  - an `/approve`, `/revise` or `/question` that arrives while a role runs (`intake`, `proposal`, `proposal-approved`, `design`, `design-review`, `plan`) gets the busy reply, quoting its first line, and is not kept.
  - `/approve` during `build`, with the pull request open, or with no work item gets its "nothing awaits" or "the PR is open" reply.
  - `/revise`, `/question`, `/abort` and `/resume` are answered "not yet available" until `add-approval-feedback` and `add-work-item-resume` land. That reply is interim and in no spec (design, "Interim replies").
- **A `comments` table in the ledger** (migration `0005_comments.sql`): the work item (nullable), the GitHub comment id (unique, so a redelivery is a no-op), author, verb, body at receipt, received time, outcome (`applied`, `busy`, `refused`, `unknown`) and the work-item state the command met. Applied `/approve`, `/revise`, `/abort` and `/resume` count as owner interventions, and the count per work item is queryable.
- **Local runs:** `pnpm factory command --issue <n> --comment <id> [--target <name>]` runs the same handler against the local ledger. `pnpm factory approve` stays as a shortcut.

Out of scope:
- `/revise` and `/question` (`add-approval-feedback`), `/abort`, `/resume` and the closed issue (`add-work-item-resume`); this change only answers them "not yet available"
- comments on pull requests (M4's reviewer)
- `/restart` (left out of M3.5 by the owner)
- a namespaced verb (`/ceh …`); possible later as a per-target option
- acting on edited comments; the owner writes a new comment instead
- the factory console (M6)

## Capabilities

### New Capabilities

### Modified Capabilities
- `orchestration`: owner commands from issue comments, the `command` worker task that replaces `approve`, their record in the ledger and the replies, `/status` and `/help`, and the local `pnpm factory command`.

## Impact

- `factory/forge`: `getComment(id)` on the `Forge` interface, `GitHubForge` and `FakeForge`, with a contract test.
- `factory/orchestrator`: a command parser, the command handler with the state table, the replies, `/status`; `approve` becomes the `/approve` branch of the handler. The webhook routes every owner first-line `/` comment to `command`.
- `factory/ledger`: migration `0005_comments.sql`, the queries, the work-item lock and the interventions count.
- `factory/worker`: the `command` entry replaces `approve`.
- `factory/cli`: `pnpm factory command`.
- `infra`: the webhook's environment and policy are unchanged in kind (it already runs the worker family); its RunTask override changes. No new network, IAM or resources.
- GitHub App: no new permission or event. Reading a comment by id needs Issues read, which the App has, and Issue comment events are already subscribed.
- Docs: ADR 0015 (owner commands), amendments to ADR 0002 and ADR 0009, brief section 8, `CLAUDE.md`.
- Tagged `large`: it changes who can make the factory act (a security boundary), and adds a ledger migration and a worker entry point.
