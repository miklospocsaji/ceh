-- Revisions and questions (add-approval-feedback design, "Ledger"; ADR 0015 amendment).

-- How a closed approval was closed: `approved` by /approve, `revise` by /revise. Every approval
-- closed before this change was approved, since /approve was the only way to close one.
ALTER TABLE approvals ADD COLUMN outcome text CONSTRAINT approvals_outcome_check CHECK (outcome IN ('approved', 'revise'));
UPDATE approvals SET outcome = 'approved' WHERE state = 'closed';
ALTER TABLE approvals ADD CONSTRAINT approvals_outcome_closed CHECK ((state = 'closed') = (outcome IS NOT NULL));

-- The owner commands a role was given (comments.id, oldest first): a revision's /revise
-- comments and the stage's questions, or a question session's /question.
ALTER TABLE attempts ADD COLUMN comment_ids bigint[] NOT NULL DEFAULT '{}';
