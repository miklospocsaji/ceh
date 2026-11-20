import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FakeForge } from "@ceh/factory-forge/testing";
import { findWorkItemByIssue, LedgerRecorder, listAttempts, migrate, openApproval, setWorkItemState } from "@ceh/factory-ledger";
import { createTestDatabase, type TestDatabase } from "@ceh/factory-ledger/testing";
import { loadRole, type PlanPaths, type Role } from "@ceh/factory-roles";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeBuildRunner, type FakeBuildCall, type FakeBuildStep } from "../../orchestrator/test/fake-build-runner.ts";
import { CHANGE_FILES, createFakeRoleRunner, validResult, type FakeCall, type FakeStep } from "../../orchestrator/test/fake-role-runner.ts";
import { FsStore } from "../../worker/src/store.ts";
import { EXIT_CODES, runCli, type CliEnv } from "../src/cli.ts";
import { localTargetPaths, prepareLocalTarget } from "../src/local-target.ts";
import { testTarget } from "@ceh/factory-target/testing";

const REPOSITORY = "miklospocsaji/vocab";

const TARGET = testTarget();

const CHANGE_ID = "add-import-kindle-vocab-db";
const ISSUE = { number: 12, title: "Import Kindle vocab.db", body: "Import the lookups from the Kindle's vocab.db." };
const RUN = ["run", "--issue", String(ISSUE.number), "--until", "proposal"];
const COST = ["cost", "--issue", String(ISSUE.number)];
const OPEN_QUESTION = "Should a re-import skip lookups already imported?";

/** A change that passes strict validation. */
const VALID: FakeStep = {
  files: { "proposal.md": CHANGE_FILES.proposal, ".openspec.yaml": CHANGE_FILES.metadata, "specs/vocab-import/spec.md": CHANGE_FILES.spec },
  result: { ...validResult(CHANGE_ID), complexity: "medium", openQuestions: [OPEN_QUESTION] },
};
/** A proposal without any delta spec, which strict validation rejects. */
const INVALID: FakeStep = { files: { "proposal.md": CHANGE_FILES.proposal } };

/** The same valid change as `medium`: Approved routes on `.openspec.yaml`. */
const MEDIUM: FakeStep = { ...VALID, files: { ...VALID.files, ".openspec.yaml": CHANGE_FILES.metadata.replace("small", "medium") } };
const APPROVE = ["approve", "--issue", String(ISSUE.number)];
const until = (stop: string) => ["run", "--issue", String(ISSUE.number), "--until", stop];

/** Two tasks; the change's one scenario is task 1.1's. */
const TASKS_MD = ["# Tasks", "", "## 1. Import", "", "- [ ] 1.1 Parse the lookups", "- [ ] 1.2 Count the lookups", ""].join("\n");
const PLAN = {
  tasks: [
    { id: "1.1", title: "Parse the lookups", dependsOn: [], files: ["app/domain/src/lookups.ts"], scenarios: ["Lookups are imported"], tests: ["app/domain/test/lookups.test.ts"] },
    { id: "1.2", title: "Count the lookups", dependsOn: ["1.1"], files: ["app/domain/src/counts.ts"], scenarios: [], tests: ["app/domain/test/counts.test.ts"] },
  ],
};
const PLANNER: FakeStep = { files: { "tasks.md": TASKS_MD }, result: PLAN };
const ARCHITECT: FakeStep = { files: { "design.md": "# Design\n\n## Overview\n\nRead vocab.db with node:sqlite.\n" }, result: { summary: "Read vocab.db.", contracts: [], adrNeeded: [], openQuestions: [] } };
const REVIEW_APPROVES: FakeStep = { result: { verdict: "approve", findings: [] } };
const files = (entries: Record<string, string>): FakeBuildStep => ({ files: entries });
const BUILDS: FakeBuildStep[] = [
  files({ "app/domain/test/lookups.test.ts": 'it("Scenario: Lookups are imported", () => {});\n', "app/domain/src/lookups.ts": "export {};\n" }),
  files({ "app/domain/src/lookups.ts": "export const lookups = [];\n" }),
  files({ "app/domain/test/counts.test.ts": 'it("counts", () => {});\n', "app/domain/src/counts.ts": "export {};\n" }),
  files({ "app/domain/src/counts.ts": "export const counts = 0;\n" }),
];

