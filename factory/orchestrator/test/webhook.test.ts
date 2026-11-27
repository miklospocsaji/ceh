/**
 * The webhook handler (add-cloud-proposal-run task 3.6), with fake Step Functions and ECS
 * clients and a fake Parameter Store read. No AWS.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { RunTaskCommandInput } from "@aws-sdk/client-ecs";
import type { StartExecutionCommandInput } from "@aws-sdk/client-sfn";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWebhookHandler, type FunctionUrlEvent, type WebhookConfig, type WebhookDeps } from "../src/lambda/webhook.ts";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const SECRET = "whsec-5b1d7c0e-test-only";
const OWNER = "miklospocsaji";
const REPOSITORY = "miklospocsaji/vocab";
const DELIVERY = "72d3162e-cc78-11e3-81ab-4c9367dc0958";
const CONFIG: WebhookConfig = {
  stateMachineArn: "arn:aws:states:eu-central-1:123456789012:stateMachine:factory-work-item",
  repository: REPOSITORY,
  owner: OWNER,
  worker: {
    cluster: "arn:aws:ecs:eu-central-1:123456789012:cluster/factory",
    taskDefinition: "arn:aws:ecs:eu-central-1:123456789012:task-definition/FactoryWorker:7",
    subnets: ["subnet-0aaa", "subnet-0bbb"],
    securityGroup: "sg-0worker",
    container: "worker",
  },
};

let executions: StartExecutionCommandInput[];
let tasks: RunTaskCommandInput[];
let logs: string[];
let readSecret: ReturnType<typeof vi.fn<() => Promise<string>>>;
let deps: WebhookDeps;

beforeEach(() => {
  executions = [];
  tasks = [];
  logs = [];
  readSecret = vi.fn(() => Promise.resolve(SECRET));
  deps = {
    config: CONFIG,
    readSecret,
    startExecution: (input) => {
      executions.push(input);
      return Promise.resolve();
    },
    runTask: (input) => {
      tasks.push(input);
      return Promise.resolve();
    },
    log: (line) => logs.push(line),
  };
  vi.mocked(timingSafeEqual).mockClear();
});

const sign = (body: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

interface Delivery {
  signature?: string | null;
  delivery?: string;
  base64?: boolean;
}

/** A Function URL event for a GitHub delivery, signed with the secret unless told otherwise. */
function delivery(event: string, payload: unknown, options: Delivery = {}): FunctionUrlEvent {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const signature = options.signature === undefined ? sign(body) : options.signature;
  return {
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": options.delivery ?? DELIVERY,
      "user-agent": "GitHub-Hookshot/abc123",
      ...(signature === null ? {} : { "x-hub-signature-256": signature }),
    },
    body: options.base64 === true ? Buffer.from(body).toString("base64") : body,
    isBase64Encoded: options.base64 === true,
  };
}

const repository = { full_name: REPOSITORY };
const issue = (overrides: Record<string, unknown> = {}) => ({ number: 12, state: "open", title: "Import Kindle vocab.db", ...overrides });
const labeled = (label = "factory", issueOverrides: Record<string, unknown> = {}) => ({
  action: "labeled",
  label: { name: label },
  issue: issue(issueOverrides),
  repository,
  sender: { login: OWNER },
});
const COMMENT_ID = 2_418_096_512;
const commented = (body: string, login = OWNER, issueOverrides: Record<string, unknown> = {}, action = "created", id: unknown = COMMENT_ID) => ({
  action,
  comment: { id, body, user: { login } },
  issue: issue(issueOverrides),
  repository,
  sender: { login },
});

