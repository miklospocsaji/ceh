# Proposal

## Why

Since the split (ADR 0013) the factory lives in `ceh` and its first workload in `miklospocsaji/vocab`, but the code still assumes one shared repository:

- The role configs and prompts name `app/` paths and the `pnpm typecheck:app` and `pnpm lint:app` scripts, which `vocab` no longer has.
- The gates run those scripts and the tests under `app/`.
- The local CLI works on the checkout it runs in and that checkout's `origin`, which is now `ceh`.
- The build image warms a pnpm store from the factory's lockfile, which no longer holds the app's dependencies.
- The ledger keys a work item by issue number and change id alone.

So no work item runs today. This change is step 3 of M3.25 (brief, section 7): it makes `ceh` work on a repository it does not live in, and carries the renames to `ceh`. It ships one target, `vocab`.

## What Changes

- **A target config:** `targets/<project>/target.yaml`, validated with zod, and `targets/vocab/target.yaml` as the first. It names:
  - the repository, its default branch and the owner who may `/approve`
  - the commands: install, typecheck, lint, unit (with its test path) and spec validation
  - the coverage test directory
  - the writable paths of the test author and the implementer, and the contracts path
  - the per-work-item budget

  A target is refused at load if a path leaves its repository, reaches `openspec/`, `.git/`, `.github/` or `.claude/`, or lets a build role write the contracts. A role is refused for a target whose command the runner's deny list covers.
- **Roles take the target's paths and commands.** The role YAMLs keep model, tools, turn cap and budget; their `writable` and `allow` lists hold placeholders (`{target.contracts}`, `{target.typecheck}`, …) that the loader fills from the target. The prompts use the same placeholders instead of naming `app/`. No file under `factory/roles/` names a target.
- **Gates run the target's commands**, without a shell, and coverage reads the target's test directory. **BREAKING** for `pnpm gates red|green`, which now needs `--target`.
- **Capabilities are the target's own.** The proposal result takes any kebab-case capability name instead of today's fixed list of eight, and the runner checks that the named capabilities are exactly the change's delta specs. The proposal author reads the allowed names from the target's `openspec/config.yaml`.
- **The local CLI works on a clone of the target.** `pnpm factory run|approve|cost` take `--target <name>`, which defaults to the only target. The clone and the worktrees live under the factory home, never in the checkout the CLI runs in.
- **A build image per target:** `targets/vocab/build.Dockerfile` starts from ceh's build base and adds only the target's toolchain. The warm pnpm store and the `--offline` install go: before each session the build runs the target's install command in the clone, online, with no credential in its environment, and records how long it took.
- **Work items keyed by repository:** migration `0004_repository.sql` adds `repository` to `work_items`, backfills `miklospocsaji/vocab`, and makes `(repository, issue_number)` and `(repository, change_id)` unique.
- **The worker and the build task serve a configured target** (`FACTORY_TARGET`). The repository, the owner, the pull request's base branch and the contracts path come from the target config, not from `cdk.json`, a hard-coded `master` or `app/contracts/src`.
- **Renames:**
  - the packages become `@ceh/*`, and the root package `ceh`
  - the App slug in `cdk.json` becomes `ceh-app` (the owner renamed the App on 2026-11-14; the bot is `ceh-app[bot]`), and the resource tag `project=ceh`
  - the fallback git identity, the local image tag and the role prompts stop naming `vocab`
  - the CDK stack keeps the name `Factory`

Out of scope:
- a second target, and what it needs: routing a webhook to one of several targets, a build task definition per target, store keys and execution names that carry the repository, cost reporting per target
- enforcing the per-work-item budget (M6); the value only moves into the target config
- a test runner other than Vitest: the unit command must accept Vitest's reporter flags
- a warm dependency store for the build image; the exit run measures the install first
- the deploy and exit run (M3.25 step 4), which follow as this change's last tasks
- owner comments and resuming work items (M3.5)

## Capabilities

### New Capabilities

### Modified Capabilities
- `roles`: target configs and their validation, roles resolved against a target, the target's build image and the install before each session, capabilities taken from the target.
- `gates`: the checks run the target's commands and read the target's test directory.
- `orchestration`: work items keyed by repository, the worker and the stack configured by a target, the local run on a clone of the target, the pull request's base branch.

## Impact

- `targets/vocab/`: new, `target.yaml` and `build.Dockerfile`.
- `factory/target`: a new package, `@ceh/factory-target`, with the schema, the loader and the placeholder values. `infra` reads the target through it too.
- `factory/roles`: `loadRole` takes a target; the role YAMLs and prompts hold placeholders.
- `factory/gates`: the checks take their commands as options; `pnpm gates` takes `--target`.
- `factory/artifacts`: the proposal result's capability list, `target` in the build input, `installMs` in the build outcome.
- `factory/ledger`: migration `0004_repository.sql`; the work-item queries take a repository.
- `factory/orchestrator`: handlers take the target (contracts path, base branch, repository).
- `factory/worker`: `FACTORY_TARGET`, the online install, the image split into a build base and a target image.
- `factory/cli`: `--target`, the clone under the factory home, the image tag `ceh-build-<target>:local`.
- `infra`: the stack reads the target config, builds the target's image, sets `FACTORY_TARGET` and the new tag. `cdk.json` loses `factory:githubRepository` and `factory:owner`.
- Every `@vocab/*` import becomes `@ceh/*` (77 files) and `pnpm-lock.yaml` is regenerated.
- Docs: ADR 0014 (target configs), amendments to ADR 0003 and ADR 0010, `CLAUDE.md`, the brief.
- The deploy changes the tag on every resource, in place. It must replace no stateful resource; the `infra:diff` is reviewed for that before the owner deploys.
- Running cost: each build session spends its install time online. The exit run measures it.
- Tagged `large`: three capabilities, a ledger migration, and writable paths, which are a security boundary.
