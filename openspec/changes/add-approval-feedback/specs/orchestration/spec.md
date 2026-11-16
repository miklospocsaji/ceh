## ADDED Requirements

### Requirement: `/revise` sends the awaiting proposal back to its author
An owner's `/revise <text>` while the work item awaits proposal approval SHALL close the approval with the outcome `revise`, put the work item back in `proposal`, and resume the execution with the decision `revise`, which runs Proposal again in the same execution. The author SHALL start from the branch head, and its new commit SHALL be followed by the summary, with what changed, and a new approval.

#### Scenario: Revise sends the proposal back to its author
- **WHEN** the owner comments `/revise Use SQLite, not CSV, for the export` on an issue whose work item awaits proposal approval after proposal attempt 1
- **THEN** the approval is closed with the outcome `revise`, the execution runs Proposal again, attempt 2's prompt holds the comment, a new commit is on the branch, the summary is posted again with a "What changed" section, and a new approval is open

#### Scenario: Revised proposal keeps the owner's branch edits
- **WHEN** the owner has pushed a commit editing `proposal.md` on the work item's branch, then comments `/revise …`
- **THEN** the proposal author's worktree starts from that commit, and the owner's edit is still in `proposal.md` after the revision unless the comment asked to change it

#### Scenario: Revised proposal routes on its new complexity
- **WHEN** a revision changes the change's `x-complexity` from `small` to `medium`, and the owner then approves
- **THEN** Approved routes the work item to Design, not to Plan

### Requirement: `/revise` sends an awaiting design back to the architect
An owner's `/revise <text>` while the work item awaits design approval SHALL close the approval with the outcome `revise`, put the work item back in `design`, and resume the execution with the decision `revise`, which runs Design again in the same execution. The design summary SHALL be posted again with what changed, and a new design approval opened.

#### Scenario: Revise sends the design back to the architect
- **WHEN** the owner comments `/revise Keep the parser in the domain package` on an issue whose `large` work item awaits design approval
- **THEN** the design approval is closed with the outcome `revise`, the architect runs again with the comment in its prompt, a new design commit is pushed, and the issue gets the design summary with "What changed" and a new design approval

### Requirement: Revisions are limited
A `/revise` without text SHALL be refused with a reply. A stage SHALL take at most 5 applied revisions; a 6th `/revise` SHALL be refused with a reply that suggests a new issue. A `/revise` SHALL be refused when the work item's estimated cost so far plus the author's per-attempt budget exceeds the target's per-work-item budget. A refused `/revise` SHALL change nothing.

#### Scenario: Revise without text is refused
- **WHEN** the owner comments `/revise` with nothing after the verb
- **THEN** the issue gets a reply saying `/revise` needs the answers or changes wanted, and the approval stays open

#### Scenario: Sixth revision is refused
- **WHEN** the owner comments `/revise …` on a proposal that has been revised 5 times
- **THEN** the issue gets a reply saying the limit of 5 revisions is reached and suggesting a new issue, and the approval stays open

#### Scenario: Revision over the budget is refused
- **WHEN** the work item's estimated cost is $4.00, the proposal author's per-attempt budget is $1.50 and the target's budget is $5
- **THEN** a `/revise` gets a reply naming the cost so far and the budget, and the approval stays open

### Requirement: Approval waits route on the owner's decision
AwaitApproval and AwaitDesignApproval SHALL be followed by a Choice on the decision the task token was resumed with: `revise` SHALL go back to Proposal (Design), and `approve` SHALL go on to Approved (Plan). The execution history SHALL carry only the decision, never the comment's text.

#### Scenario: Approval decision routes the execution
- **WHEN** AwaitApproval is resumed with `{ "decision": "revise" }`, and later with `{ "decision": "approve" }`
- **THEN** the execution enters Proposal the first time and Approved the second, and no event in its history holds the `/revise` comment's text

### Requirement: Approvals record how they were closed
A closed approval SHALL record its outcome: `approved` for `/approve`, `revise` for `/revise`. Approvals closed before this change SHALL read as `approved`.

#### Scenario: Closed approval records its outcome
- **WHEN** a proposal is revised once and then approved
- **THEN** the work item's first approval is closed with the outcome `revise` and the second with `approved`, both by the owner's login

