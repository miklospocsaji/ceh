# Tasks

M3.25 step 3, and step 4 as the last section. Built by a local Claude Code session in `ceh`; no factory role changes the factory. Unit tests run in `pnpm check` with `FakeForge`, fake SDK sessions, an `FsStore` and the real local ledger (`pnpm db:up`). `pnpm check` is green after every task that writes code. Every deploy, AWS write and GitHub write is confirmed with the owner first.

Scenarios carried unchanged inside MODIFIED requirements keep their existing tests and are not listed below: Expiring token is refreshed, Token failures do not leak the token, Commits are authored by the factory's bot, Pull request is opened once, Pull request says what its cost means, Boundaries hold in the worker container, Architect output is complete, Coverage checks only the given scenarios. They must still pass, and the coverage run of task 8.5 checks them.

## 0. Before building

- [x] 0.1 Spike, thrown away afterwards: assemble the worker Dockerfile and a two-line target Dockerfile into one file, build its `target-build` stage with `docker build`, and synthesise a `DockerImageAsset` that points at it with the worker's exclude list. Confirm the staged context holds no `.env*`. Record the result in `design.md` under "Images"; if it fails, stop and settle the fallback with the owner.
- [x] 0.2 Owner: name the GitHub App. Done 2026-11-14: renamed to `ceh-app`, so the slug in `cdk.json` is `ceh-app`. No scenario.

## 1. Renames

- [x] 1.1 Rename the packages to `@ceh/*` and the root package to `ceh`: every `package.json`, every import, the Dockerfile's `--filter` arguments, and a regenerated `pnpm-lock.yaml`. No scenario; `pnpm check` stays green.
- [x] 1.2 Rename what else names `vocab` in the factory's own identity: `FACTORY_GIT_IDENTITY` (`ceh <factory@ceh.invalid>`), the local image tag, comments and test data that say "vocab-factory" as the factory's name. Test data that is the workload's (issue titles, `vocab.db`, `miklospocsaji/vocab`) stays. No scenario.

## 2. Target config

- [x] 2.1 Create the package `factory/target` (`@ceh/factory-target`) with failing tests for `TargetSchema`, `loadTarget`, `listTargets` and `onlyTarget`, against fixture targets in a temp root. Scenarios:
  - Invalid target config is refused
  - Target path outside its repository is refused
  - Contracts writable by a build role are refused
- [x] 2.2 Write the schema, the loader and `TargetConfigError`.
- [x] 2.3 Write `targets/vocab/target.yaml` and a first `targets/vocab/build.Dockerfile`, with a failing repository check first. Scenario: Every target in the repository loads.

## 3. Roles

- [x] 3.1 Failing tests for `loadRole(name, { target })`. Scenarios:
  - Role is resolved for its target
  - Unknown placeholder is refused
  - Build roles run only the target's commands
  - Target command on the deny list is refused
  - Three attempts stay within the work-item limit
- [x] 3.2 Write the placeholder resolution in `factory/roles/src/config.ts`, and move the role YAMLs to placeholders. Update every caller and test of `loadRole` to pass a target; tests that need no real target use a shared test target (`@ceh/factory-target/testing`).
- [x] 3.3 Failing repository check, then rewrite the seven prompts: "ceh" as the factory's name, the target's commands and paths as placeholders, the proposal author's capabilities from the target's `openspec/config.yaml`. Scenario: Role files name no target.
- [x] 3.4 Re-point the guard and diff-check tests at roles resolved for the `vocab` target. Scenarios:
  - Test author cannot change existing code
  - Implementer cannot edit a test
- [x] 3.5 Failing tests, then the code: `ProposalResult.capabilities` takes kebab-case names, and Proposal checks them against the change's delta specs. Scenario: Capability without a delta spec fails the attempt.

## 4. Gates

- [x] 4.1 Failing tests with stand-in commands that record their arguments, in a copy of the `workspace` fixture. Scenarios:
  - Gates run the target's commands
  - Spec check names the change
  - Gates run without a ledger
  - Scenario without a test fails coverage
- [x] 4.2 Write it: `RunGatesOptions.commands` and `coverageTestsDir`, `checks.ts` spawning the given commands, `pnpm gates red|green --target <name>`. Remove the `factory-broken` fixture and the test of the removed requirement.

## 5. Ledger and handlers

- [x] 5.1 Failing tests against the local Postgres for migration 0004 and the queries that take a repository. Scenarios:
  - Existing work items are backfilled
  - Second work item for the same issue is refused
