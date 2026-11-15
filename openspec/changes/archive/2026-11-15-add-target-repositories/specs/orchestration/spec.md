## ADDED Requirements

### Requirement: Work items are keyed by repository
The ledger SHALL record each work item's repository, and SHALL hold at most one work item per repository and issue number, and at most one per repository and change id. Work items that existed before the repository was recorded SHALL belong to `miklospocsaji/vocab`. Every handler SHALL find a work item by its target's repository and the issue number, never by the issue number alone.

#### Scenario: Existing work items are backfilled
- **WHEN** the migration runs on a ledger that holds work items without a repository
- **THEN** each of them has the repository `miklospocsaji/vocab`, and its id, issue number, change id and state are unchanged

#### Scenario: Two repositories can hold the same issue number
- **WHEN** a work item exists for issue 12 of one repository, and Intake runs for issue 12 of another whose title gives the same change id
- **THEN** the ledger holds two work items, one per repository, with the same issue number and the same change id

#### Scenario: Second work item for the same issue is refused
- **WHEN** a second work item is created for an issue number, or a change id, that its repository already has
- **THEN** the ledger refuses it, and the first work item is unchanged

### Requirement: The worker serves its configured target
The worker SHALL take its target's name from `FACTORY_TARGET` and the target's repository, default branch, owner and contracts path from that target's config. It SHALL clone only that repository. A missing or unknown target SHALL be refused as invalid input before any state runs.

#### Scenario: Worker without a target is refused
- **WHEN** the worker starts with no `FACTORY_TARGET`, or with one that has no folder under `targets/`
- **THEN** no role runs, nothing is cloned or recorded, and the worker exits 2 with a message naming `FACTORY_TARGET`

#### Scenario: Worker works on its target's repository
- **WHEN** the worker runs `proposal` with `FACTORY_TARGET=vocab` for a work item in state `proposal`
- **THEN** the clone's `origin` is `miklospocsaji/vocab`, the role is loaded for the `vocab` target, and the build input it later writes names the target `vocab`

### Requirement: Local runs work on a clone of the target
The CLI's `run`, `approve` and `cost` commands SHALL take `--target <name>`, which defaults to the only target when there is one. A local run SHALL work on a clone of the target's repository under the factory home, made if it is missing, with its worktrees and artifact store beside it. It SHALL NOT read or change the checkout it is run from, beyond the factory's own code and `.env.local`.

#### Scenario: Local run works on a clone of the target
- **WHEN** the owner runs `pnpm factory run --issue 12 --until proposal` in the `ceh` checkout, with `vocab` as the only target
- **THEN** the target's repository is cloned to `<factory home>/targets/vocab/repo`, the work item's worktree is under `<factory home>/targets/vocab/worktrees/`, the work item's repository is `miklospocsaji/vocab`, and the `ceh` checkout has no new branch, worktree or file

#### Scenario: Ambiguous or unknown target is a usage error
- **WHEN** the CLI runs without `--target` while `targets/` holds two targets, or with `--target nosuch`
- **THEN** it exits 2 without touching the ledger or GitHub, and its message lists the known targets

### Requirement: The stack is configured by its target
The factory stack SHALL take the repository and the owner from its target's config: the webhook SHALL accept only that repository's deliveries and only that owner's `/approve`. The worker and build task definitions SHALL set `FACTORY_TARGET`, and the build task definition SHALL run the target's build image. Every resource SHALL be tagged `project=ceh`. The stack SHALL keep the name `Factory`.

#### Scenario: Stack settings come from the target config
- **WHEN** the factory stack is synthesised for the `vocab` target
- **THEN** the webhook's repository and owner are the target's, the worker, boundary-check and build containers set `FACTORY_TARGET=vocab`, the worker container has no `FACTORY_GITHUB_REPOSITORY`, and the build task's image is built from the assembled `vocab` build Dockerfile

#### Scenario: Stack is tagged for ceh
- **WHEN** the factory stack is synthesised
- **THEN** the stack's name is `Factory`, its resources carry the tag `project=ceh`, and none carries `project=vocab-factory`

## MODIFIED Requirements

### Requirement: The factory acts as its GitHub App
Outside local runs, the Forge SHALL authenticate with the factory's GitHub App installation tokens, requested for the target's repository only with `contents: write`, `issues: write`, `pull_requests: write` and `metadata: read`, and refreshed before any call within five minutes of expiry. Tokens SHALL never appear in error messages, logs, command lines, remote URLs or git config. Commits the factory pushes SHALL be authored and committed by the App's bot user.

#### Scenario: Installation token is scoped to the repository
- **WHEN** the token provider requests an installation token
- **THEN** the request is signed with a JWT for the App, names only the target's repository, and asks only for `contents: write`, `issues: write`, `pull_requests: write` and `metadata: read`

#### Scenario: Expiring token is refreshed
- **WHEN** the Forge makes a call less than five minutes before its current token expires
- **THEN** a new installation token is requested first, and the call uses the new token

#### Scenario: Token failures do not leak the token
- **WHEN** a GitHub call or a push fails with an authentication error
- **THEN** the error message and every log line name the failure without containing the token or the App's private key

#### Scenario: Commits are authored by the factory's bot
- **WHEN** the worker commits and pushes a proposal or a task
- **THEN** the pushed commit's author and committer are the App's bot user, not the owner

### Requirement: A pull request opens when every task is done
When every task of the plan is ticked, the worker SHALL open one pull request from the change branch to the target's default branch, or reuse the open one. Its body SHALL list the tasks, each role's tokens and estimated cost, and the issue. The issue SHALL get a comment linking it, and the work item SHALL become `pr-open`.

#### Scenario: Pull request is opened once
- **WHEN** the open-PR state runs twice for a work item whose tasks are all ticked
- **THEN** exactly one pull request exists for the branch, its body lists the tasks and the cost, and the issue has one comment linking it

#### Scenario: Pull request targets the default branch
- **WHEN** the open-PR state runs for a target whose default branch is `main`
- **THEN** the pull request's base is `main`

### Requirement: Commits and pull requests say what they hold
A design commit that adds or changes files under the target's contracts path SHALL be a `feat` commit, `feat(<change id>): design the change and its contracts`; one that changes only `design.md` stays `docs(<change id>): design the change`. The pull request's cost note SHALL follow the auth modes its attempts ran in: in `api-key` mode the cost was charged to the factory's API key, in `subscription` mode no money was charged per token.

#### Scenario: Design that adds contracts is committed as a feature
- **WHEN** the architect writes `design.md` and a file under the target's contracts path, and the design is accepted
- **THEN** the design commit holds both files, and its subject is `feat(<change id>): design the change and its contracts`

#### Scenario: Pull request says what its cost means
- **WHEN** a pull request opens for a work item whose attempts all ran in `api-key` mode
- **THEN** its cost note says the cost was charged to the factory's API key, and does not say that no money was charged
