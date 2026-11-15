/** A target for tests that need one but not a real repository's: `vocab`'s shape, with any field replaced. */
import { TargetSchema, type Target } from "./target.ts";

export const TEST_TARGET_CONFIG = {
  name: "vocab",
  repository: "miklospocsaji/vocab",
  defaultBranch: "master",
  owner: "miklospocsaji",
  commands: {
    install: "pnpm install --frozen-lockfile",
    typecheck: "pnpm typecheck",
    lint: "pnpm lint",
    unit: "pnpm exec vitest run",
    specValidate: "pnpm exec openspec validate {changeId} --strict --no-interactive",
  },
  unitTestPath: "app/",
  coverageTestsDir: "app",
  contracts: "app/contracts/src",
  writable: {
    "test-author": ["app/*/test/**", "app/e2e/**"],
    implementer: ["app/*/src/**", "!app/contracts/**", "infra/app-stack.ts", "infra/preview-stack.ts", "infra/app/**"],
  },
  budgetUsd: 5,
} as const satisfies Target;

/** The test target with `overrides` applied, checked by the schema like a loaded one. */
export function testTarget(overrides: Partial<Target> = {}): Target {
  return TargetSchema.parse({ ...structuredClone(TEST_TARGET_CONFIG), ...overrides });
}
