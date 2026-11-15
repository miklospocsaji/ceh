## ADDED Requirements

### Requirement: Targets are defined by validated config
Each repository the factory works on SHALL be defined by `targets/<name>/target.yaml`, which names its repository, default branch and owner, its commands, test paths and contracts path, the writable globs of its build roles, and its per-work-item budget. The loader SHALL refuse a config that fails its schema, with an error naming the target and the field. A command SHALL be plain words separated by spaces, with no quoting and no shell syntax.

#### Scenario: Invalid target config is refused
- **WHEN** a target config lacks its repository, or its typecheck command holds `&&`
- **THEN** loading the target fails before any role is loaded, with an error naming the target and the invalid field

#### Scenario: Every target in the repository loads
- **WHEN** the repository is checked
- **THEN** every folder under `targets/` holds a `target.yaml` that loads, a `build.Dockerfile`, and a name equal to its folder's

### Requirement: Target paths stay inside the target's own code
A path or glob in a target config SHALL be relative, SHALL NOT hold `..`, and SHALL NOT start with a wildcard or with `openspec`, `.git`, `.github` or `.claude`. The contracts path SHALL NOT be writable by the test author or the implementer. The loader SHALL refuse a target that breaks either rule.

#### Scenario: Target path outside its repository is refused
- **WHEN** a target's implementer globs hold `../other/**`, `/etc/**`, `**/*.ts`, `.claude/**` or `openspec/**`
- **THEN** loading the target fails, and the error names the target and the glob

#### Scenario: Contracts writable by a build role are refused
- **WHEN** a target's contracts path is `app/contracts/src` and its implementer globs hold `app/*/src/**` with no exclusion of the contracts
- **THEN** loading the target fails, and the error names the contracts path and the implementer

### Requirement: Roles take their paths and commands from the target
The runner SHALL load a role for a target, filling the role config's and the prompt's `{target.…}` placeholders from the target config: the contracts path, the typecheck, lint and unit commands, and the role's writable globs. A placeholder the target cannot fill SHALL fail the load with an error naming the role and the placeholder. No file under `factory/roles/` SHALL name a path, a script or the name of a target.

#### Scenario: Role is resolved for its target
- **WHEN** the implementer and the architect are loaded for the `vocab` target
- **THEN** the implementer's writable globs are the target's implementer globs, the architect's are the change's `design.md` and `app/contracts/src/**`, and neither prompt holds a `{target.` placeholder

#### Scenario: Unknown placeholder is refused
- **WHEN** a role config or prompt holds `{target.deploy}`
- **THEN** loading the role fails, and the error names the role and `{target.deploy}`

#### Scenario: Role files name no target
- **WHEN** the repository is checked
- **THEN** no role config or prompt under `factory/roles/` contains `app/`, `:app` or `vocab`

### Requirement: Build roles run only the target's commands
The Bash allowlist of the test author and the implementer SHALL hold the target's typecheck command, its lint command, its unit command with any arguments, `git status` and `git diff`, and no other command. Their prompts SHALL name the target's commands. A target command that the runner's deny list covers SHALL fail the load of the role.

#### Scenario: Build roles run only the target's commands
- **WHEN** the test author's and the implementer's configs are loaded for a target whose commands are `pnpm typecheck`, `pnpm lint` and `pnpm exec vitest run`
- **THEN** their Bash rules are exactly `Bash(pnpm typecheck)`, `Bash(pnpm lint)`, `Bash(pnpm exec vitest run:*)`, `Bash(git status:*)` and `Bash(git diff:*)`, and their prompts name those three commands

#### Scenario: Target command on the deny list is refused
- **WHEN** the implementer is loaded for a target whose typecheck command is `npm run typecheck`
- **THEN** loading fails, and the error names the role, the rule and the denied command `npm`

### Requirement: Each target has its own build image
A target's build image SHALL be built from `targets/<name>/build.Dockerfile` on top of the factory's build base, and SHALL add only the target's toolchain. It SHALL hold no dependency store and none of the target's dependencies or code. It SHALL name its target in `FACTORY_TARGET`, and `factory-build` SHALL refuse an input for any other target.

#### Scenario: Target image adds only its toolchain
- **WHEN** the `vocab` build image is built
- **THEN** it runs `factory-build` as the non-root factory user, sets `FACTORY_TARGET=vocab`, holds `targets/vocab/target.yaml`, and holds no pnpm store and no `node_modules` outside the factory's own code

