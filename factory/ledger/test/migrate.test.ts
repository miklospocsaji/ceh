import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase("migrate");
  return () => db.close();
});

async function tables(): Promise<string[]> {
  const { rows } = await db.pool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name",
  );
  return rows.map((row) => row.table_name);
}

describe("migrate", () => {
  it("applies each migration once and is idempotent", async () => {
    expect(await migrate(db.pool)).toEqual(["0001_init", "0002_cloud", "0003_build", "0004_repository", "0005_comments"]);
    expect(await tables()).toEqual(["approvals", "attempts", "comments", "events", "messages", "schema_migrations", "tasks", "work_items"]);

    expect(await migrate(db.pool)).toEqual([]);
    const { rows } = await db.pool.query<{ version: string }>("SELECT version FROM schema_migrations");
    expect(rows.map((row) => row.version).sort()).toEqual(["0001_init", "0002_cloud", "0003_build", "0004_repository", "0005_comments"]);
  });

  it("Scenario: Existing work items are backfilled", async () => {
    const old = await createTestDatabase("migrate_backfill");
    const before = await mkdtemp(join(tmpdir(), "ledger-migrations-"));
    try {
      // The ledger as it was before 0004, holding work items.
      const all = resolve(import.meta.dirname, "../migrations");
      for (const file of (await readdir(all)).filter((name) => name < "0004")) await cp(join(all, file), join(before, file));
      expect(await migrate(old.pool, before)).toEqual(["0001_init", "0002_cloud", "0003_build"]);
      await old.pool.query(
        "INSERT INTO work_items (issue_number, change_id, branch, state, execution_arn) VALUES (11, 'add-read-a-kindle-vocab-db', 'add-read-a-kindle-vocab-db', 'pr-open', 'arn:one'), (12, 'add-word-counts', 'add-word-counts', 'escalated', NULL)",
      );
      const rows = async () => (await old.pool.query<Record<string, unknown>>("SELECT * FROM work_items ORDER BY id")).rows;
      const earlier = await rows();

      expect(await migrate(old.pool)).toEqual(["0004_repository", "0005_comments"]);

      const later = await rows();
      expect(later.map((row) => row["repository"])).toEqual(["miklospocsaji/vocab", "miklospocsaji/vocab"]);
      // Nothing else of a work item changed.
      expect(later.map((row) => Object.fromEntries(Object.entries(row).filter(([column]) => column !== "repository")))).toEqual(earlier);
      // The old keys are gone: the same issue number and change id fit in another repository.
      await old.pool.query("INSERT INTO work_items (repository, issue_number, change_id, branch, state) VALUES ('someone/other', 11, 'add-read-a-kindle-vocab-db', 'b', 'intake')");
      await expect(old.pool.query("INSERT INTO work_items (issue_number, change_id, branch, state) VALUES (13, 'add-x', 'add-x', 'intake')")).rejects.toThrow(/repository/);
    } finally {
      await rm(before, { recursive: true, force: true });
      await old.close();
    }
  });
});
