/**
 * add-approval-feedback task 1.3: the read-only question mode of the proposal author and the
 * architect, with a fake SDK session.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookCallback, HookJSONOutput, Options, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { QuestionAnswer } from "@ceh/factory-artifacts";
import { testTarget } from "@ceh/factory-target/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRole } from "../src/config.ts";
import { questionRole, QUESTION_BUDGET_USD, QUESTION_MAX_TURNS, renderQuestionPrompt } from "../src/question.ts";
import { createRunner } from "../src/runner.ts";
import { fakeQuery, success } from "./fake-session.ts";

const TARGET = testTarget();
const CHANGE_ID = "add-sample";
const PROPOSAL = `openspec/changes/${CHANGE_ID}/proposal.md`;
const PROPOSAL_TEXT = "# Proposal\n\n## Why\n\nBecause.\n";

let worktree: string;

beforeEach(() => {
  worktree = realpathSync(mkdtempSync(join(tmpdir(), "question-role-")));
  mkdirSync(join(worktree, `openspec/changes/${CHANGE_ID}`), { recursive: true });
  writeFileSync(join(worktree, PROPOSAL), PROPOSAL_TEXT);
});

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
});

/** The PreToolUse hooks a session got, for the tool name. */
function hooksFor(options: Options, toolName: string): HookCallback[] {
  return (options.hooks?.PreToolUse ?? []).filter((matcher) => new RegExp(`^(${matcher.matcher ?? ".*"})$`).test(toolName)).flatMap((matcher) => matcher.hooks);
}

async function decide(options: Options, toolName: string, toolInput: Record<string, unknown>): Promise<string | undefined> {
  const input: PreToolUseHookInput = {
    hook_event_name: "PreToolUse",
    session_id: "session",
    transcript_path: join(worktree, "transcript.jsonl"),
    cwd: worktree,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "tool-use",
  };
  for (const hook of hooksFor(options, toolName)) {
    const output: HookJSONOutput = await hook(input, "tool-use", { signal: new AbortController().signal });
    const specific = "hookSpecificOutput" in output ? output.hookSpecificOutput : undefined;
    if (specific?.hookEventName === "PreToolUse" && specific.permissionDecision === "deny") return "deny";
  }
  return undefined;
}

