/**
 * `factory-worker <state> --issue <n>`: the worker with its real dependencies, the entry
 * point of the `factory-worker` image (ADR 0010).
 * - The command line is checked first, so invalid input exits 2 with no configuration,
 *   database or network.
 * - Configuration comes from the environment (`config.ts`), and the target it names
 *   (`FACTORY_TARGET`) from `targets/` in the image. The App's private key and the
 *   ledger's secret or URL are removed from `process.env` once read, so no child process
 *   inherits them.
 * - Each connection attempt is bounded, so `runWorker`'s wait for a resuming Aurora can retry.
 * - The Forge is the factory's GitHub App (ADR 0009), and commits are its bot user's
 *   (`github.ts`). A `command` task whose App set-up fails still tries its fixed reply.
 * - The clone and the worktrees live in a temp home, removed at the end.
 * - Step Functions, ECS and the artifact bucket (`FACTORY_STORE_BUCKET`) are reached with the
 *   task role's credentials, in the task's region. A `/resume` starts an execution of the state
 *   machine `FACTORY_STATE_MACHINE_ARN` names (add-work-item-resume). The build task clones the repository over public
 *   HTTPS with no token.
 * - Roles and prompts come from the image, resolved for the target.
 * Nothing printed contains a secret: errors from the Forge are scrubbed of tokens, and
 * configuration errors name a variable only. Exit codes are `WORKER_EXIT` in worker.ts.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ECSClient, StopTaskCommand } from "@aws-sdk/client-ecs";
import {
  DescribeExecutionCommand,
  GetExecutionHistoryCommand,
  SendTaskFailureCommand,
  SendTaskSuccessCommand,
  SFNClient,
  StartExecutionCommand,
  StopExecutionCommand,
} from "@aws-sdk/client-sfn";
import { DATABASE_URL_VAR, LEDGER_SECRET_VAR, LedgerRecorder } from "@ceh/factory-ledger";
import { createRunner, loadRole } from "@ceh/factory-roles";
import { cloneUrl, type Target } from "@ceh/factory-target";
import pg from "pg";
import { ENV, parseWorkerArgs, USAGE, WorkerConfigError, workerConfig } from "./config.ts";
import type { EcsTasks, ExecutionEvent, Executions, TaskTokens } from "@ceh/factory-orchestrator";
import { connectGitHub } from "./github.ts";
import { STORE_ENV, storeFromEnv, type ArtifactStore } from "./store.ts";
import { runWorker, WORKER_EXIT, type WorkerRoles } from "./worker.ts";

const PROPOSAL_AUTHOR = "proposal-author";
/** One connection attempt; runWorker's waitForLedger retries within its 180 s. */
const LEDGER_CONNECT_TIMEOUT_MS = 10_000;
/** The factory's region (brief, section 5), if the task's environment does not name one. */
const DEFAULT_REGION = "eu-central-1";
/** The work-item state machine a `/resume` starts, set by the stack. */
const STATE_MACHINE_VAR = "FACTORY_STATE_MACHINE_ARN";
/** GetExecutionHistory pages read before the abort gives up on finding the running task. */
const HISTORY_PAGES = 5;

const out = (text: string) => process.stdout.write(text);
const err = (text: string) => process.stderr.write(text);

async function main(argv: string[]): Promise<number> {
  const args = parseWorkerArgs(argv);
  if (!args.ok) {
    err(`factory-worker: ${args.message}\n\n${USAGE}`);
    return WORKER_EXIT.invalid;
  }

  let config;
  try {
    config = await workerConfig(process.env);
  } catch (error) {
    if (!(error instanceof WorkerConfigError)) throw error;
    err(`factory-worker: ${error.message}\n`);
    return WORKER_EXIT.invalid;
  }
  // Only `step` uses the store; the other states run without one.
  const store = storeFromEnv(process.env) ?? missingStore();
  const taskToken = process.env[ENV.taskToken];
  // Read once; no child process (git, openspec, the role session) needs them.
  Reflect.deleteProperty(process.env, ENV.privateKey);
  Reflect.deleteProperty(process.env, DATABASE_URL_VAR);
  Reflect.deleteProperty(process.env, LEDGER_SECRET_VAR);
  Reflect.deleteProperty(process.env, ENV.taskToken);

  // A `command` task whose set-up fails still answers the owner, or logs that it could not.
  const github = await connectGitHub({ args, config, err });
  if (!github.ok) return github.code;
  const { forge, committer } = github;

  // A bounded connect, so a resuming Aurora is retried rather than waited on forever.
  const pool = new pg.Pool({ ...config.ledger, connectionTimeoutMillis: LEDGER_CONNECT_TIMEOUT_MS });
  const home = await mkdtemp(join(tmpdir(), "factory-worker-"));
  try {
    return await runWorker(argv, {
      db: pool,
      forge,
      runRole: createRunner({ recorder: new LedgerRecorder(pool) }),
      target: config.target,
      role: await loadRole(PROPOSAL_AUTHOR, config.target),
      roles: await loadRoles(config.target),
      store,
      cloneUrl: cloneUrl(config.target),
      home,
      committer,
      taskTokens: stepFunctions(),
      executions: executions(process.env[STATE_MACHINE_VAR]),
      ecsTasks: ecsTasks(),
      ...(taskToken === undefined ? {} : { taskToken }),
      out,
      err,
    });
  } finally {
    await rm(home, { recursive: true, force: true });
    await pool.end();
  }
}

