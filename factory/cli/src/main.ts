/**
 * `pnpm factory <command>`: the CLI with its real dependencies.
 * - `.env.local` at the root of this checkout (git-ignored) is loaded first, for
 *   `CLAUDE_CODE_OAUTH_TOKEN` (ADR 0006) and optionally `FACTORY_DATABASE_URL`. Variables already
 *   set win.
 * - The ledger is the Postgres at `FACTORY_DATABASE_URL`, migrated once the command line is valid.
 * - The target comes from `targets/` (`--target`, or the only one). `run` and `approve` read the
 *   owner's token with `gh auth token`, talk to the target's repository on GitHub, and work on a
 *   clone of it under the factory home (`local-target.ts`), never on this checkout. Roles run
 *   through the Agent SDK, resolved for the target. The token is never logged.
 * - Builds run in the target's locally built build image through Docker, with the artifact store
 *   mounted and only `CLAUDE_CODE_OAUTH_TOKEN` passed in (add-build-loop design, "Local runs").
 *   The image clones the target's repository with no token.
 * Exit codes are `EXIT_CODES` in cli.ts.
 */
import { join, resolve } from "node:path";
import { ghAuthToken, GitHubForge } from "@ceh/factory-forge";
import { databaseUrl, LedgerRecorder, migrate } from "@ceh/factory-ledger";
import { factoryHome } from "@ceh/factory-orchestrator";
import { createRunner, loadRole } from "@ceh/factory-roles";
import { cloneUrl, listTargets, loadTarget, repositoryParts } from "@ceh/factory-target";
import { localBuildImage } from "@ceh/factory-worker/image";
import { FsStore } from "@ceh/factory-worker/store";
import pg from "pg";
import { EXIT_CODES, runCli } from "./cli.ts";
import { dockerBuildRunner } from "./docker-build.ts";
import { prepareLocalTarget } from "./local-target.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const PROPOSAL_AUTHOR = "proposal-author";

function loadEnvLocal(): void {
  try {
    process.loadEnvFile(join(REPO_ROOT, ".env.local"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function main(): Promise<number> {
  loadEnvLocal();
  const pool = new pg.Pool({ connectionString: databaseUrl() });
  try {
    return await runCli(process.argv.slice(2), {
      db: pool,
      out: (text) => process.stdout.write(text),
      err: (text) => process.stderr.write(text),
      listTargets: () => listTargets(),
      loadTarget: (name) => loadTarget(name),
      prepare: async () => {
        await migrate(pool);
      },
      runContext: async (target) => {
        const token = await ghAuthToken();
        const forge = new GitHubForge({ ...repositoryParts(target), token });
        const local = await prepareLocalTarget(target, forge, factoryHome());
        const [role, architect, designReviewer, planner, testAuthor, implementer, classifier] = await Promise.all(
          [PROPOSAL_AUTHOR, "architect", "design-reviewer", "planner", "test-author", "implementer", "failure-classifier"].map((name) => loadRole(name, target)),
        );
        if (role === undefined || architect === undefined || designReviewer === undefined || planner === undefined || testAuthor === undefined || implementer === undefined || classifier === undefined) {
          throw new Error("a role config is missing");
        }
        return {
          forge,
          runRole: createRunner({ recorder: new LedgerRecorder(pool) }),
          role,
          architect,
          designReviewer,
          planner,
          planPaths: { implementer: implementer.writable, testAuthor: testAuthor.writable },
          testAuthor,
          implementer,
          classifier,
          store: new FsStore(local.storeDir),
          runBuild: dockerBuildRunner({ storeDir: local.storeDir, image: localBuildImage(target), env: process.env }),
          cloneUrl: cloneUrl(target),
          repo: local.repo,
          home: local.home,
        };
      },
    });
  } finally {
    await pool.end();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`factory: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = EXIT_CODES.error;
}
