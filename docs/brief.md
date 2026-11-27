# ceh Software Factory — Bootstrap Brief

Oct 25, 2026 · @Miki

## 1. Purpose and how to use this brief

ceh (Hungarian *céh*, "guild", said "tsay") is an autonomous software factory. It works on target repositories it does not live in; each target is described in `targets/<project>/`. Its first workload is the Kindle vocabulary app in `miklospocsaji/vocab`, whose product brief lives there (section 6). The factory is the thing being learned, measured and improved.

**Learning goals for the owner**

- Build agent roles with the Claude Agent SDK (TypeScript): hooks, subagents, sessions, permissions, structured outputs.
- Orchestrate them durably: retries, timers, human-approval signals, replayable state.
- Run agents safely: confined workers, short-lived credentials.
- Measure the factory itself: success rate, cost, wall time and human interventions per work item.

**Instructions to Claude Code**

1. Read this whole brief before writing code. Treat it as the source of truth; propose changes to it as edits, not silent deviations.
2. Work milestone by milestone (section 7). Do not start a milestone before the previous one meets its exit criteria.
3. Build a walking skeleton: a thin end-to-end path first, then thicken it. Prefer a working stub over a complete but unconnected component.
4. Record every significant technical decision as an ADR in `docs/adr/NNNN-title.md` (context, decision, alternatives, consequences).
5. When a decision belongs to the owner (section 8 lists known ones), stop and ask. Offer 2–3 options with a recommendation.
6. Keep `CLAUDE.md` short and current: build/test commands, repo map, conventions. Put role-specific knowledge in skills and agent definitions, not in `CLAUDE.md`.
7. Never put secrets in the repo, prompts or logs.

## 2. Guiding principles

The factory is a deterministic program that calls agents for judgement work; agents never control the flow.

1. **Deterministic skeleton, agentic leaves.** The state machine, gates, retries, budgets, merge and deployment are plain code. Agents only write specs, tests and code, review, and explore. The deployer is never an agent.
2. **Narrow roles, enforced boundaries.** Each role has its own model, tool allowlist, writable paths (enforced by a `PreToolUse` hook), turn limit and token budget.
3. **Tests before code, by a different agent.** The test author writes tests from the acceptance criteria; the implementer cannot edit them. The reviewer starts in a fresh session and never sees the implementer's transcript.
4. **Artifacts, not conversations, between steps.** Every step emits an artifact: OpenSpec files validated by `openspec validate --strict`, or a small JSON result validated by zod. All are recorded in the ledger. Steps are replayable and swappable.
5. **Verification gates decide "done".** Typecheck, lint, unit, e2e, review verdict, test deploy and QA report. No gate, no progress.
6. **Fail, classify, retry with context, escalate.** A cheap classifier labels each failure; retries carry the failure evidence; after N attempts the item escalates to the owner.
7. **Humans approve at gates, not in loops.** The owner approves specs, chooses UX directions and accepts releases. Everything between is autonomous.
8. **Measure the factory.** Every work item records cost, turns, attempts, wall time and interventions. A benchmark of reference tasks is re-run on every factory change.
9. **Behaviour lives in the repo.** Role prompts, skills, agent definitions, hooks and evals are versioned files, changed through merge requests like code.
10. **Cheapest model that passes.** Default to Haiku or Sonnet; reserve Opus for spec and architecture. Model choice per role is configuration, not code.

## 3. Target architecture

A GitHub issue labelled `factory` starts a Step Functions execution that walks one work item from intake to release, calling agent roles as Fargate tasks.

Flow (11 states, per-task build loop): Intake → Proposal → Proposal approval → Design → Design review → Plan → Build loop (per task: tests → code → gates) → Review → Test deploy + QA → Acceptance → Release. The decision points are complexity routing after Proposal approval, the gate result inside the build loop, the review verdict, the QA verdict and the owner's acceptance. From M4 the detailed flow is in `docs/m4-review-preview-qa-release.md`.

Inside the build loop a failing gate goes to the classifier: bugs retry the task, design flaws send the change back to Design, and spec ambiguity or infrastructure problems escalate to the owner.

### Components

| Component | Responsibility | Implementation |
| --- | --- | --- |
| Forge adapter | Read issues, post comments, open and merge PRs, receive webhooks | GitHub App + `@octokit`, behind a `Forge` interface |
| Intake | Turn a webhook into an execution, whose first state creates the work item | One Lambda behind a Function URL, outside the VPC; it never touches the ledger |
| Orchestrator | The work-item state machine: order, retries, waits, budgets, the per-task loop | Step Functions (Standard, JSONata), defined in CDK; states pass ids and pointers, never artifacts (256 KB payload limit) |
| Factory worker | One container image that runs every state, including every role without Bash, and is the only component that touches the ledger | Node + Agent SDK + OpenSpec CLI + git, on ECS Fargate |
| Build container | Runs the roles with Bash (test author, implementer), then the diff check and the gates, and hands a patch back to the worker; holds only the model credential (ADR 0011) | One image per target: ceh's build base with the target's toolchain on top (`targets/<project>/build.Dockerfile`), on ECS Fargate; the target's dependencies are installed online before each session; inputs and outputs through S3 |
| Role runner | Loads role config, runs the agent, validates the output | TypeScript in `factory/roles/` |
| Spec tooling | Validate and archive OpenSpec changes | `openspec` CLI, called by the deterministic runner |
| Gates | Typecheck, lint, unit, e2e, contract checks, `openspec validate`, scenario coverage | Deterministic scripts run in the build container after each build role, never by an agent and never in the worker, which does not run agent-written code |
| QA container | Runs the QA explorer's browser against the target's test environment; holds only the model key and the target's QA login (M4) | Its own image (the worker's base, Playwright, Chromium, the Playwright MCP server), on ECS Fargate; inputs and outputs through S3 |
| Deployer | Deploys the target's test environment and production release into the target's own AWS account (M4) | Deterministic: a synth task (the target's build image, no secrets) makes the cloud assembly; a deployer task (ceh's pinned `aws-cdk`, no repository code) deploys it with the target account's CDK roles |
| Ledger | Work items, attempts, artifacts, costs, events | Postgres on a dedicated Aurora Serverless v2 cluster with auto-pause, separate from the app's; JSON results in the ledger in M2, in S3 from M3 |
| Approvals and commands | Pause for owner decisions and resume; from M3.5 the owner's other commands (`docs/m3.5-owner-commands.md`) | Step Functions `waitForTaskToken`, with the token in the ledger; an owner's issue comment whose first line is a command starts a worker task that acts on it |
| Console | One page per work item: state, tasks, attempts, cost, links | Small read-only web page over the ledger (milestone 6) |
| Secrets | Model key, GitHub App key, webhook secret, ledger credentials | SSM Parameter Store SecureStrings (free); Secrets Manager only for the generated ledger credentials; injected per task |