- [x] 5.2 Write `factory/ledger/migrations/0004_repository.sql` and the queries.
- [x] 5.3 Failing handler tests with `target` in the context. Scenarios:
  - Two repositories can hold the same issue number
  - Pull request targets the default branch
  - Design that adds contracts is committed as a feature (a target whose contracts path is not `app/contracts/src`)
- [x] 5.4 Write it: `HandlerContext.target`; Intake, the approvals and the run loop find work items by repository; `design.ts` and `open-pr.ts` read the target; `step` writes the target into the build input.

## 6. Worker and build

- [x] 6.1 Failing tests for the worker's configuration and wiring. Scenarios:
  - Worker without a target is refused
  - Worker works on its target's repository
  - Installation token is scoped to the repository
- [x] 6.2 Write it: `FACTORY_TARGET` in `workerConfig`, the target passed to the handlers and to `loadRole`, `FACTORY_GITHUB_REPOSITORY` removed from the worker.
- [x] 6.3 Failing tests for `runBuild`. Scenarios:
  - Input for another target is refused
  - Install runs before the session
- [x] 6.4 Write it: `target` in `BuildInput`, the target's install command in place of the offline install, `installMs` in `BuildOutcome`, the gates called with the target's commands.

## 7. Local CLI

- [x] 7.1 Failing tests for the CLI with a `FakeForge` and a local bare repository as the target's remote. Scenarios:
  - Local run works on a clone of the target
  - Ambiguous or unknown target is a usage error
- [x] 7.2 Write it: `--target`, the per-target home, the clone made or fetched through the Forge, the image `ceh-build-<target>:local`. Remove `github-remote.ts` and its test.

## 8. Images, stack and documents

- [x] 8.1 Rename the Dockerfile's `build` stage to `build-base` and drop the warm store; add `!targets/` to the allowlist; write `assembleBuildDockerfile` and `pnpm image:build --target <name>`, with unit tests for the assembled text. Update the Docker and live tests to build the `vocab` image. Scenarios (`pnpm test:docker`):
  - Target image adds only its toolchain
  - Worker image holds no secrets
- [x] 8.2 Failing stack tests, then the stack: the target as a prop, the webhook's repository and owner, `FACTORY_TARGET`, the target's image asset, the tag, `cdk.json` without `factory:githubRepository` and `factory:owner` and with the slug `ceh-app`. Scenarios:
  - Stack settings come from the target config
  - Stack is tagged for ceh
- [x] 8.3 Write ADR 0014 (target configs) and the amendments to ADR 0003 and ADR 0010.
- [x] 8.4 Update `CLAUDE.md` (commands, repo map, the bot's name, the image tag, no "no work item runs" note), `openspec/config.yaml` if a convention changed, and the brief (sections 4 and 5 where they describe what this change built differently, and `ceh-app[bot]` where M3.25 says `ceh[bot]`).
- [x] 8.5 Run `pnpm check`, `pnpm gates coverage --change add-target-repositories --tests factory` and `--tests infra`, `pnpm test:docker`, and `pnpm test:live` (the boundary tests, and one local `pnpm factory run --until proposal` against a throwaway `vocab` issue the owner agrees to). Record the results in `design.md`.
  - Done 2026-11-15: `pnpm check`, both coverage runs and `pnpm test:docker`, recorded in `design.md` ("Results").
  - Done 2026-11-15: the local run against `vocab` issue #19, recorded in `design.md` ("Results").
  - Done 2026-11-15: `pnpm test:live`, after moving the role live tests' vocab files into a fixture; recorded in `design.md` ("Results").

## 9. Step 4: deploy and exit run

- [x] 9.1 Owner: rename the GitHub App. Done 2026-11-14 (`ceh-app`).
- [x] 9.2 Run `pnpm infra:diff`. It must show the new images, the tag on every resource, the App slug and the new task environment, and no replacement of the ledger, the bucket or any other stateful resource. Show the diff to the owner.
- [x] 9.3 Owner confirms; `pnpm infra:deploy`. The first worker task applies migration 0004.
- [x] 9.4 Run `pnpm test:cloud`. Scenarios carried from earlier changes: Boundaries hold in Fargate, Build boundaries hold in Fargate.
- [x] 9.5 Exit run: the owner files a fresh small `vocab` issue and labels it `factory`. Follow it to a pull request opened by the renamed bot, with every task built in vocab's build image and its gates green. Record each session's `installMs`, the cost and the wall time in `design.md`.
- [x] 9.6 Tick M3.25 in the brief, update `CLAUDE.md`, and archive this change (`pnpm exec openspec archive add-target-repositories --yes`).
