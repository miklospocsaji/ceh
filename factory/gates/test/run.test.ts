import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GatesResult } from "@ceh/factory-artifacts";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { runGates, type GatesTask } from "../src/run.ts";
import { makeWorktree, removeWorktree, TARGET_GATES } from "./helpers/worktree.ts";

const changeId = "add-demo";
// Task 1.2 of the fixture's change; task 1.1 ("Adds two numbers") is done.
const task: GatesTask = {
  id: "1.2",
  scenarios: ["Subtracts two numbers", "Refuses non-finite numbers"],
  coveredSoFar: ["Adds two numbers", "Subtracts two numbers", "Refuses non-finite numbers"],
};
const apiKey = "sk-ant-fixture-0123456789abcdef";

const worktrees: string[] = [];
async function worktree(...overlays: string[]): Promise<string> {
  const created = await makeWorktree(...overlays);
  worktrees.push(created);
  return created;
}
afterAll(async () => {
  await Promise.all(worktrees.map(removeWorktree));
});

/** Sets environment variables for one test and restores them after it. */
const saved = new Map<string, string | undefined>();
function setEnv(name: string, value: string | undefined): void {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
}
afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
  saved.clear();
});

function checkOf(result: GatesResult, name: GatesResult["checks"][number]["name"]) {
  const found = result.checks.find((entry) => entry.name === name);
  if (!found) throw new Error(`no ${name} check in ${result.checks.map((entry) => entry.name).join(", ")}`);
  return found;
}