let db: TestDatabase;
let role: Role;
let roles: { architect: Role; designReviewer: Role; planner: Role; planPaths: PlanPaths; testAuthor: Role; implementer: Role; classifier: Role };
let storeDir: string;
let root: string;
let remote: string;
let repo: string;
let home: string;
let forge: FakeForge;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8" }).trim();
}

function write(dir: string, file: string, content: string): void {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), content);
}

interface Cli {
  /** Runs one command with the scripted role-runner and build steps; resolves with its exit code and output. */
  run(argv: string[], steps?: FakeStep[], builds?: FakeBuildStep[], overrides?: Partial<CliEnv>): Promise<{ code: number; out: string; err: string }>;
  /** Every role-runner call, across all commands. */
  calls: FakeCall[];
  /** Every build, across all commands. */
  builds: FakeBuildCall[];
}

/** The CLI on the test ledger, the FakeForge, a scripted fake role runner and a fake build runner on an FsStore. */
function cli(): Cli {
  const calls: FakeCall[] = [];
  const builds: FakeBuildCall[] = [];
  return {
    calls,
    builds,
    async run(argv, steps = [], buildSteps = [], overrides = {}) {
      let out = "";
      let err = "";
      const fake = createFakeRoleRunner(new LedgerRecorder(db.pool), steps);
      const store = new FsStore(storeDir);
      const build = createFakeBuildRunner(store, buildSteps);
      const env: CliEnv = {
        db: db.pool,
        out: (text) => (out += text),
        err: (text) => (err += text),
        listTargets: () => Promise.resolve([TARGET.name]),
        loadTarget: (name) => (name === TARGET.name ? Promise.resolve(TARGET) : Promise.reject(new Error(`no target ${name}`))),
        runContext: () =>
          Promise.resolve({ forge, runRole: fake.runRole, role, repo, home, ...roles, store, runBuild: build.runBuild, cloneUrl: remote, wait: () => Promise.resolve() }),
        ...overrides,
      };
      const code = await runCli(argv, env);
      calls.push(...fake.calls);
      builds.push(...build.calls);
      return { code, out, err };
    },
  };
}

async function attemptCount(): Promise<number> {
  const workItem = await findWorkItemByIssue(db.pool, REPOSITORY, ISSUE.number);
  return workItem === undefined ? 0 : (await listAttempts(db.pool, workItem.id)).length;
}

beforeAll(async () => {
  db = await createTestDatabase("cli_run");
  await migrate(db.pool);
  role = await loadRole("proposal-author", TARGET);
  const [architect, designReviewer, planner, testAuthor, implementer, classifier] = await Promise.all(
    ["architect", "design-reviewer", "planner", "test-author", "implementer", "failure-classifier"].map((name) => loadRole(name, TARGET)),
  );
  if (architect === undefined || designReviewer === undefined || planner === undefined || testAuthor === undefined || implementer === undefined || classifier === undefined) {
    throw new Error("missing role");
  }
  roles = { architect, designReviewer, planner, planPaths: { implementer: implementer.writable, testAuthor: testAuthor.writable }, testAuthor, implementer, classifier };
  return () => db.close();
});

