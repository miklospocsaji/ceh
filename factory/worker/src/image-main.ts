/**
 * `pnpm image:build [--target <name>]`: builds a target's build image locally, tagged
 * `ceh-build-<name>:local`, which `pnpm factory run --until pr` runs. Without `--target`, the
 * only target.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { listTargets, loadTarget, onlyTarget } from "@ceh/factory-target";
import { assembleBuildDockerfile, dockerBuildArgs, localBuildImage } from "./image.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

try {
  const { values } = parseArgs({ args: process.argv.slice(2), strict: true, options: { target: { type: "string" } } });
  // Loaded, so a broken target config fails here and not in the first build session.
  const target = values.target === undefined ? await onlyTarget() : await loadTarget(values.target);
  const tag = localBuildImage(target);
  execFileSync("docker", dockerBuildArgs(assembleBuildDockerfile(target.name), tag), { cwd: REPO_ROOT, stdio: "inherit" });
  process.stdout.write(`Built ${tag}\n`);
} catch (error) {
  process.stderr.write(`image:build: ${error instanceof Error ? error.message : String(error)} (targets: ${(await listTargets()).join(", ") || "none"})\n`);
  process.exitCode = 1;
}
