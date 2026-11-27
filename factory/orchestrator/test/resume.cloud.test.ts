/**
 * `/abort`, `/resume` and the closed issue against the deployed stack (add-work-item-resume task
 * 4.3). Files one throwaway `vocab` issue as the owner, labels it `factory`, approves its proposal
 * and lets the execution reach Build. Then, in order:
 *
 * 1. `/abort` while a build task runs: the execution is aborted, its build task stops, the issue
 *    gets the abort reply and `/status` says `aborted`.
 * 2. `/resume`: one execution `issue-<n>-resume-<comment id>` starts with `{ issueNumber, resume:
 *    true }`, and the issue gets the resume reply.
 * 3. Closing the issue once the resumed execution builds again: the webhook starts one `command
 *    --issue <n> --closed` task, the execution is aborted and the issue gets the closed comment.
 * 4. Reopening and `/resume`: a new execution starts, adopts the work item and enters BuildTasks
 *    without Intake, Proposal or a second approval.
 *
 * The issue is closed at the end, which stops the last execution, and is left closed with its
 * branch; nothing is merged. The ledger is not reachable from the laptop, so what it holds is read
 * through the factory's own replies.
 *
 * Needs the owner's AWS credentials (`AWS_PROFILE=vocab`), `gh` logged in as the target's owner,
 * the deployed stack and no other running execution; runs only through `pnpm test:cloud`. It spends
 * model budget: a proposal, a plan and parts of two build sessions, about $0.50 to $1.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { DescribeTasksCommand, ECSClient, ListTasksCommand } from "@aws-sdk/client-ecs";
import { DescribeExecutionCommand, GetExecutionHistoryCommand, type HistoryEvent, ListExecutionsCommand, SFNClient } from "@aws-sdk/client-sfn";
import { afterAll, describe, expect, it } from "vitest";

const REGION = "eu-central-1";
const STACK = "Factory";
const REPOSITORY = "miklospocsaji/vocab";
const OWNER = "miklospocsaji";
const BOT = "ceh-app[bot]";
const MINUTE = 60_000;

const exec = promisify(execFile);
const sfn = new SFNClient({ region: REGION });
const ecs = new ECSClient({ region: REGION });

interface Outputs {
  StateMachineArn: string;
  ClusterArn: string;
  WorkerTaskDefinitionArn: string;
  BuildTaskDefinitionArn: string;
}

interface Comment {
  id: number;
  user: { login: string };
  body: string;
}

async function stackOutputs(): Promise<Outputs> {
  const { Stacks } = await new CloudFormationClient({ region: REGION }).send(new DescribeStacksCommand({ StackName: STACK }));
  const found = Object.fromEntries((Stacks?.[0]?.Outputs ?? []).map((output) => [output.OutputKey, output.OutputValue])) as Partial<Outputs>;
  for (const key of ["StateMachineArn", "ClusterArn", "WorkerTaskDefinitionArn", "BuildTaskDefinitionArn"] as const) {
    expect(found[key], `stack ${STACK} has no output ${key}`).toBeTruthy();
  }
  return found as Outputs;
}

function family(taskDefinitionArn: string): string {
  const name = /:task-definition\/([^:]+):\d+$/.exec(taskDefinitionArn)?.[1];
  if (name === undefined) throw new Error(`no family in ${taskDefinitionArn}`);
  return name;
}

async function gh(...args: string[]): Promise<string> {
  const { stdout } = await exec("gh", args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

async function comment(issue: number, body: string): Promise<number> {
  const id = await gh("api", `repos/${REPOSITORY}/issues/${String(issue)}/comments`, "-f", `body=${body}`, "--jq", ".id");
  return Number(id);
}

async function comments(issue: number): Promise<Comment[]> {
  const pages = await gh("api", "--paginate", "--slurp", `repos/${REPOSITORY}/issues/${String(issue)}/comments?per_page=100`);
  return (JSON.parse(pages) as Comment[][]).flat();
}

/** The bot's comments posted after the comment `after` (comment ids grow with time). */
async function botCommentsAfter(issue: number, after: number): Promise<Comment[]> {
  return (await comments(issue)).filter((c) => c.user.login === BOT && c.id > after);
}

/** Polls `probe` until it returns a value, or fails with `what` after `timeoutMs`. */
async function waitFor<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined>, everyMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${String(Math.round(timeoutMs / 1000))} s waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

