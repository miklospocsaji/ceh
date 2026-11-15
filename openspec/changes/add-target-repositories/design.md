# Design

## Overview

Everything the factory knows about a repository it works on moves into one validated file, `targets/<project>/target.yaml`. A `Target` is loaded once per process and passed down: to the role loader, which fills the roles' placeholders from it; to the gates, which run its commands; and to the handlers, which read its repository, default branch and contracts path. Nothing else in `factory/` names a target's path or script.

```
targets/vocab/target.yaml ──▶ loadTarget("vocab") ──▶ Target
                                                       ├─▶ loadRole(name, target)       writable, allow and prompt resolved
                                                       ├─▶ runGates({ …, commands })    typecheck, lint, unit, spec, coverage dir
                                                       ├─▶ handlers (ctx.target)        repository, defaultBranch, contracts
                                                       └─▶ infra (synth)                webhook repository and owner, FACTORY_TARGET, image
```

Which target a process serves:

| Process | Target comes from |
|---|---|
| `pnpm factory …` | `--target <name>`, or the only folder in `targets/` |
| `factory-worker` | `FACTORY_TARGET` in the task definition |
| `factory-build` | `target` in `input.json`; it must equal the image's `FACTORY_TARGET` |
| `cdk synth` | the only folder in `targets/`; several are an error until a second target is designed |
| webhook Lambda | its environment, set by the stack from the target at synth; it reads no file |

## Components

### Target config (`factory/target`, new package `@ceh/factory-target`)

A package of its own because `roles`, `worker`, `cli` and `infra` all read it, and `infra` should not pull in the role runner to read a YAML file. It depends on `zod`, `yaml` and `minimatch` only.

`targets/vocab/target.yaml`:

```yaml
name: vocab
repository: miklospocsaji/vocab
defaultBranch: master
# The only login whose /approve counts (ADR 0009).
owner: miklospocsaji
commands:
  install: pnpm install --frozen-lockfile
  typecheck: pnpm typecheck
  lint: pnpm lint
  unit: pnpm exec vitest run
  specValidate: pnpm exec openspec validate {changeId} --strict --no-interactive
# Appended to the unit command by the gates.
unitTestPath: app/
coverageTestsDir: app
contracts: app/contracts/src
writable:
  test-author:
    - app/*/test/**
    - app/e2e/**
  implementer:
    - app/*/src/**
    - "!app/contracts/**"
    - infra/app-stack.ts
    - infra/preview-stack.ts
    - infra/app/**
budgetUsd: 5
```

The schema is a `z.strictObject`. Beyond field types, `loadTarget` refuses:

- a `name` that differs from its folder
- a command that is not words separated by single spaces, each of `[A-Za-z0-9@%+=:,./_{}-]`. Commands run without a shell (the gates) or become a `Bash(...)` rule (the roles), so quotes and metacharacters have no meaning and are refused
- `{changeId}` anywhere but in `specValidate`
- a path or glob that is absolute, holds `..`, or whose first segment is a wildcard or one of `openspec`, `.git`, `.github`, `.claude`
- a `contracts` path that the `test-author` or `implementer` globs match
- a `writable` key that is not a role with `{target.writable}` in its config (checked by the role loader, which knows the roles)

Exports: `TargetSchema`, `type Target`, `loadTarget(name, { root? })`, `listTargets({ root? })`, `onlyTarget({ root? })` and `TargetConfigError` (target and field, like `RoleConfigError`).

### Roles (`factory/roles`)

`loadRole(name, target, { root? })` resolves a role for a target. Placeholders, in the YAMLs and the prompts:

| Placeholder | Value |
|---|---|
| `{target.name}`, `{target.repository}` | as in the config |
| `{target.contracts}` | the contracts path |
| `{target.typecheck}`, `{target.lint}`, `{target.unit}` | the command strings |
| `{target.writable}` | YAML only, as a whole `writable` entry: replaced by the role's globs from the target, or dropped if it has none |
| `{target.writable.<role>}` | prompts only: that role's globs as comma-separated code spans |

The role files after the change:

```yaml
# architect.yaml
writable:
  - openspec/changes/{changeId}/design.md
  - "{target.contracts}/**"

# implementer.yaml (test-author.yaml alike, plus "{taskStubs}")
allow:
  - Read
  - Grep
  - Glob
  - Edit
  - Write
  - Bash({target.typecheck})
  - Bash({target.lint})
  - Bash({target.unit}:*)
  - Bash(git status:*)
  - Bash(git diff:*)
writable:
  - "{target.writable}"
```