describe("webhook signature", () => {
  it("Scenario: Unsigned webhook is rejected", async () => {
    const handle = createWebhookHandler(deps);
    const payload = labeled();
    const body = JSON.stringify(payload);

    const requests: FunctionUrlEvent[] = [
      delivery("issues", payload, { signature: null }),
      delivery("issues", payload, { signature: "" }),
      delivery("issues", payload, { signature: sign(body, "another-secret") }),
      delivery("issues", payload, { signature: sign(JSON.stringify(labeled("bug"))) }),
      delivery("issues", payload, { signature: sign(body).replace("sha256=", "sha1=") }),
      delivery("issues", payload, { signature: sign(body).slice(0, -2) }),
      delivery("issues", payload, { signature: `${sign(body)}00` }),
      delivery("issues", payload, { signature: "sha256=zz" }),
    ];
    for (const request of requests) {
      const response = await handle(request);
      expect(response.statusCode, JSON.stringify(request.headers?.["x-hub-signature-256"])).toBe(401);
    }

    expect(executions).toEqual([]);
    expect(tasks).toEqual([]);
  });

  it("compares signatures in constant time", async () => {
    const handle = createWebhookHandler(deps);
    const payload = labeled();

    expect((await handle(delivery("issues", payload, { signature: sign(JSON.stringify(payload), "another-secret") }))).statusCode).toBe(401);
    expect((await handle(delivery("issues", payload))).statusCode).toBe(202);

    // Both well-formed signatures went through timingSafeEqual, as 32-byte digests.
    expect(vi.mocked(timingSafeEqual)).toHaveBeenCalledTimes(2);
    for (const [a, b] of vi.mocked(timingSafeEqual).mock.calls) {
      expect((a as Buffer).length).toBe(32);
      expect((b as Buffer).length).toBe(32);
    }
  });

  it("verifies the raw body of a base64-encoded request", async () => {
    const handle = createWebhookHandler(deps);

    expect((await handle(delivery("issues", labeled(), { base64: true }))).statusCode).toBe(202);
    expect(executions).toHaveLength(1);
  });

  it("reads the webhook secret once per cold start and never logs it", async () => {
    const handle = createWebhookHandler(deps);
    const failing = createWebhookHandler({ ...deps, startExecution: () => Promise.reject(new Error("AccessDeniedException: not authorized")) });
    const consoleLines: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleLines.push(args.map(String).join(" "));
      });
    }

    await handle(delivery("issues", labeled()));
    await handle(delivery("issues", labeled(), { signature: null }));
    await handle(delivery("issue_comment", commented("/approve")));
    await handle(delivery("issues", labeled("bug")));
    expect((await failing(delivery("issues", labeled()))).statusCode).toBe(502);

    // One read per handler: per cold start, since the module builds its handler once.
    expect(readSecret).toHaveBeenCalledTimes(2);
    expect(logs.length).toBeGreaterThan(0);
    for (const line of [...logs, ...consoleLines]) expect(line).not.toContain(SECRET);
    vi.restoreAllMocks();
  });

  it("reads the secret again after a failed read, and answers 500 until it can", async () => {
    readSecret.mockRejectedValueOnce(new Error("ParameterNotFound"));
    const handle = createWebhookHandler(deps);

    expect((await handle(delivery("issues", labeled()))).statusCode).toBe(500);
    expect((await handle(delivery("issues", labeled()))).statusCode).toBe(202);

    expect(readSecret).toHaveBeenCalledTimes(2);
    expect(executions).toHaveLength(1);
  });
});

