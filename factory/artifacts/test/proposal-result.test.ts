import { describe, expect, it } from "vitest";
import { ProposalResult, resultSchemas } from "../src/index.ts";

const valid = {
  changeId: "add-vocab-import",
  capabilities: ["vocab-import"],
  complexity: "medium",
  summary: "Import lookups from a Kindle vocab.db.",
  openQuestions: ["Should re-imports skip deleted books?"],
};

function without(key: keyof typeof valid): Record<string, unknown> {
  return Object.fromEntries(Object.entries(valid).filter(([name]) => name !== key));
}

describe("ProposalResult", () => {
  // Control: without it, a schema that rejects everything would pass every test below.
  it("accepts a complete result, with or without open questions", () => {
    expect(ProposalResult.parse(valid)).toEqual(valid);
    expect(ProposalResult.safeParse({ ...valid, openQuestions: [] }).success).toBe(true);
  });

  it("is registered as proposal-result", () => {
    expect(resultSchemas["proposal-result"]).toBe(ProposalResult);
  });

  it("requires the change id, capabilities, complexity, summary and open questions", () => {
    for (const key of ["changeId", "capabilities", "complexity", "summary", "openQuestions"] as const) {
      expect(ProposalResult.safeParse(without(key)).success, key).toBe(false);
    }
  });

  it("refuses a change id that is not verb-led kebab-case", () => {
    for (const changeId of ["", "Add-Vocab", "vocab", "add_vocab_import", "add-vocab-"]) {
      expect(ProposalResult.safeParse({ ...valid, changeId }).success, changeId).toBe(false);
    }
  });

  it("takes any kebab-case capability name, since capabilities are the target's own", () => {
    for (const name of ["vocab-import", "billing", "auth", "a1-b2"]) expect(ProposalResult.safeParse({ ...valid, capabilities: [name] }).success, name).toBe(true);
    for (const name of ["", "Vocab", "vocab_import", "../roles", "specs/roles", "-auth", "auth-"]) {
      expect(ProposalResult.safeParse({ ...valid, capabilities: [name] }).success, name).toBe(false);
    }
    expect(ProposalResult.safeParse({ ...valid, capabilities: [] }).success).toBe(false);
  });

  it("limits complexity to small, medium and large", () => {
    for (const complexity of ["small", "medium", "large"]) {
      expect(ProposalResult.safeParse({ ...valid, complexity }).success, complexity).toBe(true);
    }
    expect(ProposalResult.safeParse({ ...valid, complexity: "huge" }).success).toBe(false);
  });

  it("refuses unknown fields", () => {
    expect(ProposalResult.safeParse({ ...valid, design: "…" }).success).toBe(false);
  });
});

describe("ProposalResult: whatChanged (add-approval-feedback)", () => {
  it("takes an optional whatChanged string, and leaves it out when absent", () => {
    expect(ProposalResult.safeParse({ ...valid, whatChanged: "Answered the export question: SQLite." }).success).toBe(true);
    expect(ProposalResult.parse(valid)).not.toHaveProperty("whatChanged");
    expect(ProposalResult.safeParse({ ...valid, whatChanged: ["a"] }).success).toBe(false);
  });
});
