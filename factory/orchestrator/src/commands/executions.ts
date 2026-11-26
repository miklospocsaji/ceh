/**
 * What `/abort`, `/resume` and a closed issue need of AWS (add-work-item-resume design, "Command
 * handler"): the work item's Step Functions executions, and stopping an ECS task. Like
 * `TaskTokens`, these are interfaces: the worker passes the real clients, tests pass fakes.
 */

/** An execution's status, as DescribeExecution reports it; only `RUNNING` means it runs. */
export type ExecutionStatus = "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "ABORTED" | "PENDING_REDRIVE";

/** One event of an execution's history: the fields of GetExecutionHistory the abort reads. */
export interface ExecutionEvent {
  /** Such as `TaskSubmitted`, `TaskSucceeded`, `TaskFailed`, `TaskTimedOut`. */
  type: string;
  /** A `TaskSubmitted` event's output: the ECS RunTask response, as JSON. */
  taskSubmittedEventDetails?: { output?: string };
}

/** The work-item state machine's executions. */
export interface Executions {
  describe(executionArn: string): Promise<{ status: string }>;
  /** StopExecution with a fixed error and cause. */
  stop(executionArn: string, error: string, cause: string): Promise<void>;
  /** The execution's history, newest event first. */
  history(executionArn: string): Promise<ExecutionEvent[]>;
  /**
   * StartExecution of the work-item state machine. A name taken already rejects with an error
   * whose `name` is `ExecutionAlreadyExists`.
   */
  start(name: string, input: string): Promise<void>;
}

/** ECS StopTask. */
export interface EcsTasks {
  stop(cluster: string, taskArn: string, reason: string): Promise<void>;
}

/** The error a stopped execution records: a fixed code, never the comment's text. */
export const ABORT_ERROR = "factory.Aborted";

/** The name of the execution a `/resume` starts: one per comment, so a redelivery starts nothing new. */
export function resumeExecutionName(issueNumber: number, commentId: number): string {
  return `issue-${String(issueNumber)}-resume-${String(commentId)}`;
}

/** The ECS task the latest `TaskSubmitted` event started, if no later task event closed it. */
export function latestOpenTask(events: readonly ExecutionEvent[]): string | undefined {
  for (const event of events) {
    if (CLOSING.includes(event.type)) return undefined;
    if (event.type === "TaskSubmitted") return taskArnOf(event.taskSubmittedEventDetails?.output);
  }
  return undefined;
}

/** The events that end a submitted task. Only one task runs at a time, so a later one closes the latest. */
const CLOSING: readonly string[] = ["TaskSucceeded", "TaskFailed", "TaskTimedOut"];

/** `Tasks[0].TaskArn` of a RunTask response, as Step Functions records it. */
function taskArnOf(output: string | undefined): string | undefined {
  if (output === undefined) return undefined;
  try {
    const parsed = JSON.parse(output) as { Tasks?: { TaskArn?: unknown }[] } | null;
    const arn = parsed?.Tasks?.[0]?.TaskArn;
    return typeof arn === "string" && clusterOf(arn) !== undefined ? arn : undefined;
  } catch {
    return undefined;
  }
}

/** The cluster of an ECS task ARN, `arn:aws:ecs:<region>:<account>:task/<cluster>/<id>`. */
export function clusterOf(taskArn: string): string | undefined {
  return /^arn:aws[a-z-]*:ecs:[a-z0-9-]+:[0-9]{12}:task\/([A-Za-z0-9_-]+)\/[A-Za-z0-9]+$/.exec(taskArn)?.[1];
}