### Work-item states

1. **Intake:** check the issue states a requirement; create the ledger row and a verb-led OpenSpec change id (for example `add-vocab-import`), which is also the branch name.
2. **Proposal:** the proposal author writes `proposal.md` (why, what, impact) and delta specs (requirements with WHEN/THEN scenarios) under `openspec/changes/<id>/`, and tags the change `small`, `medium` or `large` as `x-complexity` in the change's `.openspec.yaml` (strict validation rejects unprefixed custom keys). Open questions go to the owner as an issue comment. `openspec validate <id> --strict` must pass.
3. **Proposal approval (human):** the owner replies `/approve`, edits the files on the branch, or (from M3.5) replies `/revise` with answers or changes, which sends the proposal back to its author, or `/question`, which its author answers without changing anything.
4. **Design:** the architect writes `design.md` (components, data model, decisions, risks) and the code contracts in the target's contracts path. Skipped for `small` changes.
5. **Design review:** `large` changes wait for owner approval, `medium` changes get a fresh-context design-reviewer agent, `small` changes skip it.
6. **Plan:** the planner writes `tasks.md` (numbered checklist) and a `tasks.json` result listing each task's dependencies, files, scenarios and tests. Every task must fit one implementer session.
7. **Build loop, per task in order:** the test author writes failing tests for the task's scenarios, the implementer makes them pass, then the gates run. When they pass, the runner ticks the task in `tasks.md` and commits. A Step Functions Map state iterates the tasks; independent tasks may run in parallel later.
8. **Review:** a fresh-context reviewer checks the whole diff against the delta specs, `design.md` and the contracts, and returns a verdict.
   From M4 the pull request opens only once the reviewer approves. `changes-requested` starts a fix round: the tasks the findings name are reopened and built again with the findings as evidence (at most 2 review rounds).
9. **Test deploy + QA:** the work item waits for the target's one `test` environment, which holds one work item at a time. The runner resets the `test` branch to the default branch, merges the feature branch, synthesises and deploys it, and runs a smoke check. The QA explorer then exercises the scenarios on desktop and mobile viewports. Issues start a fix round, then Review, test deploy and QA again (at most 2 QA rounds).
10. **Acceptance (human):** the owner tries the change on the test environment and replies `/approve` to release it, `/revise` for a fix round, or closes the pull request to reject it. A hand merge counts as `/approve`. Auto-merge for `small` changes comes in M4.5.
11. **Release:** the runner runs `openspec archive <id> --yes` on the branch, which merges the deltas into `openspec/specs/`, and commits; it merges the pull request once the target's CI is green, deploys production and runs the smoke check. `test` then goes back to the default branch. The retro agent (M7) records lessons.

Failure loop: the classifier labels a failure as `flaky`, `bug`, `design-flaw`, `spec-ambiguity` or `infra`. A bug retries the current task with the evidence (max 3). A design flaw sends the change back to Design with the evidence, then the planner re-plans the unfinished tasks. Spec ambiguity returns to the owner. Infra retries with backoff, then escalates. A reviewer verdict of `changes-requested` is classified the same way.

### Artifacts and the OpenSpec layout

OpenSpec is the format for intent, design and tasks, so the owner can read, edit or hand-run any stage with the normal OpenSpec workflow. One GitHub issue maps to one OpenSpec change. A work item's change lives in the target's repository, in the target's own `openspec/` folder:

```
openspec/
├── config.yaml                        # project conventions (context + per-artifact rules), created by `openspec init`
├── specs/<capability>/spec.md         # source of truth: current requirements and scenarios
└── changes/
    ├── <change-id>/
    │   ├── .openspec.yaml             # change metadata: schema, created, goal, x-complexity
    │   ├── proposal.md                # why, what, impact
    │   ├── specs/<capability>/spec.md # delta: ADDED / MODIFIED / REMOVED / RENAMED requirements
    │   ├── design.md                  # how; omitted for small changes
    │   └── tasks.md                   # numbered implementation checklist
    └── archive/YYYY-MM-DD-<change-id>/
```

The scenarios in the delta specs are the acceptance criteria. Each test names the scenario it proves by putting the exact scenario title in its test name (for example `it("Scenario: Re-import adds only new lookups", …)`), and a gate checks that every scenario in the change has at least one test. Scenario titles are unique within a change.

`openspec validate --strict` requires every change to contain at least one delta. A change that touches no requirements (pure tooling, refactor, docs) sets `skip_specs: true` in its `.openspec.yaml`.

Factory capabilities are built through OpenSpec changes too, in this repository's `openspec/` folder, scoped per milestone and written by the owner or a local Claude Code session, never by a factory role. A change holds only what its milestone builds and is archived when that milestone exits, so `openspec/specs/` never describes behaviour that does not exist yet.

Results OpenSpec has no place for are small JSON artifacts with zod schemas in `factory/artifacts/`, stored in S3 by work item and attempt (in M2, the single result sits in the ledger on its attempt). They never go in the change folder.

