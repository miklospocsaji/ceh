# M4 Review, test deploy, QA and release

Settled with the owner on 27 November 2026 (section 13). Brief section 7 points here, and brief section 8 records the decisions. They go to ADRs when the first change starts.

## 1. Why, and what changed since the brief

In M3.5 a work item ends at a pull request that no one but the owner has looked at. No agent reviews the whole diff, nothing runs the app, and nothing happens after the merge: the change stays active in `openspec/changes/`, and `openspec/specs/` never learns about it. M4 closes the loop from pull request to production:

- a fresh-context **reviewer** checks the whole change
- the change is **deployed to a test environment**
- a **QA explorer** exercises its scenarios in a browser
- the **owner accepts** it
- the factory **releases** it to production and **archives** the change

The brief's M4 was written when the factory and the app shared one repository. Three things have changed since:

- **No preview stack per pull request.** The target has one long-lived `test` environment, holding one work item at a time (section 4). For `vocab`: `test.vocab.logtion.app` and `api.test.vocab.logtion.app`, deployed from a `test` branch that is `master` plus one feature branch.
- **The app's base is hand-built in the target.** No role may write manifests or install packages, so the frame every feature fills in was built by the owner in `vocab` as the OpenSpec change `add-app-foundations`. That covers the packages, dependencies, CDK app, environments and database. `vocab` documents it in its own words (its ADRs 0006 and 0007) and knows nothing about ceh. This doc covers only ceh's side.
- **The target has its own AWS account** (`vocab`: 100159507559), bootstrapped to trust the factory's account (943081072466) in eu-central-1. The factory deploys there and nowhere else.

## 2. The flow after M4

```
… Plan ─▶ BuildTasks ─▶ Review ──changes-requested──▶ Fix ─▶ Review
                          │ approve                      (reopened tasks, max 2 rounds)
                          ▼
                    OpenPullRequest
                          ▼
                    AcquireTest  (waits while another work item holds test)
                          ▼
                    DeployTest  (reset test, merge the branch, synth, deploy, smoke)
                          ▼
                          QA ──issues──▶ Fix ─▶ Review ─▶ DeployTest ─▶ QA
                          │ clean                         (max 2 rounds)
                          ▼
                 AwaitAcceptance ── /revise ──▶ Fix ─▶ Review ─▶ DeployTest ─▶ QA
                    │ /approve        │ pull request closed unmerged
                    ▼                 ▼
                 Release           Rejected ─▶ ReleaseTest
                    ▼
                 ReleaseTest ─▶ Done
```

- The **pull request is opened after Review approves**, not before. The owner never sees a pull request the reviewer would have sent back.
- **The test environment is held only from AcquireTest to ReleaseTest.** Every earlier state runs for any number of work items in parallel, as today.
- **Every fix goes through the same path:** the build loop, then Review, then a fresh test deploy and QA. A fix never skips a check that came before it.

## 3. Reviewer

- **Role:** `reviewer`, `claude-sonnet-5-5`, Read, Grep and Glob only, in the worker. No writable paths, 25 turns, $0.75 per session. It has no Bash, so it never runs the code it reads.
- **Input**, as files the runner writes into a read-only scratch folder beside the clone, never as transcripts:
  - the change's diff from the merge base with the default branch to the branch head
  - `proposal.md`, the delta specs, `design.md`, `tasks.md` and the contracts
  - the last `gates.json` of each task
  - the issue
- **What it checks:**
  - the diff against the delta specs' scenarios, `design.md` and the contracts
  - tests that prove what their scenario says
  - code outside the tasks' files, and dead or duplicated code
  - for infrastructure changes, the target's own isolation rules as its ADRs state them. For `vocab`: nothing in `test` may reach `prod`'s database, secrets or stacks, and nothing in `infra/src/base/` changes (ADR 0006 in `vocab`).

  ADR 0006 in `vocab` rests on this check: the reviewer runs before any test deploy.
