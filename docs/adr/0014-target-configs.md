# 0014 Target configs

Status: accepted (2026-11-15; owner decisions of 2026-11-14, brief section 7, M3.25 step 3)

## Context

After the split (ADR 0013) the factory lives in `ceh` and works on repositories it does not live in. Its first one is `miklospocsaji/vocab`. What it knew about that repository was spread over its own code:

- the role configs and prompts named `app/` paths and the `pnpm typecheck:app` and `pnpm lint:app` scripts
- the gates ran those scripts and the tests under `app/`
- the contracts path was a constant in the Design handler, and the pull request's base was `master`
- the repository and the owner were CDK context
- the proposal result's schema listed eight capabilities, three of them the factory's own

Writable paths are a security boundary: they decide what a session may change. A target's own work items must never be able to move them.

## Decision

- **A target is one file, in `ceh`:** `targets/<name>/target.yaml`, next to the target's `build.Dockerfile` (ADR 0010). It names:
  - the repository, its default branch, and the owner who may `/approve`
  - the install, typecheck, lint, unit and spec-validation commands, the unit test path and the coverage test directory
  - the contracts path, and the writable globs of the test author and the implementer
  - the per-work-item budget

  A target changes like a role config: through `ceh`, by the owner or a local Claude Code session.
- **`factory/target` loads it** (`@ceh/factory-target`), a package of its own, so the stack reads a target without the role runner. The loader refuses:
  - a command that is not plain words: commands run without a shell and become `Bash(...)` rules
  - a path or glob that is absolute, holds `..`, starts with a wildcard, or starts with `openspec`, `.git`, `.github` or `.claude`
  - a contracts path that a build role's globs match
- **Which target a process serves:**
  - the CLI: `--target`, or the only one
  - the worker: `FACTORY_TARGET`
  - the build: the target its input names, which must be its image's `FACTORY_TARGET`
  - the stack: the only target under `targets/`
- **Role files name no target.** Their `writable` and `allow` lists and their prompts hold `{target.…}` placeholders, which `loadRole(name, target)` fills. The deny list is checked against the filled-in rules, so a target cannot bring a denied command. A role's YAML still shows everything the role may do.
- **The architect's glob is derived** from the contracts path, which is also what the design commit takes.
- **Capabilities are the target's own.** The factory holds no list. The proposal author reads the names from the target's `openspec/config.yaml`, and Proposal fails an attempt whose result and delta specs disagree. The owner approves every proposal.
- **Sessions keep `settingSources: ["project"]`**, which is now the target's `.claude/` and `CLAUDE.md`: what a role should know about the repository it works on.
- **Work items are keyed by repository** in the ledger (ADR 0003, amendment of 2026-11-15).

## Alternatives

- **The config in the target's repository.** The target would own its writable paths, and one of its work items could widen them.
- **Lists merged into the roles by the loader, with no placeholders.** The role files would say nothing about what the target adds.
- **Capabilities listed in `target.yaml` and enforced by the schema.** Stricter, but the same list in two repositories, and a new capability would need a change in both.
- **Sessions with no settings source.** No hook of a target's could run in the worker, but roles would lose the target's `CLAUDE.md`.
- **The loader inside `factory/roles`.** One package fewer, but the stack would import the Agent SDK's package to read a YAML file.

## Consequences

- A second target is a folder under `targets/`, but not yet a running one. Still to design: routing a webhook to one of several targets, a build task definition per target, store keys and execution names that carry the repository, cost reporting per target.
- A target's `.claude/settings.json` is loaded by sessions in the worker, the task that holds the factory's secrets. No role can write `.claude/`, and only the owner merges to a target; a hook there must still be read as factory code. If someone else can ever merge to a target, sessions must stop loading it.
- An invented capability is caught by the owner at approval, not by the factory.
- The unit command must be a Vitest run: the gates add Vitest's reporter flags and read its JSON report.
- Two OpenSpec versions check a change: ceh's in the worker, the target's in the gates. Both are pinned.
- `cdk.json` keeps only the App's ids and slug.
