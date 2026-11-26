/**
 * Test helpers for `/abort`, `/resume` and a closed issue: fakes of the work-item state machine's
 * executions (DescribeExecution, StopExecution, GetExecutionHistory, StartExecution) and of ECS
 * StopTask. They keep every call, and can be told to fail.
 */
import type { EcsTasks, ExecutionEvent, Executions } from "../src/commands/executions.ts";

export const EXECUTION = "arn:aws:states:eu-central-1:123456789012:execution:factory-work-item:issue-12-a1b2c3";
export const NEW_EXECUTION = "arn:aws:states:eu-central-1:123456789012:execution:factory-work-item:issue-12-resume-77";
export const CLUSTER = "factory-cluster";
export const taskArn = (id: string): string => `arn:aws:ecs:eu-central-1:123456789012:task/${CLUSTER}/${id}`;

/** A `TaskSubmitted` event for an ECS task, as Step Functions records the RunTask response. */
export function submitted(arn: string): ExecutionEvent {
  return { type: "TaskSubmitted", taskSubmittedEventDetails: { output: JSON.stringify({ Failures: [], Tasks: [{ LastStatus: "PROVISIONING", TaskArn: arn }] }) } };
}

export const event = (type: string): ExecutionEvent => ({ type });

export class FakeExecutions implements Executions {
  /** Each execution's status; one not listed is RUNNING. */
  readonly statuses = new Map<string, string>();
  /** Each execution's history, newest first. */
  readonly histories = new Map<string, ExecutionEvent[]>();
  readonly described: string[] = [];
  readonly stops: { executionArn: string; error: string; cause: string }[] = [];
  readonly starts: { name: string; input: string }[] = [];
  /** Rejects the next StartExecution with this error, then clears it. */
  failNextStart: Error | undefined;

  describe(executionArn: string): Promise<{ status: string }> {
    this.described.push(executionArn);
    return Promise.resolve({ status: this.statuses.get(executionArn) ?? "RUNNING" });
  }

  stop(executionArn: string, error: string, cause: string): Promise<void> {
    this.stops.push({ executionArn, error, cause });
    this.statuses.set(executionArn, "ABORTED");
    return Promise.resolve();
  }

  history(executionArn: string): Promise<ExecutionEvent[]> {
    return Promise.resolve(this.histories.get(executionArn) ?? []);
  }

  start(name: string, input: string): Promise<void> {
    const error = this.failNextStart;
    if (error !== undefined) {
      this.failNextStart = undefined;
      return Promise.reject(error);
    }
    this.starts.push({ name, input });
    return Promise.resolve();
  }
}

/** The error StartExecution rejects with for a name taken already. */
export function executionAlreadyExists(): Error {
  const error = new Error("Execution Already Exists: 'issue-12-resume-77'");
  error.name = "ExecutionAlreadyExists";
  return error;
}

export class FakeEcsTasks implements EcsTasks {
  readonly stops: { cluster: string; taskArn: string; reason: string }[] = [];
  /** Rejects the next StopTask with this error, then clears it. */
  failNextStop: Error | undefined;

  stop(cluster: string, taskArn: string, reason: string): Promise<void> {
    const error = this.failNextStop;
    if (error !== undefined) {
      this.failNextStop = undefined;
      return Promise.reject(error);
    }
    this.stops.push({ cluster, taskArn, reason });
    return Promise.resolve();
  }
}
