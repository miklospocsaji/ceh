// The M3 session roles (add-build-roles task 2.12): each config pinned to design.md's table.
// The classifier's config is pinned in classifier.test.ts, the proposal author's in
// proposal-author.test.ts.
import { DesignResult, ImplementationResult, PlanResult, ReviewResult, TestResult } from "@ceh/factory-artifacts";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadTarget } from "@ceh/factory-target";
import { testTarget } from "@ceh/factory-target/testing";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { loadRole } from "../src/config.ts";

const TARGET = testTarget();
const ROLES_DIR = resolve(import.meta.dirname, "..");
const SAMPLE = {
  name: "sample",
  model: "claude-haiku-5-5",
  runsIn: "build",
  tools: ["Read", "Bash"],
  allow: ["Read"],
  writable: [],
  skills: [],
  maxTurns: 5,
  maxBudgetUsd: 0.1,
  resultSchema: "proposal-result",
  authMode: "subscription",
};

/** The names of the repository's roles: every `factory/roles/<role>.yaml`. */
function repoRoles(): string[] {
  return readdirSync(ROLES_DIR)
    .filter((file) => file.endsWith(".yaml"))
    .map((file) => file.slice(0, -".yaml".length));
}

const READ_ONLY = ["Read", "Grep", "Glob"];
const EDITING = [...READ_ONLY, "Edit", "Write"];
// The target's commands only (add-target-repositories, "Build roles run only the target's commands").
const BASH_ALLOWLIST = [
  "Bash(pnpm typecheck)",
  "Bash(pnpm lint)",
  "Bash(pnpm exec vitest run:*)",
  "Bash(git status:*)",
  "Bash(git diff:*)",
];

const ROLES = [
  {
    name: "architect",
    model: "claude-opus-5-5",
    runsIn: "worker",
    tools: EDITING,
    allow: EDITING,
    writable: ["openspec/changes/{changeId}/design.md", "app/contracts/src/**"],
    maxTurns: 40,
    maxBudgetUsd: 1.5,
    resultSchema: "design-result",
    schema: DesignResult,
  },
  {
    name: "design-reviewer",
    model: "claude-sonnet-5-5",
    runsIn: "worker",
    tools: READ_ONLY,
    allow: READ_ONLY,
    writable: [],
    maxTurns: 20,
    maxBudgetUsd: 0.5,
    resultSchema: "review-result",
    schema: ReviewResult,
  },
  {
    name: "planner",
    model: "claude-sonnet-5-5",
    runsIn: "worker",
    tools: EDITING,
    allow: EDITING,
    writable: ["openspec/changes/{changeId}/tasks.md"],
    maxTurns: 25,
    maxBudgetUsd: 0.75,
    resultSchema: "plan-result",
    schema: PlanResult,
  },
  {
    name: "test-author",
    model: "claude-sonnet-5-5",
    runsIn: "build",
    tools: [...EDITING, "Bash"],
    allow: [...EDITING, ...BASH_ALLOWLIST],
    writable: ["app/*/test/**", "app/e2e/**", "{taskStubs}"],
    maxTurns: 40,
    maxBudgetUsd: 1,
    resultSchema: "test-result",
    schema: TestResult,
  },
  {
    name: "implementer",
    model: "claude-sonnet-5-5",
    runsIn: "build",
    tools: [...EDITING, "Bash"],
    allow: [...EDITING, ...BASH_ALLOWLIST],
    writable: ["app/*/src/**", "!app/contracts/**", "infra/app-stack.ts", "infra/preview-stack.ts", "infra/app/**"],
    maxTurns: 60,
    maxBudgetUsd: 1.5,
    resultSchema: "implementation-result",
    schema: ImplementationResult,
  },
] as const;

describe("the M3 session roles", () => {
  for (const expected of ROLES) {
    const { schema, ...config } = expected;

    it(`${expected.name}: tools, writable globs, runsIn, model and budget match design.md`, async () => {
      const role = await loadRole(expected.name, TARGET);
      expect(role).toMatchObject({ ...config, skills: [], authMode: "subscription" });
      // Exact lists, not just a superset.
      expect(role.tools).toEqual(config.tools);
      expect(role.allow).toEqual(config.allow);
      expect(role.writable).toEqual(config.writable);
      expect(role.schema).toBe(schema);
    });

    it(`${expected.name}: the prompt fences untrusted data and says what the role returns`, async () => {
      const role = await loadRole(expected.name, TARGET);
      expect(role.prompt).toMatch(/untrusted/i);
      expect(role.prompt).toContain("## What you may write");
      expect(role.prompt).toContain("structured output");
    });
  }

  it("the design reviewer has no tool that writes", async () => {
    const role = await loadRole("design-reviewer", TARGET);
    for (const tool of ["Edit", "Write", "Bash", "NotebookEdit"]) expect(role.tools).not.toContain(tool);
  });

  it("the test author's prompt states the stub rules", async () => {
    const { prompt } = await loadRole("test-author", TARGET);
    expect(prompt).toContain('it("Scenario: <exact title>"');
    expect(prompt).toContain('new Error("not implemented")');
    expect(prompt).toContain("Promise.reject");
    expect(prompt).toContain("`_`");
  });

  it("the implementer's prompt names the checks to run before returning", async () => {
    const { prompt } = await loadRole("implementer", TARGET);
    for (const command of ["`pnpm exec vitest run`", "`pnpm typecheck`", "`pnpm lint`"]) expect(prompt).toContain(command);
  });
});