/** The bot's first reply after `after` whose body contains `text`. */
function botReply(issue: number, after: number, text: string, timeoutMs = 4 * MINUTE): Promise<Comment> {
  return waitFor(`a ${BOT} comment containing ${JSON.stringify(text)}`, timeoutMs, async () => (await botCommentsAfter(issue, after)).find((c) => c.body.includes(text)));
}

async function issueExecutions(stateMachineArn: string, issue: number): Promise<{ executionArn: string; name: string; status: string }[]> {
  const found: { executionArn: string; name: string; status: string }[] = [];
  let nextToken: string | undefined;
  do {
    const page = await sfn.send(new ListExecutionsCommand({ stateMachineArn, maxResults: 100, nextToken }));
    for (const execution of page.executions ?? []) {
      if (execution.name?.startsWith(`issue-${String(issue)}-`) === true) {
        found.push({ executionArn: execution.executionArn ?? "", name: execution.name, status: execution.status ?? "" });
      }
    }
    nextToken = page.nextToken;
  } while (nextToken !== undefined);
  return found;
}

async function history(executionArn: string): Promise<HistoryEvent[]> {
  const events: HistoryEvent[] = [];
  let nextToken: string | undefined;
  do {
    const page = await sfn.send(new GetExecutionHistoryCommand({ executionArn, maxResults: 1000, nextToken }));
    events.push(...(page.events ?? []));
    nextToken = page.nextToken;
  } while (nextToken !== undefined);
  return events;
}

/** The states the execution entered, in order. */
async function enteredStates(executionArn: string): Promise<string[]> {
  return (await history(executionArn)).filter((event) => event.type?.endsWith("StateEntered") === true).map((event) => event.stateEnteredEventDetails?.name ?? "");
}

/** The ECS task of the family the execution submitted last, if no later task event closed it. */
async function openTaskOf(executionArn: string, taskFamily: string): Promise<string | undefined> {
  const events = (await history(executionArn)).reverse();
  for (const event of events) {
    if (event.type === "TaskSucceeded" || event.type === "TaskFailed" || event.type === "TaskTimedOut") return undefined;
    if (event.type === "TaskSubmitted") {
      const output = JSON.parse(event.taskSubmittedEventDetails?.output ?? "{}") as { Tasks?: { TaskArn?: string; TaskDefinitionArn?: string }[] };
      const task = output.Tasks?.[0];
      return task?.TaskDefinitionArn?.includes(`:task-definition/${taskFamily}:`) === true ? task.TaskArn : undefined;
    }
  }
  return undefined;
}

async function taskStatus(cluster: string, taskArn: string): Promise<string> {
  const { tasks } = await ecs.send(new DescribeTasksCommand({ cluster, tasks: [taskArn] }));
  return tasks?.[0]?.lastStatus ?? "MISSING";
}

/** Waits for the execution to run a build task that is `RUNNING` in ECS, and returns its ARN. */
function runningBuildTask(outputs: Outputs, executionArn: string, timeoutMs: number): Promise<string> {
  return waitFor("a running build task", timeoutMs, async () => {
    const { status } = await sfn.send(new DescribeExecutionCommand({ executionArn }));
    if (status !== "RUNNING") throw new Error(`execution ${executionArn} is ${String(status)} before its build ran`);
    const task = await openTaskOf(executionArn, family(outputs.BuildTaskDefinitionArn));
    if (task === undefined) return undefined;
    return (await taskStatus(outputs.ClusterArn, task)) === "RUNNING" ? task : undefined;
  });
}

function executionAborted(executionArn: string, timeoutMs = 3 * MINUTE): Promise<true> {
  return waitFor(`execution ${executionArn} to be ABORTED`, timeoutMs, async () => {
    const { status } = await sfn.send(new DescribeExecutionCommand({ executionArn }));
    return status === "ABORTED" ? true : undefined;
  }, 5_000);
}

function taskStopped(cluster: string, taskArn: string, timeoutMs = 3 * MINUTE): Promise<true> {
  return waitFor(`task ${taskArn} to be STOPPED`, timeoutMs, async () => ((await taskStatus(cluster, taskArn)) === "STOPPED" ? true : undefined), 10_000);
}

