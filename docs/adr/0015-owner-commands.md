# 0015 Owner commands

Status: accepted (2026-11-20; owner decisions of 2026-11-15, `docs/m3.5-owner-commands.md` sections 2 and 12; add-owner-commands); amended 2026-11-20 (`/revise` and `/question`, add-approval-feedback) and 2026-11-26 (`/abort`, `/resume` and the closed issue, add-work-item-resume)

## Context

Until M3.5 the factory ignored every issue comment except `/approve`. The owner could not ask where a work item stood without the AWS console, and a typo in `/approve` passed silently. M3.5 adds `/revise`, `/question`, `/abort`, `/resume`, `/status` and `/help` (`docs/m3.5-owner-commands.md`, section 3). They need one path from a comment to the factory that decides who may give a command, keeps teammates' comments inert, and answers each command once, even when GitHub redelivers a webhook or two commands arrive together.

The webhook has no ledger and no GitHub token (ADR 0002, amendment of 2026-11-06), and a RunTask override holds at most 8 KB.

## Decision

- **A command is a first-line `/<verb>` by the owner, on an issue.** Its first line, trimmed, starts with `/`. The verb runs up to the first whitespace, is case-sensitive, and the known verbs are lowercase. The rest of the comment is the command's text. The owner is `owner` in `targets/<name>/target.yaml`, compared ignoring case.
- **Everything else is ignored, with no reply and no task:** a comment without a command, a command below the first line, a non-owner's comment (shown only in the webhook's log, with the login and the verb), an edited or deleted comment, and any comment on a pull request. A reply to a non-owner would let anyone make the bot post.
- **One parser, `parseCommand`,** is used by the webhook and by the worker, so they cannot disagree on what is a command.
- **One `command` worker task per owner command,** `factory-worker command --issue <n> --comment <comment id>`, replacing the `approve` task. The webhook passes only the comment id, never its text. The task reads the comment through the Forge by id, and acts only if its author is the owner and it belongs to `--issue`: the webhook's check is the gate, the task's is the proof. Otherwise it exits 2 and records nothing.
- **Decided under a lock on the work item, never queued.** In one transaction the task locks the work item's row (`SELECT … FOR UPDATE`), records the comment, decides by the work item's state, applies the effect (for `/approve`, `SendTaskSuccess`) and records the outcome. Commands on one work item are applied one at a time, in the order they take the lock. No role session ever runs under the lock. A command that arrives while a role runs gets the busy reply and is not kept.
- **Recorded once, answered once.** The `comments` table (ledger migration `0005_comments.sql`) holds each command by its GitHub comment id, which is unique: the work item (or none), the author, the verb as written, the body as read at receipt, the time, the outcome (`applied`, `busy`, `refused`, `unknown`) and the state it met. A comment recorded already changes nothing and is not answered again. The one reply is posted after the commit, so it never announces something that was rolled back.
- **Interventions:** applied `/approve`, `/revise`, `/abort` and `/resume` count as owner interventions, per work item; `/question`, `/status` and `/help` do not.
- **Every owner command gets a reply,** from fixed templates: an unknown verb gets "unknown command" and the `/help` table, so a typo never passes silently. No error message reaches a reply.
- **Local runs** take commands through `pnpm factory command --issue <n> --comment <id>`, with the same handler, records and replies.

This change ships `/approve`, `/status` and `/help`. `/revise`, `/question`, `/abort` and `/resume` are answered "not yet available" until `add-approval-feedback` and `add-work-item-resume` amend this ADR.

## Alternatives

| Option | For | Against |
| --- | --- | --- |
| **First-line slash command (chosen)** | Already how `/approve` worked; deliberate, easy to type; teammates' comments cannot trigger it by accident; the webhook decides without the ledger | Collides only if another bot on the repository uses the same verb |
| Mention `@ceh-app` | Reads naturally | GitHub App bot accounts are not reliably mentionable or autocompleted; a mention in passing would count as a command |
| Namespaced, e.g. `/ceh revise` | No collision with other bots | Longer to type, and there is no other bot today. Can be added later as a per-target option without breaking `/<verb>` |
| Any owner comment is feedback | Nothing to learn | The owner cannot talk to teammates on the issue; a stray "thanks" would re-run a role |

