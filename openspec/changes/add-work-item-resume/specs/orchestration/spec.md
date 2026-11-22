## ADDED Requirements

### Requirement: `/abort` stops a running work item
An owner's `/abort` while the work item is between `intake` and `build` SHALL stop its execution, close its open attempts with the outcome `aborted` and its open approval with the outcome `aborted`, record the state it was in as `stopped_in`, and make it `aborted`. If the execution had already ended, the work item SHALL become `aborted` the same way. The reply SHALL say how to resume.

#### Scenario: Abort during the build stops the execution
- **WHEN** the owner comments `/abort` while task 1.2 is being built
- **THEN** the execution is stopped, the open implementer attempt is closed `aborted`, the work item is `aborted` with `stopped_in` = `build`, and the issue gets one reply saying the work item is aborted and `/resume` continues it

#### Scenario: Abort while awaiting approval closes the approval
- **WHEN** the owner comments `/abort` while the proposal awaits approval
- **THEN** the execution is stopped, the approval is closed with the outcome `aborted`, and the work item is `aborted` with `stopped_in` = `awaiting-proposal-approval`

#### Scenario: Abort with nothing running is answered
- **WHEN** the owner comments `/abort` on an issue whose work item is `aborted`, `escalated` or `pr-open`, or that has no work item
- **THEN** nothing changes, and the issue gets one reply saying nothing runs

### Requirement: Stopping an execution stops its running task
Stopping a work item's execution SHALL stop the worker or build task it is running, and a task that writes after the stop SHALL NOT change the work item's state: every state update SHALL apply only from the state its writer expects.

#### Scenario: Stopped execution stops its running task
- **WHEN** an execution is stopped while its Build state runs a build task, and again while a worker state runs
- **THEN** the build task and the worker task each stop within two minutes

#### Scenario: Late write after abort is refused
- **WHEN** a Proposal worker that was stopped finishes its attempt after the work item became `aborted`
- **THEN** the work item stays `aborted`, and the worker's state update is refused

### Requirement: `/resume` continues a stopped work item
An owner's `/resume [guidance]` SHALL start a new execution named `issue-<n>-resume-<comment id>` with input `{ issueNumber, resume: true }`, when the work item's execution has ended, its issue is open and its pull request is not open. Otherwise it SHALL be answered and change nothing: "running" while the execution runs, refused on a closed issue, "the PR is open", or "no work item; label the issue `factory`".

#### Scenario: Resume starts a new execution
- **WHEN** the owner comments `/resume` on an open issue whose work item is `aborted`
- **THEN** one execution named `issue-<n>-resume-<comment id>` starts with input `{ issueNumber, resume: true }`, and the issue gets one reply saying the work item resumes

#### Scenario: Resume while running is answered
- **WHEN** the owner comments `/resume` while the work item's execution is running
- **THEN** no execution starts, and the issue gets a reply saying the work item is running

#### Scenario: Resume on a closed issue is refused
- **WHEN** the owner comments `/resume` on a closed issue whose work item is `aborted`
- **THEN** no execution starts, and the reply says to reopen the issue first

#### Scenario: Resume with the pull request open is answered
- **WHEN** the owner comments `/resume` on an issue whose work item is `pr-open`
- **THEN** no execution starts, and the reply says the pull request is open

#### Scenario: Resume with no work item is answered
- **WHEN** the owner comments `/resume` on an issue of the target with no work item
- **THEN** no execution starts, and the reply says there is no work item and that labelling the issue `factory` starts one

### Requirement: A resumed execution enters where the work item stopped
On resume, Intake SHALL adopt the work item, storing the new execution's ARN, and the execution SHALL enter the state for the work item's state, or `stopped_in`: Proposal for `intake` and `proposal`, AwaitApproval, Approved, Design for `design` and `design-review`, AwaitDesignApproval, Plan, or BuildTasks with the unfinished tasks. Every entry state SHALL accept a work item in its own state.

#### Scenario: Resume during the build skips finished tasks
- **WHEN** a work item aborted in `build` with tasks 1.1 and 1.2 done is resumed
- **THEN** the new execution enters BuildTasks, no role runs for tasks 1.1 and 1.2, the build goes on with task 1.3, and the work item reaches `pr-open`