| Artifact | Produced by | Consumed by |
| --- | --- | --- |
| `proposal.md` + delta specs | Proposal author | Every later step |
| `design.md` + the target's contracts | Architect | Planner, test author, implementer, reviewer |
| `tasks.md` + `tasks.json` | Planner | Build loop |
| Test diff per task | Test author | Implementer, gates |
| Code diff per task, PR | Implementer | Gates, reviewer |
| `gates.json` | Gates | Classifier, ledger |
| `review.json` (verdict, findings) | Design reviewer, reviewer | Orchestrator |
| `qa-report.json` + screenshots | QA explorer | Owner, orchestrator |
| `retro.md` | Retro | Factory improvement PRs |

## 4. Role catalog

Ten roles, each defined by one config file in `factory/roles/<role>.yaml` plus a prompt in `factory/roles/<role>.md` with no frontmatter (ADR 0012). All run as Agent SDK sessions through the role runner; the failure classifier is a session with no tools and structured output (owner, 2026-11-09). Models are starting defaults; tune them from benchmark results. Paths outside `openspec/changes/<id>/` are the target's: each target's `targets/<project>/target.yaml` sets its writable paths per role, its contracts path and its commands.

| Role | Default model | Tools | May write | Output | Turn cap |
| --- | --- | --- | --- | --- | --- |
| Proposal author | `claude-opus-5-5` | Read, Grep, Glob, Edit, Write, WebFetch (GitHub only) | `openspec/changes/<id>/` except `design.md` and `tasks.md` | `proposal.md`, delta specs, `x-complexity` tag | 30 |
| Architect | `claude-opus-5-5` | Read, Grep, Glob, Edit, Write | `openspec/changes/<id>/design.md`, the target's contracts path | `design.md`, contracts | 40 |
| Design reviewer | `claude-sonnet-5-5` | Read, Grep, Glob | nothing | `review.json` | 20 |
| Planner | `claude-sonnet-5-5` | Read, Grep, Glob, Edit, Write | `openspec/changes/<id>/tasks.md` | `tasks.md`, `tasks.json` | 25 |
| Test author | `claude-sonnet-5-5` | Read, Grep, Glob, Edit, Write, Bash | the target's test paths, and stubs of the task's new source files | test diff for one task | 40 |
| Implementer | `claude-sonnet-5-5` | Read, Grep, Glob, Edit, Write, Bash | the target's source paths except its contracts path, and the target's own infrastructure (never tests) | code diff for one task | 60 |
| Reviewer | `claude-sonnet-5-5` | Read, Grep, Glob (in the worker) | nothing | `review.json`, with each finding's task and kind (`code` or `test`) | 25 |
| QA explorer | `claude-sonnet-5-5` | Playwright MCP limited to the test environment's origins, Read (in the QA container) | the runner-provided screenshot directory only (outside the repo; the runner uploads it to S3) | `qa-report.json` + screenshots | 60 |
| Failure classifier | `claude-haiku-5-5` | none: an Agent SDK session with structured output, input in prompt | nothing | `{kind, evidence}` | 3 |
| Retro | `claude-haiku-5-5` | Read, Edit, Write | `factory/lessons/`; the runner commits and opens the PR | `retro.md` | 20 |

**Rules that apply to every role**

- The role runner wraps `query()` from `@anthropic-ai/claude-agent-sdk`. It sets:
  - `cwd` to the work item's worktree.
  - `tools` to the role's tool list; these are the only tools that exist for the role. `allowedTools` only pre-approves calls and does not restrict anything.
  - `allowedTools` to the role's pre-approved calls, including Bash patterns such as `Bash(pnpm test:*)`.
  - `permissionMode: "dontAsk"`, so anything not pre-approved is denied. The mode is never left to default, because the default can be `auto`.
  - `settingSources: ["project"]`, so the user's `~/.claude` never leaks in.
  - `skills` to the role's skill list.
  - `maxTurns` and `maxBudgetUsd` from the role config, the one place each limit is set. A session stopped on a limit names the role, the limit and its value in the escalation.
  - A `PreToolUse` hook that denies `Edit`, `Write` and `NotebookEdit` outside the role's paths. The hook resolves paths against the worktree, following symlinks.
  - `sandbox` per place: worker roles keep the sandbox options of ADR 0007; build roles set `sandbox: { enabled: false }` explicitly.