- Resolution happens before `RoleConfigSchema`'s checks, so the deny-list overlap check runs on the resolved rules. A target whose typecheck is `npm run typecheck` fails the load of the build roles, naming the rule and `npm`.
- A `{target.…}` left after resolution is a `RoleConfigError` naming the placeholder.
- `{changeId}` and `{taskStubs}` stay as they are, filled per work item by `writableFor`.
- The prompts say "ceh" instead of "the Kindle Vocab Software Factory", name the commands and paths through placeholders, and keep the stub conventions that are TypeScript's, not vocab's. The proposal author's prompt takes its capability list from the target's `openspec/config.yaml`.
- `validatePlan`'s `PlanPaths` are the resolved globs of the two build roles, as today.

### Capabilities (`factory/artifacts`, `factory/orchestrator/src/proposal.ts`)

`ProposalResult.capabilities` becomes an array of kebab-case names; the `CAPABILITIES` list goes. Proposal then checks the result against the change: the names must be exactly the folders under `openspec/changes/<id>/specs/`. A mismatch fails the attempt with reason `invalid-result` and evidence naming the capability, so it is retried like a failed validation.

### Gates (`factory/gates`)

`RunGatesOptions` gains `commands: { typecheck, lint, unit, unitTestPath, specValidate }` and `coverageTestsDir`. `checks.ts` splits a command on spaces and spawns it without a shell, as today.

- `unit` runs `<unit> --reporter=default --reporter=json --outputFile.json=<file> <unitTestPath>`. The report parser reads Vitest's JSON, so the unit command must be a Vitest run. `--project unit` goes: it was this repository's project name.
- `spec` runs `specValidate` with `{changeId}` filled, in the worktree, so it is the target's own pinned OpenSpec. The worker's role runner still validates with ceh's.
- `pnpm gates red|green` take `--target <name>`. `pnpm gates coverage --change <id> --tests <dir>` is unchanged; ceh uses it for its own changes.
- The fixtures under `factory/gates/test/fixtures/` keep their `app/` layout as an example target; the tests pass the commands in. The `factory-broken` fixture goes with its requirement.

### Ledger (`0004_repository.sql`)

```sql
ALTER TABLE work_items ADD COLUMN repository text;
UPDATE work_items SET repository = 'miklospocsaji/vocab';
ALTER TABLE work_items ALTER COLUMN repository SET NOT NULL;
ALTER TABLE work_items DROP CONSTRAINT work_items_issue_number_key;
ALTER TABLE work_items DROP CONSTRAINT work_items_change_id_key;
ALTER TABLE work_items ADD CONSTRAINT work_items_repository_issue_number_key UNIQUE (repository, issue_number);
ALTER TABLE work_items ADD CONSTRAINT work_items_repository_change_id_key UNIQUE (repository, change_id);
```

`createWorkItem`, `findWorkItemByIssue` and `findWorkItemByChangeId` take the repository. `WorkItemRow` gains `repository`. Every caller passes `ctx.target.repository`.

### Handlers (`factory/orchestrator`)

- `HandlerContext` gains `target: Target`.
- `design.ts`: `CONTRACTS` becomes `ctx.target.contracts`.
- `open-pr.ts`: the base is `ctx.target.defaultBranch`; the `base` option goes.
- `step.ts`: writes `target: ctx.target.name` into `input.json`.
- `git.ts`: `FACTORY_GIT_IDENTITY` becomes `ceh <factory@ceh.invalid>`. It is the fallback for local runs; cloud commits are the App's bot.
- The state machine and the webhook do not change. Executions still carry only the issue number.

### Worker and build (`factory/worker`)

- `workerConfig` reads `FACTORY_TARGET` and loads the target; `FACTORY_GITHUB_REPOSITORY` goes from the worker's environment. A missing or unknown target is a `WorkerConfigError`, so exit 2.
- `BuildInput` gains `target`. `runBuild` loads it, and refuses (exit 2) an input whose target differs from `FACTORY_TARGET`.
- `install()` runs the target's install command in the clone with `toolEnv` (no credential), online. `FACTORY_PNPM_STORE`, `--offline` and the fallback log line go. The time goes to the log and to `outcome.json` as `installMs`.
- A failed install throws, as today: exit 1 with no outcome, which the state machine retries and `step` records as `no-outcome`.