### Requirement: `/question` is answered while the approval stays open
An owner's `/question <text>` while a proposal or design awaits approval SHALL be answered by a read-only session of that stage's author in the `command` task, on a fresh clone of the branch head. The execution and the approval SHALL be left as they are. The reply SHALL hold the answer and name the commit it read.

#### Scenario: Question about the proposal is answered
- **WHEN** the owner comments `/question Why is the importer in the domain package?` while the proposal awaits approval
- **THEN** the issue gets a reply with the proposal author's answer naming the branch head's commit, the approval is still open with its token, and the execution is still paused

#### Scenario: Question about the design is answered by the architect
- **WHEN** the owner comments `/question …` while a `large` design awaits approval
- **THEN** the answer comes from a question session of the architect, and the design approval stays open

#### Scenario: Question that asks for a change changes nothing
- **WHEN** the owner comments `/question Can you fix the typo in the proposal?`
- **THEN** the branch is unchanged, nothing is committed or pushed, and the answer points to `/revise`

### Requirement: Questions are limited and one at a time
A `/question` without text SHALL be refused. A work item SHALL answer one question at a time: a `/question` while another is being answered SHALL get the busy reply. A stage SHALL take at most 10 questions, and a `/question` SHALL be refused when the work item's cost so far plus $0.30 exceeds the target's budget. A failed answer SHALL be a failed attempt with a reply to ask again.

#### Scenario: Question without text is refused
- **WHEN** the owner comments `/question` with nothing after the verb
- **THEN** the issue gets a reply saying `/question` needs the question, and no session runs

#### Scenario: Question while another is answered gets the busy reply
- **WHEN** the owner comments a second `/question` while the first one's answer is being written
- **THEN** the second gets the busy reply quoting its first line, and only one question session runs

#### Scenario: Eleventh question is refused
- **WHEN** the owner comments `/question …` on a proposal that has had 10 questions
- **THEN** the issue gets a reply saying the limit of 10 questions is reached, and no session runs

#### Scenario: Failed answer can be asked again
- **WHEN** the question session ends without a valid answer
- **THEN** the question's attempt is recorded as failed, the issue gets a reply saying the question was not answered and can be asked again, and the approval stays open

### Requirement: Approval and revision go through during a question
A question SHALL NOT lock the work item while its answer is written: an `/approve` or `/revise` arriving meanwhile SHALL be applied at once. The answer SHALL still be posted, naming the commit it read.

#### Scenario: Approval during a question goes through
- **WHEN** the owner comments `/approve` while the answer to a `/question` is being written
- **THEN** the execution resumes at once, and the answer is posted afterwards naming the commit it read

### Requirement: `/revise` and `/question` outside an approval are answered
`/revise` and `/question` with no work item, during `build`, or for an escalated work item SHALL be answered that nothing awaits approval, naming the state; with the pull request open, that the pull request is open for review. No session SHALL run and no execution SHALL change.

#### Scenario: Revise during the build is answered
- **WHEN** the owner comments `/revise …` while the work item is in `build`
- **THEN** the issue gets a reply saying nothing awaits approval and naming `build`, and no role runs

#### Scenario: Question with the pull request open is answered
- **WHEN** the owner comments `/question …` on an issue whose work item is `pr-open`
- **THEN** the issue gets a reply saying the pull request is open for review, and no session runs

### Requirement: Revision and question attempts are recorded
A revised author's attempt SHALL record the ids of the comments it was given. A question's answer SHALL be an attempt in state `proposal-question` or `design-question`, with the question's comment, the result `{ answer }`, its messages and its cost, which count toward the work item's.

#### Scenario: Question attempt is recorded with its comment
- **WHEN** a `/question` about a proposal has been answered
- **THEN** the ledger holds a succeeded attempt in state `proposal-question` naming the comment, with the answer as its result and a non-zero cost in the work item's total

#### Scenario: Revision attempt names its comments
- **WHEN** a proposal has been revised twice
- **THEN** the third proposal attempt names both `/revise` comments, oldest first

### Requirement: Local runs take revisions and questions
`pnpm factory command` SHALL apply `/revise` and `/question` to a local work item: a revision moves the work item back to `proposal` or `design` for the next `pnpm factory run`, and a question is answered at once.

