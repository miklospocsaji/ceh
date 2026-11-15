/**
 * A target's build container (add-build-roles task 2.11; add-target-repositories task 8.1): the
 * worker Dockerfile's `build-base` stage with `targets/vocab/build.Dockerfile` on top. Builds it
 * from a temp copy of this checkout, with a dummy `.env.local` and `docs/vocab.db` added, then
 * inspects it. The image holds no dependencies of the target's; the install is online.
 * Needs Docker; runs only through `pnpm test:docker`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assembleBuildDockerfile, dockerBuildArgs } from "../src/image.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const SECRET = `dummy-secret-${randomBytes(12).toString("hex")}`;
const VOCAB_DB = `dummy-vocab-db-${randomBytes(12).toString("hex")}`;
const IMAGE = `factory-build:test-${randomBytes(4).toString("hex")}`;

let context: string;

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

/** Runs a shell command in a fresh container with no network and no added capabilities. */
function sh(script: string, ...mounts: string[]): string {
  return docker("run", "--rm", "--network", "none", ...mounts.flatMap((mount) => ["--volume", mount]), "--entrypoint", "sh", IMAGE, "-c", script);
}

beforeAll(() => {
  context = realpathSync(mkdtempSync(join(tmpdir(), "factory-build-image-")));
  cpSync(REPO_ROOT, context, { recursive: true, filter: (source) => basename(source) !== "node_modules" });
  writeFileSync(join(context, ".env.local"), `CLAUDE_CODE_OAUTH_TOKEN=${SECRET}\n`);
  mkdirSync(join(context, "docs"), { recursive: true });
  writeFileSync(join(context, "docs/vocab.db"), VOCAB_DB);
  // As `pnpm image:build --target vocab` builds it: the worker Dockerfile with vocab's on top.
  docker(...dockerBuildArgs(assembleBuildDockerfile("vocab", context), IMAGE, context));
});

afterAll(() => {
  spawnSync("docker", ["image", "rm", "--force", IMAGE], { stdio: "ignore" });
  rmSync(context, { recursive: true, force: true });
});

describe("factory-build image", () => {
  it("Scenario: Worker image holds no secrets (build target)", () => {
    const found = sh("find / -xdev \\( -name .env.local -o -name vocab.db -o -name .git \\) -print 2>/dev/null || true");
    expect(found).toBe("");
    const leaked = sh(`grep -rlsF -e '${SECRET}' -e '${VOCAB_DB}' / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev || true`);
    expect(leaked).toBe("");
    expect(docker("history", "--no-trunc", IMAGE)).not.toContain(SECRET);

    const user = docker("image", "inspect", "--format", "{{.Config.User}}", IMAGE);
    expect(user).not.toBe("");
    expect(["root", "0", "0:0"]).not.toContain(user);
    expect(sh("id -u")).not.toBe("0");
  });

  it("says it is the build container, and runs factory-build", () => {
    const env = JSON.parse(docker("image", "inspect", "--format", "{{json .Config.Env}}", IMAGE)) as string[];
    expect(env).toContain("FACTORY_CONTAINER=build");
    expect(JSON.parse(docker("image", "inspect", "--format", "{{json .Config.Entrypoint}}", IMAGE))).toEqual(["node", "/app/factory/worker/src/build-main.ts"]);
  });

  it("refuses a factory credential with exit 2, naming the variable and not its value", () => {
    const run = spawnSync("docker", ["run", "--rm", "--network", "none", "--env", `FACTORY_LEDGER_SECRET=${SECRET}`, IMAGE, "implementer", "--input", "work-items/x/input.json"], {
      encoding: "utf8",
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("FACTORY_LEDGER_SECRET");
    expect(`${run.stdout}${run.stderr}`).not.toContain(SECRET);
  });

  it("holds pnpm, git and the dev dependencies", () => {
    expect(sh("pnpm --version")).toMatch(/^12\.15\.0$/);
    expect(sh("git --version")).toMatch(/^git version /);
    expect(sh("cd /app && node_modules/.bin/vitest --version")).toContain("5.0.5");
  });

  it("Scenario: Target image adds only its toolchain", () => {
    const env = JSON.parse(docker("image", "inspect", "--format", "{{json .Config.Env}}", IMAGE)) as string[];
    expect(env).toContain("FACTORY_TARGET=vocab");
    expect(JSON.parse(docker("image", "inspect", "--format", "{{json .Config.Entrypoint}}", IMAGE))).toEqual(["node", "/app/factory/worker/src/build-main.ts"]);
    expect(sh("id -un")).toBe("factory");
    // The target's config is in the image, for factory-build to load.
    expect(sh("cat /app/targets/vocab/target.yaml")).toContain("repository: miklospocsaji/vocab");

    // No dependency store, warm or left over, and no node_modules but the factory's own and the tools'.
    expect(env.some((entry) => entry.startsWith("FACTORY_PNPM_STORE="))).toBe(false);
    expect(sh("ls -d /opt/pnpm-store /home/factory/.local/share/pnpm /home/factory/.cache/pnpm /root/.local/share/pnpm 2>/dev/null || true")).toBe("");
    const modules = sh("find / -xdev -type d -name node_modules -prune -print 2>/dev/null || true").split("\n").filter((path) => path !== "");
    expect(modules.filter((path) => !path.startsWith("/app/") && !path.startsWith("/usr/local/lib/") && !path.startsWith("/opt/pnpm/"))).toEqual([]);
    // None of the target's code either: the build clones it.
    expect(sh("ls /app")).not.toMatch(/^app$/m);

    const bytes = Number(docker("image", "inspect", "--format", "{{.Size}}", IMAGE));
    console.info(`vocab build image: ${(bytes / 1e9).toFixed(2)} GB`);
  });

  it("refuses an input for another target before cloning", () => {
    // A store with one input, for a target this image is not: exit 2, naming both.
    const store = join(context, "store-other");
    mkdirSync(join(store, "work-items/x"), { recursive: true });
    writeFileSync(
      join(store, "work-items/x/input.json"),
      JSON.stringify({ target: "other", changeId: "add-x", branch: "add-x", baseCommit: "0".repeat(40), cloneUrl: "/nowhere", task: { id: "1.1", title: "t", dependsOn: [], files: [], scenarios: [], tests: [] } }),
    );
    const run = spawnSync("docker", ["run", "--rm", "--network", "none", "--volume", `${store}:/store:ro`, "--env", "FACTORY_STORE_DIR=/store", IMAGE, "implementer", "--input", "work-items/x/input.json"], { encoding: "utf8" });
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(2);
    expect(run.stderr).toContain("target other");
    expect(run.stderr).toContain("target vocab");
  });
});
