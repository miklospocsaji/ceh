# CLAUDE.md

ceh, a software factory that works on target repositories it does not live in. Each target is described in `targets/<name>/` (ADR 0014); the first is `vocab`. `docs/brief.md` is the source of truth; decisions live in `docs/adr/`.

M3.5 is done (brief section 7): owner commands and resuming work items, settled in `docs/m3.5-owner-commands.md` and shipped as three archived OpenSpec changes, `add-owner-commands`, `add-approval-feedback` and `add-work-item-resume`. The stack in AWS is deployed from this repository and works on `vocab`; M3.5's exit run was `vocab` issue #28 (pull request #29).

## Commands

- `pnpm install`: requires Node 24 (`.nvmrc`; install fails on other versions)
- `pnpm db:up`: starts the local ledger (Postgres in Docker, port 54329). Run it before `pnpm check` or `pnpm factory`: ledger-backed tests read `FACTORY_DATABASE_URL` and fail, never skip, if it is unset
- `pnpm check`: all gates: typecheck, lint, unit tests, `openspec validate --all --strict`
- `pnpm test` / `pnpm lint` / `pnpm typecheck` / `pnpm spec:validate`: single gates
- `pnpm gates coverage --change <id> --tests <dir>`: the scenario coverage gate for a change. For the factory's own changes use `--tests factory`, and `--tests infra` for the stack's scenarios. `pnpm gates red|green --target <name> …` runs a target's gates in a worktree of it
- `pnpm test:live`: real Agent SDK sessions with small budgets (`*.live.test.ts`); never in `pnpm check` or CI
- `pnpm test:docker`: tests that build and run the worker image and vocab's build image (`*.docker.test.ts`); never in `pnpm check` or CI. Needs Docker
- `pnpm image:build [--target <name>]`: builds a target's build image locally as `ceh-build-<name>:local`, which `pnpm factory run --until pr` runs. Rebuild it after a change under `factory/` or `targets/`
- `pnpm test:cloud`: tests against the deployed `Factory` stack (`*.cloud.test.ts`), with `AWS_PROFILE=vocab`; never in `pnpm check` or CI. The worker and build boundary tests spend under $0.20 of model budget together
- `pnpm infra:synth` / `pnpm infra:diff` / `pnpm infra:deploy`: the factory's CDK stack in eu-central-1, with `AWS_PROFILE=vocab`. Each needs `-c budgetEmail=<address>`, which is never committed. Ask the owner before every deploy. Run them through these scripts, not a bare `cdk`, so the webhook's esbuild bundling finds `infra`'s esbuild. A diff after any edit under `factory/` shows new images, since tests are in the image's build context
- `pnpm factory run --issue <n> --until proposal|design|plan|pr [--target <name>]`: runs the factory locally against an issue of the target's repository (pushes a change branch, comments on the issue; `pr` builds the tasks in the local `ceh-build-<name>:local` image and opens a pull request). It works on a clone under `~/.factory/targets/<name>/`, never on this checkout, and stops at every approval. `--target` may be left out while there is one target. Needs `gh auth login` and `CLAUDE_CODE_OAUTH_TOKEN` in the git-ignored `.env.local` (ADR 0006)
- `pnpm factory approve --issue <n>`: approves the proposal or design a local run stopped at
- `pnpm factory command --issue <n> --comment <id> [--target <name>]`: handles one owner comment on the issue as the cloud's `command` task does, against the local ledger: the same records and reply on the issue. A local `/approve` approves as `pnpm factory approve` does; a local run's `/abort` and `/resume` are answered with `pnpm factory run`, since it has no execution
- `pnpm factory cost --issue <n>`: the work item's tokens, auth mode and estimated cost per attempt and in total, from the local ledger only
- `pnpm exec openspec <cmd>`: the pinned OpenSpec CLI (`list`, `show <id>`, `validate <id> --strict`, `archive <id> --yes`)

## Repo map

