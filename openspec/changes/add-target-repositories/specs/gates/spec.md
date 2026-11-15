## ADDED Requirements

### Requirement: Gates run the target's commands
The gates SHALL run the typecheck, lint, unit and spec-validation commands of the target they are given, in the worktree and without a shell, and no script named by the factory. The unit check SHALL run the target's unit command on the target's unit test path. The spec check SHALL run the target's spec-validation command with `{changeId}` replaced by the change id.

#### Scenario: Gates run the target's commands
- **WHEN** the green gates run for a target whose typecheck, lint and unit commands are stand-ins that record their arguments
- **THEN** each of the `typecheck`, `lint` and `unit` checks ran its stand-in exactly once, the unit one with the target's unit test path as its last argument, and no `typecheck:app` or `lint:app` script ran

#### Scenario: Spec check names the change
- **WHEN** the green gates run for the change `add-demo` and a target whose spec-validation command is `pnpm exec openspec validate {changeId} --strict --no-interactive`
- **THEN** the `spec` check ran `pnpm exec openspec validate add-demo --strict --no-interactive`

## MODIFIED Requirements

### Requirement: Every scenario has a test
The coverage check SHALL read the scenario titles from the change's delta specs and SHALL report every title, from all of them or from a given subset, that no test name under the target's coverage test directory contains verbatim as `Scenario: <title>`. Coverage SHALL fail when any title is missing.

#### Scenario: Scenario without a test fails coverage
- **WHEN** a change's delta spec has a scenario "Re-import adds only new lookups" and no test under the target's coverage test directory names it
- **THEN** coverage fails, and its result lists "Re-import adds only new lookups" as missing

#### Scenario: Coverage checks only the given scenarios
- **WHEN** coverage runs with a subset of the change's scenario titles, all of which have tests, while other scenarios of the change have none yet
- **THEN** coverage passes

### Requirement: Gates run without the factory's services
The gates SHALL run the target's tests only, and SHALL need no ledger, network access or factory credentials.

#### Scenario: Gates run without a ledger
- **WHEN** the green gates run with no `FACTORY_DATABASE_URL` and no credentials in the environment
- **THEN** the `unit` check runs the target's tests only, and no factory test is reported

## REMOVED Requirements

### Requirement: Gates check only the app's code
**Reason**: It kept the gates away from the factory's code while the app and the factory shared a repository. A target's repository holds no factory code, and its `typecheck:app` and `lint:app` scripts are gone.
**Migration**: "Gates run the target's commands" replaces it: the typecheck and lint commands come from the target's `target.yaml`.
