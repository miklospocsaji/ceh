/**
 * The states a resumed execution enters (add-work-item-resume design, "Adopt"): Adopt answers one
 * of these words, and the state machine's entry Choice routes on it. A module of its own, so the
 * state machine definition stays free of the ledger.
 */
export type Entry = "proposal" | "await-approval" | "approved" | "design" | "await-design" | "plan" | "build";
export const ENTRIES: readonly Entry[] = ["proposal", "await-approval", "approved", "design", "await-design", "plan", "build"];
