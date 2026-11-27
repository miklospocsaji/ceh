/**
 * add-owner-commands task 1.4: what counts as an owner command (design, "Parsing"). No scenario
 * of its own; the webhook and handler scenarios rest on it.
 */
import { describe, expect, it } from "vitest";
import { KNOWN_VERBS, parseCommand } from "../src/commands/parse.ts";

describe("parseCommand", () => {
  it("reads the verb after the slash, with no text", () => {
    expect(parseCommand("/approve")).toEqual({ written: "approve", verb: "approve", firstLine: "/approve", text: "" });
  });

  it("trims the first line before looking for the slash", () => {
    expect(parseCommand("   /status  \nthanks")).toMatchObject({ verb: "status", firstLine: "/status" });
    expect(parseCommand("\t/help")).toMatchObject({ verb: "help", firstLine: "/help" });
  });

  it("takes the verb up to the first whitespace, and the rest of the first line as text", () => {
    expect(parseCommand("/revise keep the CSV export\tas it is")).toEqual({
      written: "revise",
      verb: "revise",
      firstLine: "/revise keep the CSV export\tas it is",
      text: "keep the CSV export\tas it is",
    });
  });

  it("adds the following lines to the text, trimmed as a whole", () => {
    const body = "/revise Answers:\n\n1. Skip duplicates.\n2. Keep the book titles.\n\n";

    expect(parseCommand(body)?.text).toBe("Answers:\n\n1. Skip duplicates.\n2. Keep the book titles.");
    expect(parseCommand("/question\n\nWhy node:sqlite?  \n")?.text).toBe("Why node:sqlite?");
  });

  it("ends the first line at a CRLF as at a LF, and keeps no carriage returns", () => {
    const command = parseCommand("/question  why?\r\nand how?\r\n");

    expect(command).toEqual({ written: "question", verb: "question", firstLine: "/question  why?", text: "why?\nand how?" });
  });

  it.each(KNOWN_VERBS.map((verb) => [verb]))("knows /%s", (verb) => {
    expect(parseCommand(`/${verb}`)).toMatchObject({ written: verb, verb });
  });

  it("knows exactly the seven M3.5 verbs, all lowercase", () => {
    expect([...KNOWN_VERBS]).toEqual(["approve", "revise", "question", "abort", "resume", "status", "help"]);
  });

  it.each([
    ["a capitalised verb", "/Approve", "Approve"],
    ["a misspelt verb", "/aprove", "aprove"],
    ["a path", "/tmp/foo is missing", "tmp/foo"],
    ["a bare slash", "/", ""],
    ["a slash before a space", "/ approve", ""],
    ["a verb not in M3.5", "/restart", "restart"],
  ])("calls %s unknown, keeping the verb as written", (_label, body, written) => {
    expect(parseCommand(body)).toMatchObject({ verb: "unknown", written });
  });

  it.each([
    ["no slash", "Looks good to me, thanks."],
    ["a command on the second line", "As discussed:\n/approve"],
    ["an empty body", ""],
    ["only whitespace", "  \n\t\n"],
    ["a command in inline code", "`/approve`"],
    ["a quoted command", "> /approve"],
  ])("is not a command with %s", (_label, body) => {
    expect(parseCommand(body)).toBeUndefined();
  });
});