- `openspec/`: specs (`specs/`), active changes (`changes/`), conventions (`config.yaml`)
- `docs/`: brief and ADRs
- `targets/<name>`: one folder per target repository: `target.yaml` (repository, owner, commands, writable paths per role, contracts path, budget) and `build.Dockerfile` (the target's toolchain on the build base). Factory roles never write it
- `factory/target`: the target config's schema and loader
- `factory/roles`: role configs (`*.yaml` + prompt, with `{target.…}` placeholders filled from the target) and the role runner on the Agent SDK
- `factory/artifacts`: zod schemas for role results
- `factory/ledger`: Postgres migrations, typed queries and the `LedgerRecorder`
- `factory/forge`: the `Forge` interface, `GitHubForge` and the test `FakeForge`
- `factory/orchestrator`: change ids, worktrees and git, the state handlers (Intake to Open PR, including `step`, which drives the build loop), the state machine definition, the local run loop
- `factory/gates`: the build gates (typecheck, lint, unit, red, spec, coverage), which run the target's commands, and `pnpm gates`
- `factory/cli`: the `pnpm factory` entry point (`src/main.ts`)
- `factory/worker`: the image (stages `worker`, `boundary-check` and `build-base`, on which each target's build image is assembled) and its entry points: `factory-worker`, which runs one state per task, and `factory-build`, which runs one test-author or implementer session or a gates-only run per task
- `infra`: the factory's CDK app (`bin/factory.ts`) and its one stack, `factory-stack.ts`: VPC with public subnets only, Aurora ledger, artifact bucket, worker, build and boundary-check task definitions, state machine, webhook Lambda, budget. The App's ids and slug are in `cdk.json` context; the repository and the owner come from the target. Factory roles never write it

## Cloud runs

- An issue labelled `factory` starts an execution of the `factory-work-item` state machine through the webhook. An issue comment counts only if it is the owner's and its first line is a command (`/<verb>`); the webhook ignores every other comment and posts no reply. Each owner command runs the `command` worker task (`factory-worker command --issue <n> --comment <id>`), which records the comment and replies once on the issue: `/approve` approves a proposal or a `large` design and resumes the paused execution. `/revise <text>` sends what awaits approval back to its author (the proposal author or the architect) with the comment; the author commits a revision on the branch head and the summary is posted again with "What changed". There are at most 5 revisions per stage. `/question <text>` is answered in the `command` task itself by a read-only session of that author (Read, Grep and Glob only, $0.30 and 10 turns per answer, at most 10 per stage), and the approval stays open. `/status` names the work item's state, tasks, attempts and cost so far. `/abort` stops a running work item: the execution, and its running ECS task, which a token task such as Plan would otherwise keep running. The work item becomes `aborted`, recording where it stopped. `/resume [guidance]` continues an `aborted` or `escalated` work item on an open issue in a new execution, `issue-<n>-resume-<comment id>`. Its Adopt state (`intake --resume`) enters where the work item stopped: nothing approved is asked for again, no finished task is built again, and the guidance goes to the next role. Resuming an escalated work item gives it fresh retries; aborted attempts never count. Closing the issue stops the work item as `/abort` does; reopen it and `/resume` to continue. A command sent while a role runs gets a busy reply and is not kept. Every state is a `factory-worker <state> --issue <n>` Fargate task, except Build: the build loop runs `step` in the worker and each session in a `factory-build` Fargate task (8 GB, only the API key, no ledger access). The run ends with a pull request opened by `ceh-app[bot]`; the owner reviews and merges it.
- Relabelling an issue that already has a work item ends in a `duplicate` Intake, which comments that `/resume` continues it.
- To follow a run (with `AWS_PROFILE=vocab AWS_REGION=eu-central-1`): `aws stepfunctions list-executions` and `get-execution-history` for the states, `aws logs tail` on the worker log group (one stream per task: `worker/worker/<task-id>` for worker states, `build/build/<task-id>` for build sessions; `--log-stream-name-prefix build/` follows only builds) and the webhook log group. The log group names are in the stack outputs.
- Each build attempt's evidence is in the artifact bucket (`ArtifactBucketName` output), under `work-items/<change-id>/tasks/<task-id>/<role>/<n>/`: `input.json`, `patch.diff`, `gates.json`, `messages.jsonl` and `outcome.json`; the task's `next.json` names the next build. Objects expire after 180 days.
- The ledger has no public address, so the laptop can't read it. `pnpm factory cost` doesn't work for cloud work items.
- Reading cloud cost:
  - **Per work item:** the summary comment's cost line (tokens, estimated USD, auth mode `api-key`), and the pull request's cost table per role.
  - **Model spend:** the Anthropic console, under the factory's workspace ($20 monthly limit).
  - **AWS spend:** Cost Explorer. The account is shared with other projects, so the $50 budget alarm (emails at 80% actual and 100% forecast) covers all of it. The stack tags its resources `project=ceh`, but that tag isn't activated as a cost allocation tag yet.
- Don't deploy while an execution is paused if you need it unchanged. Paused executions continue on the worker family's latest revision.

## Conventions

- Every change goes through an OpenSpec change (`openspec/changes/<verb-led-id>/`), scoped to one milestone and archived when it ships.
- Tests name the scenario they prove: `it("Scenario: <exact title>", …)`.
- TypeScript is strict and erasable-only (no enums, namespaces or parameter properties), so `node file.ts` runs it directly.
- Pin dependencies exactly (`--save-exact`); the Agent SDK and OpenSpec are upgraded deliberately.
- Record significant decisions as ADRs: `docs/adr/NNNN-title.md`.
- Never commit secrets.