describe("webhook: labels", () => {
  it("Scenario: Labelling an issue starts an execution", async () => {
    const handle = createWebhookHandler(deps);

    const response = await handle(delivery("issues", labeled()));

    expect(response.statusCode).toBe(202);
    expect(executions).toHaveLength(1);
    const [execution] = executions;
    expect(execution?.stateMachineArn).toBe(CONFIG.stateMachineArn);
    expect(execution?.name).toBe(`issue-12-${DELIVERY}`);
    // The input is the issue number only: no title, body or anything else from the payload.
    expect(JSON.parse(execution?.input ?? "null")).toEqual({ issueNumber: 12 });
    expect(Object.keys(execution ?? {}).sort()).toEqual(["input", "name", "stateMachineArn"]);
    expect(tasks).toEqual([]);
  });

  it("Scenario: Other labels are ignored", async () => {
    const handle = createWebhookHandler(deps);

    for (const request of [
      delivery("issues", labeled("bug")),
      delivery("issues", labeled("Factory ")),
      delivery("issues", { ...labeled(), action: "unlabeled" }),
      delivery("issues", { ...labeled(), action: "opened" }),
    ]) {
      expect((await handle(request)).statusCode).toBe(204);
    }

    expect(executions).toEqual([]);
    expect(tasks).toEqual([]);
  });

  it("ignores the label on a closed issue, on a pull request, and in another repository", async () => {
    const handle = createWebhookHandler(deps);

    for (const request of [
      delivery("issues", labeled("factory", { state: "closed" })),
      delivery("pull_request", { ...labeled(), pull_request: issue() }),
      delivery("issues", { ...labeled(), repository: { full_name: "someone/else" } }),
    ]) {
      expect((await handle(request)).statusCode).toBe(204);
    }

    expect(executions).toEqual([]);
  });

  it("keeps the execution name within Step Functions' rules, and accepts a redelivery of the same delivery", async () => {
    const handle = createWebhookHandler({
      ...deps,
      startExecution: (input) => {
        executions.push(input);
        if (executions.length === 1) return Promise.resolve();
        return Promise.reject(Object.assign(new Error("Execution Already Exists"), { name: "ExecutionAlreadyExists" }));
      },
    });
    const odd = `${"x".repeat(90)}/../ü`;

    expect((await handle(delivery("issues", labeled(), { delivery: odd }))).statusCode).toBe(202);
    expect((await handle(delivery("issues", labeled(), { delivery: odd }))).statusCode).toBe(202);

    expect(executions[0]?.name).toMatch(/^issue-12-[A-Za-z0-9_-]+$/);
    expect(executions[0]?.name?.length).toBeLessThanOrEqual(80);
  });

  it("answers 400 to a signed delivery that is not JSON or names no issue", async () => {
    const handle = createWebhookHandler(deps);

    expect((await handle(delivery("issues", "not json"))).statusCode).toBe(400);
    expect((await handle(delivery("issues", { ...labeled(), issue: { number: "12; drop", state: "open" } }))).statusCode).toBe(400);
    expect(executions).toEqual([]);
  });

  it("answers 204 to a ping", async () => {
    const handle = createWebhookHandler(deps);

    expect((await handle(delivery("ping", { zen: "Design for failure.", hook_id: 1 }))).statusCode).toBe(204);
  });
});

/** The RunTask input of the `command` worker task for a comment on issue 12. */
const commandTask = (commentId = COMMENT_ID): RunTaskCommandInput => ({
  cluster: CONFIG.worker.cluster,
  taskDefinition: CONFIG.worker.taskDefinition,
  launchType: "FARGATE",
  networkConfiguration: { awsvpcConfiguration: { subnets: CONFIG.worker.subnets, securityGroups: [CONFIG.worker.securityGroup], assignPublicIp: "ENABLED" } },
  overrides: { containerOverrides: [{ name: CONFIG.worker.container, command: ["command", "--issue", "12", "--comment", String(commentId)] }] },
});

