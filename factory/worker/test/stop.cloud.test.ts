/**
 * An aborted execution's running task stops (add-work-item-resume task 4.4; the stop spike of
 * task 0.1, as a test). A throwaway role and state machine run the stack's boundary-check task
 * definitions, which have the worker's and the build task's images, roles, security groups and
 * subnets but let ECS override the command:
 * - a `.sync` worker task, as Intake to Escalate run;
 * - a `.sync` build task inside an inline Map, as BuildTasks runs a build;
 * - a `waitForTaskToken` worker task, as Plan and Adopt run, which Step Functions leaves running.
 *
 * Each task runs `node` as PID 1 with a script that logs SIGTERM and does not exit, so only SIGKILL
 * ends it, as with the real entry points. Once a task is `RUNNING`, its execution is stopped the
 * way `/abort` does (`stopWorkItem` in `commands/handle.ts`): DescribeExecution, StopExecution with
 * `factory.Aborted`, then the execution's history newest first, `latestOpenTask` and `clusterOf`
 * from the orchestrator, and StopTask on that task. Each task must be `STOPPED` within two minutes
 * of StopExecution. The state machine and its role are deleted afterwards, and any task still
 * running is stopped.
 *
 * Needs the owner's AWS credentials (`AWS_PROFILE=vocab`, allowed to create and delete an IAM role
 * and a state machine) and the deployed stack; runs only through `pnpm test:cloud`. A few Fargate
 * minutes and no model budget.
 */
import { randomBytes } from "node:crypto";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { DescribeTaskDefinitionCommand, DescribeTasksCommand, ECSClient, StopTaskCommand, type Task } from "@aws-sdk/client-ecs";
import { CreateRoleCommand, DeleteRoleCommand, DeleteRolePolicyCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import {
  CreateStateMachineCommand,
  DeleteStateMachineCommand,
  DescribeExecutionCommand,
  GetExecutionHistoryCommand,
  SFNClient,
  StartExecutionCommand,
  StopExecutionCommand,
} from "@aws-sdk/client-sfn";
import { ABORT_ERROR, clusterOf, latestOpenTask, type ExecutionEvent } from "@ceh/factory-orchestrator";
import { afterAll, describe, expect, it } from "vitest";

const REGION = "eu-central-1";
const STACK = "Factory";
/** The scenario's limit, from StopExecution to the task's `STOPPED`. */
const STOP_LIMIT_MS = 2 * 60_000;
const NAME = `ceh-stop-test-${randomBytes(4).toString("hex")}`;
const POLICY = "run-boundary-checks";

/** PID 1 of each task: ignores SIGTERM (it only logs it), heartbeats, and gives up after 10 minutes. */
const SCRIPT =
  "process.on('SIGTERM', () => console.log('stop test: SIGTERM')); setInterval(() => console.log('stop test: heartbeat'), 5000); setTimeout(() => process.exit(0), 600000);";

const sfn = new SFNClient({ region: REGION });
const ecs = new ECSClient({ region: REGION });
const iam = new IAMClient({ region: REGION });

interface Outputs {
  ClusterArn: string;
  BoundaryCheckTaskDefinitionArn: string;
  BuildBoundaryCheckTaskDefinitionArn: string;
  WorkerContainerName: string;
  BuildContainerName: string;
  WorkerSecurityGroupId: string;
  BuildSecurityGroupId: string;
  WorkerSubnetIds: string;
}
const OUTPUT_KEYS = [
  "ClusterArn",
  "BoundaryCheckTaskDefinitionArn",
  "BuildBoundaryCheckTaskDefinitionArn",
  "WorkerContainerName",
  "BuildContainerName",
  "WorkerSecurityGroupId",
  "BuildSecurityGroupId",
  "WorkerSubnetIds",
] as const;

const CASES = ["worker", "build", "token"] as const;
type Case = (typeof CASES)[number];

async function stackOutputs(): Promise<Outputs> {
  const { Stacks } = await new CloudFormationClient({ region: REGION }).send(new DescribeStacksCommand({ StackName: STACK }));
  const found = Object.fromEntries((Stacks?.[0]?.Outputs ?? []).map((output) => [output.OutputKey, output.OutputValue])) as Partial<Outputs>;
  for (const key of OUTPUT_KEYS) expect(found[key], `stack ${STACK} has no output ${key}`).toBeTruthy();
  return found as Outputs;
}

/** The task and execution roles a task definition passes to ECS. */
async function rolesOf(taskDefinitionArn: string): Promise<string[]> {
  const { taskDefinition } = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: taskDefinitionArn }));
  return [taskDefinition?.taskRoleArn, taskDefinition?.executionRoleArn].filter((arn): arn is string => typeof arn === "string");
}

function unversioned(taskDefinitionArn: string): string {
  return taskDefinitionArn.replace(/:\d+$/, ":*");
}

