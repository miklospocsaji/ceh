/**
 * The worker's GitHub App connection (ADR 0009): the installation token provider, the bot user
 * as the commit identity, and the Forge built on both. `main.ts` calls it before `runWorker`.
 *
 * A `command` task whose set-up fails (add-work-item-resume, "A command that fails before its
 * handler is answered") still tries the fixed "did not go through" reply, through a Forge with no
 * committer, since a comment needs no commit identity. Like the handler, it answers only the
 * owner's command on the task's issue. If GitHub cannot be reached for the reply either, one log
 * line names the issue and the comment, and the owner sends the command again: nothing retries a
 * `command` task, and GitHub does not redeliver a webhook that was answered.
 */
import { appCommitter, createInstallationTokenProvider, GitHubForge, type Sleep } from "@ceh/factory-forge";
import { commandFailedReply, parseCommand, WORKER_EXIT } from "@ceh/factory-orchestrator";
import type { WorkerArgs, WorkerConfig } from "./config.ts";

export interface ConnectGitHubOptions {
  args: WorkerArgs;
  config: Pick<WorkerConfig, "owner" | "repo" | "app" | "target">;
  /** Defaults to the global `fetch`; tests inject one so nothing reaches the network. */
  fetch?: typeof fetch;
  /** Waits between the tries of the token request and the bot lookup; tests inject one. */
  sleep?: Sleep;
  err: (text: string) => void;
}

export type GitHubConnection = { ok: true; forge: GitHubForge; committer: { name: string; email: string } } | { ok: false; code: number };

export async function connectGitHub(options: ConnectGitHubOptions): Promise<GitHubConnection> {
  const { config, fetch: fetchFn, sleep } = options;
  const io = { ...(fetchFn === undefined ? {} : { fetch: fetchFn }), ...(sleep === undefined ? {} : { sleep }) };
  const token = createInstallationTokenProvider({
    appId: config.app.appId,
    installationId: config.app.installationId,
    privateKey: config.app.privateKey,
    repository: config.repo,
    ...io,
  });
  try {
    const committer = await appCommitter({ slug: config.app.slug, token, ...io });
    const forge = new GitHubForge({ owner: config.owner, repo: config.repo, token, committer, ...(fetchFn === undefined ? {} : { fetch: fetchFn }) });
    return { ok: true, forge, committer };
  } catch (error) {
    const { args } = options;
    if (args.state !== "command" || args.commentId === undefined) {
      options.err(`factory-worker: ${messageOf(error)}\n`);
    } else {
      const subject = `command for issue #${String(args.issueNumber)}, comment ${String(args.commentId)}`;
      options.err(`factory-worker: ${subject}: setting up the GitHub App failed: ${messageOf(error)}\n`);
      await replyCommandFailed(options, new GitHubForge({ owner: config.owner, repo: config.repo, token, ...(fetchFn === undefined ? {} : { fetch: fetchFn }) }), args.issueNumber, args.commentId, subject);
    }
    return { ok: false, code: WORKER_EXIT.error };
  }
}

/** The fixed reply to the owner's command, naming it when the comment can be read. */
async function replyCommandFailed(options: ConnectGitHubOptions, forge: GitHubForge, issueNumber: number, commentId: number, subject: string): Promise<void> {
  const log = (text: string) => {
    options.err(`factory-worker: ${subject}: ${text}\n`);
  };
  let written: string | undefined;
  try {
    const comment = await forge.getComment(commentId);
    const command = parseCommand(comment.body);
    const owner = options.config.target.owner;
    // As the handler checks it: never a reply to anyone but the owner, or on another issue.
    const refusal =
      comment.author.toLowerCase() !== owner.toLowerCase()
        ? `is by ${comment.author}, not by the owner ${owner}`
        : comment.issueNumber !== issueNumber
          ? `is on #${String(comment.issueNumber)}, not on issue #${String(issueNumber)}`
          : command === undefined
            ? "has no command on its first line"
            : undefined;
    if (refusal !== undefined) {
      log(`comment ${String(commentId)} ${refusal}; not answered`);
      return;
    }
    written = command?.written;
  } catch (error) {
    // The reply below still goes out, without naming the command.
    log(`reading the comment failed: ${messageOf(error)}`);
  }
  try {
    await forge.comment(issueNumber, commandFailedReply(written));
    log("the command was not recorded; the issue was told it did not go through");
  } catch (error) {
    log(`replying to the failure failed: ${messageOf(error)}`);
    log("GitHub could not be reached; the command was neither recorded nor answered");
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