- **Output:** the existing `ReviewResult`, with `verdict` (`approve` or `changes-requested`) and `findings` (`severity` `blocker`, `major` or `minor`, a file, and the text). M4 adds two fields to each finding:
  - `task`: the task id the finding belongs to, from `tasks.json`, or `null`
  - `kind`: `code` or `test`
- **Changes requested:** the classifier labels the findings, as the brief says for a review verdict.
  - `bug`: a **fix round**. The tasks the findings name are reopened and built again through Step with the findings as evidence: the test author first if any finding is `kind: test`, then the implementer, then the gates. Findings with no task reopen the plan's last task.
  - `design-flaw`: back to Design, as from the build loop.
  - `spec-ambiguity`: escalates to the owner.
- **Limits:** at most 2 review rounds per work item; the third `changes-requested` escalates. Minor findings alone never request changes: the schema already refuses that.
- **Where it shows:** the findings are posted on the pull request as one review with the event `COMMENT`. A bot review never counts as an approval. The verdict is recorded in the ledger and summarised in the pull request's body.

## 4. The test environment

### Holding it

- A ledger table **`environments`** has `(repository, name)`, `holder` (a work item, or null), `held_since`, and a FIFO **queue** of waiting work items, each with its task token.
- **AcquireTest** is a `waitForTaskToken` worker task, so waiting costs nothing.
  - If `test` is free, the work item takes it and the token is sent at once.
  - Otherwise the work item queues, and the issue gets a comment naming the holder.
  - **ReleaseTest** frees `test` and sends the next work item's token.
- **What releases it:**
  - the end of Release
  - Rejected (the pull request was closed unmerged)
  - `/abort`
  - the issue closing
  - an escalation in any state from DeployTest on

  A resumed work item queues again. The owner's "one work item in test at a time" is this lock; nothing else waits on it.

### Deploying it (DeployTest)

1. **Branch, in the worker.** The worker resets `test` to the default branch, merges the feature branch with a merge commit, and force-pushes `test`.
   - A merge conflict escalates with the conflicting paths. With one owner and one work item in `test` this should be rare, and the owner resolves it on the feature branch, then `/resume`s.
   - `test` is protected so that only `ceh-app[bot]` may push it, force pushes included.
2. **Synth, in a synth task.** A new task definition runs the target's build image with **no secrets at all**: no model key, no GitHub token, no ledger. It clones `test` at the pushed commit, runs the target's install and its `synth` command (`vocab`: `pnpm infra:synth --env test --out <dir>`), checks the assembly, and uploads it to the artifact bucket.
   - The check refuses Docker image assets and missing context.
   - Synth is agent-written code, so it runs where there is nothing to steal.
3. **Deploy, in a deployer task.** A new image runs the factory's pinned `aws-cdk` CLI and nothing from the target. It downloads the assembly, then runs `cdk deploy --app <dir> --all --require-approval never --outputs-file outputs.json`, and uploads the outputs.
   - Its task role may only read and write its work item's artifacts and assume the target account's CDK deploy and file-publishing roles in the target's region.
   - It holds no GitHub token, no ledger access and no model key.
   - It runs no repository code: deploying an assembly executes nothing from it.
4. **Smoke, in the worker.** The target's smoke URL must answer 200 within 2 minutes (`vocab`: `{ApiUrl}/health`, which also names the deployed commit, and the worker checks it against `test`'s head). A failed synth, deploy or smoke check goes to the classifier: `infra` retries once after a wait, and anything else becomes a fix round.

### Resetting it (ReleaseTest)

ReleaseTest resets `test` to the default branch, force-pushes, deploys it the same way (synth task, then deployer), and frees the lock. `test` then always shows `master` between work items, and the target's database is rebuilt by its own deploy (`vocab`: on every test deploy).

## 5. QA explorer

