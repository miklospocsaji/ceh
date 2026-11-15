/**
 * The `factory-worker` image (add-factory-worker task 1.14). Builds the image from a temp copy
 * of this checkout, with a dummy `.env.local` and `docs/vocab.db` added, then inspects it.
 * Needs Docker; runs only through `pnpm test:docker`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
/** Unique values, so finding them anywhere in the image means the file got in. */
const SECRET = `dummy-secret-${randomBytes(12).toString("hex")}`;
const VOCAB_DB = `dummy-vocab-db-${randomBytes(12).toString("hex")}`;
const IMAGE = `factory-worker:test-${randomBytes(4).toString("hex")}`;

let context: string;

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

/** Runs a shell command in a fresh container with no network and no added capabilities. */
function sh(script: string): string {
  return docker("run", "--rm", "--network", "none", "--entrypoint", "sh", IMAGE, "-c", script);
}

beforeAll(() => {
  context = realpathSync(mkdtempSync(join(tmpdir(), "factory-worker-image-")));
  // The checkout as it is, .git included; node_modules only make the copy slow.
  cpSync(REPO_ROOT, context, { recursive: true, filter: (source) => basename(source) !== "node_modules" });
  writeFileSync(join(context, ".env.local"), `CLAUDE_CODE_OAUTH_TOKEN=${SECRET}\n`);
  mkdirSync(join(context, "docs"), { recursive: true });
  writeFileSync(join(context, "docs/vocab.db"), VOCAB_DB);

  docker("build", "--platform", "linux/amd64", "--file", join(context, "factory/worker/Dockerfile"), "--tag", IMAGE, context);
});

afterAll(() => {
  spawnSync("docker", ["image", "rm", "--force", IMAGE], { stdio: "ignore" });
  rmSync(context, { recursive: true, force: true });
});

describe("factory-worker image", () => {
  it("Scenario: Worker image holds no secrets", () => {
    // Neither file, nor any .git directory, anywhere in the image.
    const found = sh("find / -xdev \\( -name .env.local -o -name vocab.db -o -name .git \\) -print 2>/dev/null || true");
    expect(found).toBe("");
    // Nor their contents, under another name.
    const leaked = sh(`grep -rlsF -e '${SECRET}' -e '${VOCAB_DB}' / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev || true`);
    expect(leaked).toBe("");
    expect(docker("history", "--no-trunc", IMAGE)).not.toContain(SECRET);

    const user = docker("image", "inspect", "--format", "{{.Config.User}}", IMAGE);
    expect(user).not.toBe("");
    expect(["root", "0", "0:0"]).not.toContain(user);
    expect(sh("id -u")).not.toBe("0");
  });

  it("is built for linux/amd64", () => {
    expect(docker("image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", IMAGE)).toBe("linux/amd64");
  });

  it("refuses an unknown state with exit 2, with no network access", () => {
    // `deploy` is no state of the worker's; `design`, which this used to name, became one in M3.
    const run = spawnSync("docker", ["run", "--rm", "--network", "none", IMAGE, "deploy", "--issue", "1"], { encoding: "utf8" });

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("unknown state deploy");
  });

  it("refuses to run without a target, or with one the image does not hold, with exit 2", () => {
    const worker = (...env: string[]) =>
      spawnSync("docker", ["run", "--rm", "--network", "none", "--env", "FACTORY_DATABASE_URL=postgres://factory:factory@localhost:1/factory", ...env.flatMap((entry) => ["--env", entry]), IMAGE, "intake", "--issue", "1"], {
        encoding: "utf8",
      });

    const none = worker();
    expect(none.status).toBe(2);
    expect(none.stderr).toContain("FACTORY_TARGET");

    const unknown = worker("FACTORY_TARGET=nosuch");
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("FACTORY_TARGET");
    expect(unknown.stderr).toContain("targets/nosuch/target.yaml is missing");

    // With the target the image holds, the configuration gets past it, to the next missing variable.
    const vocab = worker("FACTORY_TARGET=vocab");
    expect(vocab.status).toBe(2);
    expect(vocab.stderr).not.toContain("FACTORY_TARGET");
  });

  it("holds git, the pinned OpenSpec CLI and the role's config and prompt", () => {
    expect(sh("git --version")).toMatch(/^git version /);
    const pinned = (JSON.parse(execFileSync("cat", [join(REPO_ROOT, "package.json")], { encoding: "utf8" })) as { dependencies?: Record<string, string> })
      .dependencies?.["@fission-ai/openspec"];
    expect(pinned).toBeDefined();
    expect(sh("cd /app && OPENSPEC_TELEMETRY=0 node_modules/.bin/openspec --version")).toBe(pinned);
    expect(sh("test -f /app/factory/roles/proposal-author.yaml && test -f /app/factory/roles/proposal-author.md && echo ok")).toBe("ok");
    // Role prompts are not Claude Code agents (ADR 0012).
    expect(sh("test -e /app/.claude && echo present || echo absent")).toBe("absent");
  });
});
