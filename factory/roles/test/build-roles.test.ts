// The M3 session roles (add-build-roles task 2.12): each config pinned to design.md's table.
// The classifier's config is pinned in classifier.test.ts, the proposal author's in
// proposal-author.test.ts.
import { DesignResult, ImplementationResult, PlanResult, ReviewResult, TestResult } from "@vocab/factory-artifacts";
import { describe, expect, it } from "vitest";
import { loadRole } from "../src/config.ts";

const READ_ONLY = ["Read", "Grep", "Glob"];
const EDITING = [...READ_ONLY, "Edit", "Write"];
// The app's typecheck and lint only (add-build-loop, "Build roles check only the app").
const BASH_ALLOWLIST = [
  "Bash(pnpm typecheck:app)",
  "Bash(pnpm lint:app)",
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
      const role = await loadRole(expected.name);
      expect(role).toMatchObject({ ...config, skills: [], authMode: "subscription" });
      // Exact lists, not just a superset.
      expect(role.tools).toEqual(config.tools);
      expect(role.allow).toEqual(config.allow);
      expect(role.writable).toEqual(config.writable);
      expect(role.schema).toBe(schema);
    });

    it(`${expected.name}: the prompt fences untrusted data and says what the role returns`, async () => {
      const role = await loadRole(expected.name);
      expect(role.prompt).toMatch(/untrusted/i);
      expect(role.prompt).toContain("## What you may write");
      expect(role.prompt).toContain("structured output");
    });
  }

  it("the design reviewer has no tool that writes", async () => {
    const role = await loadRole("design-reviewer");
    for (const tool of ["Edit", "Write", "Bash", "NotebookEdit"]) expect(role.tools).not.toContain(tool);
  });

  it("the test author's prompt states the stub rules", async () => {
    const { prompt } = await loadRole("test-author");
    expect(prompt).toContain('it("Scenario: <exact title>"');
    expect(prompt).toContain('new Error("not implemented")');
    expect(prompt).toContain("Promise.reject");
    expect(prompt).toContain("`_`");
  });

  it("the implementer's prompt names the checks to run before returning", async () => {
    const { prompt } = await loadRole("implementer");
    for (const command of ["pnpm exec vitest run", "pnpm typecheck:app", "pnpm lint:app"]) expect(prompt).toContain(command);
  });

  it("Scenario: Build roles check only the app", async () => {
    for (const name of ["test-author", "implementer"]) {
      const role = await loadRole(name);
      expect(role.allow).toContain("Bash(pnpm typecheck:app)");
      expect(role.allow).toContain("Bash(pnpm lint:app)");
      expect(role.allow).not.toContain("Bash(pnpm typecheck)");
      expect(role.allow).not.toContain("Bash(pnpm lint)");
      // The prompt names only the app's commands: a whole-repository lint does not fit the build task.
      expect(role.prompt).not.toMatch(/`pnpm (typecheck|lint)`/);
    }
  });
});
