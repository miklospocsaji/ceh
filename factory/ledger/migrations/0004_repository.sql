-- Work items keyed by repository (add-target-repositories design, "Ledger"; ADR 0003 amendment).

-- The repository a work item belongs to, as <owner>/<repo>. Every work item made before the
-- factory left its target's repository is vocab's.
ALTER TABLE work_items ADD COLUMN repository text;
UPDATE work_items SET repository = 'miklospocsaji/vocab';
ALTER TABLE work_items ALTER COLUMN repository SET NOT NULL;

-- One work item per issue and per change id within a repository, no longer across all of them.
ALTER TABLE work_items DROP CONSTRAINT work_items_issue_number_key;
ALTER TABLE work_items DROP CONSTRAINT work_items_change_id_key;
ALTER TABLE work_items ADD CONSTRAINT work_items_repository_issue_number_key UNIQUE (repository, issue_number);
ALTER TABLE work_items ADD CONSTRAINT work_items_repository_change_id_key UNIQUE (repository, change_id);
