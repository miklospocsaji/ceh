/**
 * The worker's configuration from its environment (add-factory-worker task 1.13). Errors name
 * the variable, never its value, since some of them are secrets. In the cloud the ledger comes
 * from the RDS secret in FACTORY_LEDGER_SECRET; locally and in the Docker tests from
 * FACTORY_DATABASE_URL (add-cloud-proposal-run, exit run of task 4.1).
 */
import { connectionFromSecret } from "@ceh/factory-ledger";
import { describe, expect, it } from "vitest";
import { loadTarget } from "@ceh/factory-target";
import { testTarget } from "@ceh/factory-target/testing";
import { parseWorkerArgs, WorkerConfigError, workerConfig, type LoadTarget } from "../src/config.ts";
import { WORKER_EXIT } from "../src/worker.ts";

const KEY = "-----BEGIN RSA PRIVATE KEY-----\nMIIEsecretkeybody\n-----END RSA PRIVATE KEY-----\n";

const LEDGER_PASSWORD = "ledger-Pa55word-from-RDS";
const LEDGER_HOST = "factory-ledger.cluster-abc123.eu-central-1.rds.amazonaws.com";
/** The shape of the secret RDS generates for the cluster's master user. */
const LEDGER_SECRET = JSON.stringify({
  engine: "postgres",
  host: LEDGER_HOST,
  port: 5432,
  username: "factory",
  password: LEDGER_PASSWORD,
  dbname: "factory",
  dbClusterIdentifier: "factory-ledger",
});

const ENV = {
  FACTORY_DATABASE_URL: "postgres://factory:s3cret@ledger:5432/factory",
  FACTORY_TARGET: "vocab",
  FACTORY_GITHUB_APP_ID: "5586098",
  FACTORY_GITHUB_APP_INSTALLATION_ID: "177972181",
  FACTORY_GITHUB_APP_SLUG: "ceh-app",
  FACTORY_GITHUB_APP_PRIVATE_KEY: KEY,
};

