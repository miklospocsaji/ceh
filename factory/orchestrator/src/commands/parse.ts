/**
 * What counts as an owner command (add-owner-commands design, "Parsing"; docs/m3.5-owner-commands.md
 * section 2). The webhook and the `command` worker task both use this one function, so they cannot
 * disagree on what is a command.
 *
 * - The first line is the text up to the first line break, trimmed. A comment is a command only if
 *   it starts with `/`; a command further down stays inert.
 * - The verb is what follows the slash up to the first whitespace, as written. Verbs are
 *   case-sensitive: anything not in KNOWN_VERBS (`/Approve`, `/aprove`, a bare `/`) is `unknown`,
 *   so a typo is answered rather than passing silently.
 * - The text is the rest of the first line and the following lines, trimmed as a whole.
 */

/** The M3.5 commands, in the order `/help` lists them. */
export const KNOWN_VERBS = ["approve", "revise", "question", "abort", "resume", "status", "help"] as const;
export type KnownVerb = (typeof KNOWN_VERBS)[number];

export interface Command {
  /** The verb as written after the slash: `approve`, `Approve`, `tmp/foo`, or `""` for a bare `/`. */
  written: string;
  /** The known verb, or `unknown`. */
  verb: KnownVerb | "unknown";
  /** The first line, trimmed. */
  firstLine: string;
  /** Everything after the verb, over all lines, trimmed; `""` when there is none. */
  text: string;
}

/** The command a comment's body holds, or undefined when it holds none. */
export function parseCommand(body: string): Command | undefined {
  const [first = "", ...rest] = body.split(/\r?\n/);
  const firstLine = first.trim();
  if (!firstLine.startsWith("/")) return undefined;

  const afterSlash = firstLine.slice(1);
  const written = /^\S*/.exec(afterSlash)?.[0] ?? "";
  const text = [afterSlash.slice(written.length), ...rest].join("\n").trim();
  return { written, verb: isKnownVerb(written) ? written : "unknown", firstLine, text };
}

function isKnownVerb(value: string): value is KnownVerb {
  return (KNOWN_VERBS as readonly string[]).includes(value);
}
