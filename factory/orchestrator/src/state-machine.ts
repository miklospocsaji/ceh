/**
 * The work item's Step Functions state machine (add-cloud-proposal-run and add-build-loop
 * designs, "State machine"): a pure function returning JSONata ASL, so it is unit-tested without
 * CDK or AWS.
 *
 * Each worker state routes on its task's exit code (`WORKER_EXIT`); an arrow's number is that
 * code, and an unnumbered arrow out of a worker state means 0. AwaitApproval and
 * AwaitDesignApproval route on the owner's decision, `approve` or `revise`.
 *
 *   Start
 *     |
 *     v
 *   StartChoice ---- resume: true ----> Adopt (see "A resumed execution" below)
 *     | otherwise
 *     v
 *   Intake ---------------- 4 ----> Ended
 *     | 0
 *     v
 *   Proposal <-------------------------------------+
 *     | 0                                          |
 *     v                                            |
 *   AwaitApproval --> ApprovalDecision -- revise --+
 *                        | approve
 *                        v
 *   Approved <-----------+
 *     |  \
 *     |   +-- 10: a small change skips Design ---------------------------+
 *     | 0: a medium or large change                                      |
 *     v                                                                  |
 *   Design <---------------------------------------------------+         |
 *     |  \                                                     |         |
 *     |   +-- 11: large --> AwaitDesignApproval                |         |
 *     |                       |                                |         |
 *     |                       v                                |         |
 *     |                     DesignApprovalDecision -- revise --+         |
 *     | 0: medium, its        | approve                                  |
 *     | reviewer approved     |                                          |
 *     v                       |                                          |
 *   Plan <--------------------+------------------------------------------+
 *     | 0, with the change id and the unfinished task ids
 *     v
 *   BuildTasks: each unfinished task, one at a time:
 *     |   Step -- 20 --------------> Build --> Step
 *     |   Step -- 21 --> WaitInfra --> Build --> Step
 *     |   Step -- 0: the task is done; the next task
 *     |   Step -- 13: a design flaw --> Design (the Map catches DesignFlaw)
 *     |   Step -- 3: escalated -------> Escalated
 *     v every task done
 *   OpenPullRequest -- 0 --> Done
 *
 * Exit codes: 0 ok; 3 the work item escalated (from Proposal, Approved, Design, Plan or a Step) -->
 * Escalated, which fails the execution; 4 nothing to do, the run ends (Intake: a rejected or
 * relabelled issue); 10 Approved: a `small` change skips Design; 11 Design: a `large` change's
 * design waits for the owner; 13 Step: a design flaw; 20 Step: build next; 21 Step: build after
 * an infrastructure failure, once WaitInfra's 60 s have passed.
 *
 * Failures: any worker state's exit 2 (refused input) goes to Escalate at once, and a crash (any
 * other exit, or a task that never ran) is retried after 30 s and 90 s, then goes to Escalate. A
 * failed waitForTaskToken task (AwaitApproval, AwaitDesignApproval, Plan, Adopt) goes to Escalate
 * with no retry. Escalate is a worker task that marks the work item and comments; then Escalated.
 *
 * A resumed execution (input `{ issueNumber, resume: true }`, add-work-item-resume):
 *
 *   StartChoice ---- resume: true ----> Adopt (waitForTaskToken: { exitCode, entry, changeId, tasks })
 *                                       |
 *                                       v
 *                                     AdoptExit -- 4: nothing to resume ---> Ended
 *                                       | 0, by entry:
 *                                       +-- proposal --------> Proposal
 *                                       +-- await-approval --> AwaitApproval
 *                                       +-- approved --------> Approved
 *                                       +-- design ----------> Design
 *                                       +-- await-design ----> AwaitDesignApproval
 *                                       +-- plan ------------> Plan
 *                                       +-- build -----------> BuildTasks, on Adopt's change id and tasks
 *                                       +-- anything else ---> Escalate
 *
 * Every state but Build is a `factory-worker` task; Build runs the build task definition. States
 * pass only pointers: the issue number, the change id, task ids, exit codes and task tokens.
 * AwaitApproval, AwaitDesignApproval and Plan pass their task token to the worker in the
 * environment.
 *
 * Where the exit code is read from follows the spike of task 3.1 (add-cloud-proposal-run
 * design.md): exit 0 completes the state with the ECS task description as its result; any other
 * exit fails it with `States.TaskFailed` and the description, as a JSON string, in `Cause`. A task
 * that never ran has no exit code, and an ECS error has a plain-text cause: both count as a crash.
 */
