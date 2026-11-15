import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { cloneUrl, commandArgs, listTargets, loadTarget, NoSingleTarget, onlyTarget, repositoryParts, TargetConfigError } from "../src/index.ts";
import { TEST_TARGET_CONFIG, testTarget } from "../src/testing.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const roots: string[] = [];

/** A temp root holding `targets/<name>/target.yaml` for each given config. */
async function rootWith(targets: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "factory-target-"));
  roots.push(root);
  for (const [name, config] of Object.entries(targets)) {
    await mkdir(join(root, "targets", name), { recursive: true });
    await writeFile(join(root, "targets", name, "target.yaml"), typeof config === "string" ? config : stringify(config));
  }
  return root;
}

const config = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ ...structuredClone(TEST_TARGET_CONFIG), ...overrides });

async function failure(root: string, name = "vocab"): Promise<TargetConfigError> {
  const error = await loadTarget(name, { root }).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(TargetConfigError);
  return error as TargetConfigError;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("target config", () => {
  it("loads a valid target", async () => {
    const root = await rootWith({ vocab: config() });
    await expect(loadTarget("vocab", { root })).resolves.toEqual(testTarget());
  });

  it("Scenario: Invalid target config is refused", async () => {
    const withoutRepository = config();
    delete withoutRepository["repository"];
    const missing = await failure(await rootWith({ vocab: withoutRepository }));
    expect(missing.target).toBe("vocab");
    expect(missing.field).toBe("repository");
    expect(missing.message).toContain("target vocab");

    const shell = await failure(await rootWith({ vocab: config({ commands: { ...TEST_TARGET_CONFIG.commands, typecheck: "pnpm typecheck && pnpm lint" } }) }));
    expect(shell.field).toBe("commands.typecheck");
    expect(shell.message).toContain("plain words");
  });

  it.each([
    ['a quoted argument', "typecheck", 'pnpm exec tsc -p "app dir"'],
    ["a pipe", "lint", "pnpm lint | tee log"],
    ["a substitution", "unit", "pnpm exec vitest run $(pwd)"],
    ["a double space", "install", "pnpm  install"],
    ["a placeholder outside specValidate", "typecheck", "pnpm typecheck {changeId}"],
    ["an unknown placeholder", "specValidate", "pnpm exec openspec validate {change} --strict"],
  ])("refuses a command with %s", async (_what, field, value) => {
    const error = await failure(await rootWith({ vocab: config({ commands: { ...TEST_TARGET_CONFIG.commands, [field]: value } }) }));
    expect(error.field).toBe(`commands.${field}`);
  });

  it("refuses an unknown field, invalid YAML, a missing file and a name that is not the folder's", async () => {
    expect((await failure(await rootWith({ vocab: config({ deploy: "pnpm deploy" }) }))).message).toContain("deploy");
    expect((await failure(await rootWith({ vocab: "name: [unclosed" }))).field).toBe("config");
    expect((await failure(await rootWith({}))).message).toContain("targets/vocab/target.yaml is missing");
    expect((await failure(await rootWith({ other: config() }), "other")).field).toBe("name");
    expect((await failure(await rootWith({}), "../vocab")).field).toBe("name");
  });

  it.each(["../other/**", "/etc/**", "**/*.ts", ".claude/**", "openspec/**", ".github/workflows/**", ".git/hooks/**", "*/src/**", "app/../openspec/**", "~/x"])(
    "Scenario: Target path outside its repository is refused (%s)",
    async (glob) => {
      const error = await failure(await rootWith({ vocab: config({ writable: { ...TEST_TARGET_CONFIG.writable, implementer: ["app/*/src/**", "!app/contracts/**", glob] } }) }));
      expect(error.target).toBe("vocab");
      expect(error.field).toBe("writable.implementer.2");
      expect(error.message).toContain(glob);
    },
  );

  it("refuses a contracts path, unit test path or coverage directory outside the repository's own code", async () => {
    for (const field of ["contracts", "unitTestPath", "coverageTestsDir"]) {
      expect((await failure(await rootWith({ vocab: config({ [field]: "../elsewhere" }) }))).field).toBe(field);
      expect((await failure(await rootWith({ vocab: config({ [field]: "openspec/specs" }) }))).field).toBe(field);
    }
  });

  it("Scenario: Contracts writable by a build role are refused", async () => {
    const error = await failure(
      await rootWith({ vocab: config({ contracts: "app/contracts/src", writable: { ...TEST_TARGET_CONFIG.writable, implementer: ["app/*/src/**"] } }) }),
    );
    expect(error.field).toBe("writable.implementer");
    expect(error.message).toContain("app/contracts/src");
    expect(error.message).toContain("implementer");

    const testAuthor = await failure(await rootWith({ vocab: config({ writable: { ...TEST_TARGET_CONFIG.writable, "test-author": ["app/**"] } }) }));
    expect(testAuthor.field).toBe("writable.test-author");
  });

  it("Scenario: Every target in the repository loads", async () => {
    const names = await listTargets();
    expect(names).toContain("vocab");
    for (const name of names) {
      const target = await loadTarget(name);
      expect(target.name).toBe(name);
      await expect(access(join(REPO_ROOT, "targets", name, "build.Dockerfile"))).resolves.toBeUndefined();
    }
  });

  it("the test target is the vocab target, so tests and the real config cannot drift apart", async () => {
    expect(await loadTarget("vocab")).toEqual(testTarget());
  });
});

describe("choosing a target", () => {
  it("lists the target folders, and loads the only one", async () => {
    const root = await rootWith({ vocab: config() });
    expect(await listTargets({ root })).toEqual(["vocab"]);
    expect((await onlyTarget({ root })).name).toBe("vocab");
  });

  it("has no only target when there are none or several", async () => {
    await expect(onlyTarget({ root: await rootWith({}) })).rejects.toBeInstanceOf(NoSingleTarget);
    const two = await rootWith({ vocab: config(), other: config({ name: "other" }) });
    await expect(onlyTarget({ root: two })).rejects.toThrow("other, vocab");
  });
});

describe("what a target gives", () => {
  it("splits a command into words and fills in the change id", () => {
    expect(commandArgs("pnpm exec vitest run")).toEqual(["pnpm", "exec", "vitest", "run"]);
    expect(commandArgs(TEST_TARGET_CONFIG.commands.specValidate, "add-demo")).toEqual(["pnpm", "exec", "openspec", "validate", "add-demo", "--strict", "--no-interactive"]);
  });

  it("gives the repository's clone URL, owner and name", () => {
    expect(cloneUrl(testTarget())).toBe("https://github.com/miklospocsaji/vocab.git");
    expect(repositoryParts(testTarget())).toEqual({ owner: "miklospocsaji", repo: "vocab" });
  });
});