describe("runGates", { timeout: 120_000 }, () => {
  it("Scenario: Green gates pass on a finished task", async () => {
    const result = await runGates({ worktree: await worktree("green"), changeId, task, mode: "green", ...TARGET_GATES });
    expect(GatesResult.parse(result)).toEqual(result);
    expect(result).toMatchObject({ mode: "green", changeId, taskId: "1.2", passed: true });
    expect(result.checks.map((entry) => [entry.name, entry.passed])).toEqual([
      ["typecheck", true],
      ["lint", true],
      ["unit", true],
      ["spec", true],
      ["coverage", true],
    ]);
    expect(checkOf(result, "typecheck").exitCode).toBe(0);
    expect(checkOf(result, "coverage")).toMatchObject({ exitCode: null, missing: [] });
  });

  it("Scenario: Every failing check is reported", async () => {
    const result = await runGates({ worktree: await worktree("green", "green-broken"), changeId, task, mode: "green", ...TARGET_GATES });
    expect(GatesResult.parse(result)).toEqual(result);
    expect(result.passed).toBe(false);
    expect(result.checks.map((entry) => entry.name)).toEqual(["typecheck", "lint", "unit", "spec", "coverage"]);

    const lint = checkOf(result, "lint");
    expect(lint).toMatchObject({ passed: false, exitCode: 1 });
    expect(lint.output).toContain("app/demo/src/double.ts");
    expect(lint.output).toContain("no-unused-vars");

    const unit = checkOf(result, "unit");
    expect(unit).toMatchObject({ passed: false, exitCode: 1 });
    expect(unit.output).toContain("doubles a number");
    expect(unit.tests).toEqual([{ file: "app/demo/test/double.test.ts", name: "doubles a number", problem: "failed" }]);

    // The other checks still ran.
    expect(checkOf(result, "typecheck")).toMatchObject({ passed: true, exitCode: 0 });
    expect(checkOf(result, "spec")).toMatchObject({ passed: true, exitCode: 0 });
    expect(checkOf(result, "coverage")).toMatchObject({ passed: true, missing: [] });
  });

  it("Scenario: Gates run the target's commands", async () => {
    const dir = await worktree("green");
    // Stand-ins that record their arguments, and the old script names, which must never run.
    await writeFile(join(dir, "record.js"), 'import { appendFileSync } from "node:fs";\nappendFileSync("ran.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");\n');
    const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { scripts: Record<string, string> };
    manifest.scripts = { "typecheck:app": "node record.js typecheck:app", "lint:app": "node record.js lint:app", typecheck: "node record.js script-typecheck", lint: "node record.js script-lint" };
    await writeFile(join(dir, "package.json"), JSON.stringify(manifest));
    const commands = { ...TARGET_GATES.commands, typecheck: "node record.js typecheck --strict", lint: "node record.js lint", unit: "node record.js unit run", unitTestPath: "packages/" };

    const result = await runGates({ worktree: dir, changeId, task, mode: "green", commands, coverageTestsDir: "app" });

    expect(GatesResult.parse(result)).toEqual(result);
    const ran = (await readFile(join(dir, "ran.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(ran).toHaveLength(3);
    expect(ran[0]).toEqual(["typecheck", "--strict"]);
    expect(ran[1]).toEqual(["lint"]);
    expect(ran[2]?.slice(0, 2)).toEqual(["unit", "run"]);
    expect(ran[2]?.at(-1)).toBe("packages/");
    expect(checkOf(result, "typecheck")).toMatchObject({ passed: true, exitCode: 0 });
    expect(checkOf(result, "lint")).toMatchObject({ passed: true, exitCode: 0 });
    // The stand-in wrote no Vitest report, so the unit check ran and failed for that reason only.
    expect(checkOf(result, "unit")).toMatchObject({ passed: false, exitCode: 0 });
  });

  it("Scenario: Spec check names the change", async () => {
    const dir = await worktree("green");
    // The worktree's own openspec, replaced by one that records how it was called.
    const bin = join(dir, "node_modules/.bin/openspec");
    await rm(bin, { force: true });
    await writeFile(bin, '#!/bin/sh\necho "$@" >> spec-args.txt\n');
    await chmod(bin, 0o755);

    const result = await runGates({ worktree: dir, changeId, task, mode: "green", ...TARGET_GATES });

    expect(checkOf(result, "spec")).toMatchObject({ passed: true, exitCode: 0 });
    expect((await readFile(join(dir, "spec-args.txt"), "utf8")).trim().split("\n")).toEqual([`validate ${changeId} --strict --no-interactive`]);
  });

  it("runs the unit tests under the target's unit test path only", async () => {
    const result = await runGates({ worktree: await worktree("green"), changeId, task, mode: "green", ...TARGET_GATES, commands: { ...TARGET_GATES.commands, unitTestPath: "factory/" } });
    // The fixture's factory test always fails: it runs only when the path names it.
    expect(checkOf(result, "unit")).toMatchObject({ passed: false });
    expect(checkOf(result, "unit").output).toContain("factory/demo");
  });

  it("Scenario: Assertion failures pass the red gate", async () => {
    const result = await runGates({ worktree: await worktree("red"), changeId, task, mode: "red", ...TARGET_GATES });
    expect(GatesResult.parse(result)).toEqual(result);
    expect(result.checks.map((entry) => [entry.name, entry.passed])).toEqual([
      ["typecheck", true],
      ["lint", true],
      ["unit", true],
      ["red", true],
    ]);
    expect(result).toMatchObject({ mode: "red", passed: true });
    expect(checkOf(result, "red")).toMatchObject({ exitCode: null, missing: [], tests: [] });
  });

  it("Scenario: A test that cannot load fails the red gate", async () => {
    const result = await runGates({ worktree: await worktree("red", "red-load-error"), changeId, task, mode: "red", ...TARGET_GATES });
    expect(GatesResult.parse(result)).toEqual(result);
    expect(result.passed).toBe(false);
    const red = checkOf(result, "red");
    expect(red.passed).toBe(false);
    expect(red.output).toContain("app/demo/test/subtract.test.ts");
    expect(red.output).toContain("../src/minus.ts");
    expect(red.tests).toContainEqual({ file: "app/demo/test/subtract.test.ts", name: "", problem: "load-error" });
  });

  it("Scenario: A passing new test fails the red gate", async () => {
    const result = await runGates({ worktree: await worktree("green"), changeId, task, mode: "red", ...TARGET_GATES });
    expect(GatesResult.parse(result)).toEqual(result);
    expect(result.passed).toBe(false);
    const red = checkOf(result, "red");
    expect(red.passed).toBe(false);
    expect(red.output).toContain("subtract Scenario: Subtracts two numbers");
    expect(red.tests).toEqual([
      { file: "app/demo/test/subtract.test.ts", name: "subtract Scenario: Subtracts two numbers", problem: "passed" },
      { file: "app/demo/test/subtract.test.ts", name: "subtract Scenario: Refuses non-finite numbers", problem: "passed" },
    ]);
  });

  it("Scenario: A broken existing test fails the red gate", async () => {
    const result = await runGates({ worktree: await worktree("red", "broken-add"), changeId, task, mode: "red", ...TARGET_GATES });
    expect(GatesResult.parse(result)).toEqual(result);
    expect(result.passed).toBe(false);
    const red = checkOf(result, "red");
    expect(red.passed).toBe(false);
    expect(red.output).toContain("add Scenario: Adds two numbers");
    expect(red.tests).toEqual([{ file: "app/demo/test/add.test.ts", name: "add Scenario: Adds two numbers", problem: "failed" }]);
  });

  it("names the scenarios no test names in the red check", async () => {
    const withExtra = { ...task, scenarios: [...task.scenarios, "Multiplies two numbers"] };
    const result = await runGates({ worktree: await worktree("red"), changeId, task: withExtra, mode: "red", ...TARGET_GATES });
    const red = checkOf(result, "red");
    expect(red).toMatchObject({ passed: false, missing: ["Multiplies two numbers"] });
    expect(red.output).toContain("Multiplies two numbers");
  });

  it("Scenario: Gate output never holds the API key", async () => {
    const result = await runGates({ worktree: await worktree("green", "secret"), changeId, task, mode: "green", secrets: [apiKey], ...TARGET_GATES });
    expect(GatesResult.parse(result)).toEqual(result);
    const unit = checkOf(result, "unit");
    expect(unit.passed).toBe(false);
    expect(unit.output).toContain("the key is [redacted]");
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it("Scenario: Gates run without a ledger", async () => {
    for (const name of ["FACTORY_DATABASE_URL", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
      setEnv(name, undefined);
    }
    // The fixture's test outside the unit test path always fails, so the unit check passes only if it never ran.
    const result = await runGates({ worktree: await worktree("green"), changeId, task, mode: "green", ...TARGET_GATES });
    expect(GatesResult.parse(result)).toEqual(result);
    const unit = checkOf(result, "unit");
    expect(unit).toMatchObject({ passed: true, exitCode: 0, tests: [] });
    expect(unit.output).toContain("app/demo/test/subtract.test.ts");
    expect(unit.output).not.toContain("factory/demo");
    expect(unit.output).not.toContain("needs the ledger");
  });

  it("runs every check with only the fixed environment", async () => {
    setEnv("FACTORY_DATABASE_URL", "postgres://probe:probe@localhost:1/probe");
    setEnv("ANTHROPIC_API_KEY", apiKey);
    setEnv("GATES_PROBE_CANARY", "leaked");
    setEnv("NODE_OPTIONS", "--no-deprecation");
    setEnv("CI", undefined);
    const dir = await worktree("green", "probe");
    const result = await runGates({ worktree: dir, changeId, task, mode: "green", ...TARGET_GATES });
    expect(GatesResult.parse(result)).toEqual(result);
    expect(result.passed).toBe(true);

    for (const check of ["typecheck", "lint", "unit", "spec"]) {
      const env = JSON.parse(await readFile(join(dir, `env-${check}.json`), "utf8")) as Record<string, string>;
      expect(env, check).toMatchObject({ CI: "1", OPENSPEC_TELEMETRY: "0", HOME: process.env["HOME"] });
      // pnpm prepends node_modules/.bin and drops duplicate entries, so compare entries, not strings.
      const entries = new Set((env["PATH"] ?? "").split(":"));
      expect((process.env["PATH"] ?? "").split(":").filter((entry) => !entries.has(entry)), check).toEqual([]);
      for (const leaked of ["FACTORY_DATABASE_URL", "ANTHROPIC_API_KEY", "GATES_PROBE_CANARY", "NODE_OPTIONS"]) {
        expect(env, `${check}: ${leaked}`).not.toHaveProperty(leaked);
      }
    }
  });
});