import { ENTRIES, type Entry } from "./entries.ts";
import { ESCALATION_REASON, WORKER_EXIT } from "./exit-codes.ts";

/** Where and how the state machine runs worker tasks. In CDK, these are tokens. */
export interface WorkerTaskConfig {
  cluster: string;
  /** The worker task definition's family, never a revision: ECS runs its latest revision. */
  taskDefinition: string;
  subnets: string[];
  securityGroup: string;
  /** The worker's container, which the overrides name. */
  container: string;
  /**
   * The build task, which the Build state runs, in the same cluster and subnets. `definition()`
   * requires it; the webhook, which runs only the worker's `approve` task, has none.
   */
  build?: BuildTaskConfig;
}

/** Where the state machine runs build tasks: the build family, its security group and container. */
export interface BuildTaskConfig {
  /** The build task definition's family, never a revision. */
  taskDefinition: string;
  securityGroup: string;
  container: string;
}

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface StateMachineDefinition {
  Comment: string;
  QueryLanguage: "JSONata";
  StartAt: string;
  States: Record<string, Record<string, Json>>;
}

/** The environment variable that carries a waitForTaskToken task's token to the worker. */
export const TASK_TOKEN_VAR = "FACTORY_TASK_TOKEN";

/** Retries of a crashed worker or build task, and the wait before each. */
export const RETRY_WAITS_SECONDS = [30, 90] as const;
/** The wait before a build that follows an infrastructure failure. */
export const INFRA_WAIT_SECONDS = 60;
/** How long Plan may take before the execution escalates (design, "State machine"). */
export const PLAN_TIMEOUT_SECONDS = 2 * 60 * 60;

const RUN_TASK_SYNC = "arn:aws:states:::ecs:runTask.sync";
const RUN_TASK_WAIT_FOR_TOKEN = "arn:aws:states:::ecs:runTask.waitForTaskToken";

const ISSUE = "$string($issueNumber)";
const EXIT_CODE = "$states.input.exitCode";
const CAUSE = "$states.errorOutput.Cause";
/** The exit code from a failed state's task description; null when the cause is not one, or has none. */
const FAILED_EXIT_CODE = `$type(${CAUSE}) = 'string' and $substring(${CAUSE}, 0, 1) = '{' ? $parse(${CAUSE}).Containers[0].ExitCode : null`;

const expr = (expression: string): string => `{% ${expression} %}`;
const quote = (text: string): string => `'${text}'`;

/** The state each of Adopt's entries goes to. */
const ENTRY_STATES: Record<Entry, string> = {
  proposal: "Proposal",
  "await-approval": "AwaitApproval",
  approved: "Approved",
  design: "Design",
  "await-design": "AwaitDesignApproval",
  plan: "Plan",
  build: "BuildTasks",
};

/** Adopt's entry, as one of the fixed words or null, so the history never holds anything else. */
const ENTRY_OUTPUT = `$states.result.entry in [${ENTRIES.map(quote).join(", ")}] ? $states.result.entry : null`;

/** The decision `/revise` resumes an approval wait with; `/approve` sends `approve`. */
const REVISE = "revise";

/** A worker state's routes on exit codes other than its own: where refused and crashed tasks go. */
interface Escalation {
  /** The retry counter: `tries` at the top level, `itemTries` in the Map, whose scope may not assign an outer variable. */
  counter: "tries" | "itemTries";
  /** Where exit 2 goes. */
  refused: string;
  /** Where a crash goes once its retries are used up. */
  failed: string;
}

/** The top level's escalation: Escalate, with the reason as a variable. */
const TOP: Escalation = { counter: "tries", refused: "Escalate", failed: "Escalate" };
/** Inside the build loop: Fail states, which the Map catches into Escalate with the reason. */
const IN_MAP: Escalation = { counter: "itemTries", refused: "StepRefused", failed: "StepFailed" };

/**
 * An approval wait's output: the owner's decision, as one of two fixed words, whatever else the
 * worker sent, so the history holds the decision and never the comment (add-approval-feedback).
 */
const DECISION_OUTPUT = expr(`{ 'decision': $states.result.decision = ${quote(REVISE)} ? ${quote(REVISE)} : 'approve' }`);

/** After an approval wait: `revise` back to the author's state, with its retries unused; anything else on. */
function decisionChoice(revised: string, approved: string): Record<string, Json> {
  return {
    Type: "Choice",
    Choices: [{ Condition: expr(`$states.input.decision = ${quote(REVISE)}`), Assign: { tries: 0 }, Next: revised }],
    Default: approved,
  };
}

