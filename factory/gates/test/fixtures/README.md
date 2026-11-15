# Gate fixtures

`workspace/` is a small target repository: one package the gates check (`app/demo`), one whose
test needs a ledger and sits outside the unit test path (`factory/demo`), and one OpenSpec change
(`add-demo`) with three scenarios. Its `typecheck` and `lint` scripts are the commands a target's
`target.yaml` would name; the tests pass them to the gates (`helpers/worktree.ts`, `COMMANDS`).
The other folders are overlays copied on top of it by `test/helpers/worktree.ts`, which also links
the repository's pinned tools into the copy's `node_modules`. `report/` and `coverage/` serve the
Vitest report and coverage tests. Some files here are broken on purpose; the repository's own
typecheck, lint and tests skip this folder.
