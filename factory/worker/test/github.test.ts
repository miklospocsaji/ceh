/**
 * The worker's GitHub App connection (add-work-item-resume task 1.3): `connectGitHub` over the
 * emulated GitHub API with a test RSA key and an injected sleep. A `command` task whose set-up
 * fails still tries the fixed reply, and logs one line when GitHub cannot be reached at all.
 */
import { generateKeyPairSync } from "node:crypto";
import { commandFailedReply, WORKER_EXIT } from "@ceh/factory-orchestrator";
import { testTarget } from "@ceh/factory-target/testing";
import { describe, expect, it } from "vitest";
import { FakeGitHubApi } from "../../forge/test/fake-github-api.ts";
import { parseWorkerArgs, type WorkerArgs } from "../src/config.ts";
import { connectGitHub } from "../src/github.ts";

const TARGET = testTarget();
const OWNER = "miklospocsaji";
const REPO = "vocab";
const SLUG = "ceh-app";
const BOT_ID = 41898282;
const APP_ID = 5586098;
const INSTALLATION_ID = 177972181;
const ISSUE = 12;
const COMMENT = 4242;
const USERS_PATH = `/users/${SLUG}[bot]`;

const { privateKey: PRIVATE_KEY, publicKey: PUBLIC_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const KEY_LINE = PRIVATE_KEY.split("\n")[1] ?? "";

const CONFIG = {
  target: TARGET,
  owner: OWNER,
  repo: REPO,
  app: { appId: APP_ID, installationId: INSTALLATION_ID, slug: SLUG, privateKey: PRIVATE_KEY },
};

function args(argv: string[]): WorkerArgs {
  const parsed = parseWorkerArgs(argv);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed;
}

const COMMAND = args(["command", "--issue", String(ISSUE), "--comment", String(COMMENT)]);

const networkError = () => new TypeError("fetch failed", { cause: Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }) });

/** The emulated API with the issue and the owner's `/status` comment on it; the bot lookup answers. */
function fakeApi(): FakeGitHubApi {
  const api = new FakeGitHubApi({
    owner: OWNER,
    repo: REPO,
    defaultBranch: "main",
    defaultSha: "0123456789abcdef0123456789abcdef01234567",
    app: { appId: APP_ID, installationId: INSTALLATION_ID, publicKey: PUBLIC_KEY },
  });
  api.issues.set(ISSUE, { number: ISSUE, title: "Import Kindle vocab.db", body: "Read vocab.db", state: "open" });
  api.issueComments.set(COMMENT, { id: COMMENT, issueNumber: ISSUE, author: OWNER, body: "/status", createdAt: "2026-11-22T18:00:00Z" });
  return api;
}

function harness(api: FakeGitHubApi, workerArgs: WorkerArgs = COMMAND) {
  let err = "";
  const waits: number[] = [];
  const run = () =>
    connectGitHub({
      args: workerArgs,
      config: CONFIG,
      fetch: api.fetch,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      err: (text) => (err += text),
    });
  return { run, waits, err: () => err };
}

/** The users endpoint is not one the emulator serves: answer it as GitHub does for the bot. */
const botLookup = (request: { path: string }) => (request.path === USERS_PATH ? Response.json({ login: `${SLUG}[bot]`, id: BOT_ID, type: "Bot" }) : undefined);

/** The JWTs and tokens the API saw, so a test can check none reached the log. */
function credentials(api: FakeGitHubApi): string[] {
  return [...api.requests.map((r) => (r.authorization ?? "").replace(/^(bearer|token) /i, "")).filter((c) => c !== ""), ...api.issuedTokens.map((t) => t.token)];
}

describe("connectGitHub", () => {
  it("builds the Forge with the App's bot user as the committer", async () => {
    const api = fakeApi();
    api.intercept = botLookup;
    const { run } = harness(api);

    const connection = await run();

    expect(connection).toMatchObject({ ok: true, committer: { name: `${SLUG}[bot]`, email: `${String(BOT_ID)}+${SLUG}[bot]@users.noreply.github.com` } });
    expect(api.comments.get(ISSUE)).toBeUndefined();
  });

  it("Scenario: Command that fails before its handler is answered", async () => {
    const api = fakeApi();
    // The bot lookup fails on every try; the token request and the issue's endpoints answer.
    api.intercept = (request) => {
      if (request.path === USERS_PATH) throw networkError();
      return undefined;
    };
    const { run, err } = harness(api);

    const connection = await run();

    // Nothing is recorded: the handler, and with it the ledger, never runs.
    expect(connection).toEqual({ ok: false, code: WORKER_EXIT.error });
    expect(api.comments.get(ISSUE)).toEqual([commandFailedReply("status")]);
    expect(commandFailedReply("status")).toMatch(/`\/status` did not go through.*Send it again/);
    expect(err()).toContain("UND_ERR_CONNECT_TIMEOUT");
    expect(api.requests.filter((r) => r.path === USERS_PATH)).toHaveLength(3);
    for (const secret of [...credentials(api), PRIVATE_KEY, KEY_LINE]) expect(err()).not.toContain(secret);
  });

  it("Scenario: Command that cannot reach GitHub is logged", async () => {
    const api = fakeApi();
    api.intercept = () => {
      throw networkError();
    };
    const { run, err } = harness(api);

    const connection = await run();

    expect(connection).toEqual({ ok: false, code: WORKER_EXIT.error });
    expect(api.comments.get(ISSUE)).toBeUndefined();
    expect(err()).toContain(
      `factory-worker: command for issue #${String(ISSUE)}, comment ${String(COMMENT)}: GitHub could not be reached; the command was neither recorded nor answered\n`,
    );
    for (const secret of [...credentials(api), PRIVATE_KEY, KEY_LINE]) expect(err()).not.toContain(secret);
  });

  it("does not answer a comment that is not the owner's", async () => {
    const api = fakeApi();
    api.issueComments.set(COMMENT, { id: COMMENT, issueNumber: ISSUE, author: "someone-else", body: "/status", createdAt: "2026-11-22T18:00:00Z" });
    api.intercept = (request) => {
      if (request.path === USERS_PATH) throw networkError();
      return undefined;
    };
    const { run, err } = harness(api);

    const connection = await run();

    expect(connection).toEqual({ ok: false, code: WORKER_EXIT.error });
    expect(api.comments.get(ISSUE)).toBeUndefined();
    expect(err()).toContain(`not by the owner ${TARGET.owner}`);
  });

  it("posts nothing when another state's set-up fails", async () => {
    const api = fakeApi();
    api.intercept = (request) => {
      if (request.path === USERS_PATH) throw networkError();
      return undefined;
    };
    const { run, err } = harness(api, args(["proposal", "--issue", String(ISSUE)]));

    const connection = await run();

    expect(connection).toEqual({ ok: false, code: WORKER_EXIT.error });
    expect(api.comments.get(ISSUE)).toBeUndefined();
    expect(err()).toContain(`factory-worker: GitHub App: looking up the bot user ${SLUG}[bot] failed 3 times: fetch failed (UND_ERR_CONNECT_TIMEOUT)\n`);
  });
});