describe("questionRole", () => {
  it("Scenario: Question session has only read tools", async () => {
    const author = await loadRole("proposal-author", TARGET);

    const role = questionRole(author);

    expect(role.name).toBe(author.name);
    expect(role.model).toBe(author.model);
    expect(role.authMode).toBe(author.authMode);
    expect([...role.tools].sort()).toEqual(["Glob", "Grep", "Read"]);
    expect([...role.allow].sort()).toEqual(["Glob", "Grep", "Read"]);
    expect(role.writable).toEqual([]);
    expect(role.maxTurns).toBe(10);
    expect(QUESTION_MAX_TURNS).toBe(10);
    expect(role.maxBudgetUsd).toBe(0.3);
    expect(QUESTION_BUDGET_USD).toBe(0.3);
    expect(role.runsIn).toBe("worker");
    expect(role.resultSchema).toBe("question-answer");
    expect(role.schema).toBe(QuestionAnswer);
    // The author's prompt, then the question overlay, which points to /revise for changes.
    expect(role.prompt.startsWith(author.prompt)).toBe(true);
    expect(role.prompt.length).toBeGreaterThan(author.prompt.length);
    expect(role.prompt.slice(author.prompt.length)).toContain("/revise");

    // The session the runner starts, not only the role it is given.
    const fake = fakeQuery(success({ answer: "Because the issue asks for it." }));
    const runRole = createRunner({ query: fake.query, recorder: { record: () => Promise.resolve() }, env: { PATH: "/usr/bin" } });
    const answer = await runRole(role, { id: "item-1", changeId: CHANGE_ID, worktree, issue: { title: "t", body: "b" }, changeFiles: [], specs: [], prompt: "Why?" });

    expect(answer).toEqual({ answer: "Because the issue asks for it." });
    const options = fake.calls[0]?.options;
    expect([...(options?.tools as string[])].sort()).toEqual(["Glob", "Grep", "Read"]);
    expect(options?.allowedTools?.some((rule) => rule.startsWith("WebFetch"))).toBe(false);
    expect(options?.maxTurns).toBe(10);
    expect(options?.maxBudgetUsd).toBe(0.3);
    expect(options?.model).toBe(author.model);
  });

  it("builds the architect's question mode from the architect", async () => {
    const architect = await loadRole("architect", TARGET);
    const role = questionRole(architect);
    expect(role).toMatchObject({ name: "architect", model: architect.model, writable: [], maxTurns: 10, maxBudgetUsd: 0.3, resultSchema: "question-answer" });
    expect([...role.tools].sort()).toEqual(["Glob", "Grep", "Read"]);
    expect(role.prompt.startsWith(architect.prompt)).toBe(true);
  });

  it("Scenario: Question session cannot write even when asked", async () => {
    const role = questionRole(await loadRole("proposal-author", TARGET));
    const decisions: (string | undefined)[] = [];
    // The "session" tries to edit proposal.md, as a question asking for a fix might lead it to.
    const fake = fakeQuery(success({ answer: "Use /revise to change it." }), async (options) => {
      decisions.push(await decide(options, "Edit", { file_path: join(worktree, PROPOSAL), old_string: "Because.", new_string: "Edited." }));
      decisions.push(await decide(options, "Write", { file_path: join(worktree, PROPOSAL), content: "Rewritten." }));
    });
    const runRole = createRunner({ query: fake.query, recorder: { record: () => Promise.resolve() }, env: { PATH: "/usr/bin" } });
    const prompt = renderQuestionPrompt({
      changeId: CHANGE_ID,
      commit: "0123456789abcdef0123456789abcdef01234567",
      issue: { title: "Add a sample", body: "Please add a sample." },
      changeFiles: [{ path: PROPOSAL, content: PROPOSAL_TEXT }],
      ownerFeedback: { revisions: [], questions: [] },
      question: "Can you fix the typo in proposal.md? Edit it now.",
    });

    await runRole(role, { id: "item-1", changeId: CHANGE_ID, worktree, issue: { title: "t", body: "b" }, changeFiles: [], specs: [], prompt });

    const options = fake.calls[0]?.options;
    // Edit and Write do not exist for the session, and the guard denies them anyway.
    expect(options?.tools).not.toContain("Edit");
    expect(options?.tools).not.toContain("Write");
    expect(options?.allowedTools).not.toContain("Edit");
    expect(options?.allowedTools).not.toContain("Write");
    expect(decisions).toEqual(["deny", "deny"]);
    expect(readFileSync(join(worktree, PROPOSAL), "utf8")).toBe(PROPOSAL_TEXT);
  });
});

describe("renderQuestionPrompt", () => {
  it("holds the issue, the change files, the commit, earlier feedback and the question, the owner's text fenced", () => {
    const prompt = renderQuestionPrompt({
      changeId: CHANGE_ID,
      commit: "0123456789abcdef0123456789abcdef01234567",
      issue: { title: "Add a sample", body: "Please add a sample." },
      changeFiles: [{ path: PROPOSAL, content: PROPOSAL_TEXT }],
      ownerFeedback: { revisions: [{ text: "Use SQLite, not CSV." }], questions: [{ question: { text: "Why CSV?" }, answer: "The issue said so." }] },
      question: "Why is the importer in the domain package?",
    });

    for (const text of [CHANGE_ID, "0123456789abcdef0123456789abcdef01234567", "Please add a sample.", PROPOSAL, "Because.", "Use SQLite, not CSV.", "Why CSV?", "The issue said so.", "Why is the importer in the domain package?"]) {
      expect(prompt).toContain(text);
    }
    expect(prompt).toMatch(/untrusted-data owner-feedback/);
    expect(prompt.indexOf("Use SQLite, not CSV.")).toBeLessThan(prompt.indexOf("Why is the importer in the domain package?"));
  });
});