beforeEach(() => {
  // Keep the owner's and the system's git config (signing, hooks, identity) out of the tests.
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");

  root = realpathSync(mkdtempSync(join(tmpdir(), "factory-cli-")));
  remote = join(root, "remote.git");
  repo = join(root, "repo");
  home = join(root, "factory-home");
  storeDir = join(root, "store");

  git(root, "init", "--bare", "-b", "master", remote);
  const seed = join(root, "seed");
  git(root, "clone", remote, seed);
  write(seed, "README.md", "# vocab\n");
  write(seed, "openspec/config.yaml", "schema: spec-driven\n");
  write(seed, "openspec/specs/vocab-import/spec.md", "# vocab-import\n\n## Purpose\nImporting Kindle lookups.\n\n## Requirements\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "initial");
  git(seed, "push", "origin", "master");
  git(root, "clone", remote, repo);

  forge = new FakeForge({ remote, issues: [ISSUE] });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  await db.pool.query("TRUNCATE work_items, attempts, messages, events, approvals, tasks CASCADE");
});

describe("factory run", () => {
  it("Scenario: Summary comment is posted", async () => {
    const factory = cli();

    const { code, out } = await factory.run(RUN, [VALID]);

    expect(code).toBe(EXIT_CODES.ok);
    const workItem = await findWorkItemByIssue(db.pool, REPOSITORY, ISSUE.number);
    expect(workItem?.state).toBe("awaiting-proposal-approval");
    expect(out).toContain("awaiting-proposal-approval");
    expect(factory.calls).toHaveLength(1);

    expect(forge.comments).toHaveLength(1);
    const [comment] = forge.comments;
    expect(comment?.issueNumber).toBe(ISSUE.number);
    const body = comment?.body ?? "";
    expect(body).toContain(CHANGE_ID);
    expect(body).toContain("vocab-import");
    expect(body).toMatch(/complexity\W+medium/i);
    expect(body).toMatch(/open questions/i);
    expect(body).toContain(OPEN_QUESTION);
    // Why and what changes, from the pushed proposal.md.
    expect(body).toContain("Owners want their Kindle lookups in the app.");
    expect(body).toContain("Import the lookups from a Kindle vocab.db.");
  });

  it("Scenario: Re-run after completion does nothing", async () => {
    const factory = cli();
    expect((await factory.run(RUN, [VALID])).code).toBe(EXIT_CODES.ok);
    const head = git(remote, "rev-parse", `refs/heads/${CHANGE_ID}`);
    const attempts = await attemptCount();
    const comments = forge.comments.length;

    // No scripted steps: any agent run would fail the fake.
    const { code, out } = await factory.run(RUN);

    expect(code).toBe(EXIT_CODES.ok);
    expect(factory.calls).toHaveLength(1);
    expect(await attemptCount()).toBe(attempts);
    expect(forge.comments).toHaveLength(comments);
    expect(git(remote, "rev-parse", `refs/heads/${CHANGE_ID}`)).toBe(head);
    expect(out).toContain("awaiting-proposal-approval");
    const { rows } = await db.pool.query<{ n: string }>("SELECT count(*) AS n FROM work_items WHERE issue_number = $1", [ISSUE.number]);
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it("treats a proposal-approved work item as past --until proposal", async () => {
    const factory = cli();
    expect((await factory.run(RUN, [VALID])).code).toBe(EXIT_CODES.ok);
    const workItem = await findWorkItemByIssue(db.pool, REPOSITORY, ISSUE.number);
    await setWorkItemState(db.pool, workItem?.id ?? "", "proposal-approved");
    const comments = forge.comments.length;

    // No scripted steps: any agent run would fail the fake.
    const { code, out } = await factory.run(RUN);

    expect(code).toBe(EXIT_CODES.ok);
    expect(factory.calls).toHaveLength(1);
    expect(forge.comments).toHaveLength(comments);
    expect(out).toContain("proposal-approved");
    expect((await findWorkItemByIssue(db.pool, REPOSITORY, ISSUE.number))?.state).toBe("proposal-approved");
  });

  it("re-running an escalated work item runs no agent and exits non-zero", async () => {
    const factory = cli();
    const first = await factory.run(RUN, [INVALID, INVALID, INVALID]);
    expect(first.code).toBe(EXIT_CODES.failed);
    expect((await findWorkItemByIssue(db.pool, REPOSITORY, ISSUE.number))?.state).toBe("escalated");
    const attempts = await attemptCount();
    const comments = forge.comments.length;

    const { code, out, err } = await factory.run(RUN);

    expect(code).toBe(EXIT_CODES.failed);
    expect(factory.calls).toHaveLength(3);
    expect(await attemptCount()).toBe(attempts);
    expect(forge.comments).toHaveLength(comments);
    expect(out + err).toContain("escalated");
    expect((await findWorkItemByIssue(db.pool, REPOSITORY, ISSUE.number))?.state).toBe("escalated");
  });
});

describe("factory run, on a target", { timeout: 60_000 }, () => {
  const CEH = resolve(import.meta.dirname, "../../..");
  /** What a run must leave alone in the checkout it is run from: its branches, worktrees and files. */
  const checkout = () => [git(CEH, "branch", "--list"), git(CEH, "worktree", "list"), git(CEH, "status", "--porcelain")];

  it("Scenario: Local run works on a clone of the target", async () => {
    const factoryHome = join(root, "ceh-home");
    const local = localTargetPaths(TARGET, factoryHome);
    expect(local.repo).toBe(join(factoryHome, "targets/vocab/repo"));
    const before = checkout();
    const factory = cli();
    // As main.ts wires it: the clone is made through the Forge, under the factory home.
    const onTarget: Partial<CliEnv> = {
      runContext: async (target) => {
        const place = await prepareLocalTarget(target, forge, factoryHome);
        const fake = createFakeRoleRunner(new LedgerRecorder(db.pool), [VALID]);
        const store = new FsStore(place.storeDir);
        return { forge, runRole: fake.runRole, role, repo: place.repo, home: place.home, ...roles, store, runBuild: createFakeBuildRunner(store, []).runBuild, cloneUrl: remote };
      },
    };

    // No --target: vocab is the only one.
    const { code } = await factory.run(RUN, [], [], onTarget);

    expect(code).toBe(EXIT_CODES.ok);
    expect(git(local.repo, "remote", "get-url", "origin")).toBe(remote);
    const worktree = join(factoryHome, "targets/vocab/worktrees", CHANGE_ID);
    expect(git(worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(CHANGE_ID);
    expect(existsSync(join(worktree, "openspec/changes", CHANGE_ID, "proposal.md"))).toBe(true);
    expect(await findWorkItemByIssue(db.pool, "miklospocsaji/vocab", ISSUE.number)).toMatchObject({ repository: "miklospocsaji/vocab", state: "awaiting-proposal-approval" });
    expect(checkout()).toEqual(before);

    // A second command reuses the clone: nothing is cloned again, and the work item is found.
    const head = git(local.repo, "rev-parse", "HEAD");
    const again = await factory.run([...RUN, "--target", "vocab"], [], [], onTarget);
    expect(again.out).toContain("Nothing to do");
    expect(git(local.repo, "rev-parse", "HEAD")).toBe(head);
  });

  it("Scenario: Ambiguous or unknown target is a usage error", async () => {
    const factory = cli();
    let prepared = 0;
    let contexts = 0;
    const two: Partial<CliEnv> = {
      listTargets: () => Promise.resolve(["other", "vocab"]),
      prepare: () => {
        prepared += 1;
        return Promise.resolve();
      },
      runContext: () => {
        contexts += 1;
        return Promise.reject(new Error("no run context for a usage error"));
      },
    };

    const ambiguous = await factory.run(RUN, [VALID], [], two);
    expect(ambiguous.code).toBe(EXIT_CODES.usage);
    expect(ambiguous.err).toContain("--target");
    expect(ambiguous.err).toContain("other, vocab");

    for (const command of [RUN, APPROVE, COST]) {
      const unknown = await factory.run([...command, "--target", "nosuch"], [VALID], [], two);
      expect(unknown.code, command[0]).toBe(EXIT_CODES.usage);
      expect(unknown.err, command[0]).toContain("nosuch");
      expect(unknown.err, command[0]).toContain("other, vocab");
    }

    // Neither the ledger (its migrations) nor GitHub was touched, and no agent ran.
    expect(prepared).toBe(0);
    expect(contexts).toBe(0);
    expect(factory.calls).toHaveLength(0);
    expect(forge.comments).toHaveLength(0);
    expect(await findWorkItemByIssue(db.pool, REPOSITORY, ISSUE.number)).toBeUndefined();

    // Named, a target among several works.
    const named = await factory.run([...RUN, "--target", "vocab"], [VALID], [], { listTargets: () => Promise.resolve(["other", "vocab"]), prepare: () => Promise.resolve(void (prepared += 1)) });
    expect(named.code).toBe(EXIT_CODES.ok);
    expect(prepared).toBe(1);
  });
});

describe("factory run, after Proposal", { timeout: 60_000 }, () => {
  it("Scenario: Local run reaches the pull request", async () => {
    const factory = cli();
    expect((await factory.run(RUN, [VALID])).code).toBe(EXIT_CODES.ok);
    const approval = await factory.run(APPROVE);
    expect(approval.code).toBe(EXIT_CODES.ok);
    expect((await findWorkItemByIssue(db.pool, REPOSITORY, ISSUE.number))?.state).toBe("proposal-approved");

    const { code, out } = await factory.run(until("pr"), [PLANNER], BUILDS);

    expect(code).toBe(EXIT_CODES.ok);
    // The plan's tasks are built in order, tests first.
    expect(factory.builds.map((call) => [call.taskId, call.next.role])).toEqual([
      ["1.1", "test-author"],
      ["1.1", "implementer"],
      ["1.2", "test-author"],
      ["1.2", "implementer"],
    ]);
    // Each is ticked in tasks.md on the branch.
    const tasksMd = git(remote, "show", `refs/heads/${CHANGE_ID}:openspec/changes/${CHANGE_ID}/tasks.md`);
    expect(tasksMd).toContain("- [x] 1.1 Parse the lookups");
    expect(tasksMd).toContain("- [x] 1.2 Count the lookups");
    // A pull request is open from the change branch, and the work item is pr-open.
    expect(forge.pullRequests).toEqual([expect.objectContaining({ head: CHANGE_ID, base: "master" })]);
    const workItem = await findWorkItemByIssue(db.pool, REPOSITORY, ISSUE.number);
    expect(workItem?.state).toBe("pr-open");
    expect(out).toContain("pr-open");
    expect(out).toContain(forge.pullRequests[0]?.url ?? "no url");
  });

  it("stops with --until design once the design is accepted", async () => {
    const factory = cli();
    expect((await factory.run(RUN, [MEDIUM])).code).toBe(EXIT_CODES.ok);
    expect((await factory.run(APPROVE)).code).toBe(EXIT_CODES.ok);

    const { code, out } = await factory.run(until("design"), [ARCHITECT, REVIEW_APPROVES]);

    expect(code).toBe(EXIT_CODES.ok);
    expect(factory.calls.map((call) => call.role)).toEqual(["proposal-author", "architect", "design-reviewer"]);
    expect((await findWorkItemByIssue(db.pool, REPOSITORY, ISSUE.number))?.state).toBe("plan");
    expect(out).toContain("plan");
    expect(factory.builds).toEqual([]);
  });

  it("stops with --until plan once the plan is stored", async () => {
    const factory = cli();
    expect((await factory.run(RUN, [VALID])).code).toBe(EXIT_CODES.ok);
    expect((await factory.run(APPROVE)).code).toBe(EXIT_CODES.ok);

    const { code, out } = await factory.run(until("plan"), [PLANNER]);

    expect(code).toBe(EXIT_CODES.ok);
    expect(factory.calls.map((call) => call.role)).toEqual(["proposal-author", "planner"]);
    expect((await findWorkItemByIssue(db.pool, REPOSITORY, ISSUE.number))?.state).toBe("build");
    expect(out).toContain("build");
    expect(factory.builds).toEqual([]);
    expect(forge.pullRequests).toEqual([]);
  });

  it("stops at an open approval and names the approve command", async () => {
    const factory = cli();

    const { code, out } = await factory.run(until("pr"), [VALID]);

    expect(code).toBe(EXIT_CODES.ok);
    expect(factory.calls.map((call) => call.role)).toEqual(["proposal-author"]);
    expect((await findWorkItemByIssue(db.pool, REPOSITORY, ISSUE.number))?.state).toBe("awaiting-proposal-approval");
    expect(out).toContain(`pnpm factory approve --issue ${String(ISSUE.number)}`);
  });

  it("stops at a large change's design approval, which approve closes", async () => {
    const factory = cli();
    const large: FakeStep = { ...VALID, files: { ...VALID.files, ".openspec.yaml": CHANGE_FILES.metadata.replace("small", "large") } };
    expect((await factory.run(RUN, [large])).code).toBe(EXIT_CODES.ok);
    expect((await factory.run(APPROVE)).code).toBe(EXIT_CODES.ok);

    const stopped = await factory.run(until("pr"), [ARCHITECT]);
    expect(stopped.code).toBe(EXIT_CODES.ok);
    expect((await findWorkItemByIssue(db.pool, REPOSITORY, ISSUE.number))?.state).toBe("awaiting-design-approval");
    expect(stopped.out).toContain(`pnpm factory approve --issue ${String(ISSUE.number)}`);

    const approval = await factory.run(APPROVE);
    expect(approval.code).toBe(EXIT_CODES.ok);
    expect(approval.out).toMatch(/design/i);
    const { code } = await factory.run(until("plan"), [PLANNER]);
    expect(code).toBe(EXIT_CODES.ok);
    expect((await findWorkItemByIssue(db.pool, REPOSITORY, ISSUE.number))?.state).toBe("build");
    expect(factory.calls.map((call) => call.role)).toEqual(["proposal-author", "architect", "planner"]);
  });

  it("answers approve with nothing awaiting, changing nothing", async () => {
    const factory = cli();
    expect((await factory.run(RUN, [VALID])).code).toBe(EXIT_CODES.ok);
    expect((await factory.run(APPROVE)).code).toBe(EXIT_CODES.ok);
    const comments = forge.comments.length;

    const { code, err } = await factory.run(APPROVE);

    expect(code).toBe(EXIT_CODES.failed);
    expect(err).toMatch(/nothing awaits approval/i);
    expect(err).toContain("proposal-approved");
    expect(forge.comments).toHaveLength(comments);
    expect((await findWorkItemByIssue(db.pool, REPOSITORY, ISSUE.number))?.state).toBe("proposal-approved");
  });
});

/** Seeds the comment on the issue, as its author would write it, and returns the `command` arguments for it. */
function commandFor(body: string, author: string = TARGET.owner): string[] {
  const { id } = forge.addComment({ issueNumber: ISSUE.number, author, body });
  return ["command", "--issue", String(ISSUE.number), "--comment", String(id)];
}

describe("factory command", { timeout: 60_000 }, () => {
  it("Scenario: Local command answers on the issue", async () => {
    const factory = cli();
    expect((await factory.run(RUN, [VALID])).code).toBe(EXIT_CODES.ok);
    const comments = forge.comments.length;

    const { code, out } = await factory.run(commandFor("/status"));

    expect(code).toBe(EXIT_CODES.ok);
    expect(forge.comments).toHaveLength(comments + 1);
    expect(forge.comments.at(-1)?.issueNumber).toBe(ISSUE.number);
    expect(forge.comments.at(-1)?.body).toContain(CHANGE_ID);
    expect(forge.comments.at(-1)?.body).toContain("`awaiting-proposal-approval`");
    expect(out).toContain("/status");
    expect(out).toContain("applied");
    expect(factory.calls.map((call) => call.role)).toEqual(["proposal-author"]);
  });

  it("Scenario: Local approval by command", async () => {
    const factory = cli();
    expect((await factory.run(RUN, [VALID])).code).toBe(EXIT_CODES.ok);
    const workItem = await findWorkItemByIssue(db.pool, REPOSITORY, ISSUE.number);
    // A local run opens no approval row; one left open (by an earlier cloud run, say) is closed by the owner.
    await openApproval(db.pool, { workItemId: workItem?.id ?? "", taskToken: "AQB8AAAAKgAAAAMAAAAAAAAAAeTaskToken" });
    const comments = forge.comments.length;

    const { code } = await factory.run(commandFor("/approve"));

    expect(code).toBe(EXIT_CODES.ok);
    const { rows } = await db.pool.query<{ state: string; resolved_by: string | null }>("SELECT state, resolved_by FROM approvals WHERE work_item_id = $1", [workItem?.id]);
    expect(rows).toEqual([{ state: "closed", resolved_by: TARGET.owner }]);
    expect((await findWorkItemByIssue(db.pool, REPOSITORY, ISSUE.number))?.state).toBe("proposal-approved");
    // One reply: Approved's confirmation.
    expect(forge.comments).toHaveLength(comments + 1);
    expect(forge.comments.at(-1)?.body).toMatch(/\bproposal\b.*\bapproved\b/i);

    // pnpm factory run goes on from there.
    const next = await factory.run(until("plan"), [PLANNER]);

    expect(next.code).toBe(EXIT_CODES.ok);
    expect((await findWorkItemByIssue(db.pool, REPOSITORY, ISSUE.number))?.state).toBe("build");
    expect(factory.calls.map((call) => call.role)).toEqual(["proposal-author", "planner"]);
  });

  it("refuses another user's comment with exit 1, replying nothing and changing nothing", async () => {
    const factory = cli();
    expect((await factory.run(RUN, [VALID])).code).toBe(EXIT_CODES.ok);
    const comments = forge.comments.length;

    const { code, err } = await factory.run(commandFor("/approve", "someone-else"));

    expect(code).toBe(EXIT_CODES.failed);
    expect(err).toContain("someone-else");
    expect(forge.comments).toHaveLength(comments);
    expect((await findWorkItemByIssue(db.pool, REPOSITORY, ISSUE.number))?.state).toBe("awaiting-proposal-approval");
  });

  it.each([
    ["no --comment", ["command", "--issue", "12"]],
    ["a comment id that is not a number", ["command", "--issue", "12", "--comment", "x1"]],
    ["--comment on run", ["run", "--issue", "12", "--until", "proposal", "--comment", "5"]],
  ])("is a usage error with %s", async (_label, argv) => {
    const { code, err } = await cli().run(argv);

    expect(code).toBe(EXIT_CODES.usage);
    expect(err).toContain("pnpm factory command --issue <n> --comment <id>");
    expect(forge.comments).toEqual([]);
  });
});

describe("factory cost", () => {
  it("Scenario: Cost is visible after a run", async () => {
    const factory = cli();
    // Each fake attempt records 1,000 input and 500 output tokens.
    expect((await factory.run(RUN, [{ ...INVALID, costUsd: 0.25 }, { ...VALID, costUsd: 0.5 }])).code).toBe(EXIT_CODES.ok);

    const { code, out } = await factory.run(COST);

    expect(code).toBe(EXIT_CODES.ok);
    const lines = out.split("\n");
    const attempt = (n: number) => lines.find((line) => new RegExp(`^\\s*#${String(n)}\\b`).test(line)) ?? "";
    expect(attempt(1)).toMatch(/proposal-author/);
    expect(attempt(1)).toMatch(/failed.*invalid-change/);
    expect(attempt(1)).toMatch(/subscription/);
    expect(attempt(1)).toMatch(/1,500 tokens/);
    expect(attempt(1)).toMatch(/\$0\.25\b/);
    expect(attempt(2)).toMatch(/succeeded/);
    expect(attempt(2)).toMatch(/subscription/);
    expect(attempt(2)).toMatch(/1,500 tokens/);
    expect(attempt(2)).toMatch(/\$0\.50\b/);
    expect(lines.find((line) => /total/i.test(line))).toMatch(/3,000 tokens.*\$0\.75\b/);
    expect(out).toContain(CHANGE_ID);
  });
});