### Images (`factory/worker/Dockerfile`, `targets/vocab/build.Dockerfile`)

The worker Dockerfile's `build` stage is renamed `build-base` and loses the warm store. The `.dockerignore` allowlist gains `!targets/`, so both images hold the target configs.

```dockerfile
# targets/vocab/build.Dockerfile
# vocab's toolchain on top of ceh's build base. No project dependencies: the build installs them.
FROM build-base AS target-build
ENV FACTORY_TARGET=vocab
```

`vocab` needs nothing more today; a target that does switches to root, installs and switches back to `factory`.

**How the target image is built** (the question the brief left to this design): the build Dockerfile is assembled, the worker Dockerfile followed by the target's, so `FROM build-base` names the stage above it and one `docker build --target target-build` makes the image.

- `assembleBuildDockerfile(target)` in `factory/worker/src/image.ts` writes `.build/<name>.Dockerfile` and a copy of the worker's `.dockerignore` next to it. `.build/` is git-ignored.
- `infra` calls it at synth and points a `DockerImageAsset` at the file, with the same `exclude` list as the worker image.
- `pnpm image:build --target <name>` calls it and builds `ceh-build-<name>:local`, for local runs and the Docker tests.
- The target Dockerfile also builds on its own against a pre-built base, with `--build-context build-base=docker-image://<base>`.

| Option | Why not |
|---|---|
| Two image assets, the target `FROM` the base asset | CDK publishes assets with no order between them, and the base's URI is a token at synth, so the target cannot name it |
| Named build context in CDK (`buildContexts`) | A named context is a directory, a URL or an existing image, never a stage of another Dockerfile, so the base must be built first: the same ordering problem |
| Assembled Dockerfile (chosen) | One build, no order, the same locally and in CDK. Cost: a generated file |

Spike result (task 0.1, 2026-11-14): the assembled file builds its `target-build` stage with one `docker build` (Docker 29.9, 1 min 49 s cold), running as `factory` with `FACTORY_TARGET` set. A `DockerImageAsset` with `file: ".build/<name>.Dockerfile"` synthesises, and its staged context holds no `.env*`. One finding: under the allowlist's leading `*`, CDK's own force-include of the Dockerfile does not reach a file in a subfolder, so the asset's `exclude` list ends with `!.build/<name>.Dockerfile`. The image CDK builds therefore also holds that one generated file under `/app/.build/`.

### Local CLI (`factory/cli`)