describe("webhook: owner commands", () => {
  it("Scenario: Owner command starts the command task", async () => {
    const handle = createWebhookHandler(deps);
    const body = "/status\nAnd the cost so far, in detail please.";

    const response = await handle(delivery("issue_comment", commented(body)));

    expect(response.statusCode).toBe(202);
    expect(executions).toEqual([]);
    expect(tasks).toEqual([commandTask()]);
    // Only the comment's id: no part of its text, not even the verb.
    const overrides = JSON.stringify(tasks[0]?.overrides);
    for (const part of ["status", "cost so far", body]) expect(overrides).not.toContain(part);
  });

  it("Scenario: Owner's approval resumes the execution", async () => {
    const handle = createWebhookHandler(deps);

    const response = await handle(delivery("issue_comment", commented("/approve\n\nLooks good.")));

    // The webhook's half: the command task, which resumes the execution.
    expect(response.statusCode).toBe(202);
    expect(executions).toEqual([]);
    expect(tasks).toEqual([commandTask()]);
  });

  it("starts the command task for every first-line command of the owner's, known or not, for the task to answer", async () => {
    const handle = createWebhookHandler(deps);

    for (const [n, body] of ["/help", "/aprove", "/Approve", "/approve please", "/tmp/foo is missing", "/"].entries()) {
      expect((await handle(delivery("issue_comment", commented(body, OWNER, {}, "created", 100 + n)))).statusCode, body).toBe(202);
    }

    expect(tasks).toEqual([100, 101, 102, 103, 104, 105].map((id) => commandTask(id)));
  });

  it("accepts a command with surrounding whitespace and CRLF line ends, and the owner's login in any case", async () => {
    const handle = createWebhookHandler(deps);

    expect((await handle(delivery("issue_comment", commented("  /approve \r\nThanks")))).statusCode).toBe(202);
    expect((await handle(delivery("issue_comment", commented("/status", OWNER.toUpperCase())))).statusCode).toBe(202);
    expect(tasks).toEqual([commandTask(), commandTask()]);
  });

  it("logs the command task it started, with the comment id and not the comment's text", async () => {
    const handle = createWebhookHandler(deps);

    await handle(delivery("issue_comment", commented("/status\nprivate note")));

    expect(logs.join("\n")).toContain(String(COMMENT_ID));
    expect(logs.join("\n")).not.toContain("private note");
  });

  it("answers 400 to an owner command whose comment has no usable id", async () => {
    const handle = createWebhookHandler(deps);

    for (const id of [null, "2418096512", 0, -4, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      expect((await handle(delivery("issue_comment", commented("/status", OWNER, {}, "created", id)))).statusCode, String(id)).toBe(400);
    }
    expect(tasks).toEqual([]);
  });

  it("answers 502 when the worker task cannot be started", async () => {
    const handle = createWebhookHandler({ ...deps, runTask: () => Promise.reject(new Error("RunTask failed: RESOURCE:ENI")) });

    expect((await handle(delivery("issue_comment", commented("/approve")))).statusCode).toBe(502);
  });
});

describe("webhook: comments that start nothing", () => {
  it("Scenario: Comment without a command is ignored", async () => {
    const handle = createWebhookHandler(deps);

    const response = await handle(delivery("issue_comment", commented("Looks good to me, thanks.")));

    expect(response.statusCode).toBe(204);
    expect(tasks).toEqual([]);
    expect(executions).toEqual([]);
  });

  it("Scenario: Command below the first line is ignored", async () => {
    const handle = createWebhookHandler(deps);

    for (const body of ["As discussed:\n/approve", "LGTM\r\n/approve", "\n/approve", "   \n/status"]) {
      expect((await handle(delivery("issue_comment", commented(body)))).statusCode, JSON.stringify(body)).toBe(204);
    }

    expect(tasks).toEqual([]);
    expect(executions).toEqual([]);
  });

  it("Scenario: Command from another user is ignored", async () => {
    const handle = createWebhookHandler(deps);

    const response = await handle(delivery("issue_comment", commented("/status", "someone-else")));

    expect(response.statusCode).toBe(204);
    expect(tasks).toEqual([]);
    expect(executions).toEqual([]);
    // Shown only in the Lambda's log, with the user and the verb.
    const logged = logs.join("\n");
    expect(logged).toContain("someone-else");
    expect(logged).toContain("/status");
  });

  it("Scenario: Approval from another user is ignored", async () => {
    const handle = createWebhookHandler(deps);

    const response = await handle(delivery("issue_comment", commented("/approve", "someone-else")));

    expect(response.statusCode).toBe(204);
    expect(tasks).toEqual([]);
    expect(executions).toEqual([]);
    // Visible only in the Lambda's log.
    expect(logs.join("\n")).toContain("someone-else");
  });

  it("Scenario: Edited comment is ignored", async () => {
    const handle = createWebhookHandler(deps);

    expect((await handle(delivery("issue_comment", commented("/approve", OWNER, {}, "edited")))).statusCode).toBe(204);
    expect((await handle(delivery("issue_comment", commented("/approve", OWNER, {}, "deleted")))).statusCode).toBe(204);

    expect(tasks).toEqual([]);
    expect(executions).toEqual([]);
  });

  it("starts nothing for a command on a pull request, or in another repository", async () => {
    const handle = createWebhookHandler(deps);
    const pullRequest = { pull_request: { url: "https://api.github.com/repos/miklospocsaji/vocab/pulls/12" } };

    for (const request of [
      delivery("issue_comment", commented("/approve", OWNER, pullRequest)),
      delivery("issue_comment", commented("/status", OWNER, pullRequest)),
      delivery("issue_comment", { ...commented("/approve"), repository: { full_name: "someone/else" } }),
    ]) {
      expect((await handle(request)).statusCode).toBe(204);
    }

    expect(tasks).toEqual([]);
  });

  it("leaves labelling as it was: a labelled issue starts an execution and no task", async () => {
    const handle = createWebhookHandler(deps);

    expect((await handle(delivery("issues", labeled()))).statusCode).toBe(202);
    expect(executions.map((execution) => JSON.parse(execution.input ?? "null") as unknown)).toEqual([{ issueNumber: 12 }]);
    expect(tasks).toEqual([]);
  });
});

describe("webhook: closing and reopening an issue (add-work-item-resume)", () => {
  const event = (action: string, issueOverrides: Record<string, unknown> = {}, login = OWNER) => ({ action, issue: issue({ state: action === "closed" ? "closed" : "open", ...issueOverrides }), repository, sender: { login } });
  const closedTask = (): RunTaskCommandInput => ({ ...commandTask(), overrides: { containerOverrides: [{ name: CONFIG.worker.container, command: ["command", "--issue", "12", "--closed"] }] } });

  it("Scenario: Closing the issue stops the work item", async () => {
    const handle = createWebhookHandler(deps);

    const response = await handle(delivery("issues", event("closed")));

    // The webhook's half: one `command --closed` task, which stops a running work item.
    expect(response.statusCode).toBe(202);
    expect(tasks).toEqual([closedTask()]);
    expect(executions).toEqual([]);
    expect(logs.join("\n")).toContain("--closed");
  });

  it("starts the task whoever closed the issue: it stops only a work item that runs", async () => {
    const handle = createWebhookHandler(deps);

    expect((await handle(delivery("issues", event("closed", {}, "a-teammate")))).statusCode).toBe(202);
    expect(tasks).toEqual([closedTask()]);
  });

  it("Scenario: Reopened issue can be resumed", async () => {
    const handle = createWebhookHandler(deps);

    // Reopening starts nothing; the owner's `/resume` that follows is a command like any other.
    expect((await handle(delivery("issues", event("reopened")))).statusCode).toBe(204);
    expect(tasks).toEqual([]);
    expect(executions).toEqual([]);

    expect((await handle(delivery("issue_comment", commented("/resume")))).statusCode).toBe(202);
    expect(tasks).toEqual([commandTask()]);
    expect(executions).toEqual([]);
  });

  it("starts nothing for a closed pull request or an issue of another repository", async () => {
    const handle = createWebhookHandler(deps);

    for (const request of [
      delivery("issues", event("closed", { pull_request: { url: "https://api.github.com/repos/x/y/pulls/12" } })),
      delivery("pull_request", { ...event("closed"), pull_request: issue() }),
      delivery("issues", { ...event("closed"), repository: { full_name: "someone/else" } }),
    ]) {
      expect((await handle(request)).statusCode).toBe(204);
    }
    expect(tasks).toEqual([]);
  });

  it("answers 502 when the closed issue's task cannot be started", async () => {
    const handle = createWebhookHandler({ ...deps, runTask: () => Promise.reject(Object.assign(new Error("x"), { name: "ThrottlingException" })) });

    expect((await handle(delivery("issues", event("closed")))).statusCode).toBe(502);
  });
});
