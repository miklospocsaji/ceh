-- Aborting and resuming work items (add-work-item-resume design, "Ledger"; ADR 0003 amendment).

-- The state an `aborted` or `escalated` work item stopped in, where a `/resume` enters again;
-- null for every other state. Work items escalated before this change have none.
ALTER TABLE work_items ADD COLUMN stopped_in text;

-- An attempt stopped by `/abort` (or a closed issue) is closed `aborted`, with no failure reason:
-- it never counts toward a retry limit.
ALTER TABLE attempts DROP CONSTRAINT attempts_outcome_check;
ALTER TABLE attempts ADD CONSTRAINT attempts_outcome_check CHECK (outcome IN ('succeeded', 'failed', 'aborted'));
-- 0001's open/closed check, with `aborted` closed like `succeeded`: no failure reason.
ALTER TABLE attempts DROP CONSTRAINT attempts_check;
ALTER TABLE attempts ADD CONSTRAINT attempts_open_or_closed CHECK (
  (ended_at IS NULL AND outcome IS NULL AND failure_reason IS NULL)
  OR (ended_at IS NOT NULL AND outcome IN ('succeeded', 'aborted') AND failure_reason IS NULL)
  OR (ended_at IS NOT NULL AND outcome = 'failed' AND failure_reason IS NOT NULL)
);

-- An approval whose execution was stopped is closed `aborted`: its task token is dead.
ALTER TABLE approvals DROP CONSTRAINT approvals_outcome_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_outcome_check CHECK (outcome IN ('approved', 'revise', 'aborted'));
