/**
 * GitHub App installation tokens for the Forge (ADR 0009). The provider signs a short-lived
 * RS256 JWT with the App's private key (`node:crypto`, no dependency), exchanges it for an
 * installation token scoped to one repository with the factory's permissions, and caches the
 * token until five minutes before it expires.
 *
 * The token request and the bot user's lookup are tried up to 3 times, 2 s and then 5 s apart,
 * after a network error or a 5xx (add-work-item-resume): every worker task makes both at start-up,
 * and repeating them changes nothing. The Forge's other calls are not retried here, since a
 * comment or a push repeated after a connection reset could be done twice.
 *
 * The key, the JWT and the token live only in this closure, never in an object that could be
 * inspected or serialised, and no error message carries any of them.
 */
import { sign } from "node:crypto";
import { ForgeError, type ForgeErrorKind } from "./forge.ts";

/** Resolves to a currently valid token; GitHubForge calls it before every request and push. */
export type TokenProvider = () => Promise<string>;

export interface InstallationTokenProviderOptions {
  appId: number;
  installationId: number;
  /** The App's private key (PEM); never logged or put in an error. */
  privateKey: string;
  /** The repository's name, without the owner: the only repository the token covers. */
  repository: string;
  /** Defaults to the global `fetch`; tests inject one so nothing reaches the network. */
  fetch?: typeof fetch;
  /** The REST API root; defaults to `https://api.github.com`. */
  baseUrl?: string;
  /** Waits between tries; tests inject one that does not wait. */
  sleep?: Sleep;
}

/** Resolves after `ms` milliseconds. */
export type Sleep = (ms: number) => Promise<void>;

/** ADR 0009: exactly these, and pull requests join in M3. */
const PERMISSIONS = { contents: "write", issues: "write", pull_requests: "write", metadata: "read" } as const;
/** A token is replaced once less than this is left of it. */
const REFRESH_MARGIN_MS = 5 * 60_000;
/** GitHub allows up to 10 minutes; `iat` is backdated for clock drift, as GitHub recommends. */
const JWT_BACKDATE_S = 60;
const JWT_LIFETIME_S = 9 * 60;

const WHAT = "GitHub App: requesting an installation token failed";

interface CachedToken {
  token: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
}