#### Scenario: Resume at an approval asks again
- **WHEN** a work item aborted while awaiting proposal approval is resumed
- **THEN** the new execution enters AwaitApproval, a new approval is open with a new token, and the summary is posted again

#### Scenario: Resume after approval asks for no second approval
- **WHEN** a work item aborted in `design` after its proposal was approved is resumed
- **THEN** the new execution enters Design, the architect runs, and no proposal approval is asked for

#### Scenario: Resume after an execution failed outside the factory
- **WHEN** a work item is in `plan` and its execution was stopped in the AWS console, and the owner comments `/resume`
- **THEN** a new execution starts and enters Plan, and the planner runs

### Requirement: Aborted attempts and resumes reset retry counts
An attempt closed `aborted` SHALL NOT count toward any retry limit. Resuming an escalated work item SHALL give its escalated state a fresh set of retries, counted from the resume.

#### Scenario: Aborted attempt does not count
- **WHEN** a work item is aborted during its second proposal attempt, after one failed attempt, and is resumed
- **THEN** the proposal author may make two more attempts before the work item escalates

#### Scenario: Resumed escalation gets fresh retries
- **WHEN** a task escalated after three failed implementer attempts is resumed
- **THEN** the implementer runs again for that task, with up to three more attempts

### Requirement: Stopped work items record where they stopped
An escalation SHALL record the state the work item was in as `stopped_in`, as an abort does, so a resume knows where to enter.

#### Scenario: Escalation records where the work item stopped
- **WHEN** a work item escalates in `plan` after three failed planner attempts
- **THEN** the work item is `escalated` with `stopped_in` = `plan`

### Requirement: Closing the issue is the final stop
When a work item's issue is closed, the factory SHALL stop a running execution as `/abort` does and comment once that the work item stopped. `/resume` SHALL be refused while the issue is closed, and SHALL work again once the issue is reopened.

#### Scenario: Closing the issue stops the work item
- **WHEN** the owner closes an issue whose work item's execution is in Design
- **THEN** the webhook starts one `command --issue <n> --closed` task, the execution is stopped, the work item is `aborted` with `stopped_in` = `design`, and the issue gets one comment saying so

#### Scenario: Reopened issue can be resumed
- **WHEN** the owner reopens that issue and comments `/resume`
- **THEN** a new execution starts and enters Design

### Requirement: Replies on a stopped work item point to `/resume`
For an `aborted` or `escalated` work item, `/approve`, `/revise` and `/question` SHALL be answered that nothing awaits and that `/resume` continues the work item. During `build`, `/revise` and `/question` SHALL be answered that nothing awaits and that `/abort` or a new issue are the ways on.

#### Scenario: Commands on a stopped work item point to resume
- **WHEN** the owner comments `/approve` on an issue whose work item is `escalated`
- **THEN** nothing changes, and the reply says nothing awaits approval and that `/resume` continues the work item

#### Scenario: Revise during the build points to abort
- **WHEN** the owner comments `/revise …` while the work item is in `build`
- **THEN** nothing changes, and the reply names `/abort` and a new issue

### Requirement: Local work items point to the run command
`/abort` and `/resume` on a work item with no execution, from a local run, SHALL be answered that local runs continue with `pnpm factory run`, and SHALL change nothing.

#### Scenario: Local work item points to the run command
- **WHEN** the owner runs `pnpm factory command` for a `/resume` on an escalated local work item
- **THEN** nothing changes, and the reply names `pnpm factory run`

### Requirement: The worker controls only its own executions
The worker's task role SHALL be allowed `states:StopExecution` and `states:DescribeExecution` only on its state machine's executions, and `states:StartExecution` only on its state machine.

#### Scenario: Worker may control only its own executions
- **WHEN** the factory stack is synthesised
- **THEN** the worker's task role allows `states:StartExecution` on the work-item state machine only, and `states:StopExecution` and `states:DescribeExecution` on that state machine's executions only