Also considered:
- **One worker task per verb.** The webhook would need verb logic, and the start-up cost (about a minute) is the same.
- **The webhook passing the comment's text.** Overrides are limited to 8 KB and land in the ECS task's description; the ledger is the store for issue-derived text.
- **Queueing commands that arrive while a role runs.** The owner asked for them to be refused and said so (section 6): a queued `/approve` could approve something the owner has not read.
- **Replying before the commit.** A crash after the reply would announce a command that did not happen. A crash after the commit instead leaves an applied command without a reply, which `/status` shows.

## Consequences

- Every owner comment whose first line starts with `/` gets a reply, `/tmp/foo is missing` included ("unknown command"). Accepted: the owner learns the rule once.
- Replies take about a minute, the `command` task's Fargate start-up.
- A crash between the commit and the reply leaves the command applied and unanswered; a redelivery does not repeat it.
- `/approve` holds the work item's lock across one `SendTaskSuccess` call, well under a second.
- The ledger now stores the owner's comment bodies. They are never put into an execution's history or a task override.
- An execution paused at an approval while this deploys is approved through `command` afterwards: nothing in it names `approve`.

## Amendment 2026-11-20: `/revise` and `/question`

M3.5 (add-approval-feedback; `docs/m3.5-owner-commands.md` sections 4 to 6) replaces the "not yet available" answers of `/revise` and `/question`. Both are valid only while a proposal, or a `large` change's design, awaits the owner's approval; in any other state they get the replies of section 6's table, and no session runs.