- `run`, `approve` and `cost` take `--target <name>`; without it, the only target. Several targets and no flag is a usage error (exit 2), as is an unknown name.
- Per target, under the factory home: `targets/<name>/repo` (the clone), `targets/<name>/worktrees/`, `targets/<name>/store/`. The handlers already take a `home`, so the CLI passes `<factory home>/targets/<name>`.
- The clone is made with `forge.clone` (the owner's `gh` token through the credential helper, never stored) if it is missing, and fetched otherwise. `github-remote.ts` and its test go: the repository comes from the target.
- `.env.local` is still read from the `ceh` checkout.
- The build runner's image is `ceh-build-<name>:local`.
- Worktrees in `~/.factory/worktrees/` from before the split belong to the old checkout and are not migrated; the old work items are refiled (brief, M3.25 step 1).

### Stack (`infra`)

- `bin/factory.ts` loads the only target and passes it as a prop. `cdk.json` keeps `factory:githubAppId`, `factory:githubAppInstallationId` and `factory:githubAppSlug` (now `ceh-app`).
- The webhook's `FACTORY_GITHUB_REPOSITORY` and `FACTORY_OWNER` come from the target.
- The worker, the boundary check and the build task get `FACTORY_TARGET`; the worker loses `FACTORY_GITHUB_REPOSITORY`.
- The build task's image is the target's; the build boundary check follows it.
- `Tags.of(this).add("project", "ceh")`. The stack id stays `Factory`, and so do the state machine's name and the `/factory/*` parameters.

### Results (task 8.5, 2026-11-15)

- `pnpm check`: green, 715 unit tests in 54 files, typecheck, lint and strict validation.
- Scenario coverage: every scenario of the change has a test. `--tests factory` finds all but the two stack scenarios, which `--tests infra` finds.
- `pnpm test:docker`: green, 11 tests: the worker image and vocab's build image, built from the assembled Dockerfile. The worker image refuses to run with no `FACTORY_TARGET` or an unknown one (exit 2), and the build image refuses an input for another target.
- `pnpm infra:synth` with a placeholder budget address: synthesises 49 resources and three image assets (`factory/worker/Dockerfile`, its `boundary-check` stage, and `.build/vocab.Dockerfile` at `target-build`). No AWS call was made.
- Found on the way: the Docker test "refuses an unknown state" named `design`, which became a real state in M3, so it had failed since then. It now names `deploy`.
- Not run yet: `pnpm test:live` and a local `pnpm factory run` against a `vocab` issue. Both spend model budget and the second writes to GitHub, so they wait for the owner. `build-e2e.live.test.ts` now clones `miklospocsaji/vocab` from GitHub in place of this repository.

## Decisions

- **Placeholders in the role files, not lists merged in by the loader.** A role's YAML still shows everything the role may do; what is the target's is marked as such.
- **The architect's glob is derived from `contracts`.** One source for the path the design commit takes and the path the architect may write.
- **The build roles' globs are listed per role in the target.** They are the security boundary, so they are written out, exclusions included, not derived from "source" and "test" paths.
- **Commands are plain words, never shell.** The same string is spawned by the gates and matched as a permission rule.
- **Capabilities are not listed in `ceh`.** They are the target's own decision (brief, section 8), stated in its `openspec/config.yaml`. The deterministic check is that result and delta specs agree; the owner approves every proposal.
- **Sessions keep `settingSources: ["project"]`**, which is now the target's `.claude/`: its `CLAUDE.md` and skills are what a role should know about the target. No role can write there.
- **The store and the executions stay keyed as they are** (`work-items/<change-id>/`, `issue-<n>-…`). Only the ledger's key changes, as the brief asks; the rest waits for a second target.
- **`FACTORY_*` variables, the `factory-worker` and `factory-build` commands, the state machine name and the parameter paths keep their names.** "Factory" is still what ceh is; only `vocab` leaves the names.

## Risks

- **The App slug.** `appCommitter` looks up `<slug>[bot]`, so `cdk.json` and the App's real name must agree. The owner renamed the App to `ceh-app` on 2026-11-14, so the deployed stack, which still says `vocab-factory`, cannot commit until step 4's deploy. No work item runs before then.
- **The target's `.claude/settings.json` is loaded by worker sessions**, in the task that holds the factory's secrets. Only the owner merges to a target, and no role can write `.claude/`; a hook there is still code the owner must read as factory code.
- **The install runs dependency scripts** in the build container before the session. Its environment holds no credential, but the task's does, as for any code run there (ADR 0011, accepted).
- **The install needs the registry.** A registry outage fails builds as `no-outcome`, retried and then escalated as infrastructure.
- **Two OpenSpec versions**, ceh's in the worker and the target's in the gates, can disagree on a change. Both are pinned; a disagreement shows as a green-gate `spec` failure.
- **The migration's backfill** assumes every existing row is vocab's, which holds in the cloud ledger and in the owner's local one.
- **The tag change touches every resource.** Task 9.2 reviews the diff for replacements before any deploy.

## Contracts

Changed zod schemas in `factory/artifacts`: `ProposalResult.capabilities` (any kebab-case name), `BuildOutcome.installMs` (optional). `BuildInput` in `factory/worker` gains `target`. New: `TargetSchema` in `factory/target`.

## Decisions that need an ADR

- **ADR 0014, target configs:** what a target is, why it lives in `ceh`, placeholders in the role files, commands as plain words, capabilities left to the target, project settings loaded from the target.
- **ADR 0010, amendment:** the build base and the image per target, the assembled Dockerfile, the online install in place of the warm store.
- **ADR 0003, amendment:** work items keyed by repository.

## Open questions

None. Settled by the owner on 2026-11-14:

1. **The App's name:** the owner renamed the App to `ceh-app`; the bot is `ceh-app[bot]`. The brief's `ceh[bot]` is corrected in task 8.4.
2. **Capabilities** are read from the target's `openspec/config.yaml` and checked only against the delta specs, not listed in `target.yaml`.
3. **The target's `.claude/`** stays loaded as project settings.
4. **The target config's code** is a package of its own, `factory/target`.

`AWS_PROFILE=vocab` in `CLAUDE.md` is the owner's local profile name and stays.

## Owner prerequisites

- Before task 9.3 (the deploy): confirm each outward step (deploy, the exit-run issue). The App is already renamed.
