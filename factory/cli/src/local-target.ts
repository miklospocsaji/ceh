/**
 * Where a local run works on a target (add-target-repositories design, "Local CLI"): never in the
 * checkout the CLI runs from, but under the factory home, per target:
 *
 *   <factory home>/targets/<name>/repo        a clone of the target's repository
 *   <factory home>/targets/<name>/worktrees/  one worktree per work item
 *   <factory home>/targets/<name>/store/      the artifact store the build container mounts
 *
 * The clone is made through the Forge, so its `origin` is the target's repository and no
 * credential is stored in it. An existing clone is used as it is: each work item's worktree
 * fetches its own branch.
 */
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Forge } from "@ceh/factory-forge";
import type { Target } from "@ceh/factory-target";

const run = promisify(execFile);

export interface LocalTarget {
  /** The handlers' home for this target: its worktrees live in `<home>/worktrees`. */
  home: string;
  /** The clone the worktrees are added to. */
  repo: string;
  /** The FsStore's directory. */
  storeDir: string;
}

/** The target's folders under the factory home; nothing is created. */
export function localTargetPaths(target: Pick<Target, "name">, factoryHome: string): LocalTarget {
  const home = join(factoryHome, "targets", target.name);
  return { home, repo: join(home, "repo"), storeDir: join(home, "store") };
}

/** The target's folders, with the clone made if it is missing. */
export async function prepareLocalTarget(target: Pick<Target, "name">, forge: Pick<Forge, "clone">, factoryHome: string): Promise<LocalTarget> {
  const local = localTargetPaths(target, factoryHome);
  if (!(await isClone(local.repo))) {
    await mkdir(dirname(local.repo), { recursive: true });
    await forge.clone(local.repo);
  }
  return local;
}

async function isClone(directory: string): Promise<boolean> {
  try {
    const { stdout } = await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: directory, encoding: "utf8" });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}