/** The worker tasks started after `since` whose command override is `command`, with their commands. */
async function commandTasks(outputs: Outputs, since: Date): Promise<string[][]> {
  const taskFamily = family(outputs.WorkerTaskDefinitionArn);
  const arns: string[] = [];
  for (const desiredStatus of ["RUNNING", "STOPPED"] as const) {
    const { taskArns } = await ecs.send(new ListTasksCommand({ cluster: outputs.ClusterArn, family: taskFamily, desiredStatus }));
    arns.push(...(taskArns ?? []));
  }
  if (arns.length === 0) return [];
  const found: string[][] = [];
  for (let i = 0; i < arns.length; i += 100) {
    const { tasks } = await ecs.send(new DescribeTasksCommand({ cluster: outputs.ClusterArn, tasks: arns.slice(i, i + 100) }));
    for (const task of tasks ?? []) {
      const command = task.overrides?.containerOverrides?.[0]?.command ?? [];
      if (command[0] === "command" && (task.createdAt ?? new Date(0)) >= since) found.push(command);
    }
  }
  return found;
}

/** The end of every summary that awaits the owner's approval (summary.ts, COMMANDS_INSTRUCTION). */
const ASKS_APPROVAL = "Reply `/approve`, `/revise`";

const ISSUE_TITLE = "[cloud test] Count lookups per weekday";
const ISSUE_BODY = [
  "Throwaway issue for ceh's `add-work-item-resume` cloud test: it is aborted, resumed and closed on purpose, and never merged.",
  "",
  "Add a domain function that takes a `VocabImport` and returns how many lookups there were on each weekday, so the UI can later show on which days of the week the owner reads most.",
  "",
  "- A lookup's weekday is the UTC weekday of its `timestamp`, named `monday` to `sunday`.",
  "- The result is a list of `{ weekday, count }` with all seven weekdays, Monday first, including those with a count of 0.",
  "- A lookup whose `timestamp` is `null` is not counted under any weekday. The result also says how many such lookups there were.",
  "- It's a pure function in `app/domain/src/vocab-import/` and exported from the domain's index.",
].join("\n");