- **Role:** `qa-explorer`, `claude-sonnet-5-5`, with the Playwright MCP server plus Read. It writes only a screenshot directory outside any clone. 60 turns, $1.50 per session.
- **Where it runs:** in a new **QA task**, not the worker. The browser runs JavaScript from an agent-written app, and Chromium in Fargate runs without its own sandbox. So the QA task follows the build container's pattern (ADR 0011):
  - its own image: the worker's base, Playwright, Chromium and the Playwright MCP server, pinned
  - only the model key and the target's QA login in its environment
  - no GitHub token, no ledger access
  - input and output through the artifact bucket

  The worker records the result.
- **What it may browse:** only the target environment's origins, enforced by Playwright MCP's allowed-origins option (`vocab`: `https://test.vocab.logtion.app` and `https://api.test.vocab.logtion.app`). Page content is data, never instructions; the prompt says so, and the origin list holds regardless.
- **Input:**
  - the issue
  - `proposal.md` and the delta specs: their scenarios are the QA plan
  - the web URL, from the deploy's outputs
  - the viewports: by default desktop 1280×800 and mobile 390×844 with touch
  - the QA login, if the target has one

  QA sees no diff and no code: it tests what a user can see.
- **Output:** `qa-report.json`, a zod schema in `factory/artifacts`:
  - `verdict`: `clean` or `issues`
  - per scenario and viewport: `status` (`pass`, `fail` or `blocked`), the steps taken, the screenshot names and a note
  - `findings`, with severity as in a review

  Screenshots are PNGs in the same artifact folder.
- **Issues:** the classifier labels the failed scenarios.
  - `bug`: a fix round. The tasks whose scenarios failed are reopened, then Review, then DeployTest and QA again.
  - `infra` (the environment did not answer): DeployTest again, once.
  - `spec-ambiguity`: escalates.
  - At most 2 QA rounds; the third `issues` escalates.
- **The report on the pull request:** one comment with a table of scenarios × viewports, the findings, and the screenshots as images. The images are served from a public, unguessable path in the artifact bucket behind CloudFront, kept 180 days (D5).
- **The QA login:** the target supplies a user on its test environment, and ceh keeps the credential in its own SSM (`/ceh/targets/<name>/qa-login`) as the QA task's only secret besides the model key. For `vocab` that user exists only once the auth work item has merged. Until then QA runs without a login, and the scaffold has nothing behind one.

## 6. Acceptance

- **AwaitAcceptance** is a `waitForTaskToken` state, like the approvals. The factory comments on the issue and the pull request with:
  - the test URL
  - the review summary
  - the QA report
  - the cost so far
  - the commands that apply: "Try it on `<test URL>`. Reply `/approve` to release it, `/revise` with what to change, or close the pull request to reject it."
- **`/approve`** (owner only, as always) accepts, and the execution goes on to Release.
- **`/revise <text>`** is the owner's own QA feedback. It goes to the classifier like a QA finding: a fix round with the comment as evidence, then Review, DeployTest, QA, and acceptance is asked again. At most 5 revisions, as for proposals.
- **`/question`** is answered by a read-only session of the reviewer, about the change as built: the same mechanism as M3.5's, with the same limits.
- **Closing the pull request unmerged rejects** the work item. The webhook gains `pull_request.closed`, and the work item becomes `rejected`. Then comes ReleaseTest.
- **Merging by hand** is treated as `/approve` (the webhook sees `pull_request.closed` with `merged: true`). Release then archives in a follow-up pull request, since the archive commit can no longer go on the branch (section 7).
- **Auto-merge** for small changes (brief section 8) moves to M4.5: in M4 every change waits for the owner.

## 7. Release

1. **Archive, on the branch.** The worker runs `openspec archive <id> --yes` on the feature branch, with the target's pinned OpenSpec, as the gates do. It commits `chore(<id>): archive the change` and pushes. The pull request then carries its own archive, and master never holds a shipped change that is still active.
2. **Merge, by the factory.** The worker waits for the pull request's required checks (the target's CI) on that commit, then merges it with a merge commit. `vocab`'s master requires a pull request and its `check` status, with no approving review, so `ceh-app[bot]` can merge once CI is green. A red CI after the archive escalates.
3. **Deploy production.** The synth task synthesises the default branch's merge commit for `prod`, the deployer deploys it, and the worker runs the smoke check.
   - A failed production deploy escalates at once, with no retry. CloudFormation rolls the stack back, but master already holds the change, so the owner decides.
   - `/resume` retries the deploy.