export function createInstallationTokenProvider(options: InstallationTokenProviderOptions): TokenProvider {
  const { appId, installationId, privateKey, repository } = options;
  const fetchFn = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const url = `${(options.baseUrl ?? "https://api.github.com").replace(/\/+$/, "")}/app/installations/${String(installationId)}/access_tokens`;
  let cached: CachedToken | undefined;
  let pending: Promise<string> | undefined;

  const request = async (): Promise<string> => {
    const jwt = appJwt(appId, privateKey);
    const { response, body } = await tryRequest(WHAT, [jwt], sleep, () =>
      fetchFn(url, {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${jwt}`,
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({ repositories: [repository], permissions: PERMISSIONS }),
      }),
    );
    const token = body?.["token"];
    const expiresAt = typeof body?.["expires_at"] === "string" ? Date.parse(body["expires_at"]) : Number.NaN;
    if (typeof token !== "string" || token === "" || Number.isNaN(expiresAt)) {
      throw new ForgeError(`${WHAT}: the response has no token or expiry`, "failed", response.status);
    }
    cached = { token, expiresAt };
    return token;
  };

  return () => {
    if (cached !== undefined && Date.now() < cached.expiresAt - REFRESH_MARGIN_MS) return Promise.resolve(cached.token);
    // Concurrent callers share one request.
    pending ??= request().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}

/** How often a request is tried, and the waits between the tries. */
const TRIES = 3;
const WAITS_MS = [2_000, 5_000] as const;
/** A cause's `code` such as `UND_ERR_CONNECT_TIMEOUT`; anything else from the cause is left out. */
const PLAIN_CODE = /^[A-Z][A-Z0-9_]*$/;

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Tries a request that is safe to repeat up to TRIES times, while `fetch` rejects or GitHub
 * answers with a 5xx; any other answer is final at once. Resolves to a 2xx response and its JSON
 * body, and otherwise rejects with a ForgeError whose message holds none of `secrets` and,
 * from a rejected `fetch`, only its message and its cause's code.
 */
async function tryRequest(what: string, secrets: string[], sleep: Sleep, send: () => Promise<Response>): Promise<{ response: Response; body: Record<string, unknown> | undefined }> {
  for (let tried = 1; ; tried += 1) {
    let failure: ForgeError;
    let retryable: boolean;
    const prefix = (exhausted: boolean) => (exhausted ? `${what} ${String(TRIES)} times` : what);
    try {
      const response = await send();
      const body = await readJson(response);
      if (response.ok) return { response, body };
      const kind: ForgeErrorKind = response.status === 401 ? "unauthorized" : response.status === 404 ? "not-found" : "failed";
      const detail = typeof body?.["message"] === "string" ? ` ${body["message"]}` : "";
      retryable = response.status >= 500;
      failure = new ForgeError(`${prefix(retryable && tried === TRIES)}: ${String(response.status)}${scrub(detail, secrets)}`, kind, response.status);
    } catch (error) {
      // No `cause`: a fetch error may carry the request, and with it the credential.
      retryable = true;
      failure = new ForgeError(`${prefix(tried === TRIES)}: ${scrub(networkDetail(error), secrets)}`, "failed");
    }
    if (!retryable || tried === TRIES) throw failure;
    await sleep(WAITS_MS[tried - 1] ?? WAITS_MS[1]);
  }
}

/** A rejected fetch's message, with its cause's code when that is a plain code. */
function networkDetail(error: unknown): string {
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  const code: unknown = typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : undefined;
  return typeof code === "string" && PLAIN_CODE.test(code) ? `${messageOf(error)} (${code})` : messageOf(error);
}

/** An RS256 JWT issued by the App, valid for under 10 minutes. */
function appJwt(appId: number, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url({ alg: "RS256", typ: "JWT" });
  const payload = base64url({ iat: now - JWT_BACKDATE_S, exp: now + JWT_LIFETIME_S, iss: appId });
  let signature: Buffer;
  try {
    signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey);
  } catch {
    // OpenSSL's message is not needed, and nothing about the key goes into the error.
    throw new ForgeError("GitHub App: signing the JWT failed: the private key cannot be used", "failed");
  }
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function readJson(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = await response.json();
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function scrub(text: string, secrets: string[]): string {
  return secrets.reduce((result, secret) => (secret === "" ? result : result.replaceAll(secret, "[REDACTED]")), text);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface AppCommitterOptions {
  /** The App's slug, such as `ceh-app`. */
  slug: string;
  /** Authenticates the lookup; an installation token provider in the worker. */
  token?: TokenProvider;
  fetch?: typeof fetch;
  baseUrl?: string;
  sleep?: Sleep;
}

/**
 * The App's bot user as a git identity: `<slug>[bot]` with GitHub's noreply address for the
 * bot's user id, so GitHub attributes the commits to the App. Looked up once at start-up.
 */
export async function appCommitter(options: AppCommitterOptions): Promise<{ name: string; email: string }> {
  const login = `${options.slug}[bot]`;
  const what = `GitHub App: looking up the bot user ${login} failed`;
  const url = `${(options.baseUrl ?? "https://api.github.com").replace(/\/+$/, "")}/users/${encodeURIComponent(login)}`;
  const token = options.token === undefined ? undefined : await options.token();
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  if (token !== undefined) headers["authorization"] = `token ${token}`;
  const secrets = token === undefined ? [] : [token];

  const fetchFn = options.fetch ?? fetch;
  const { response, body } = await tryRequest(what, secrets, options.sleep ?? defaultSleep, () => fetchFn(url, { headers }));
  const id = body?.["id"];
  if (body?.["login"] !== login || typeof id !== "number" || !Number.isSafeInteger(id)) {
    throw new ForgeError(`${what}: the response is not that bot user`, "failed", response.status);
  }
  return { name: login, email: `${String(id)}+${login}@users.noreply.github.com` };
}
