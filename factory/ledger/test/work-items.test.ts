import { beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.ts";
import { ChangeIdTaken, IssueHasWorkItem, createWorkItem, findWorkItemByChangeId, findWorkItemByIssue, setWorkItemState } from "../src/queries.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";

const REPOSITORY = "miklospocsaji/vocab";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase("work_items");
  await migrate(db.pool);
  return () => db.close();
});

describe("work items", () => {
  it("creates a work item and finds it by issue number", async () => {
    const created = await createWorkItem(db.pool, {
      repository: REPOSITORY,
      issueNumber: 12,
      changeId: "add-import-kindle-vocab-db",
      branch: "add-import-kindle-vocab-db",
      state: "intake",
    });

    expect(created).toMatchObject({
      issueNumber: 12,
      changeId: "add-import-kindle-vocab-db",
      branch: "add-import-kindle-vocab-db",
      state: "intake",
    });
    expect(created.id).toEqual(expect.any(String));
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);

    expect(await findWorkItemByIssue(db.pool, REPOSITORY, 12)).toEqual(created);
  });

  it("finds nothing for an issue without a work item", async () => {
    expect(await findWorkItemByIssue(db.pool, REPOSITORY, 999)).toBeUndefined();
  });

  it("rejects a second work item with the same change id", async () => {
    await createWorkItem(db.pool, { repository: REPOSITORY, issueNumber: 20, changeId: "fix-duplicate-lookups", branch: "fix-duplicate-lookups", state: "intake" });

    const second = createWorkItem(db.pool, { repository: REPOSITORY, issueNumber: 21, changeId: "fix-duplicate-lookups", branch: "fix-duplicate-lookups", state: "intake" });

    await expect(second).rejects.toThrow(ChangeIdTaken);
    await expect(second).rejects.toThrow("fix-duplicate-lookups");
    expect(await findWorkItemByIssue(db.pool, REPOSITORY, 21)).toBeUndefined();
  });

  it("finds a work item by change id", async () => {
    const created = await createWorkItem(db.pool, { repository: REPOSITORY, issueNumber: 30, changeId: "add-review-queue", branch: "add-review-queue", state: "intake" });

    expect(await findWorkItemByChangeId(db.pool, REPOSITORY, "add-review-queue")).toEqual(created);
    expect(await findWorkItemByChangeId(db.pool, REPOSITORY, "add-nothing-like-it")).toBeUndefined();
  });

  it("moves a work item to a new state and bumps updated_at", async () => {
    const created = await createWorkItem(db.pool, { repository: REPOSITORY, issueNumber: 31, changeId: "add-word-export", branch: "add-word-export", state: "intake" });

    const moved = await setWorkItemState(db.pool, created.id, "proposal", { from: "intake" });

    expect(moved).toMatchObject({ id: created.id, state: "proposal", createdAt: created.createdAt });
    expect(moved.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
    expect(await findWorkItemByIssue(db.pool, REPOSITORY, 31)).toEqual(moved);
    await expect(setWorkItemState(db.pool, "999999", "proposal", { from: "intake" })).rejects.toThrow("999999");
  });

  it("Scenario: Second work item for the same issue is refused", async () => {
    const first = await createWorkItem(db.pool, { repository: REPOSITORY, issueNumber: 40, changeId: "add-book-filter", branch: "add-book-filter", state: "proposal" });

    const sameIssue = createWorkItem(db.pool, { repository: REPOSITORY, issueNumber: 40, changeId: "add-book-filter-2", branch: "add-book-filter-2", state: "intake" });
    await expect(sameIssue).rejects.toThrow(IssueHasWorkItem);
    const sameChange = createWorkItem(db.pool, { repository: REPOSITORY, issueNumber: 41, changeId: "add-book-filter", branch: "add-book-filter", state: "intake" });
    await expect(sameChange).rejects.toThrow(ChangeIdTaken);

    expect(await findWorkItemByIssue(db.pool, REPOSITORY, 40)).toEqual(first);
    expect(await findWorkItemByIssue(db.pool, REPOSITORY, 41)).toBeUndefined();
    expect(await findWorkItemByChangeId(db.pool, REPOSITORY, "add-book-filter-2")).toBeUndefined();
  });

  it("keeps each repository's work items apart", async () => {
    const vocab = await createWorkItem(db.pool, { repository: REPOSITORY, issueNumber: 50, changeId: "add-streaks", branch: "add-streaks", state: "intake" });
    const other = await createWorkItem(db.pool, { repository: "someone/other", issueNumber: 50, changeId: "add-streaks", branch: "add-streaks", state: "intake" });

    expect(other.id).not.toBe(vocab.id);
    expect(vocab.repository).toBe(REPOSITORY);
    expect(await findWorkItemByIssue(db.pool, REPOSITORY, 50)).toEqual(vocab);
    expect(await findWorkItemByIssue(db.pool, "someone/other", 50)).toEqual(other);
    expect(await findWorkItemByChangeId(db.pool, "someone/other", "add-streaks")).toEqual(other);
    expect(await findWorkItemByIssue(db.pool, "nobody/else", 50)).toBeUndefined();
  });
});