describe("roles resolved for a target", () => {
  const BASH = (role: { allow: readonly string[] }) => role.allow.filter((rule) => rule.startsWith("Bash"));

  it("Scenario: Role is resolved for its target", async () => {
    const vocab = await loadTarget("vocab");
    const [implementer, architect, testAuthor] = await Promise.all(["implementer", "architect", "test-author"].map((name) => loadRole(name, vocab)));
    expect(implementer?.writable).toEqual(vocab.writable["implementer"]);
    expect(architect?.writable).toEqual(["openspec/changes/{changeId}/design.md", "app/contracts/src/**"]);
    // The stubs placeholder is the work item's, filled later.
    expect(testAuthor?.writable).toEqual([...(vocab.writable["test-author"] ?? []), "{taskStubs}"]);
    for (const name of repoRoles()) {
      const role = await loadRole(name, vocab);
      expect(role.prompt, name).not.toContain("{target.");
      expect(JSON.stringify([role.allow, role.writable]), name).not.toContain("{target.");
    }
    expect(implementer?.prompt).toContain("`app/*/src/**`, `!app/contracts/**`, `infra/app-stack.ts`");
    expect(architect?.prompt).toContain("files under `app/contracts/src/`");
  });

  it("follows the target, not vocab's layout", async () => {
    const other = testTarget({
      name: "other",
      repository: "someone/other",
      contracts: "packages/api/contracts",
      commands: { ...TARGET.commands, typecheck: "make typecheck", lint: "make lint", unit: "pnpm exec vitest run --config vitest.unit.ts" },
      writable: { "test-author": ["packages/*/tests/**"], implementer: ["packages/*/lib/**", "!packages/api/contracts/**"] },
    });
    const implementer = await loadRole("implementer", other);
    expect(implementer.writable).toEqual(["packages/*/lib/**", "!packages/api/contracts/**"]);
    expect(BASH(implementer)).toEqual(["Bash(make typecheck)", "Bash(make lint)", "Bash(pnpm exec vitest run --config vitest.unit.ts:*)", "Bash(git status:*)", "Bash(git diff:*)"]);
    expect((await loadRole("architect", other)).writable).toContain("packages/api/contracts/**");
    expect((await loadRole("proposal-author", other)).prompt).toContain("`someone/other`");
    expect(implementer.prompt).not.toContain("app/");
  });

  it("refuses a build role for a target that gives it no paths", async () => {
    const none = testTarget({ writable: { implementer: ["app/*/src/**", "!app/contracts/**"] } });
    await expect(loadRole("test-author", none)).rejects.toThrow("{target.writable.test-author}");
  });

  it("Scenario: Unknown placeholder is refused", async () => {
    const root = mkdtempSync(join(tmpdir(), "ceh-roles-"));
    try {
      mkdirSync(join(root, "factory/roles"), { recursive: true });
      const write = (allow: string[], prompt: string) => {
        writeFileSync(join(root, "factory/roles/sample.yaml"), stringify({ ...SAMPLE, allow }));
        writeFileSync(join(root, "factory/roles/sample.md"), prompt);
      };
      write(["Read", "Bash({target.deploy})"], "You are a sample role.\n");
      await expect(loadRole("sample", TARGET, { root })).rejects.toMatchObject({ name: "RoleConfigError", role: "sample", field: "allow" });
      await expect(loadRole("sample", TARGET, { root })).rejects.toThrow("{target.deploy}");

      write(["Read"], "Run `{target.deploy}` when you are done.\n");
      await expect(loadRole("sample", TARGET, { root })).rejects.toMatchObject({ name: "RoleConfigError", role: "sample", field: "prompt" });
      await expect(loadRole("sample", TARGET, { root })).rejects.toThrow("{target.deploy}");

      // Control: the same role with a placeholder the target fills loads.
      write(["Read", "Bash({target.lint})"], "Run `{target.lint}`.\n");
      await expect(loadRole("sample", TARGET, { root })).resolves.toMatchObject({ allow: ["Read", "Bash(pnpm lint)"], prompt: "Run `pnpm lint`." });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a target that gives paths to a role with no place for them", async () => {
    const target = testTarget({ writable: { ...TARGET.writable, planner: ["docs/plans/**"] } });
    await expect(loadRole("planner", target)).rejects.toMatchObject({ name: "RoleConfigError", role: "planner", field: "writable" });
  });

  it("Scenario: Build roles run only the target's commands", async () => {
    for (const name of ["test-author", "implementer"]) {
      const role = await loadRole(name, TARGET);
      expect(BASH(role), name).toEqual(["Bash(pnpm typecheck)", "Bash(pnpm lint)", "Bash(pnpm exec vitest run:*)", "Bash(git status:*)", "Bash(git diff:*)"]);
      for (const command of ["`pnpm typecheck`", "`pnpm lint`", "`pnpm exec vitest run"]) expect(role.prompt, name).toContain(command);
    }
  });

  it("Scenario: Target command on the deny list is refused", async () => {
    const target = testTarget({ commands: { ...TARGET.commands, typecheck: "npm run typecheck" } });
    const load = loadRole("implementer", target);
    await expect(load).rejects.toMatchObject({ name: "RoleConfigError", role: "implementer", field: "allow" });
    await expect(load).rejects.toThrow("Bash(npm run typecheck)");
    await expect(load).rejects.toThrow(/would allow npm\b/);
    // The worker roles take no command from the target, so they still load.
    await expect(loadRole("architect", target)).resolves.toMatchObject({ name: "architect" });
  });

  it("Scenario: Role files name no target", () => {
    const files = readdirSync(ROLES_DIR).filter((file) => file.endsWith(".yaml") || file.endsWith(".md"));
    expect(files.length).toBeGreaterThan(13);
    for (const file of files) {
      const text = readFileSync(join(ROLES_DIR, file), "utf8");
      for (const named of ["app/", ":app", "vocab", "Vocab"]) expect(text, `${file} names ${named}`).not.toContain(named);
    }
  });
});
