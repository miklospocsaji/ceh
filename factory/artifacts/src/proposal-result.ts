import { z } from "zod";

/**
 * A capability's name: a folder under `openspec/specs/`. Which capabilities exist is the target's
 * own decision, stated in its `openspec/config.yaml`, so the factory checks only the name's form;
 * Proposal checks the names against the change's delta specs (ADR 0014).
 */
export const Capability = z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, "a kebab-case capability name");

/** A change's `x-complexity` in `.openspec.yaml`, which routes it after Proposal approval. */
export const Complexity = z.enum(["small", "medium", "large"]);
export type Complexity = z.infer<typeof Complexity>;

/** The proposal author's result (add-role-runner design.md). */
export const ProposalResult = z.strictObject({
  changeId: z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/, "a verb-led kebab-case id"),
  capabilities: z.array(Capability).min(1),
  complexity: Complexity,
  summary: z.string().min(1),
  openQuestions: z.array(z.string()),
});

export type ProposalResult = z.infer<typeof ProposalResult>;