function definition(outputs: Outputs): string {
  const subnets = outputs.WorkerSubnetIds.split(",");
  const runTask = (taskDefinition: string, securityGroup: string, container: string, command: string[], environment?: { Name: string; Value: string }[]) => ({
    Cluster: outputs.ClusterArn,
    TaskDefinition: taskDefinition,
    LaunchType: "FARGATE",
    NetworkConfiguration: { AwsvpcConfiguration: { Subnets: subnets, SecurityGroups: [securityGroup], AssignPublicIp: "ENABLED" } },
    Overrides: { ContainerOverrides: [{ Name: container, Command: command, ...(environment === undefined ? {} : { Environment: environment }) }] },
  });
  const worker = (environment?: { Name: string; Value: string }[]) =>
    runTask(outputs.BoundaryCheckTaskDefinitionArn, outputs.WorkerSecurityGroupId, outputs.WorkerContainerName, ["node", "-e", SCRIPT], environment);
  return JSON.stringify({
    Comment: "Throwaway: add-work-item-resume task 4.4, an aborted execution's running task stops.",
    QueryLanguage: "JSONata",
    StartAt: "Case",
    States: {
      Case: {
        Type: "Choice",
        Choices: [
          { Condition: "{% $states.input.case = 'worker' %}", Next: "Worker" },
          { Condition: "{% $states.input.case = 'build' %}", Next: "BuildTasks" },
        ],
        Default: "Plan",
      },
      Worker: { Type: "Task", Resource: "arn:aws:states:::ecs:runTask.sync", Arguments: worker(), End: true },
      BuildTasks: {
        Type: "Map",
        Items: "{% [1] %}",
        MaxConcurrency: 1,
        ItemProcessor: {
          ProcessorConfig: { Mode: "INLINE" },
          StartAt: "Build",
          States: {
            Build: {
              Type: "Task",
              Resource: "arn:aws:states:::ecs:runTask.sync",
              // The build check's entry point is `sh -c`; `exec` makes node PID 1, as factory-build is.
              Arguments: runTask(outputs.BuildBoundaryCheckTaskDefinitionArn, outputs.BuildSecurityGroupId, outputs.BuildContainerName, [`exec node -e "${SCRIPT}"`]),
              End: true,
            },
          },
        },
        End: true,
      },
      Plan: {
        Type: "Task",
        Resource: "arn:aws:states:::ecs:runTask.waitForTaskToken",
        Arguments: worker([{ Name: "FACTORY_TASK_TOKEN", Value: "{% $states.context.Task.Token %}" }]),
        End: true,
      },
    },
  });
}

function policy(outputs: Outputs, passRoles: string[]): string {
  const account = /^arn:aws:ecs:[a-z0-9-]+:(\d{12}):/.exec(outputs.ClusterArn)?.[1] ?? "";
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: "ecs:RunTask", Resource: [unversioned(outputs.BoundaryCheckTaskDefinitionArn), unversioned(outputs.BuildBoundaryCheckTaskDefinitionArn)] },
      { Effect: "Allow", Action: ["ecs:StopTask", "ecs:DescribeTasks"], Resource: "*" },
      { Effect: "Allow", Action: "iam:PassRole", Resource: passRoles },
      { Effect: "Allow", Action: ["events:PutTargets", "events:PutRule", "events:DescribeRule"], Resource: `arn:aws:events:${REGION}:${account}:rule/StepFunctionsGetEventsForECSTaskRule` },
    ],
  });
}

/** Polls `probe` until it returns a value, or fails with `what` after `timeoutMs`. */
async function waitFor<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined>, everyMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${String(Math.round(timeoutMs / 1000))} s waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

/** The execution's history newest first, in the shape the abort reads (the worker's `executions().history`). */
async function history(executionArn: string): Promise<ExecutionEvent[]> {
  const { events } = await sfn.send(new GetExecutionHistoryCommand({ executionArn, reverseOrder: true, maxResults: 100 }));
  return (events ?? []).map((event) => {
    const output = event.taskSubmittedEventDetails?.output;
    return { type: event.type ?? "", ...(output === undefined ? {} : { taskSubmittedEventDetails: { output } }) };
  });
}

async function task(cluster: string, taskArn: string): Promise<Task | undefined> {
  const { tasks } = await ecs.send(new DescribeTasksCommand({ cluster, tasks: [taskArn] }));
  return tasks?.[0];
}

/** `/abort`'s stop of a running execution (`stopWorkItem`), returning the task it stopped. */
async function abortStop(executionArn: string, cause: string): Promise<{ stoppedAt: number; taskArn: string | undefined }> {
  const { status } = await sfn.send(new DescribeExecutionCommand({ executionArn }));
  expect(status).toBe("RUNNING");
  await sfn.send(new StopExecutionCommand({ executionArn, error: ABORT_ERROR, cause }));
  const stoppedAt = Date.now();
  const taskArn = latestOpenTask(await history(executionArn));
  const cluster = taskArn === undefined ? undefined : clusterOf(taskArn);
  if (taskArn !== undefined && cluster !== undefined) await ecs.send(new StopTaskCommand({ cluster, task: taskArn, reason: cause }));
  return { stoppedAt, taskArn };
}