#### Scenario: Local revision runs on the next run
- **WHEN** the owner comments `/revise …` on a local work item awaiting proposal approval, runs `pnpm factory command` for it, then `pnpm factory run --issue 12 --until proposal`
- **THEN** the proposal author runs again with the comment, and the run stops at the proposal approval again

## MODIFIED Requirements

### Requirement: Proposal produces a valid change
The Proposal state SHALL run the proposal-author role on the work item's branch, and SHALL accept its output only if `openspec validate <id> --strict` passes and the role's result passes its schema. An attempt that fails either check SHALL be retried with the failure evidence in the prompt, up to 3 attempts per run, where an owner's revision starts a new run. After that, the work item SHALL be marked `escalated` and the issue SHALL get a comment with the last failure.

#### Scenario: Valid proposal is committed and pushed
- **WHEN** the proposal-author role produces a change that passes strict validation
- **THEN** the runner commits the change folder on the work item's branch and pushes it

#### Scenario: Invalid proposal is retried with evidence
- **WHEN** an attempt produces a change that fails strict validation
- **THEN** the next attempt's prompt contains the validation errors, and the ledger records the failed attempt with its reason

#### Scenario: Three failed attempts escalate
- **WHEN** three attempts in a row fail validation
- **THEN** the work item is `escalated`, the issue gets a comment with the last validation errors, and the CLI exits non-zero

#### Scenario: Revision gets its own attempts
- **WHEN** a proposal that succeeded at attempt 3 is revised, and the revision's first attempt fails validation
- **THEN** the work item is not escalated, and attempt 5 runs with the validation errors

### Requirement: Proposal approval waits for the owner
After a valid proposal is pushed, the execution SHALL pause in Proposal approval. The worker SHALL store the approval's task token in the ledger before it posts the summary comment. The summary SHALL list what M1's summary lists, plus the attempt's tokens, estimated cost and auth mode, and after a revision what changed, and SHALL end with the commands that apply: `/approve`, `/revise` and `/question`.

#### Scenario: Execution waits for approval
- **WHEN** the Proposal state of an execution succeeds
- **THEN** the execution is paused in Proposal approval, the work item is `awaiting-proposal-approval`, the ledger holds an open approval stored before the summary comment was posted, and no worker task is running

#### Scenario: Summary shows the cost
- **WHEN** the summary comment is posted for a cloud run
- **THEN** it shows the proposal's token count, estimated cost in USD and the auth mode `api-key`, and ends with "Reply `/approve`, `/revise` with your answers or the changes you want, or `/question` to ask about it."

### Requirement: Complexity decides the design route
After Proposal approval, the work item's route SHALL follow the change's `x-complexity`: `small` goes to Plan, `medium` to Design followed by the design reviewer, and `large` to Design followed by the owner's approval. A missing or unknown value SHALL escalate the work item.

#### Scenario: Small change skips Design
- **WHEN** a `small` change's proposal is approved
- **THEN** no architect or design reviewer runs, and the work item is in Plan

#### Scenario: Medium change gets the agent review
- **WHEN** a `medium` change's design passes strict validation
- **THEN** the design reviewer runs in a fresh session, and the work item goes to Plan once it returns `approve`

#### Scenario: Large design waits for the owner
- **WHEN** a `large` change's design passes strict validation
- **THEN** no design reviewer runs, the execution pauses with an open design approval, and the issue gets a comment with the design summary ending with the `/approve`, `/revise` and `/question` commands

### Requirement: Design is produced and reviewed
The Design state SHALL run the architect and accept its output only if the change passes `openspec validate <id> --strict` and the result passes its schema. A design reviewer's `changes-requested` SHALL send its findings to the architect's next attempt. Design SHALL escalate after 3 architect attempts in a run; a design flaw and an owner's revision each start a new run. An accepted design SHALL be committed and pushed.

#### Scenario: Requested changes reach the architect
- **WHEN** the design reviewer returns `changes-requested` with a blocker finding
- **THEN** the architect's next attempt has the finding in its prompt, and the reviewer runs again on the new design

#### Scenario: Three rejected designs escalate
- **WHEN** the architect's third attempt is also answered with `changes-requested`
- **THEN** the work item is `escalated`, and the issue gets a comment with the last findings