- The runner reads `factory/roles/<role>.md` itself and passes it as the system prompt. Roles never get the Agent tool, so they cannot start subagents. No role prompt lives in `.claude/agents/`, so Claude Code never registers a role as a subagent (ADR 0012).
- Each config says where the role runs: `runsIn: worker | build`. The runner refuses a `build` role anywhere but the build container. In M3 the test author and implementer run in the build container; every other role runs in the worker.
- Every role starts from the change folder and the current `openspec/specs/` for the affected capabilities. Only the proposal author changes requirements and only the architect changes design. The implementer never edits `tasks.md`; the runner ticks a task once its gates pass.
- Only roles in the build container have Bash, allowlisted per role as permission rules: the target's typecheck, lint and unit commands from its `target.yaml`, plus `git status:*` and `git diff:*`. No install, no network commands, no `git push`; the deterministic runner pushes. The SDK sandbox cannot start on Fargate (ADR 0007), so Bash can write anywhere in the clone. After the session a diff check against the starting commit fails the attempt if any path outside the role's globs changed, and the worker runs the same check on the patch before it commits (ADR 0011).
- Writable globs may hold `!` exclusions (the implementer's exclusion of the target's contracts path) and the `{taskStubs}` placeholder, the task's source files that did not exist at the starting commit (the test author's stubs).
- The role returns its JSON result as structured output (`outputFormat` built from its zod schema with `z.toJSONSchema`, targeting draft-07, because the CLI rejects zod's default 2020-12 `$schema`). The runner re-parses `structured_output` with zod and validates any OpenSpec files with `openspec validate <id> --strict`. Invalid output, or any non-`success` result subtype, counts as a failed attempt.
- Every SDK message is streamed to the ledger with token usage, so cost per role, per task and per work item is always known. Cost comes from the result's `modelUsage` and `total_cost_usd`, which are estimates in both auth modes. The auth mode comes from the init message's `apiKeySource`.
- Prompts receive only artifacts, never other roles' transcripts.

**Role runner sketch** (checked against Agent SDK 0.3.310; the SDK is 0.x, so pin it exactly and re-check on every upgrade):

```ts
import { query, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export async function runRole(role: RoleConfig, item: WorkItem): Promise<Artifact> {
  const guardPaths: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const { file_path, notebook_path } = input.tool_input as { file_path?: string; notebook_path?: string };
    const rel = relative(item.worktree, await realpathOrSelf(resolve(item.worktree, file_path ?? notebook_path ?? "")));
    const allowed = !rel.startsWith("..") && role.writable.some((g) => minimatch(rel, g));
    return allowed
      ? {}
      : {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `${role.name} may only write ${role.writable.join(", ")}`,
          },
        };
  };

  for await (const msg of query({
    prompt: renderPrompt(role, item), // artifacts only, never transcripts
    options: {
      cwd: item.worktree,
      model: role.model,
      systemPrompt: role.prompt, // from factory/roles/<role>.md
      tools: role.tools,
      allowedTools: role.allow,
      permissionMode: "dontAsk",
      settingSources: ["project"],
      skills: role.skills,
      maxTurns: role.maxTurns,
      maxBudgetUsd: role.maxBudgetUsd,
      outputFormat: { type: "json_schema", schema: z.toJSONSchema(role.schema, { target: "draft-07" }) }, // the CLI rejects 2020-12
      hooks: { PreToolUse: [{ matcher: "Edit|Write|NotebookEdit", hooks: [guardPaths] }] },
    },
  })) {
    await ledger.record(item.id, role.name, msg);
    if (msg.type === "result") {
      if (msg.subtype !== "success") throw new AttemptFailed(msg.subtype);
      return role.schema.parse(msg.structured_output);
    }
  }
  throw new AttemptFailed("no result");
}
```

## 5. Stack, repo layout, infrastructure and security

One TypeScript monorepo holds the factory, its infrastructure and its target configs. The targets it works on live in their own repositories and choose their own stacks. The factory deploys to one AWS account with CDK.

### Stack

| Area | Choice |
| --- | --- |
| Language | TypeScript 6.0 (strict), Node 24 LTS. TypeScript 7 waits until typescript-eslint supports it. |
| Package manager | pnpm workspaces; exact versions pinned for the Agent SDK (0.x) and the OpenSpec CLI |
| Lint | ESLint (flat config) + typescript-eslint |
| Agents | `@anthropic-ai/claude-agent-sdk` for every role, the classifier included; `@anthropic-ai/sdk` for Batch API calls; Anthropic API key in SSM Parameter Store |
| Specs and tasks | OpenSpec (`@fission-ai/openspec`): CLI in the worker image and locally, as a repo dev dependency; changes under `openspec/changes/` |
| Orchestration | AWS Step Functions (Standard workflows, JSONata), Map state for the per-task loop |
| Agent compute | ECS Fargate tasks from one `factory-worker` image in ECR, and a build image per target on its `build-base` stage for the roles with Bash |
| Infrastructure | AWS CDK v2 (TypeScript) |
| Validation | zod for every JSON result and config |
| Tests | Vitest (unit); Playwright for the QA role |
| Forge | GitHub: issues as the backlog, PRs as the unit of change, a GitHub App for the factory |

### Repo layout

```
/
├── CLAUDE.md                 # build/test commands, repo map, conventions (short)
├── .claude/                  # no agents/: role prompts live in factory/roles/ (ADR 0012)
│   ├── skills/               # reusable know-how (e.g. writing-scenarios, splitting-tasks), plus openspec-* skills from `openspec init`
│   ├── commands/opsx/        # OpenSpec slash commands from `openspec init`, for hand-running stages
│   └── settings.json         # hooks shared by local Claude Code and the worker
├── openspec/                 # specs, active changes, archive (see section 3)
├── docs/
│   ├── brief.md              # this document
│   └── adr/                  # architecture decision records
├── factory/
│   ├── target/               # target config schema + loader
│   ├── roles/                # role configs (yaml), prompts (md) + role runner
│   ├── artifacts/            # zod schemas for every JSON result
│   ├── orchestrator/         # state machine definition + task handlers
│   ├── forge/                # Forge interface + GitHub implementation
│   ├── ledger/               # data access for work items, tasks, attempts, costs
│   ├── gates/                # deterministic checks, incl. scenario coverage
│   ├── lessons/              # curated lessons written by the retro role
│   ├── benchmark/            # reference tasks + runner + results
│   └── worker/               # Dockerfile for factory-worker and its build target
├── targets/
│   └── <project>/            # one folder per target repository (from M3.25)
│       ├── target.yaml       # repository, owner, commands, writable paths per role, contracts path, budget
│       └── build.Dockerfile  # the target's toolchain on top of ceh's build base
└── infra/
    └── factory-stack.ts      # never written by factory roles
```

### Environments

- **Factory:** one long-lived stack (Step Functions, Fargate cluster, ledger, webhook Lambda).
- **Target accounts:** each target's app lives in its own AWS account, bootstrapped for CDK to trust the factory's account (`vocab`: 100159507559). The factory deploys there with the target account's CDK roles, never into its own account. The target's base stacks (zone, certificates, database) are the owner's; the target documents them.
- **Test:** one long-lived environment per target, deployed from its `test` branch, which is the default branch plus at most one feature branch. One work item holds it at a time; it goes back to the default branch after that work item is released or rejected. There is no stack per pull request.
- **Production:** deployed from the default branch only by the Release state.
- **Region:** the factory's stack lives in eu-central-1. A target's regions are its own (`vocab`: eu-central-1, plus us-east-1 for the CloudFront certificate).

### Security

- Worker tasks run in the public subnets of a small VPC, with a public IP and no inbound access. Aurora has no public address and accepts connections only from the worker. There is no network-level egress control (owner decision, section 8): the Bash allowlist, per-role `WebFetch` domain rules, a read guard and a spend-limited API key limit what an agent can reach and leak. The SDK's Bash sandbox cannot start in a container with no added privileges (ADR 0007), so no role in the worker has Bash.
- Roles with Bash run in the build container, which holds only the model credential and refuses to start if any other factory credential is in its environment (ADR 0011). It clones the branch with no token and never pushes. Agent-written code there can read the model credential and send it anywhere; the owner accepts that risk (section 8). The worker checks every patch's paths before it commits.
- Each worker task gets a short-lived GitHub App installation token scoped to the target's repository, and no AWS credentials beyond reporting to its own execution and, from M3, reading its inputs and writing its artifacts. A build task gets no GitHub token, and AWS access only to its work item's artifacts. Deploys use a separate deployer role that agents never hold. Agent-written infrastructure code is synthesised in a task with no secrets at all; the deployer task runs only the resulting assembly with ceh's pinned CDK CLI and holds no GitHub token, ledger access or model key (M4).
- The QA explorer's browser runs agent-written code, so it runs in its own container with only the model key and the target's QA login, and Playwright MCP may open only the test environment's origins (M4).
- Agent-visible content from issues, web pages or the app under test is data, never instructions. Role prompts say so, and hooks, permission rules, the sandbox (worker) and the diff check (build container) enforce the path and command allowlists regardless.
- No work item changes the factory: work items run on a target's repository, never on this one, and target configs are outside every target's reach. `ceh` changes only through the owner or a local Claude Code session; the retro role's lesson PRs (M7) are reviewed by the owner like any other.
- Monthly AWS budget alarm and a per-work-item token budget; exceeding either pauses the execution and notifies the owner.

## 6. First workload: the Kindle vocabulary app

The app lives in `miklospocsaji/vocab`, with its product brief (`docs/brief.md` there), its issues and its own decisions. What `ceh` knows about it is in `targets/vocab/`. The milestones below still name their `vocab` workload, since that is how the factory proves each one.

## 7. Milestones

Eleven milestones, each ending in a working end-to-end path; app features enter as factory workload from milestone 3 onwards. M3.25 and M3.5 were added during M3; both are done. M4.5 was added when M4 was settled.

1. **M0 Foundations**
   - Deliverables: monorepo with pnpm, strict TS, Vitest, lint; `openspec init` with project conventions filled in (`openspec/config.yaml`); `CLAUDE.md`; ADRs 0001–0005 (stack, orchestration, ledger store, OpenSpec usage and capabilities, fixture anonymisation); a basic GitHub Actions CI running the gates on every PR, including `openspec validate --all --strict`; an anonymised copy of the owner's real `vocab.db` in `app/fixtures/`, produced by a committed script; the approved OpenSpec changes for M1's `orchestration` and `roles` work.
   - Exit: `pnpm check` runs typecheck, lint, tests and OpenSpec validation green locally and in CI.
2. **M1 Local walking skeleton**
   - Deliverables: `Forge` interface + GitHub implementation; role runner; proposal-author role; zod schema for its JSON result; a local ledger (Postgres in Docker); CLI `pnpm factory run --issue <n> --until proposal`.
   - Exit: running the CLI against a real issue creates a branch with an OpenSpec change that passes `openspec validate --strict`, posts a summary as an issue comment, and records cost in the ledger.
3. **M2 Cloud skeleton**
   - Deliverables: `factory-worker` image; factory CDK stack (webhook Lambda, Step Functions, Fargate, secrets, ledger); states Intake → Proposal → Proposal approval with `waitForTaskToken`; `/approve` comment command resumes it.
   - Exit: labelling an issue `factory` produces a validated change within minutes; `/approve` moves the execution on; nothing runs on the laptop.
4. **M3 Design, plan and build loop**
   - Deliverables: architect, design-reviewer, planner, test-author, implementer and failure-classifier roles; complexity routing (small skips design, medium gets the agent review, large waits for the owner); the per-task Map loop with gates, task ticking and retry with evidence (max 3); `design-flaw` routing back to Design and re-planning; scenario-coverage gate; PR opening by the deterministic runner.
   - First workload issue: the `vocab.db` importer in `app/domain/` (parse words, lookups and books; idempotent re-import), tested against the fixture.
   - Exit: the importer PR has every task in `tasks.md` ticked with green gates and no human edits to code or tests, and at least one `medium` change has passed through agent design review.
5. **M3.25 Factory in its own repository (settled 14 November 2026, done 15 November 2026)**
   - Why: the factory and the app share one repository, so they also share one `openspec/` folder, gates, CI, branch protection and history. App roles see factory specs as context, and an app change could carry deltas to a factory capability. Every app task's gates run the factory's tests, and the build image holds the factory's source. None of this holds up for several or larger projects.
   - Name: the factory becomes **ceh** (Hungarian *céh*, "guild", said "tsay"), in the public repository `miklospocsaji/ceh`. It is built to serve several projects later, so nothing in it is named after `vocab`, but M3.25 ships one target only. Routing, budgets and cost reporting for several targets wait for a second project.
   - Principles:
     - The app stays in `vocab`, with its issues. The factory moves to `ceh`, made with `git filter-repo` from a clone, so its history comes along. `vocab`'s history is not rewritten: it is tagged `pre-split`, and the factory is removed in one ordinary PR.
     - Documents are split, never duplicated: each repository describes only itself. `vocab` knows nothing about `ceh`; everything ceh knows about `vocab` lives in `ceh`.
     - The split is a repository operation by the owner and a local Claude Code session, not an OpenSpec change (the removed specs would need a REMOVED delta for every requirement). ADR 0013 in `ceh` records it. Everything after the split goes through one OpenSpec change in `ceh`.
     - `ceh` keeps today's layout (`factory/*`, `infra/`, `openspec/`, `docs/`); only `targets/` is new, at its root.
   - What goes where in the split (step 2):
     - **to `ceh`:** `factory/*`, `infra/` (the `Factory` stack), the worker Dockerfile, `.claude/`, `docker-compose.yml` (the local ledger), CI with its Postgres service, the `orchestration`, `roles` and `gates` specs, and the archived changes `add-monorepo-foundations`, `add-role-runner`, `add-local-proposal-run`, `add-cloud-proposal-run`, `add-factory-worker`, `add-build-gates`, `add-build-roles` and `add-build-loop`.
     - **stays in `vocab`:** `app/*` (fixtures included), `.claude/`, the `vocab-import` spec, and the archived changes `add-vocab-fixture` and `add-read-a-kindle-vocab-db-into-books`. CI without Postgres, running a `pnpm check` of the app only.
     - **Root files:** each repository gets its own trimmed copy of `package.json`, `pnpm-workspace.yaml` (ceh: `factory/*` and `infra`; vocab: `app/*`), a regenerated `pnpm-lock.yaml`, `tsconfig*.json`, `eslint.config.js`, `vitest.config.ts`, `.nvmrc` and `openspec/config.yaml` (each listing only its own capabilities). `vocab`'s scripts become plain `typecheck` and `lint`; the `:app` variants go.
     - **Brief:** `ceh` keeps this brief without section 6, and in step 2 rewrites sections 3–5 for its own repository (layout, no `app/`; role paths say "the target's", pointing to `targets/`). Its milestones still name their `vocab` workload, since that is how the factory proves each one. `vocab` gets `docs/brief.md` as a product brief: section 6, plus the app's owner decisions from section 8 (languages, users, domain, UX, fixture data). The preview-database decision stays in `ceh`, since the deployer is the factory's.
     - **`CLAUDE.md`:** each repository gets its own. `ceh`'s is today's without the app; `vocab`'s has the app's commands and conventions only.
     - **ADRs** keep their numbers, with gaps; later ADRs number on independently in each repository. `ceh`: 0002, 0003, 0006–0012 and the new 0013. `vocab`: 0005. ADRs 0001 (stack) and 0004 (OpenSpec) are split by content, with no shared text: `ceh`'s 0001 keeps the factory's stack (Agent SDK, Step Functions, Fargate, CDK, ledger), `vocab`'s the app's (React/Vite, Lambda, Aurora, Cognito, Vitest/Playwright); each states its own Node, TypeScript and ESLint choice. `ceh`'s 0004 keeps how the factory uses OpenSpec in a target and its own capabilities; `vocab`'s only its capabilities.
   - What `ceh` needs to work on a repository it does not live in (step 3, one OpenSpec change in `ceh`):
     - **A target config, in `ceh`:** `targets/<project>/target.yaml`, so `targets/vocab/target.yaml`. Writable paths are a security boundary, so a target's own work items never reach them; targets change through `ceh`, like role configs. It names:
       - the repository and its default branch, and the owner who may `/approve` (moving out of `infra/cdk.json`, which keeps the App ID, installation ID and slug)
       - the commands: install, typecheck, lint, unit with its test path, spec validation; the gates run them, and the build roles' Bash allowlist is built from them (today `pnpm typecheck:app` and `pnpm lint:app` sit in the role YAMLs, and `app/` in `factory/gates/src/checks.ts`)
       - the coverage test directory
       - the writable paths per role (today's `app/*` and `infra/app*` globs in the role YAMLs)
       - the contracts path (today `app/contracts/src`, hard-coded in `factory/orchestrator/src/design.ts`)
       - the per-work-item budget
     - Role YAMLs keep model, tools, turn cap and per-role budget. Prompts take the target's paths as placeholders instead of naming `app/`.
     - **The local CLI works on a clone of the target:** `pnpm factory run` today works on the checkout it runs in and its GitHub remote. It takes the target from `targets/` instead (with one target, by default).
     - **A build image per target, defined in `ceh`:** `targets/vocab/build.Dockerfile` starts `FROM` ceh's build base (Node, pnpm, the factory's code and the `factory-build` entry point with its credential check) and adds only the target's toolchain: system packages, and later Playwright browsers. It bakes in no project dependencies: before each session the runner runs the target's install command (`pnpm install --frozen-lockfile`) in the clone, from the registry. This replaces today's warm pnpm store and `--offline` install, which come from the factory's own lockfile and stop working once the app's dependencies leave it. The exit run measures the time the install costs; a warm store can come later if it hurts. Settled in the change's design: the worker's and the target's Dockerfiles are assembled into one file, whose last stage one `docker build` makes (ADR 0010, amendment of 15 November 2026).
     - **Work items keyed by repository:** a ledger migration adds `repository` to `work_items`, backfills `miklospocsaji/vocab`, and makes `(repository, issue_number)` and `(repository, change_id)` unique instead of the issue number and change id alone. The webhook still accepts only the one target's repository.
     - **Renames:** the packages become `@ceh/*`, the GitHub App `ceh-app` (renamed by the owner on 14 November 2026; the bot is `ceh-app[bot]`, and the slug in `cdk.json` follows) and the resource tag `project=ceh`. The CDK stack keeps the name `Factory`, because renaming it would replace the ledger. The App stays installed on `vocab` only; `ceh` needs no installation.
   - Order (the owner confirms every outward step: closing, deleting, creating the repository, renaming the App, deploying):
     - **Step 1: Clean up `vocab`.** Close PR #9 (issue #7) unmerged. Delete the remote work-item branches: `add-clean-up-kindle-usage-sentences-and`, `add-import-a-kindle-vocab-db-into-books`, `add-import-words-lookups-and-books-from`, `add-mark-words-as-known-or-ignored`, `add-read-a-kindle-vocab-db-into-books`, `add-show-how-often-each-word-was-looked`, `add-show-the-number-of-words-per-book`. Comment on the open issues #2, #4, #5 and #7 to refile each as a new issue after M3.25, since relabelling ends in a duplicate Intake until M3.5. Archive the merged `add-read-a-kindle-vocab-db-into-books` change by hand (`openspec archive`). Then tag `pre-split` on `master` and push the tag.
     - **Step 2: Split.** Create the public repository `miklospocsaji/ceh` and push the filter-repo result. Trim the root files, the brief, `CLAUDE.md`, the ADRs and CI as above, and switch CI and branch protection on. Open `vocab`'s removal PR the same way. Both repositories' `pnpm check` are green. No work item runs between this step and step 4.
     - **Step 3: Make `ceh` target-aware.** The OpenSpec change is `add-target-repositories`; its scope is the list above under "What `ceh` needs to work on a repository it does not live in", plus capabilities left to the target (ADR 0014). The owner approves it, and a local Claude Code session builds it in `ceh` (factory roles never change the factory). The change carries the renames in code (the packages, the App slug in `cdk.json`, the resource tag); the owner renamed the GitHub App itself on GitHub (`ceh-app`).
     - **Step 4: Deploy from `ceh`.** The `infra:diff` shows new images, the renamed tag, the App slug and the new task environment, and no replacement of the ledger or any other stateful resource. Then the owner files a fresh small `vocab` issue for the exit run.
   - Exit: `ceh`, deployed from its own repository, takes that issue to a pull request opened by `ceh-app[bot]`, with every task built in vocab's build image and its gates green. `vocab`'s CI runs only the app's gates, and `ceh`'s CI only the factory's.
6. **M3.5 Owner commands and resuming work items (settled 15 November 2026, done 26 November 2026)**
   - Why: in M3 the factory ignores every issue comment except `/approve`, so the owner's answers and feedback never reach a proposal already written. A stopped or failed work item cannot be resumed, only refiled as a new issue (M3's #11). The owner cannot stop a work item, ask where it stands, or ask about a proposal from the issue.
   - Scope, in `docs/m3.5-owner-commands.md`: owner-only commands on a comment's first line (`/approve`, `/revise`, `/question`, `/abort`, `/resume`, `/status`, `/help`), all other comments ignored. While a proposal or design awaits approval:
     - `/revise` sends it back to its author with the comment.
     - `/question` gets an answer from a read-only session of its author and changes nothing.

     A command that arrives while a role runs is refused with a reply, never queued. `/abort` pauses a work item and `/resume` continues it from where it stopped; closing the issue is the final stop. `/restart` is left out. The document holds the detailed design, what each command means in each state, the mechanics, and the settled and open decisions.
   - Three OpenSpec changes in `ceh`, built in this order by a local Claude Code session: `add-owner-commands`, `add-approval-feedback`, `add-work-item-resume`.
   - Exit: in `docs/m3.5-owner-commands.md`, section 11. It is a cloud run on a fresh `vocab` issue with:
     - a `/question` and a `/revise` that answers an open question
     - a refused busy command and ignored non-commands
     - `/status`
     - an `/abort` and `/resume` during Build that ends in a pull request with no task rebuilt and no second `/approve`
7. **M4 Review, test deploy, QA and release (settled 27 November 2026)**
   - Why: a work item ends at a pull request no agent has reviewed and nothing has run, and after the merge its change stays active. The brief's first plan (a preview stack per pull request) was written when the factory and the app shared one repository.
   - Scope, in `docs/m4-review-preview-qa-release.md`: the reviewer, with fix rounds that reopen tasks; the pull request opened after Review; one long-lived `test` environment per target, held by one work item at a time; the synth task and the deployer in the target's own account; the QA explorer in its own container, with its report and screenshots on the pull request; acceptance by `/approve`, `/revise` or a closed pull request; release with the archive on the branch, the factory's merge and the production deploy. Local runs stop at `--until review`.
   - Before it, by hand in `vocab`: the app's base (packages, dependencies, CDK app, environments, database), as `vocab`'s `add-app-foundations`.
   - Four OpenSpec changes in `ceh`, in this order: `add-reviewer`, `add-test-deploy`, `add-qa-explorer` (2 and 3 in either order), `add-acceptance-release`.
   - Workload: auth with Cognito (after `add-reviewer`), trajectories CRUD, and the upload of `vocab.db` with a minimal unstyled UI as the exit run.
   - Exit: in `docs/m4-review-preview-qa-release.md`, section 14. A seeded UI bug is caught by the reviewer or the QA explorer and fixed; a second work item waits for `test`; the owner sends a `/revise` and then `/approve`s; the factory archives, merges, deploys production, and `openspec/specs/` reflects the change.
8. **M4.5 Hardening the release path (proposed, settled when M4 exits)**
   - The e2e gate: Playwright tests in the build container against the local build.
   - A deterministic check of the templates before every deploy, which narrows the risk of `test` and `prod` sharing a target account.
   - Auto-merge for `small` changes on an approving review and a clean QA report.
   - The target's QA login provisioned by the target itself.
9. **M5 UX directions**
   - Deliverables: three clickable prototype directions (from `vocab`'s product brief) for desktop and mobile, linked from an issue; owner choice recorded in an ADR; design system (tokens, components, layouts) committed; QA checks screenshots against it.
   - Exit: the owner has picked a direction and the existing UI is restyled by the factory to match.
10. **M6 Enrichment, practice and the factory console**
   - Workload: enrichment pipeline with the `evals/enrichment/` gate; FSRS practice flow; filters by trajectory and book.
   - Factory deliverables: console page per work item (state, task progress, attempts, cost, links); per-item token budgets and the monthly budget alarm, both pausing executions.
   - Exit: the owner can import their own Kindle data and practise; every work item's cost is visible in one place.
11. **M7 Self-improving factory**
   - Deliverables: benchmark of 10 reference tasks (replays of earlier issues) with a runner and a results table; retro role opening PRs to `factory/lessons/`, skills and role prompts; model routing per role driven by benchmark results.
   - Workload: optional EPUB upload for paragraph context.
   - Exit: a baseline benchmark run is recorded, and at least one retro PR has measurably improved success rate or cost.

## 8. Owner decisions

Decided on 26–27 October 2026. Claude Code treats these as requirements and records each in an ADR when its milestone starts. Open items are unticked; they are decided when their milestone starts.

- [x] **Toolchain (M0):** Node 24 LTS, TypeScript 6.0, ESLint + typescript-eslint. Revisit TypeScript 7 once typescript-eslint supports it.
- [x] **OpenSpec change scope (M0):** per milestone. A change holds only what its milestone builds and is archived at that milestone's exit.
- [x] **Implementer infrastructure scope (M3):** app and preview stacks only (`infra/app-stack.ts`, `infra/preview-stack.ts`, `infra/app/`). Factory infrastructure is never changed by a work item. From M4 the target's `target.yaml` names them (`vocab`: `infra/src/app-stack.ts` and `infra/src/app/**`, never its base stacks).
- [x] **Worker egress (M2, changed 2 November 2026):** no egress control. The owner removed the domain-allowlist proxy and the learning goal, and accepts the risk. Workers use public subnets and reach the internet directly. No NAT instance, NAT Gateway or Network Firewall.
- [x] **Preview database (M4, 27 November 2026):** there are no previews. The target has one `test` environment instead, and `vocab` keeps one cluster with one database per environment; its `test` database is rebuilt on every deploy.
- [x] **Model billing (M1):** local runs use the subscription's Agent SDK credit; cloud runs (M2 onwards) use an Anthropic API key. The role runner supports both auth modes by config, and the ledger records which mode each run used, since subscription runs have no exact per-call price (record tokens, estimate cost).
- [x] **Ledger store (M0):** a dedicated Aurora Serverless v2 Postgres cluster with auto-pause, separate from the app's.
- [x] **Capabilities (M0):** `orchestration`, `roles`, `gates`. They are specified in OpenSpec from M0, so Claude Code builds the factory through OpenSpec changes too. A target's capabilities are its own decision.
- [x] **Complexity rules (M3):** small = one capability, no schema or contract change; medium = a contract or schema change within one capability; large = several capabilities, new infrastructure, or anything touching auth or security.
- [x] **Auto-merge policy (M4, moved to M4.5 on 27 November 2026):** small changes merge themselves on green gates, an approving review and a clean QA report; medium and large changes wait for the owner. In M4 every change waits for the owner.
- [x] **Budget limits (M2, changed 2 November 2026):** $50 a month AWS budget alarm, covering the whole shared AWS account; $20 a month Anthropic workspace limit; $5 model spend per work item.
- [x] **Bash roles (M3, 8 November 2026):** roles with Bash (test author, implementer) run in a build container that holds only the model credential (ADR 0011). A test author and implementer without Bash were rejected. Accepted risk: agent-written code there can read the model credential and, with no egress control, send it anywhere; in the cloud that is the spend-limited, revocable API key.
- [x] **Role prompts (M3, 8 November 2026):** prompts live at `factory/roles/<role>.md` with no frontmatter, and `.claude/agents/` is removed, so Claude Code never registers a factory role as a subagent (ADR 0012).
- [x] **Failure classifier (M3, 9 November 2026):** an Agent SDK session with no tools, a cap of 3 turns and structured output, instead of a Messages API call, so it runs in both auth modes and is recorded like every other role.
- [x] **Local build runs (M3, 9 November 2026):** local runs of the build container keep the subscription token (ADR 0006). Accepted risk: agent-written code in the container can read it, and it has no spend limit of its own.
- [x] **Factory repository (M3.25, 14 November 2026):** the factory becomes `ceh`, a public repository, named for several projects but shipping one target. Target configs and per-target build Dockerfiles live in `ceh`, never in the target. Build images carry only the toolchain; dependencies are installed online before each session. The packages, the GitHub App and the resource tag are renamed to `ceh`; the stack keeps the name `Factory`. Old work items are closed and refiled rather than resumed. The split comes first, then the target-aware change.
- [x] **Owner commands (M3.5, 15 November 2026):** commands are a first-line `/<verb>` by the owner on an issue; everything else is ignored, with no reply (ADR 0015). One `/revise` serves both answers and change requests, rather than a separate `/answer`. Commands that arrive while a role runs are refused with a busy reply, never queued. At most 5 revisions per stage. `/question` is answered in the `command` task by a read-only session of the awaiting stage's author, with at most 10 questions per stage and $0.30 and 10 turns per answer. `/abort` pauses a work item, which `/resume` continues; closing the issue is the final stop. Work items are resumed by `/resume` only, not by relabelling, and resuming an escalated one resets its retry counts. `/restart` is left out of M3.5. M3.5 ships as three OpenSpec changes, in order: `add-owner-commands`, `add-approval-feedback`, `add-work-item-resume` (`docs/m3.5-owner-commands.md`).
- [x] **Review, test deploy, QA and release (M4, 27 November 2026):** one long-lived `test` environment per target instead of a preview per pull request, held by one work item at a time and reset to the default branch after each; the target's base is built by hand in the target; each target has its own AWS account, where the factory deploys with assumed roles; synth runs with no secrets and the deploy runs only the assembly; the pull request opens after Review approves; fix rounds reopen the named tasks (at most 2 review and 2 QA rounds); QA runs in its own container; screenshots are served from the artifact bucket behind CloudFront; the QA login is the owner's, in ceh's SSM; acceptance is `/approve` and the factory merges; local runs stop at Review; role limits stay one line each in the role YAML. M4 ships as four OpenSpec changes, in order: `add-reviewer`, `add-test-deploy`, `add-qa-explorer`, `add-acceptance-release` (`docs/m4-review-preview-qa-release.md`).