describe("aborted executions on Fargate", () => {
  let stateMachineArn: string | undefined;
  let roleCreated = false;
  let cluster = "";
  const started = new Map<Case, { executionArn: string; taskArn?: string }>();

  afterAll(async () => {
    for (const { executionArn, taskArn } of started.values()) {
      const { status } = await sfn.send(new DescribeExecutionCommand({ executionArn }));
      if (status === "RUNNING") await sfn.send(new StopExecutionCommand({ executionArn, error: "test.CleanUp", cause: "stop test clean-up" }));
      if (taskArn !== undefined && (await task(cluster, taskArn))?.lastStatus !== "STOPPED") {
        await ecs.send(new StopTaskCommand({ cluster, task: taskArn, reason: "stop test clean-up" }));
      }
    }
    if (stateMachineArn !== undefined) await sfn.send(new DeleteStateMachineCommand({ stateMachineArn }));
    if (roleCreated) {
      await iam.send(new DeleteRolePolicyCommand({ RoleName: NAME, PolicyName: POLICY }));
      await iam.send(new DeleteRoleCommand({ RoleName: NAME }));
    }
  });

  it("Scenario: Stopped execution stops its running task", { timeout: 15 * 60_000 }, async () => {
    const outputs = await stackOutputs();
    cluster = outputs.ClusterArn;
    const passRoles = [...(await rolesOf(outputs.BoundaryCheckTaskDefinitionArn)), ...(await rolesOf(outputs.BuildBoundaryCheckTaskDefinitionArn))];

    const { Role } = await iam.send(
      new CreateRoleCommand({
        RoleName: NAME,
        Description: "Throwaway: add-work-item-resume task 4.4; deleted by the test",
        AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "states.amazonaws.com" }, Action: "sts:AssumeRole" }] }),
        Tags: [{ Key: "project", Value: "ceh" }],
      }),
    );
    roleCreated = true;
    await iam.send(new PutRolePolicyCommand({ RoleName: NAME, PolicyName: POLICY, PolicyDocument: policy(outputs, passRoles) }));
    // A new role takes a few seconds to be assumable; CreateStateMachine refuses it until then.
    stateMachineArn = await waitFor("the state machine to accept the new role", 90_000, async () => {
      try {
        const created = await sfn.send(new CreateStateMachineCommand({ name: NAME, roleArn: Role?.Arn, definition: definition(outputs), tags: [{ key: "project", value: "ceh" }] }));
        return created.stateMachineArn;
      } catch (error) {
        if (error instanceof Error && error.name === "AccessDeniedException") return undefined;
        throw error;
      }
    });

    for (const name of CASES) {
      const { executionArn } = await sfn.send(new StartExecutionCommand({ stateMachineArn, name: `${name}-${randomBytes(4).toString("hex")}`, input: JSON.stringify({ case: name }) }));
      started.set(name, { executionArn: executionArn ?? "" });
    }

    const results = await Promise.all(
      CASES.map(async (name) => {
        const run = started.get(name);
        if (run === undefined) throw new Error(`no execution for ${name}`);
        // The task the execution submitted, once ECS runs it; then 20 s more, so node is PID 1 and listens.
        const running = await waitFor(`${name}: a RUNNING task`, 5 * 60_000, async () => {
          const arn = latestOpenTask(await history(run.executionArn));
          return arn !== undefined && (await task(cluster, arn))?.lastStatus === "RUNNING" ? arn : undefined;
        });
        run.taskArn = running;
        await new Promise((resolve) => setTimeout(resolve, 20_000));

        const cause = `Aborted by the stop test (${name}).`;
        const { stoppedAt, taskArn } = await abortStop(run.executionArn, cause);
        expect(taskArn, `${name}: the abort found the running task in the history`).toBe(running);
        const stopped = await waitFor(`${name}: the task STOPPED`, STOP_LIMIT_MS + 30_000, async () => {
          const described = await task(cluster, running);
          return described?.lastStatus === "STOPPED" ? described : undefined;
        });
        const stoppedInMs = (stopped.stoppedAt?.getTime() ?? Number.POSITIVE_INFINITY) - stoppedAt;
        const execution = await sfn.send(new DescribeExecutionCommand({ executionArn: run.executionArn }));
        console.log(
          `stop test: ${name}: StopExecution ${new Date(stoppedAt).toISOString()}, task STOPPED +${(stoppedInMs / 1000).toFixed(1)} s, ` +
            `stop code ${String(stopped.stopCode)}, reason ${JSON.stringify(stopped.stoppedReason)}, exit ${String(stopped.containers?.[0]?.exitCode)}, execution ${String(execution.status)}`,
        );
        return { name, stopped, stoppedInMs, execution, cause };
      }),
    );

    for (const { name, stopped, stoppedInMs, execution, cause } of results) {
      expect(execution.status, name).toBe("ABORTED");
      expect(execution.error, name).toBe(ABORT_ERROR);
      expect(stoppedInMs, `${name}: STOPPED within two minutes of StopExecution`).toBeLessThanOrEqual(STOP_LIMIT_MS);
      expect(stopped.stopCode, name).toBe("UserInitiated");
      // Step Functions leaves a token task running, so only the abort's own StopTask stops it.
      if (name === "token") expect(stopped.stoppedReason, name).toBe(cause);
    }
  });
});
