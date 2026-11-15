/**
 * A target: one repository the factory works on, as `targets/<name>/target.yaml` describes it
 * (ADR 0014). Everything the factory knows about the repository is here: where it is, who may
 * approve, which commands check it, and which paths its build roles may write. The writable
 * globs are a security boundary, so the loader refuses any that leave the target's own code.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { minimatch } from "minimatch";
import { parse } from "yaml";
import { z } from "zod";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const TARGETS_DIR = "targets";
const CHANGE_ID = "{changeId}";

const NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
/** Words of these characters, separated by single spaces: nothing a shell would read as syntax. */
const COMMAND = /^[A-Za-z0-9@%+=:,./_{}-]+( [A-Za-z0-9@%+=:,./_{}-]+)*$/;
/** First path segments no role of a target may write: the change and specs, git, CI and the session's own settings. */
const RESERVED = ["openspec", ".git", ".github", ".claude"];

/** A command: plain words, with no placeholder unless `placeholder` allows `{changeId}`. */
const command = (placeholder = false) =>
  z
    .string()
    .regex(COMMAND, "must be plain words separated by single spaces, with no quoting or shell syntax")
    .refine((text) => !/[{}]/.test(placeholder ? text.replaceAll(CHANGE_ID, "") : text), placeholder ? `may hold only the placeholder ${CHANGE_ID}` : "may hold no placeholder");

/** Why a path or glob may not be in a target config; undefined if it may. A leading `!` marks an exclusion. */
function pathProblem(value: string): string | undefined {
  const path = value.startsWith("!") ? value.slice(1) : value;
  const segments = path.replace(/\/$/, "").split("/");
  const first = segments[0] ?? "";
  if (path === "" || path.startsWith("/") || path.startsWith("~")) return "must be relative to the repository";
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return "must not hold empty, `.` or `..` segments";
  if (/[*?[\]{}()!]/.test(first)) return "must start with a literal folder or file name";
  if (RESERVED.includes(first)) return `must not start with ${first}`;
  return undefined;
}

const path = z.string().superRefine((value, ctx) => {
  const problem = pathProblem(value);
  if (problem !== undefined) ctx.addIssue({ code: "custom", message: `${value} ${problem}` });
});

export const TargetSchema = z
  .strictObject({
    /** The target's name, which is also its folder under `targets/`. */
    name: z.string().regex(NAME, "must be kebab-case"),
    /** `<owner>/<repo>` on GitHub. */
    repository: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, "must be <owner>/<repo>"),
    /** The branch pull requests merge into. */
    defaultBranch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "must be a branch name"),
    /** The only login whose `/approve` counts (ADR 0009). */
    owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/, "must be a GitHub login"),
    commands: z.strictObject({
      /** Run in the build container's clone before each session, online, with no credential. */
      install: command(),
      typecheck: command(),
      lint: command(),
      /** A Vitest run: the gates append their reporters and `unitTestPath`. */
      unit: command(),
      /** `{changeId}` is replaced by the change id. */
      specValidate: command(true),
    }),
    /** What the unit command runs: its last argument. */
    unitTestPath: path,
    /** Where scenario coverage looks for tests when there is no Vitest report. */
    coverageTestsDir: path,
    /** The architect's path, which no build role may write. */
    contracts: path,
    /** The writable globs per role name; a `!` glob excludes what it matches. */
    writable: z.record(z.string().regex(NAME, "must be a role name"), z.array(path).min(1)),
    /** Model spend per work item, in USD. */
    budgetUsd: z.number().positive(),
  })
  .superRefine((target, ctx) => {
    // A probe file under the contracts path: no role's globs may match it.
    const probe = `${target.contracts.replace(/\/$/, "")}/contract.ts`;
    for (const [role, globs] of Object.entries(target.writable)) {
      if (isWritable(probe, globs) || isWritable(target.contracts, globs)) {
        ctx.addIssue({ code: "custom", path: ["writable", role], message: `the ${role} could write the contracts path ${target.contracts}; exclude it with a ! glob` });
      }
    }
  });

export type Target = z.infer<typeof TargetSchema>;

/** As the role guard matches: a path is writable if a glob matches it and no `!` glob does. */
function isWritable(file: string, globs: readonly string[]): boolean {
  const matches = (glob: string): boolean => minimatch(file, glob, { dot: true });
  return !globs.some((glob) => glob.startsWith("!") && matches(glob.slice(1))) && globs.some((glob) => !glob.startsWith("!") && matches(glob));
}

export class TargetConfigError extends Error {
  readonly target: string;
  readonly field: string;

  constructor(target: string, field: string, detail: string) {
    super(`target ${target}: invalid ${field}: ${detail}`);
    this.name = "TargetConfigError";
    this.target = target;
    this.field = field;
  }
}

export interface TargetOptions {
  /** The folder that holds `targets/`; defaults to this repository. */
  root?: string;
}

/** Loads and validates `targets/<name>/target.yaml`; any problem is a TargetConfigError naming the target and the field. */
export async function loadTarget(name: string, options: TargetOptions = {}): Promise<Target> {
  if (!NAME.test(name)) throw new TargetConfigError(name, "name", "a target's name is kebab-case");
  const file = join(TARGETS_DIR, name, "target.yaml");
  let raw: string;
  try {
    raw = await readFile(join(options.root ?? REPO_ROOT, file), "utf8");
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : String(error);
    throw new TargetConfigError(name, "config", `${file} is ${reason}`);
  }
  let data: unknown;
  try {
    data = parse(raw);
  } catch (error) {
    throw new TargetConfigError(name, "config", `${file} is not valid YAML: ${String(error)}`);
  }
  const parsed = TargetSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new TargetConfigError(name, issue?.path.join(".") || "config", issue?.message ?? "invalid");
  }
  if (parsed.data.name !== name) throw new TargetConfigError(name, "name", `${file} names the target ${parsed.data.name}`);
  return parsed.data;
}

/** The names of the folders under `targets/`, sorted; none if there is no such folder. */
export async function listTargets(options: TargetOptions = {}): Promise<string[]> {
  try {
    const entries = await readdir(join(options.root ?? REPO_ROOT, TARGETS_DIR), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** No target was named, and `targets/` does not hold exactly one. */
export class NoSingleTarget extends Error {
  readonly targets: readonly string[];

  constructor(targets: readonly string[]) {
    super(targets.length === 0 ? "there is no target under targets/" : `name a target: targets/ holds ${targets.join(", ")}`);
    this.name = "NoSingleTarget";
    this.targets = targets;
  }
}

/** The only target, loaded; a NoSingleTarget if there are none or several. */
export async function onlyTarget(options: TargetOptions = {}): Promise<Target> {
  const names = await listTargets(options);
  const [name, ...rest] = names;
  if (name === undefined || rest.length > 0) throw new NoSingleTarget(names);
  return loadTarget(name, options);
}

/** A command's words, for running it without a shell; `{changeId}` is filled in when given. */
export function commandArgs(command: string, changeId?: string): [string, ...string[]] {
  const [file = "", ...args] = (changeId === undefined ? command : command.replaceAll(CHANGE_ID, changeId)).split(" ");
  return [file, ...args];
}

/** The clone URL of the target's repository, with no credential in it. */
export function cloneUrl(target: Pick<Target, "repository">): string {
  return `https://github.com/${target.repository}.git`;
}

/** The owner and name of the target's repository. */
export function repositoryParts(target: Pick<Target, "repository">): { owner: string; repo: string } {
  const [owner = "", repo = ""] = target.repository.split("/");
  return { owner, repo };
}