/** A store that fails every call, naming the variables that would configure one. */
function missingStore(): ArtifactStore {
  const fail = () => Promise.reject(new Error(`no artifact store: neither ${STORE_ENV.dir} nor ${STORE_ENV.bucket} is set`));
  return { get: fail, put: fail, exists: fail };
}

async function loadRoles(target: Target): Promise<WorkerRoles> {
  const [architect, designReviewer, planner, testAuthor, implementer, classifier] = await Promise.all(
    ["architect", "design-reviewer", "planner", "test-author", "implementer", "failure-classifier"].map((name) => loadRole(name, target)),
  );
  if (architect === undefined || designReviewer === undefined || planner === undefined || testAuthor === undefined || implementer === undefined || classifier === undefined) {
    throw new Error("a role config is missing");
  }
  return { architect, designReviewer, planner, testAuthor, implementer, classifier };
}

/** SendTaskSuccess and SendTaskFailure with the task role's credentials. */
function stepFunctions(): TaskTokens {
  const client = new SFNClient({ region: process.env["AWS_REGION"] ?? DEFAULT_REGION });
  return {
    async succeed(taskToken, output) {
      await client.send(new SendTaskSuccessCommand({ taskToken, output }));
    },
    async fail(taskToken, error, cause) {
      await client.send(new SendTaskFailureCommand({ taskToken, error, cause }));
    },
  };
}

/** The work-item state machine's executions, with the task role's credentials. */
function executions(stateMachineArn: string | undefined): Executions {
  const client = new SFNClient({ region: process.env["AWS_REGION"] ?? DEFAULT_REGION });
  return {
    async describe(executionArn) {
      const { status } = await client.send(new DescribeExecutionCommand({ executionArn }));
      return { status: status ?? "UNKNOWN" };
    },
    async stop(executionArn, error, cause) {
      await client.send(new StopExecutionCommand({ executionArn, error, cause }));
    },
    async history(executionArn) {
      // Newest first; the running task is among the latest events, so a few pages are plenty.
      const events: ExecutionEvent[] = [];
      let nextToken: string | undefined;
      for (let page = 0; page < HISTORY_PAGES; page += 1) {
        const result = await client.send(new GetExecutionHistoryCommand({ executionArn, reverseOrder: true, maxResults: 100, ...(nextToken === undefined ? {} : { nextToken }) }));
        for (const event of result.events ?? []) {
          const output = event.taskSubmittedEventDetails?.output;
          events.push({ type: event.type ?? "", ...(output === undefined ? {} : { taskSubmittedEventDetails: { output } }) });
        }
        nextToken = result.nextToken;
        if (nextToken === undefined) break;
      }
      return events;
    },
    async start(name, input) {
      if (stateMachineArn === undefined || stateMachineArn === "") throw new Error(`${STATE_MACHINE_VAR} is not set`);
      await client.send(new StartExecutionCommand({ stateMachineArn, name, input }));
    },
  };
}

/** ECS StopTask with the task role's credentials. */
function ecsTasks(): EcsTasks {
  const client = new ECSClient({ region: process.env["AWS_REGION"] ?? DEFAULT_REGION });
  return {
    async stop(cluster, task, reason) {
      await client.send(new StopTaskCommand({ cluster, task, reason }));
    },
  };
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  err(`factory-worker: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = WORKER_EXIT.error;
}