export function definition(config: WorkerTaskConfig): StateMachineDefinition {
  const { build } = config;
  if (build === undefined) throw new Error("the state machine needs the build task's configuration");
  const runTask = (
    command: string[],
    options: { environment?: { Name: string; Value: string }[]; task?: { taskDefinition: string; securityGroup: string; container: string } } = {},
  ): Json => {
    const task = options.task ?? config;
    return {
      Cluster: config.cluster,
      TaskDefinition: task.taskDefinition,
      LaunchType: "FARGATE",
      NetworkConfiguration: {
        AwsvpcConfiguration: { Subnets: config.subnets, SecurityGroups: [task.securityGroup], AssignPublicIp: "ENABLED" },
      },
      Overrides: {
        ContainerOverrides: [
          {
            Name: task.container,
            Command: expr(`[${command.join(", ")}]`),
            ...(options.environment === undefined ? {} : { Environment: options.environment }),
          },
        ],
      },
    };
  };
  const tokenEnvironment = [{ Name: TASK_TOKEN_VAR, Value: expr("$states.context.Task.Token") }];

  /** Waits before a retry; the counter is already this retry's number. */
  const retryWait = (counter: Escalation["counter"], next: string): Record<string, Json> => ({
    Type: "Wait",
    Seconds: expr(`$${counter} = 1 ? ${String(RETRY_WAITS_SECONDS[0])} : ${String(RETRY_WAITS_SECONDS[1])}`),
    Next: next,
  });

  /**
   * A worker state run to completion, then routed on its exit code by `<name>Exit`: the routes
   * given, then exit 2 to its escalation at once, a crash to a retry while retries are left, and
   * anything else to its escalation.
   */
  const workerState = (name: string, command: string[], routes: { exit: number; next: string }[], escalation: Escalation = TOP) => {
    const reason = (code: string) => (escalation.refused === "Escalate" ? { Assign: { reason: code } } : {});
    return {
      [name]: {
        Type: "Task",
        Resource: RUN_TASK_SYNC,
        Arguments: runTask(command),
        Output: expr(`{ 'exitCode': $states.result.Containers[0].ExitCode }`),
        Catch: [{ ErrorEquals: ["States.ALL"], Output: expr(`{ 'exitCode': ${FAILED_EXIT_CODE} }`), Next: `${name}Exit` }],
        Next: `${name}Exit`,
      },
      [`${name}Exit`]: {
        Type: "Choice",
        Choices: [
          // A state that goes on starts the next one with its retries unused.
          ...routes.map((route) => ({ Condition: expr(`${EXIT_CODE} = ${String(route.exit)}`), Assign: { [escalation.counter]: 0 }, Next: route.next })),
          { Condition: expr(`${EXIT_CODE} = ${String(WORKER_EXIT.invalid)}`), ...reason(ESCALATION_REASON.refused), Next: escalation.refused },
          {
            Condition: expr(`$${escalation.counter} < ${String(RETRY_WAITS_SECONDS.length)}`),
            Assign: { [escalation.counter]: expr(`$${escalation.counter} + 1`) },
            Next: `${name}Retry`,
          },
        ],
        ...reason(ESCALATION_REASON.failed),
        Default: escalation.failed,
      },
      [`${name}Retry`]: retryWait(escalation.counter, name),
    };
  };

  /** A worker task that waits for its task token; any failure escalates, with no retry. */
  const tokenState = (command: string[], fields: Record<string, Json>): Record<string, Json> => ({
    Type: "Task",
    Resource: RUN_TASK_WAIT_FOR_TOKEN,
    Arguments: runTask(command, { environment: tokenEnvironment }),
    Catch: [{ ErrorEquals: ["States.ALL"], Assign: { reason: ESCALATION_REASON.failed }, Output: {}, Next: "Escalate" }],
    ...fields,
  });

  /** The build loop's processor: one task's Step, Build and the waits between, from the item's task id. */
  const processor: Record<string, Record<string, Json>> = {
    Task: { Type: "Pass", Assign: { taskId: expr("$states.input"), itemTries: 0 }, Output: {}, Next: "Step" },
    ...workerState(
      "Step",
      [quote("step"), quote("--issue"), ISSUE, quote("--task"), "$taskId"],
      [
        { exit: WORKER_EXIT.ok, next: "TaskDone" },
        { exit: WORKER_EXIT.build, next: "Build" },
        { exit: WORKER_EXIT.buildAfterWait, next: "WaitInfra" },
        { exit: WORKER_EXIT.designFlaw, next: "DesignFlaw" },
        { exit: WORKER_EXIT.escalated, next: "TaskEscalated" },
      ],
      IN_MAP,
    ),
    WaitInfra: { Type: "Wait", Seconds: INFRA_WAIT_SECONDS, Next: "Build" },
    Build: {
      Type: "Task",
      Resource: RUN_TASK_SYNC,
      Arguments: runTask([quote("build"), quote("--change"), "$changeId", quote("--task"), "$taskId"], { task: build }),
      Output: expr(`{ 'exitCode': $states.result.Containers[0].ExitCode }`),
      Catch: [{ ErrorEquals: ["States.ALL"], Output: expr(`{ 'exitCode': ${FAILED_EXIT_CODE} }`), Next: "BuildExit" }],
      Next: "BuildExit",
    },
    // factory-build exits 0 whenever it wrote an outcome, and 2 on input a retry cannot fix. A
    // crash is retried twice; then Step records the missing outcome as `no-outcome`.
    BuildExit: {
      Type: "Choice",
      Choices: [
        { Condition: expr(`${EXIT_CODE} = ${String(WORKER_EXIT.ok)} or ${EXIT_CODE} = ${String(WORKER_EXIT.invalid)}`), Assign: { itemTries: 0 }, Next: "Step" },
        { Condition: expr(`$itemTries < ${String(RETRY_WAITS_SECONDS.length)}`), Assign: { itemTries: expr("$itemTries + 1") }, Next: "BuildRetry" },
      ],
      Assign: { itemTries: 0 },
      Default: "Step",
    },
    BuildRetry: retryWait("itemTries", "Build"),
    TaskDone: { Type: "Succeed", Output: {} },
    DesignFlaw: { Type: "Fail", Error: "DesignFlaw", Cause: "The task failed with a design flaw; the change goes back to Design." },
    TaskEscalated: { Type: "Fail", Error: "WorkItemEscalated", Cause: "The work item is escalated and waits for the owner." },
    StepRefused: { Type: "Fail", Error: "WorkerRefused", Cause: "A step task refused its input." },
    StepFailed: { Type: "Fail", Error: "WorkerFailed", Cause: "A step task failed, and its retries are used up." },
  };

  return {
    Comment: "One factory work item, from Intake (or Adopt, on a resume) to the pull request (add-cloud-proposal-run, add-build-loop, add-work-item-resume).",
    QueryLanguage: "JSONata",
    StartAt: "Start",
    States: {
      Start: {
        Type: "Pass",
        Assign: { issueNumber: expr("$states.input.issueNumber"), tries: 0 },
        Output: expr("{ 'issueNumber': $states.input.issueNumber }"),
        Next: "StartChoice",
      },
      // Labelling starts an execution; `/resume` starts one with `resume: true` (add-work-item-resume).
      StartChoice: {
        Type: "Choice",
        Choices: [{ Condition: expr("$states.context.Execution.Input.resume = true"), Next: "Adopt" }],
        Default: "Intake",
      },
      // Adopt answers like Plan: BuildTasks needs the change id and the unfinished task ids.
      Adopt: tokenState([quote("intake"), quote("--issue"), ISSUE, quote("--resume"), quote("--execution"), "$states.context.Execution.Id"], {
        // With nothing to resume, Adopt answers no change id: the variable stays a string.
        Assign: { changeId: expr("$type($states.result.changeId) = 'string' ? $states.result.changeId : ''"), tasks: expr("[$states.result.tasks]") },
        Output: expr(`{ 'exitCode': $states.result.exitCode, 'entry': ${ENTRY_OUTPUT} }`),
        Next: "AdoptExit",
      }),
      AdoptExit: {
        Type: "Choice",
        Choices: [
          { Condition: expr(`${EXIT_CODE} = ${String(WORKER_EXIT.ended)}`), Next: "Ended" },
          ...ENTRIES.map((entry) => ({ Condition: expr(`${EXIT_CODE} = ${String(WORKER_EXIT.ok)} and $states.input.entry = ${quote(entry)}`), Next: ENTRY_STATES[entry] })),
        ],
        Assign: { reason: ESCALATION_REASON.failed },
        Default: "Escalate",
      },
      ...workerState("Intake", [quote("intake"), quote("--issue"), ISSUE, quote("--execution"), "$states.context.Execution.Id"], [
        { exit: WORKER_EXIT.ok, next: "Proposal" },
        { exit: WORKER_EXIT.ended, next: "Ended" },
      ]),
      ...workerState("Proposal", [quote("proposal"), quote("--issue"), ISSUE], [
        { exit: WORKER_EXIT.ok, next: "AwaitApproval" },
        { exit: WORKER_EXIT.escalated, next: "Escalated" },
      ]),
      // No timeout (add-cloud-proposal-run design, "Risks"). The owner's decision is all that is kept.
      AwaitApproval: tokenState([quote("await-approval"), quote("--issue"), ISSUE], { Output: DECISION_OUTPUT, Next: "ApprovalDecision" }),
      ApprovalDecision: decisionChoice("Proposal", "Approved"),
      ...workerState("Approved", [quote("approved"), quote("--issue"), ISSUE], [
        { exit: WORKER_EXIT.ok, next: "Design" },
        { exit: WORKER_EXIT.skipDesign, next: "Plan" },
        { exit: WORKER_EXIT.escalated, next: "Escalated" },
      ]),
      ...workerState("Design", [quote("design"), quote("--issue"), ISSUE], [
        { exit: WORKER_EXIT.ok, next: "Plan" },
        { exit: WORKER_EXIT.ownerDesignReview, next: "AwaitDesignApproval" },
        { exit: WORKER_EXIT.escalated, next: "Escalated" },
      ]),
      AwaitDesignApproval: tokenState([quote("await-approval"), quote("--issue"), ISSUE, quote("--kind"), quote("design")], { Output: DECISION_OUTPUT, Next: "DesignApprovalDecision" }),
      DesignApprovalDecision: decisionChoice("Design", "Plan"),
      // Plan hands back the change id and the unfinished task ids, which an inline Map needs in its state.
      Plan: tokenState([quote("plan"), quote("--issue"), ISSUE], {
        TimeoutSeconds: PLAN_TIMEOUT_SECONDS,
        Assign: { changeId: expr("$states.result.changeId"), tasks: expr("[$states.result.tasks]") },
        Output: expr("{ 'exitCode': $states.result.exitCode }"),
        Next: "PlanExit",
      }),
      PlanExit: {
        Type: "Choice",
        Choices: [
          { Condition: expr(`${EXIT_CODE} = ${String(WORKER_EXIT.ok)}`), Next: "BuildTasks" },
          { Condition: expr(`${EXIT_CODE} = ${String(WORKER_EXIT.escalated)}`), Next: "Escalated" },
        ],
        Assign: { reason: ESCALATION_REASON.failed },
        Default: "Escalate",
      },
      BuildTasks: {
        Type: "Map",
        Items: expr("$tasks"),
        MaxConcurrency: 1,
        ItemProcessor: { ProcessorConfig: { Mode: "INLINE" }, StartAt: "Task", States: processor },
        Output: {},
        Catch: [
          { ErrorEquals: ["DesignFlaw"], Assign: { tries: 0 }, Output: {}, Next: "Design" },
          { ErrorEquals: ["WorkItemEscalated"], Output: {}, Next: "Escalated" },
          { ErrorEquals: ["WorkerRefused"], Assign: { reason: ESCALATION_REASON.refused }, Output: {}, Next: "Escalate" },
          { ErrorEquals: ["States.ALL"], Assign: { reason: ESCALATION_REASON.failed }, Output: {}, Next: "Escalate" },
        ],
        Next: "OpenPullRequest",
      },
      ...workerState("OpenPullRequest", [quote("open-pr"), quote("--issue"), ISSUE], [{ exit: WORKER_EXIT.ok, next: "Done" }]),
      Escalate: {
        Type: "Task",
        Resource: RUN_TASK_SYNC,
        Arguments: runTask([quote("escalate"), quote("--issue"), ISSUE, quote("--reason"), "$reason"]),
        Output: {},
        // The execution fails either way; if this task cannot run, no comment is posted (design, "Risks").
        Catch: [{ ErrorEquals: ["States.ALL"], Output: {}, Next: "Escalated" }],
        Next: "Escalated",
      },
      Escalated: { Type: "Fail", Error: "WorkItemEscalated", Cause: "The work item is escalated and waits for the owner." },
      Ended: { Type: "Succeed", Comment: "Intake ended the run: the issue was rejected, or has a work item from another execution; or Adopt found nothing to resume." },
      Done: { Type: "Succeed", Comment: "The pull request is open; the work item is pr-open and waits for the owner." },
    },
  };
}
