-- Owner commands (add-owner-commands design, "Ledger"; ADR 0015).

-- One row per owner command the `command` task read, keyed by its GitHub comment id, so a
-- webhook redelivery or a repeated task records and applies nothing a second time. The body is
-- the comment as read at receipt: later edits or deletes on GitHub change nothing here.
CREATE TABLE comments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Null: the issue had no work item when the command arrived.
  work_item_id bigint REFERENCES work_items (id),
  repository text NOT NULL,
  issue_number integer NOT NULL,
  github_comment_id bigint NOT NULL,
  author text NOT NULL,
  -- As written, unknown verbs too.
  verb text NOT NULL,
  body text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  outcome text NOT NULL,
  -- The work item's state the command met; null without a work item.
  state_met text,
  CONSTRAINT comments_github_comment_id_key UNIQUE (github_comment_id),
  CONSTRAINT comments_outcome_check CHECK (outcome IN ('applied', 'busy', 'refused', 'unknown'))
);

CREATE INDEX comments_work_item_idx ON comments (work_item_id, received_at);