#### Scenario: Input for another target is refused
- **WHEN** `factory-build` starts with `FACTORY_TARGET=vocab` and an input whose target is `other`
- **THEN** it exits 2 before cloning, and its output names both targets

### Requirement: Dependencies are installed before each build session
Before a build session or a gates-only run, `factory-build` SHALL run the target's install command in the clone, with an environment that holds no credential, and SHALL record the install's duration in the attempt's `outcome.json`.

#### Scenario: Install runs before the session
- **WHEN** `factory-build` runs the test author for a target whose install command is `pnpm install --frozen-lockfile`
- **THEN** that command ran in the clone before the session started, its environment held neither the model credential nor any factory credential, and `outcome.json` holds the install's duration in milliseconds

### Requirement: Capabilities are the target's own
The proposal result's capabilities SHALL be kebab-case names, not a list fixed in the factory. The runner SHALL fail a proposal attempt whose result names a capability with no delta spec in the change, or leaves out one that has, with evidence naming the capability.

#### Scenario: Capability without a delta spec fails the attempt
- **WHEN** the proposal author's result names `practice` and `trajectories`, and the change holds a delta spec for `practice` only
- **THEN** the attempt fails with reason `invalid-result`, and its evidence names `trajectories`

## MODIFIED Requirements

### Requirement: Proposal attempts fit the work-item budget
The proposal author's per-attempt budget multiplied by the maximum number of Proposal attempts SHALL NOT exceed the target's per-work-item budget.

#### Scenario: Three attempts stay within the work-item limit
- **WHEN** the proposal author's config is loaded for each target
- **THEN** its `maxBudgetUsd` times the maximum number of Proposal attempts is at most the target's `budgetUsd`

### Requirement: Roles run in the factory worker image
One container image, `factory-worker`, SHALL be able to run any role with `runsIn: worker`. Its `build-base` target, and every target's build image on top of it, SHALL be able to run any role. All SHALL contain the factory's code at the commit they were built from, the target configs, the pinned Agent SDK and OpenSpec CLI, and git. They SHALL run as a non-root user, and SHALL contain no secrets and no personal data. The role boundaries SHALL hold inside them, in a container started with no added capabilities and the default seccomp profile.

#### Scenario: Worker image holds no secrets
- **WHEN** the `factory-worker` image, or a target's build image, is built from a checkout that contains `.env.local` and `docs/vocab.db`
- **THEN** the image contains neither file, has no `.git` directory, and its default user is not root

#### Scenario: Boundaries hold in the worker container
- **WHEN** the boundary tests ("Write outside the allowed paths is denied", "Reading a process environment is denied", "WebFetch outside GitHub is denied", "Proposal author cannot run commands") run inside a `factory-worker` container with no added capabilities
- **THEN** they pass

### Requirement: Architect writes the design only
The architect SHALL write only the change's `design.md` and files under the target's contracts path. Its result SHALL list a summary, the contract files it changed and the decisions that need an ADR.

#### Scenario: Architect output is complete
- **WHEN** the architect completes successfully for an approved change
- **THEN** the change folder contains `design.md`, the change passes strict validation, and the result parses with the design result schema

### Requirement: Test author writes tests and stubs only
The test author SHALL write only files matching the target's test-author globs, and new files among its task's source files, as stubs. It SHALL NOT change a source file that existed when its session started.

#### Scenario: Test author cannot change existing code
- **WHEN** the test author, working on the `vocab` target, edits an existing file under `app/domain/src/`
- **THEN** the call is denied, or the attempt fails with reason `diff-check` if the change was made through Bash

### Requirement: Implementer never edits tests
The implementer SHALL write only files matching the target's implementer globs, which never include the target's contracts path. It SHALL NOT write tests, contracts, `tasks.md` or any other file of the change.

#### Scenario: Implementer cannot edit a test
- **WHEN** the implementer, working on the `vocab` target, writes to a file under `app/domain/test/`
- **THEN** the call is denied with a reason naming the allowed paths, and the file is unchanged

## REMOVED Requirements

### Requirement: Build roles check only the app
**Reason**: The factory no longer shares a repository with the app, so there is no whole-repository typecheck or lint to keep the build roles away from, and no `typecheck:app` or `lint:app` script.
**Migration**: "Build roles run only the target's commands" replaces it: the allowlist is built from the target's `target.yaml`.
