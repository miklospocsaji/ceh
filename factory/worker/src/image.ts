/**
 * A target's build image (ADR 0010, amendment of add-target-repositories): the worker Dockerfile's
 * `build-base` stage with the target's `targets/<name>/build.Dockerfile` on top. A Dockerfile
 * cannot include another, and CDK builds its image assets in no order, so the two are assembled
 * into one file, `.build/<name>.Dockerfile`, whose `target-build` stage one `docker build` makes.
 * The worker's `.dockerignore` is copied next to it, so a plain `docker build` of the file stages
 * the same allowlisted context.
 *
 * Only Node's own modules: the CDK app imports this file.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const WORKER_DOCKERFILE = "factory/worker/Dockerfile";
/** The stage of the worker Dockerfile a target's Dockerfile starts from. */
export const BUILD_BASE_STAGE = "build-base";
/** The stage a target's Dockerfile defines: the image `factory-build` runs in. */
export const TARGET_BUILD_STAGE = "target-build";
const NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export interface AssembledDockerfile {
  /** The assembled Dockerfile, relative to the repository root: the build context. */
  file: string;
  /** The stage to build. */
  stage: string;
}

/**
 * The worker Dockerfile followed by the target's. The target's must start `FROM build-base AS
 * target-build`, set `FACTORY_TARGET` to its own name, and start from no other image: its
 * toolchain goes on top of the base, and nothing is copied in from elsewhere.
 */
export function assembleDockerfileText(name: string, worker: string, target: string): string {
  const instructions = target.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
  const froms = instructions.filter((line) => /^FROM\s/i.test(line));
  const expected = `FROM ${BUILD_BASE_STAGE} AS ${TARGET_BUILD_STAGE}`;
  if (instructions[0] !== expected || froms.length !== 1) {
    throw new Error(`targets/${name}/build.Dockerfile must start with \`${expected}\` and have no other FROM`);
  }
  if (instructions.some((line) => /^COPY\s.*--from=/i.test(line))) throw new Error(`targets/${name}/build.Dockerfile must not COPY --from another image`);
  if (!instructions.some((line) => new RegExp(`^ENV\\s+FACTORY_TARGET=${name}$`).test(line))) {
    throw new Error(`targets/${name}/build.Dockerfile must set \`ENV FACTORY_TARGET=${name}\``);
  }
  return `${worker.trimEnd()}\n\n# --- targets/${name}/build.Dockerfile, assembled by factory/worker/src/image.ts ---\n${target.trimEnd()}\n`;
}

/** Writes `.build/<name>.Dockerfile` and its `.dockerignore` under `root`, and says what to build. */
export function assembleBuildDockerfile(name: string, root: string = REPO_ROOT): AssembledDockerfile {
  if (!NAME.test(name)) throw new Error(`${name} is not a target name`);
  const text = assembleDockerfileText(name, readFileSync(join(root, WORKER_DOCKERFILE), "utf8"), readFileSync(join(root, "targets", name, "build.Dockerfile"), "utf8"));
  const file = `.build/${name}.Dockerfile`;
  mkdirSync(join(root, ".build"), { recursive: true });
  writeFileSync(join(root, file), text);
  writeFileSync(join(root, `${file}.dockerignore`), readFileSync(join(root, `${WORKER_DOCKERFILE}.dockerignore`), "utf8"));
  return { file, stage: TARGET_BUILD_STAGE };
}

/** The tag of a target's locally built build image (`pnpm image:build --target <name>`). */
export function localBuildImage(target: { name: string }): string {
  return `ceh-build-${target.name}:local`;
}

/** The `docker build` arguments for a target's build image, run from the repository root. */
export function dockerBuildArgs(assembled: AssembledDockerfile, tag: string, context = "."): string[] {
  return ["build", "--platform", "linux/amd64", "--file", join(context, assembled.file), "--target", assembled.stage, "--tag", tag, context];
}