/** The error `workerConfig` rejects with. */
async function failure(env: Record<string, string | undefined>, load?: LoadTarget): Promise<unknown> {
  return workerConfig(env, load).then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("workerConfig", () => {
  it("reads the ledger and the GitHub App from the environment, and the repository from the target", async () => {
    expect(await workerConfig(ENV)).toEqual({
      ledger: { connectionString: ENV.FACTORY_DATABASE_URL },
      target: await loadTarget("vocab"),
      owner: "miklospocsaji",
      repo: "vocab",
      app: { appId: 5586098, installationId: 177972181, slug: "ceh-app", privateKey: KEY },
    });
  });

  it("takes the repository from whichever target FACTORY_TARGET names", async () => {
    const other = testTarget({ name: "other", repository: "someone/other-repo" });
    const config = await workerConfig({ ...ENV, FACTORY_TARGET: "other" }, (name) => (name === "other" ? Promise.resolve(other) : Promise.reject(new Error(name))));
    expect(config).toMatchObject({ target: other, owner: "someone", repo: "other-repo" });
  });

  it("Scenario: Worker without a target is refused", async () => {
    const missing = await failure({ ...ENV, FACTORY_TARGET: undefined });
    expect(missing).toBeInstanceOf(WorkerConfigError);
    expect((missing as Error).message).toContain("FACTORY_TARGET");

    // A name with no folder under targets/, read from the real targets directory.
    const unknown = await failure({ ...ENV, FACTORY_TARGET: "nosuch" });
    expect(unknown).toBeInstanceOf(WorkerConfigError);
    expect((unknown as Error).message).toContain("FACTORY_TARGET");
    expect((unknown as Error).message).toContain("targets/nosuch/target.yaml is missing");

    // The repository no longer comes from the environment: the old variable changes nothing.
    expect((await workerConfig({ ...ENV, FACTORY_GITHUB_REPOSITORY: "someone/else" })).repo).toBe("vocab");
    // main.ts turns a WorkerConfigError into exit 2 before any state, clone or connection.
    expect(WORKER_EXIT.invalid).toBe(2);
  });

  it("builds the ledger connection from FACTORY_LEDGER_SECRET, over verified TLS", async () => {
    const cloud = { ...ENV, FACTORY_DATABASE_URL: undefined };

    const { ledger } = await workerConfig({ ...cloud, FACTORY_LEDGER_SECRET: LEDGER_SECRET });

    expect(ledger).toEqual(connectionFromSecret(LEDGER_SECRET));
    expect(ledger).not.toHaveProperty("connectionString");
  });

  it("prefers FACTORY_LEDGER_SECRET when FACTORY_DATABASE_URL is also set", async () => {
    expect((await workerConfig({ ...ENV, FACTORY_LEDGER_SECRET: LEDGER_SECRET })).ledger).toEqual(connectionFromSecret(LEDGER_SECRET));
  });

  it("names both ledger variables when neither is set", async () => {
    const error = await failure({ ...ENV, FACTORY_DATABASE_URL: undefined });

    expect(error).toBeInstanceOf(WorkerConfigError);
    expect((error as Error).message).toMatch(/FACTORY_LEDGER_SECRET.*FACTORY_DATABASE_URL|FACTORY_DATABASE_URL.*FACTORY_LEDGER_SECRET/);
  });

  it("refuses an invalid FACTORY_LEDGER_SECRET, naming it without any value", async () => {
    const cloud = { ...ENV, FACTORY_DATABASE_URL: undefined };
    const broken = JSON.stringify({ ...(JSON.parse(LEDGER_SECRET) as Record<string, unknown>), port: "five" });

    const error = await failure({ ...cloud, FACTORY_LEDGER_SECRET: broken });

    expect(error).toBeInstanceOf(WorkerConfigError);
    const message = (error as Error).message;
    expect(message).toContain("FACTORY_LEDGER_SECRET");
    expect(message).not.toContain(LEDGER_PASSWORD);
    expect(message).not.toContain(LEDGER_HOST);
  });

  it("accepts a private key with escaped newlines, as some secret stores hand it out", async () => {
    const escaped = KEY.replaceAll("\n", "\\n");
    expect((await workerConfig({ ...ENV, FACTORY_GITHUB_APP_PRIVATE_KEY: escaped })).app.privateKey).toBe(KEY);
  });

  it.each(Object.keys(ENV))("names %s when it is missing, without any value", async (name) => {
    const error = await failure({ ...ENV, [name]: undefined });

    expect(error).toBeInstanceOf(WorkerConfigError);
    const message = (error as Error).message;
    expect(message).toContain(name);
    for (const value of Object.values(ENV).filter((value) => value !== "vocab")) expect(message).not.toContain(value);
    expect(message).not.toContain("s3cret");
    expect(message).not.toContain("secretkeybody");
  });

  it.each([
    ["FACTORY_TARGET", "../vocab"],
    ["FACTORY_GITHUB_APP_ID", "abc"],
    ["FACTORY_GITHUB_APP_INSTALLATION_ID", "-1"],
    ["FACTORY_GITHUB_APP_PRIVATE_KEY", "not a key"],
  ])("refuses an invalid %s (%s)", async (name, value) => {
    const error = await failure({ ...ENV, [name]: value });
    expect(error).toBeInstanceOf(WorkerConfigError);
    expect((error as Error).message).toContain(name);
  });
});

describe("parseWorkerArgs", () => {
  it("reads the state and the issue number", () => {
    expect(parseWorkerArgs(["proposal", "--issue", "12"])).toEqual({ ok: true, state: "proposal", issueNumber: 12 });
    expect(parseWorkerArgs(["--issue=7", "intake"])).toEqual({ ok: true, state: "intake", issueNumber: 7 });
  });

  it("names an unknown state", () => {
    const parsed = parseWorkerArgs(["deploy", "--issue", "1"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toMatch(/unknown state deploy/);
  });

  it.each([[[]], [["intake"]], [["intake", "--issue", "0"]], [["intake", "--issue", "1.5"]], [["intake", "--issue"]], [["intake", "--issue", "1", "--x"]]])(
    "refuses %j",
    (argv) => {
      expect(parseWorkerArgs(argv).ok).toBe(false);
    },
  );
});

describe("parseWorkerArgs: a closed issue and Adopt (add-work-item-resume)", () => {
  const ARN = "arn:aws:states:eu-central-1:123456789012:execution:factory-work-item:issue-12-resume-77";

  it("reads `command --closed` and `intake --resume --execution <arn>`", () => {
    expect(parseWorkerArgs(["command", "--issue", "12", "--closed"])).toEqual({ ok: true, state: "command", issueNumber: 12, closed: true });
    expect(parseWorkerArgs(["intake", "--issue", "12", "--resume", "--execution", ARN])).toEqual({ ok: true, state: "intake", issueNumber: 12, resume: true, executionArn: ARN });
  });

  it.each([
    [["command", "--issue", "12"]],
    [["command", "--issue", "12", "--comment", "5", "--closed"]],
    [["intake", "--issue", "12", "--resume"]],
    [["proposal", "--issue", "12", "--closed"]],
    [["proposal", "--issue", "12", "--resume"]],
  ])("refuses %j", (argv) => {
    expect(parseWorkerArgs(argv).ok).toBe(false);
  });
});