describe("deployed abort and resume", () => {
  let outputs: Outputs;
  let issue = 0;
  /** The execution that runs now, as each scenario leaves it. */
  let current = "";
  let abortedBuildState = "";

  afterAll(async () => {
    if (issue === 0) return;
    const state = await gh("issue", "view", String(issue), "-R", REPOSITORY, "--json", "state", "--jq", ".state");
    // Closing stops a running execution through the closed-issue path; a closed issue is left as it is.
    if (state === "OPEN") await gh("issue", "close", String(issue), "-R", REPOSITORY, "--reason", "not planned");
  });

  it("Scenario: Abort during the build stops the execution", { timeout: 40 * MINUTE }, async () => {
    outputs = await stackOutputs();
    const running = await sfn.send(new ListExecutionsCommand({ stateMachineArn: outputs.StateMachineArn, statusFilter: "RUNNING" }));
    expect(running.executions ?? [], "another execution is running; the test counts tasks and needs the stack to itself").toEqual([]);
    expect(await gh("api", "user", "--jq", ".login"), "gh must be logged in as the target's owner").toBe(OWNER);

    const url = await gh("issue", "create", "-R", REPOSITORY, "--title", ISSUE_TITLE, "--body", ISSUE_BODY);
    issue = Number(/\/issues\/(\d+)$/.exec(url)?.[1]);
    expect(issue, `no issue number in ${url}`).toBeGreaterThan(0);
    await gh("issue", "edit", String(issue), "-R", REPOSITORY, "--add-label", "factory");

    const first = await waitFor("the labelled issue's execution", 2 * MINUTE, async () => (await issueExecutions(outputs.StateMachineArn, issue))[0]);
    current = first.executionArn;
    // The proposal summary asks for approval; a `large` change asks again for its design.
    await botReply(issue, 0, ASKS_APPROVAL, 12 * MINUTE);
    let approved = await comment(issue, "/approve");
    const buildTask = await waitFor("a running build task, approving a design if one is asked for", 30 * MINUTE, async () => {
      if ((await botCommentsAfter(issue, approved)).some((c) => c.body.includes(ASKS_APPROVAL))) approved = await comment(issue, "/approve");
      return runningBuildTask(outputs, current, 0).catch((error: unknown) => {
        if (error instanceof Error && error.message.startsWith("timed out")) return undefined;
        throw error;
      });
    });
    const abort = await comment(issue, "/abort");
    const reply = await botReply(issue, abort, "is aborted");
    expect(reply.body).toContain("stopped it in `build`");
    expect(reply.body).toContain("/resume");
    expect((await botCommentsAfter(issue, abort)).filter((c) => c.body.includes("is aborted"))).toHaveLength(1);

    await executionAborted(current);
    const { error } = await sfn.send(new DescribeExecutionCommand({ executionArn: current }));
    expect(error).toBe("factory.Aborted");
    await taskStopped(outputs.ClusterArn, buildTask);

    const status = await comment(issue, "/status");
    const statusReply = await botReply(issue, status, "Status of");
    expect(statusReply.body).toContain("- State: `aborted`");
    abortedBuildState = "build";
  });

  it("Scenario: Resume starts a new execution", { timeout: 10 * MINUTE }, async () => {
    expect(abortedBuildState, "the abort scenario did not leave an aborted work item").toBe("build");
    const resume = await comment(issue, "/resume");
    const reply = await botReply(issue, resume, "resumes from");
    expect(reply.body).toContain("resumes from `build` in a new execution");
    expect((await botCommentsAfter(issue, resume)).filter((c) => c.body.includes("resumes from"))).toHaveLength(1);

    const name = `issue-${String(issue)}-resume-${String(resume)}`;
    const started = await waitFor(`execution ${name}`, 2 * MINUTE, async () => (await issueExecutions(outputs.StateMachineArn, issue)).find((e) => e.name === name));
    const { input } = await sfn.send(new DescribeExecutionCommand({ executionArn: started.executionArn }));
    expect(JSON.parse(input ?? "{}")).toEqual({ issueNumber: issue, resume: true });
    const named = (await issueExecutions(outputs.StateMachineArn, issue)).filter((e) => e.name.includes("-resume-"));
    expect(named.map((e) => e.name)).toEqual([name]);
    current = started.executionArn;
  });

  it("Scenario: Closing the issue stops the work item", { timeout: 25 * MINUTE }, async () => {
    expect(current, "the resume scenario started no execution").toMatch(/-resume-/);
    // The resumed execution adopts the work item and builds again; close the issue while it does.
    const buildTask = await runningBuildTask(outputs, current, 15 * MINUTE);
    const before = (await comments(issue)).at(-1)?.id ?? 0;
    const since = new Date();
    await gh("issue", "close", String(issue), "-R", REPOSITORY, "--reason", "not planned");

    const closed = await botReply(issue, before, "The issue was closed");
    expect(closed.body).toContain("in `build`; it is `aborted` now");
    await executionAborted(current);
    await taskStopped(outputs.ClusterArn, buildTask);
    const closedTasks = (await commandTasks(outputs, since)).filter((command) => command.includes("--closed"));
    expect(closedTasks).toEqual([["command", "--issue", String(issue), "--closed"]]);
    expect((await botCommentsAfter(issue, before)).filter((c) => c.body.includes("The issue was closed"))).toHaveLength(1);
  });

  it("Scenario: Reopened issue can be resumed", { timeout: 25 * MINUTE }, async () => {
    expect(await gh("issue", "view", String(issue), "-R", REPOSITORY, "--json", "state", "--jq", ".state")).toBe("CLOSED");
    const before = (await comments(issue)).at(-1)?.id ?? 0;
    await gh("issue", "reopen", String(issue), "-R", REPOSITORY);
    // Reopening alone starts nothing.
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    expect((await issueExecutions(outputs.StateMachineArn, issue)).filter((e) => e.status === "RUNNING")).toEqual([]);
    expect(await botCommentsAfter(issue, before)).toEqual([]);

    const resume = await comment(issue, "/resume");
    await botReply(issue, resume, "resumes from `build`");
    const name = `issue-${String(issue)}-resume-${String(resume)}`;
    const started = await waitFor(`execution ${name}`, 2 * MINUTE, async () => (await issueExecutions(outputs.StateMachineArn, issue)).find((e) => e.name === name));
    current = started.executionArn;

    const states = await waitFor("the resumed execution to enter BuildTasks", 10 * MINUTE, async () => {
      const entered = await enteredStates(current);
      return entered.includes("BuildTasks") ? entered : undefined;
    });
    expect(states.slice(0, 3)).toEqual(["Start", "StartChoice", "Adopt"]);
    for (const skipped of ["Intake", "Proposal", "AwaitApproval", "Plan"]) expect(states).not.toContain(skipped);
    // No second approval was asked for on the issue.
    expect((await botCommentsAfter(issue, resume)).filter((c) => c.body.includes(ASKS_APPROVAL))).toEqual([]);
  });
});