4. **Report.** A comment on the issue: released, the production URL, the commit, and the final cost per role. The work item becomes `released`, and the issue is closed by the merge (`Closes #n`).
5. **ReleaseTest** (section 4).

If the pull request was merged by hand, step 1 becomes a follow-up pull request `archive-<id>` that the factory opens and merges once CI is green. The production deploy waits for that merge.

The retro role stays in M7.

## 8. Target config

`targets/<name>/target.yaml` gains (a sketch; the changes' designs settle the names):

```yaml
environments:
  account: "100159507559"
  region: eu-central-1
  test:
    branch: test
    synth: pnpm infra:synth --env test --out {out}
    smoke: "{ApiUrl}/health"
    web: "{WebUrl}"
    origins: [https://test.vocab.logtion.app, https://api.test.vocab.logtion.app]
  prod:
    synth: pnpm infra:synth --env prod --out {out}
    smoke: "{ApiUrl}/health"
qa:
  viewports: [desktop, mobile]
  login: true        # the credential is in ceh's SSM, /ceh/targets/vocab/qa-login
```

`vocab`'s writable paths follow its new layout (`add-app-foundations`). This is needed before its first M4 work item, and goes with the first change:

- **Implementer:** `app/*/src/**` except `app/contracts/**`, plus `infra/src/app-stack.ts` and `infra/src/app/**`. Never `infra/src/base/**`, `infra/bin/**`, `infra/config.ts` or `infra/scripts/**`.
- **Test author:** `app/*/test/**` and `infra/test/**`.
- **Unit tests:** `unitTestPath` becomes a list (`app/`, `infra/`), so the gates run the infra tests too. The coverage gate reads them from Vitest's report.

The loader's existing checks apply to the new commands: plain words, no shell.

## 9. Infrastructure in ceh

- **New task definitions:**
  - `synth`: the target's build image, no secrets
  - `deployer`: its own image and role
  - `qa`: its own image, the model key and the QA login

  Each has a role that reaches only its work item's artifacts. The deployer's role may additionally assume `cdk-hnb659fds-deploy-role-<account>-<region>` and `cdk-hnb659fds-file-publishing-role-<account>-<region>` in the target account, and nothing else.
- **New images:** `deployer` (on the worker's base, with the pinned `aws-cdk`) and `qa` (with Playwright and Chromium), assembled like the build image (ADR 0010). The deployer's CLI version must stay at least as new as the target's `aws-cdk-lib`. `vocab` pins both to ceh's versions, and an upgrade is agreed in both repositories.
- **The state machine** gains Review, OpenPullRequest (moved after Review), AcquireTest, DeployTest, QA, AwaitAcceptance, Release, Rejected and ReleaseTest. The fix-round Choices go back into BuildTasks with the reopened task ids.
- **The webhook** subscribes to `pull_request` events (`closed`), and the GitHub App gains that subscription. The App's existing permissions cover pushing `test`, merging and reviews. Reading CI status needs `checks: read` and `statuses: read`, which the first change verifies.
- **Repository settings in the target, by the owner:** the `test` branch, protected so that only `ceh-app[bot]` may push it, force pushes included.
- **Cost:** three more task kinds per work item, each a Fargate start of about a minute. A test deploy with CloudFront updates takes a few minutes. Model spend grows by a review (about $0.50) and a QA run (about $1.50) per round, inside the $5 per work item, though tighter.

## 10. Ledger

- Work item states gain `reviewing`, `awaiting-test`, `deploying-test`, `qa`, `awaiting-acceptance`, `releasing`, `released` and `rejected`. `stopped_in` (M3.5) covers each of them for `/resume`.
- New: `environments` and its queue (section 4).
- Attempts for `reviewer`, `qa-explorer`, `synth`, `deploy` and `smoke`. Their results (`review.json`, `qa-report.json`, deploy outputs) are in the artifact bucket, as today.
- `review_rounds` and `qa_rounds` per work item, for the limits.
- An approval kind `acceptance`, with outcomes `approved`, `revise`, `rejected` and `merged-by-hand`.

## 11. Owner commands in the new states

| State | `/approve` | `/revise` | `/question` | `/abort` | `/resume` |
| --- | --- | --- | --- | --- | --- |
| `reviewing`, `deploying-test`, `qa`, `releasing` | busy reply | busy reply | busy reply | stops | "running" |
| `awaiting-test` | "nothing awaits; waiting for test, held by #n" | same | same | stops, leaves the queue | "running" |
| `awaiting-acceptance` | accepts | a fix round | answered by the reviewer | stops, releases test | "running" |
| `released`, `rejected` | "done" | "done; open a new issue" | "done" | "nothing runs" | "done" |

`/status` names the state, the review and QA rounds, the holder of `test` and the cost so far.

## 12. Delivery: four OpenSpec changes in ceh, then M4.5

| # | Change | Scope | Proves | `vocab` workload that can run after it |
| --- | --- | --- | --- | --- |
| 1 | `add-reviewer` | the `reviewer` role, Review and fix rounds (reopened tasks), OpenPullRequest after Review, `pnpm factory run --until review`, role limits named on escalation, `vocab`'s new writable paths and test paths, `CLAUDE.md`'s `AWS_PROFILE=ceh` | a seeded bug in a branch is sent back and fixed in the cloud | **auth with Cognito** (`large`): up to a reviewed pull request, merged by hand, archived by hand |
| 2 | `add-test-deploy` | environments in `target.yaml`, the lock, the `test` branch, the synth task, the deployer image, task and cross-account role, smoke, ReleaseTest; an ADR on deploying agent-written infrastructure | a work item's branch on `test.vocab.logtion.app`, and `test` back to master after it | — |
| 3 | `add-qa-explorer` | the QA image and task, Playwright MCP with allowed origins, `qa-report.json`, screenshots on the pull request (served by a CloudFront distribution in front of the artifact bucket's `qa-evidence/` prefix only), QA rounds, the QA login; an ADR on the QA container | QA passes a scenario and fails a broken one on both viewports | **trajectories CRUD** |
| 4 | `add-acceptance-release` | AwaitAcceptance and its commands, Rejected, the archive commit on the branch, the factory's merge, the production deploy, `released` | the exit run (section 14) | **upload of `vocab.db`** with a minimal UI, as the exit run |

Each change is archived when M4 exits, as in M3.5. Changes 2 and 3 can be built in either order after 1. Change 4 needs both.

**M4.5** (proposed, settled when M4 exits):
- the e2e gate: Playwright tests in the build container against the local Vite build, and `app/e2e/` in the coverage gate
- a deterministic template check before every deploy: no IAM trust outside the account, no access to the other environment's secrets, only allowed resource types. This narrows the risk `vocab` accepted in its ADR 0006
- auto-merge for `small` changes on an approving review and a clean QA report (brief section 8)
- the target's QA login provisioned by the target itself instead of by hand

Not M4.5: a stage environment (owner, 27 November 2026: not now).

## 13. Decisions

Settled with the owner on 27 November 2026:

- [x] One long-lived `test` environment and branch instead of a preview per pull request; one work item in `test` at a time, with every other stage free to run in parallel.
- [x] `test` is reset to `master` after each merged or rejected work item, and its database is rebuilt on every deploy.
- [x] The target's base (packages, dependencies, environments, database) is built by hand in the target, as `vocab`'s `add-app-foundations`.
- [x] The target has its own AWS account; the factory deploys there with roles it assumes, never in its own account. `test` and `prod` share that account (an accepted risk in `vocab`'s ADR 0006).
- [x] Synth runs without credentials; the deploy runs only an assembly, with ceh's pinned CDK CLI.
- [x] Preview database (brief section 8): one cluster with one database per environment. The `test` database is rebuilt on every deploy.
- [x] Auth is built by the factory, as M4's first `vocab` work item.
- [x] The e2e gate waits for M4.5.

Then, from the open list:

- [x] **D1. Pull request after Review:** it opens only once Review approves.
- [x] **D2. Fix rounds reopen tasks:** the tasks the review, QA or the owner names are reopened and rebuilt through Step with the findings as evidence. At most 2 review rounds and 2 QA rounds. No "fix" task is appended.
- [x] **D3. Acceptance is `/approve`, and the factory merges.** The archive goes on the branch, and auto-merge later only skips the wait. A hand merge counts as `/approve`, with the archive in a follow-up pull request.
- [x] **D4. QA in its own task**, with only the model key and the QA login.
- [x] **D5. Screenshots** at a public, unguessable path in the artifact bucket behind CloudFront, kept 180 days.
- [x] **D6. The QA login** is created by the owner on the target's test environment and kept in ceh's SSM. M4.5 lets the target provision it.
- [x] **D7. Local runs stop at Review** (`--until review`). Test deploy, QA and release run in the cloud only. The reason is the lock: who holds `test` is in the ledger, and a local run's ledger can't see the cloud's, so a local and a cloud run could both reset and deploy `test`. QA's browser would also run agent-written code beside the laptop's credentials. Local test deploys would need a lock both can see (a GitHub check on `test`, or a DynamoDB item); not planned.
- [x] **D8. Four changes** in the order of section 12, with `vocab`'s auth work item after change 1.
- [x] **D9. Per-session budgets:** reviewer $0.75 and 25 turns, QA explorer $1.50 and 60 turns, measured in the exit run. **They must be easy to change:** each limit is one line in its role's YAML (`maxTurns`, `maxBudgetUsd`), as for every role today, and nothing else holds it. No code, test or prompt repeats a number; tests read the YAML. When a session stops on a limit, the escalation and the summary name the role, the limit and its value, so it's clear which line to raise. A change takes effect with the next image deploy. If the exit run shows QA's 60 turns are too few, the fallback is one QA session per viewport.

## 14. Exit

On a fresh `vocab` issue (the upload of `vocab.db` with a minimal UI), in the cloud, after all four changes:

1. **The seeded bug.** The work item runs to the end of Build. The owner `/abort`s it, pushes a commit with a deliberate UI bug to the feature branch (for example, the upload button does nothing on the mobile viewport), and `/resume`s it.
2. **Caught.** The reviewer or the QA explorer catches the bug. A fix round removes it, and a second QA run is clean on both viewports.
3. **The lock.** While the work item holds `test`, a second labelled issue that reaches AcquireTest waits, and gets `test` when the first is released.
4. **Owner QA.** The owner tries the feature on `test.vocab.logtion.app`, sends one `/revise`, and then `/approve`s.
5. **Released.** The factory archives the change on the branch, merges once CI is green, deploys `prod`, and the smoke check passes on `api.vocab.logtion.app/health` with the merge commit. `openspec/specs/` on master reflects the change, and `test` is back on master.

Rejection (a closed pull request), the hand-merge path and production deploy failures are proved by unit tests against `FakeForge` and the local ledger, and by `pnpm test:cloud` where they touch AWS.

## 15. Brief edits (made 27 November 2026)

- Section 3: states 9 to 11 (Preview + QA becomes Test deploy + QA, and acceptance and release as above), the Deployer component (a synth task plus a deployer task), Environments (`test` instead of a preview per pull request), and the security bullet on deploys.
- Section 4: the reviewer's and QA explorer's rows (QA in its own task, allowed origins, budgets).
- Section 7: M4's deliverables, workload and exit point here, and M4.5 is added.
- Section 8: the preview-database item is settled as above, and auto-merge moves to M4.5.
- `CLAUDE.md`: `AWS_PROFILE=ceh` instead of `vocab`, plus the new tasks, logs and the test environment under "Cloud runs".