### Requirement: A command that fails before its handler is answered
A `command` task that fails before its handler runs, for example while it sets up the GitHub App, SHALL still try to post the fixed reply that the command did not go through and can be sent again. If GitHub cannot be reached for that reply either, the task SHALL log one line naming the issue, the comment id and that the command was neither recorded nor answered, and SHALL exit 1. The owner then sends the command again.

#### Scenario: Command that fails before its handler is answered
- **WHEN** the `command` task for an owner's `/status` cannot look up the App's bot user, and GitHub answers again later
- **THEN** nothing is recorded, the issue gets one comment saying the `/status` did not go through and can be sent again, and the task exits 1

#### Scenario: Command that cannot reach GitHub is logged
- **WHEN** every request of the `command` task to GitHub fails with a network error
- **THEN** nothing is recorded, no comment is posted, the log names the issue, the comment id and that the command was neither recorded nor answered, and the task exits 1

## MODIFIED Requirements

### Requirement: Labelling an issue starts a work item
When the label `factory` is added to an open issue, the factory SHALL start a Step Functions execution for it, whose states run in the factory worker. An issue SHALL never have more than one work item, and a later execution for the same issue SHALL end without changing it, with a comment that `/resume` continues the work item. Other labels SHALL be ignored.

#### Scenario: Labelling an issue starts an execution
- **WHEN** the owner adds the label `factory` to an open issue with a stated requirement
- **THEN** one execution starts for the issue, the ledger holds one work item for it with the execution's ARN, and the work item's branch exists on the remote

#### Scenario: Relabelling does not create a second work item
- **WHEN** the label `factory` is removed from an issue that has a work item and added again, or the same delivery is redelivered
- **THEN** the new execution, if one starts, ends successfully at Intake, no role runs, the ledger still holds one work item with the original execution's ARN, and the issue gets one comment saying `/resume` continues the work item

#### Scenario: Other labels are ignored
- **WHEN** a label other than `factory` is added to an issue
- **THEN** no execution starts and no work item is created

### Requirement: The factory acts as its GitHub App
Outside local runs, the Forge SHALL authenticate with the factory's GitHub App installation tokens, requested for the target's repository only with `contents: write`, `issues: write`, `pull_requests: write` and `metadata: read`, and refreshed before any call within five minutes of expiry. Tokens SHALL never appear in error messages, logs, command lines, remote URLs or git config. Commits the factory pushes SHALL be authored and committed by the App's bot user. The installation token request and the bot user's lookup SHALL each be tried up to 3 times, with a backoff, when the request fails with a network error or GitHub answers with a 5xx status, and SHALL not be tried again after any other answer. A network error SHALL be reported with its error code, such as `UND_ERR_CONNECT_TIMEOUT`, when it has one, and with nothing else from the underlying error.

#### Scenario: Installation token is scoped to the repository
- **WHEN** the token provider requests an installation token
- **THEN** the request is signed with a JWT for the App, names only the target's repository, and asks only for `contents: write`, `issues: write`, `pull_requests: write` and `metadata: read`

#### Scenario: Expiring token is refreshed
- **WHEN** the Forge makes a call less than five minutes before its current token expires
- **THEN** a new installation token is requested first, and the call uses the new token

#### Scenario: Token failures do not leak the token
- **WHEN** a GitHub call or a push fails with an authentication error
- **THEN** the error message and every log line name the failure without containing the token or the App's private key

#### Scenario: Commits are authored by the factory's bot
- **WHEN** the worker commits and pushes a proposal or a task
- **THEN** the pushed commit's author and committer are the App's bot user, not the owner

#### Scenario: Token request is retried after a network error
- **WHEN** the first installation token request fails with a network error and the second gets a token
- **THEN** the provider returns that token, after two requests and one backoff wait

#### Scenario: Token request is not retried after a refusal
- **WHEN** GitHub answers the installation token request with 401
- **THEN** the provider rejects with `unauthorized` after one request

#### Scenario: Network failure names its code
- **WHEN** all 3 installation token requests fail with a connect timeout
- **THEN** the error message says the request failed 3 times and names `UND_ERR_CONNECT_TIMEOUT`, and contains neither the JWT nor the App's private key