- **`/revise <text>` sends what awaits back to its author.** Under the work item's lock, the `command` task closes the open approval with the outcome `revise` and the owner's login, puts the work item back in `proposal` (or `design`), records the comment `applied`, and resumes the execution with `{ "decision": "revise" }`, which runs Proposal (or Design) again in the same execution (ADR 0002, amendment of 2026-11-20). If resuming fails, the approval is reopened, the state restored and the comment recorded `refused`, and the reply says the revision can be sent again. `/approve` now resumes with `{ "decision": "approve" }`.
- **The revised author sees the owner's feedback, and later roles do not.** The proposal author (architect) gets every applied `/revise` of its stage, oldest first, and the stage's questions with their answers, each fenced as the owner's feedback, never as instructions. It runs on the branch head, so the owner's pushes are kept, and its result says what changed, which the summary shows. Later roles see only the artifacts (principle 4). The attempt records the comments it was given (`attempts.comment_ids`); a revision starts a new run with its own 3 attempts, and `n` goes on.
- **`/question <text>` is answered with the approval left open.** The `command` task opens an attempt in state `proposal-question` (`design-question`) under the lock, releases the lock, and runs the answer outside it on a fresh clone of the branch head. The execution and the approval's token are never touched, so a `/approve` or `/revise` arriving meanwhile goes through at once. The reply quotes the question, gives the answer and names the commit it read. A failed session is a failed attempt, and the reply says the question can be asked again.
- **Read-only by construction, not by prompt.** The answer runs the author's model and prompt with a question overlay, but with the tools `Read`, `Grep` and `Glob` only, no writable paths, no `WebFetch`, and a structured result `{ answer }`. It never commits or pushes. The overlay asks it to point to `/revise` for changes, but nothing depends on the model obeying: a question that says "fix it" still cannot write. The read guard of ADR 0007 confines its reads to the clone.
- **Limits.** A `/revise` or `/question` without text is refused. A stage takes at most 5 applied revisions (the 6th is refused with a reply that suggests a new issue) and 10 questions. One question is answered at a time per work item: another `/question` meanwhile gets the busy reply, and a question attempt open for more than 30 minutes is closed `failed` (`abandoned`) first, so a crashed task cannot block questions for good. An answer has at most 10 turns and $0.30.
- **The budget check.** Before it starts a session, each command checks that the work item's estimated cost so far plus the session's cap (the author's `maxBudgetUsd` for `/revise`, $0.30 for `/question`) stays within `target.budget`; otherwise it is refused with a reply naming the cost so far and the budget. This is the only enforcement of the per-work-item budget before M6, and it does not stop a role already running.
- **Ledger** (`0006_approval_feedback.sql`): `approvals.outcome` (`approved` or `revise`), required exactly when the approval is closed; approvals closed before the migration read `approved`. `attempts.comment_ids`.
- Applied `/revise` counts as an owner intervention; `/question` does not.

Also considered:
- **Routing questions through the state machine** (resume the token with `question`, answer, wait again): every role run would be in the execution history, but each question would need a new token and a re-posted approval prompt, and a crash mid-answer could leave the work item with no open approval.
- **Letting `/revise` carry questions** ("answer, don't change"): mixes a change and a non-change in one command, with the author allowed to write while asked not to.
- **Counting a revision's attempts toward the stage's first 3:** a proposal that needed 3 attempts could then never be revised. Each revision gets its own 3, as Design's run after a design flaw does.

Consequences:
- A question's answer comes from a fresh session reading the artifacts, not the author's memory: "why X?" is answered only as well as the artifacts record reasons. The proposal author's and architect's prompts now ask them to record their reasons.
- A question's answer runs inside the `command` task and gets no Step Functions retry; a crash leaves a failed attempt and the owner asks again.
- Five revisions of a proposal could cost more than the budget; the budget check refuses the one that would go over.
- An execution started before this deploy runs the old definition: a `/revise` to it would send it to Approved with the work item in `proposal`, which Approved refuses, and the work item escalates. Deploy with no execution paused at an approval.

## Amendment 2026-11-26: `/abort`, `/resume` and the closed issue

M3.5 (add-work-item-resume, ADR 0016; `docs/m3.5-owner-commands.md` sections 6, 7 and 9) replaces the last "not yet available" answers. `/help` lists every command as available.

- **`/abort [reason]`** while the work item runs (any state from `intake` to `build`) stops its execution and the ECS task it runs, closes its open attempts and approval `aborted`, and makes it `aborted`, recording where it stopped. The reply says `/resume` continues it. The reason is recorded with the comment and never reaches the execution: its stop cause names the comment id only. `/abort` on an `aborted`, `escalated` or `pr-open` work item, or on an issue with none, is answered "nothing runs".
- **`/resume [guidance]`** on a stopped work item starts a new execution that continues it (ADR 0016). It is answered "running" while the execution runs, refused on a closed issue (reopen it first), "the PR is open" once it is, and "no work item; label the issue `factory`" without one. Its text is the guidance the next role gets.
- **The replies on a stopped work item point to `/resume`:** `/approve`, `/revise` and `/question` on an `aborted` or `escalated` work item say nothing awaits and that `/resume` continues it. During `build`, `/revise` and `/question` say nothing awaits and name `/abort` and a new issue.
- **A closed issue is not a command.** The webhook runs `command --issue <n> --closed` for `issues.closed`, whoever closed the issue; the task aborts a running work item and posts one fixed comment, and records nothing in `comments`. `issues.reopened` starts nothing.
- **Local work items** answer `/abort` and `/resume` with `pnpm factory run`: they have no execution.
- The `command` task decides both under the work item's lock, as before. `/abort` holds the lock across StopExecution, GetExecutionHistory and StopTask, a few calls; `/resume` across DescribeExecution and StartExecution. Applied `/abort` and `/resume` count as owner interventions.

Consequences:
- A worker task that was stopped can still write for about 30 s; compare-and-set state updates (ADR 0003, amendment of 2026-11-26) refuse its state changes, and its attempt is closed already.
- Closing an issue by mistake aborts its work item; reopening it and replying `/resume` continues it.
