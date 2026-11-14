# 0013 The factory in its own repository

Status: accepted (2026-11-14; owner decision of 2026-11-14, brief section 7, M3.25)

## Context

Until M3 the factory and its first workload, the Kindle vocabulary app, shared the repository `miklospocsaji/vocab`. They also shared one `openspec/` folder, gates, CI, branch protection and history:

- App roles saw factory specs as context, and an app change could carry deltas to a factory capability.
- Every app task's gates ran the factory's tests, and the build image held the factory's source.
- Nothing in the factory could serve a second project.

## Decision

- The factory is **ceh** (Hungarian *céh*, "guild"), in the public repository `miklospocsaji/ceh`. The app stays in `vocab`, with its issues.
- `ceh` was made from a clone of `vocab` with `git filter-repo`, keeping these paths and their history:
  - `factory/`, `infra/`, `.claude/`, `.github/`, `docker-compose.yml`
  - the root manifests and configs: `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.json`, `tsconfig.base.json`, `eslint.config.js`, `vitest.config.ts`, `vitest.live-setup.ts`, `.nvmrc`, `.gitignore`
  - `CLAUDE.md`, `docs/brief.md`, and ADRs 0001–0004 and 0006–0012
  - `openspec/config.yaml`, the `orchestration`, `roles` and `gates` specs, and the changes `add-monorepo-foundations`, `add-role-runner`, `add-local-proposal-run`, `add-cloud-proposal-run`, `add-factory-worker`, `add-build-gates`, `add-build-roles` and `add-build-loop`, both active and archived
- `vocab`'s history is not rewritten. It is tagged `pre-split`, and the factory was removed there in one ordinary pull request.
- Documents are split, never duplicated. Each repository describes only itself: `vocab` knows nothing about `ceh`, and everything `ceh` knows about `vocab` lives in `ceh`.
  - The brief stays here without the app's section; `vocab` has a product brief.
  - ADRs keep their numbers, with gaps. ADR 0005 (fixture anonymisation) is `vocab`'s. ADRs 0001 and 0004 are split by content. Later ADRs number on independently in each repository.
- The split is a repository operation by the owner and a local Claude Code session, not an OpenSpec change: the removed specs would need a REMOVED delta for every requirement. Everything after it goes through an OpenSpec change here.
- `ceh` keeps the layout it had (`factory/*`, `infra/`, `openspec/`, `docs/`). Only `targets/` is new, added by the change that makes the factory target-aware.
- Renames wait for that change: the packages are still `@vocab/*` and the GitHub App is still `vocab-factory` right after the split. The CDK stack keeps the name `Factory` for good, because renaming it would replace the ledger.

## Alternatives

- **Stay in one repository, with separate OpenSpec folders and CI jobs.** Less work now, but the build image, the gates and branch protection stay shared, and a second target has nowhere to go.
- **Start `ceh` from a fresh commit.** Simpler than filtering, but the factory's history, with the reasons in its commits, would stay behind in `vocab`.
- **Rewrite `vocab`'s history too.** It would drop the factory's files from every old commit, and break every existing clone, pull request and commit link.

## Consequences

- Commit hashes here differ from the same commits in `vocab`. Pull request and issue numbers in old commit messages and archived changes refer to `vocab`.
- Until the target-aware change lands, the factory still assumes it lives in its target (`app/` paths, `pnpm typecheck:app`, `pnpm lint:app`), so no work item runs between the split and the first deploy from `ceh`.
- One test went with the app: the lint rule that lets agent-written stubs keep `_` parameters is now part of `vocab`'s lint config, so `ceh` no longer tests it.
- The factory can no longer change by a work item at all, since work items run only on targets.
