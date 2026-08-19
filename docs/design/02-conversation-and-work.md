# Conversation MVP and Deferred Work Domain Model

> Status: Completed — Workspace authorization prerequisites and Conversation MVP facts are closed; explicit Work is deferred
>
> MVP scope: Workspace identity/Membership/Invitation/role and Agent-creation facts required by authorization; Conversation, Conversation Timeline, Thread, Message, Discussion Scope, Agent Mention Outcome, Agent Request, and their command boundaries
>
> Deferred scope: WorkItem, assignment, claim, delegation, Result Submission, Completion Policy, and Review. Confirmed facts remain recorded below but do not gate the MVP.
>
> Out of scope: Run/Attempt execution details (Step 5), storage schema (Step 4), wire protocol and error codes (Step 3)

## 1. Design boundary

The full model keeps four kinds of fact independent. The MVP implements only discussion and the Agent Request handoff into execution; work and review facts are later product layers.

```text
discussion facts       Message in a Discussion Scope
execution facts        Agent Request → Run → Attempt
work facts             WorkItem, assignee, claimability, relationship, Submission
review facts           Review and its decision
```

A fact in one category never changes another category merely because its text appears to imply it. In particular:

- Conversation contains one immutable Message kind. There is no `Final Message`, `Run Result Message`, or `CompleteRunWithMessage` operation.
- A Run ends from an execution-layer terminal outcome, independently of whether it published zero, one, or several Messages.
- A Message never completes, blocks, cancels, assigns, reopens, or reviews a WorkItem.
- An Agent changes structured state only through an explicit Workspace command exposed by a trusted CLI, MCP, or equivalent adapter.
- Result Submission and Review remain separate objects and separate state machines.
- The model has no response-expectation or `no_response` state. Absence of a Message is an observable fact, not a new domain status.

## 2. Relationship model

```text
Product Deployment
├── Human identity 0..N
│   └── Workspace Membership 0..N across isolated Workspaces
└── Workspace 0..N
    ├── Agent identity 0..N, each permanently owned by this Workspace
    │   ├── exactly one active Human Member as accountable Owner
    │   └── creation atomically establishes its active `member` Membership
    ├── Workspace Membership 0..N
    │   ├── exactly one Human | Workspace-owned Agent identity
    │   ├── active | terminal; exactly one base role: owner | member
    │   ├── at most one active per actor in this Workspace
    │   └── one or more active Human Memberships hold owner role
    ├── Workspace Invitation 0..N
    │   ├── exactly one normalized verified email target
    │   ├── pending | accepted | revoked | expired
    │   ├── at most one pending per Workspace + normalized email
    │   └── accepted → stable Human identity + exactly one new active `member` Membership
    ├── Conversation
    │   ├── Conversation Timeline (one Discussion Scope)
    │   │   ├── top-level Message 0..N
    │   │   └── Thread 0..N, rooted in one top-level Message
    │   │       └── reply Message 1..N (another Discussion Scope)
    │   └── membership / visibility policy
    ├── Agent Mention Outcome 0..N
    │   ├── exactly one distinct Message target
    │   └── requested → Agent Request | not_requested → one authoritative structured reason
    ├── Agent Request 0..N
    │   ├── exactly one trigger source
    │   │   ├── requested Agent Mention Outcome
    │   │   ├── WorkItem assignment action
    │   │   └── Agent reviewer designation
    │   ├── target Agent
    │   ├── result Discussion Scope
    │   ├── associated WorkItem 0..1, derived from its assignment-action trigger
    │   ├── associated Review 0..1, derived from its review trigger
    │   └── Run 0..1
    └── WorkItem 0..N
        ├── immutable source Message
        ├── immutable Goal
        ├── immutable Primary Discussion Scope
        ├── current Work Assignee 0..1
        ├── current assignment kind 0..1: direct_assignment | agent_claim
        ├── monotonically increasing assignment revision
        ├── claimability
        ├── parent 0..1 / related WorkItem 0..N
        ├── Result Submission 0..N
        ├── Current Submission 0..1
        │   └── assignment revision + submitting Run
        └── Review 0..N
            └── current reviewer: Human | Agent + reviewer revision
```

Every Agent-authored Message has exactly one `produced_by_run_id`, and that Run names the same Agent as the Message author. A Human-authored Message has no `produced_by_run_id`. Workspace binds this relationship from trusted execution authority at commit time; Runtime, Web, and Local Node callers cannot self-report an authoritative author or Run. The relationship grants no special Message type and neither Message presence nor provenance determines Run outcome.

A producing Run may first-publish a new Agent Message only while it is non-terminal and its current shared-write authority remains valid. Run terminal is the authoritative closing fact; there is no parallel `RunWritePermission` object or independently mutable publication-open flag. First publication and terminal transition share one Workspace commit order. If publication commits first, the Message remains valid and terminal may follow; if terminal commits first, the new publication creates nothing. A recognized idempotent retry of a publication committed before terminal returns the prior logical result without creating another Message. Runtime process exit is only a local signal: normal shutdown settles locally pending publication intents before requesting terminal, while forced terminal caused by cancellation, revocation, or timeout may fence those intents first.

In the full model, the trigger source is a mandatory tagged alternative, not three nullable associations that may be combined arbitrarily. The MVP implements only the `requested` Agent Mention Outcome alternative and does not create unused WorkItem or Review associations. Other related facts are causation/provenance only. When the explicit-work layer is introduced, an Agent delegation Request is directly triggered by the Child WorkItem assignment action; the delegation Message is its causation, so the Request cannot also be interpreted as an ordinary mention request. WorkItem stores its current assignee and whether that responsibility came from Direct Assignment or Agent Claim. Every assignment change advances `assignment_revision`; structured assignee commands must match it, preventing delayed commands from an earlier assignment—including an earlier assignment to the same Agent—from gaining authority. Responsibility history is retained as audit facts rather than a separate tenure object.

## 3. Conversation and Message

### 3.1 Creation and permanence

- Any active Human Workspace Member may create a Workspace Channel, and any active Human Project Member may create a Project Channel. Creation fixes the scope and records creator provenance but creates no participant facts. An Agent execution cannot create one.
- Conversation records its creator as immutable provenance rather than transferable ownership. Creator, Workspace Owner, Project Manager, or either DM participant may operate its explicit lifecycle within their current access scope.
- A Conversation is durable and has an `active | archived` lifecycle. Archive preserves all Messages, Threads, provenance, and source relationships, removes it from the default active list, and makes it read-only; restore makes it writable again. Hard delete is not supported.
- Archive uses expected revision and is rejected while the Conversation has pending Agent Requests or active Runs; callers must cancel or finish them first.
- A published Message cannot be edited or deleted. Corrections and retractions are new Messages.
- Deferred work layer: a standalone WorkItem created without a discussion location atomically creates a Conversation, the Human-authored initial Message, and the WorkItem.

### 3.2 Timeline and Thread

- Every Conversation has exactly one Conversation Timeline and may have zero Threads.
- A Thread is rooted in an existing top-level Timeline Message.
- The first reply atomically creates the Thread and its first reply; empty Threads do not exist.
- Thread nesting is forbidden. A Thread inherits Conversation membership and permissions and has no independent lifecycle, owner, archive, or transfer operation.
- The root Message remains in the Timeline. Thread context is the root plus its ordered replies.

### 3.3 Ordering and frontier

Each Discussion Scope has a Workspace-authoritative total order and its own Discussion Frontier.

- A committed top-level Message advances only the Conversation Timeline frontier.
- A committed Thread reply advances only that Thread frontier.
- Messages in another Thread, reactions, read state, membership changes, and permission changes do not advance it.
- No cross-scope total Message order is required.
- Client timestamps never decide authoritative order.
- Permission is rechecked independently on every read and write even when the frontier is unchanged.

### 3.4 Membership

- Threads never have independent membership.
- A Channel stores only its fixed Workspace or Project scope. Workspace Channel participants are all active Workspace Memberships. Project Channel participants are all active Project Memberships backed by active Workspace Memberships. DM exists only at Workspace scope and stores exactly two fixed direct Membership references.
- Channel participants are a read-only projection. There is no Conversation-local add/remove or Owner recovery path. A new scope member can read full Channel history; a removed member loses current and future access, while authored Messages remain.
- A Workspace DM preset has fixed participants. A different participant set creates a new Conversation; Project scope does not expose or create DM.
- Joining a Workspace or Project immediately changes access to every Channel in that scope without writing per-Conversation membership rows. The complete active Membership chain remains necessary for Project access.
- Removing an Agent prevents future requests and publication by active execution. It does not erase Messages. In the deferred work layer it also does not silently cancel a WorkItem or rewrite assignee history.
- A Channel creator who leaves its scope has no residual authority and causes no ownership transfer. Scope Membership governance continues independently. DM participants remain fixed regardless of creator status; a different pair is a new Conversation.

Conversation creation and scope Membership change are governance intents; Message publication is a content intent inside an already governed scope. Every active Human scope Member may create a Channel in that scope. Channel visibility changes only through Workspace or Project Membership commands. Workspace DM has no participant-change intent and cannot be created under a Project. A Run that may post to one Timeline or Thread cannot create another Conversation or govern scope Membership.

Current scope Membership grants access to the whole Channel, including its Timeline, Thread roots, all replies, and visible request outcomes. There is no join-time cutoff, leave-time historical window, or per-Message reader list. Adding a Workspace or Project member therefore discloses complete Channel history; removing a member blocks all subsequent reads without deleting authored Messages.

Workspace Membership is one continuous participation of a stable Human or Agent identity in one Workspace. Removal is terminal and re-entry creates another Membership. Channel authorization evaluates the current Membership; every shared action retains stable actor plus membership-at-time. Removing a Membership immediately closes Channel and DM access, cancels affected pending Agent Requests, and fences active Runs. Re-entry restores scope-derived Channel access, but a new Membership satisfies none of an old DM's fixed references or execution grants.

Human identity is stable across all Workspaces in one product deployment. Creating or joining another Workspace adds a distinct Membership and selects another isolated collaboration context; it does not copy or expose Conversations, Messages, Agent Requests, Runs, Agents, or permissions. A client or Local Node installation is only an access/execution mechanism, not a Workspace.

Workspace Owner is the highest governance role on an active Human Workspace Membership, not a separate identity, aggregate, or permanent creator privilege. Workspace creation atomically establishes the Workspace and the creator's `owner` Membership. Several active Human Memberships may hold owner responsibility, but no change may remove the last active owner.

Every active Workspace Membership has the closed base role `owner | member`. Only Human Memberships may be owner; Agent Memberships are fixed to member. There is no admin, custom-role, inheritance, or hierarchy dimension. Role changes update the same continuous Membership and record an audit fact.

Only a current Workspace Owner may invite a Human, terminate another Human's Membership, or change a Human Membership between owner and member. An ordinary Human Member may only terminate their own Membership; a self-exit that would remove the last active owner is rejected.

Only a current Workspace Owner may terminate or readmit an Agent Membership or transfer Agent ownership to another active Human Membership in the same Workspace. Agent Owner accountability may suspend/resume and constrain the Agent but cannot mutate its Membership; Agent Host local custody may stop execution but cannot mutate Membership, ownership, or shared authority. A Human Membership that still owns any Agent cannot terminate; it must transfer all owned Agents first, and ownership history remains immutable.

Only a current Workspace Owner may permanently delete an Agent. Deletion first terminates any active Agent Membership and task authority, then removes the Agent from discovery and direct access with no readmission path. Existing Channel and DM messages remain readable under the original display name and carry a deleted-author marker.

A Human joins or rejoins only by accepting a durable Workspace Invitation created by a current Owner. A pending Invitation grants no Membership, role, Conversation, or other access. Acceptance atomically makes it terminal `accepted` and creates a new active `member` Membership, which immediately participates in Workspace Channels.

There is at most one pending Invitation for the same Workspace and normalized target email. Repeating the same invitation intent returns the existing pending Invitation without extending expiry; replacing its targeting or expiry requires revoking it and creating a new Invitation identity. After accepted, revoked, or expired, a new Invitation may be created only when the accepted Human has no active Membership in that Workspace. This makes revocation close the sole current join capability for that email.

An Agent identity is created in and permanently scoped to exactly one Workspace. Its Memberships and accountable Owner can only be in that Workspace, and every mention target, Agent Request, Run, Message provenance link, ownership relation, and audit chain must remain there. Another Workspace creates another Agent identity even if it copies an equivalent configuration; Agent history and authority never transfer or merge.

## 4. Agent Inbox 与 Discussion pull

Agent DM Message 或明确 `@Agent` 的 Message 会创建 durable Inbox Item。Workspace wake 不含正文，Runtime 必须主动读取：

```text
agent.inbox_changed { agentId, highestSequence }
→ teamctl inbox check
→ teamctl message check --target <scope>
→ atomically claim pending attention for that Scope
→ return attention references and ordered Messages since the last handled position
→ optionally read / resolve history
→ send ordinary Message or return no-output
```

`@` only selects attention; it does not filter Conversation context. An ordinary Channel Message does not wake the Agent, but a later mention causes the full Discussion Scope delta to be returned. Claim receipts are replayable until Run terminal, while structured state commands retain their own object revisions and fencing rules.

## 5. Agent Request

### 5.1 Lifecycle

```text
pending → accepted
pending → rejected
pending → cancelled
```

- `accepted`, `rejected`, and `cancelled` are terminal. `blocked` is not an authoritative Agent Request state.
- One Agent Request creates at most one Run. Technical retries are new Attempts of that Run.
- A pending request has a derived intake disposition: `ready`, `waiting`, or `blocked(reason codes)`. Waiting for a Node, scheduling, or fairness remains `waiting`; temporary policy or domain conditions such as suspension produce `blocked`. WorkItem blocking becomes another input only in the deferred work layer.
- The Workspace Intake Module computes this disposition from current facts owned by the relevant Modules. Reasons are projection values, not caller-supplied or Request-persisted facts, and no Blocker object exists. Relevant fact changes trigger reevaluation.
- A hard intake refusal, missing required capability, or irrecoverable budget constraint is `rejected`.
- A Message target that is not a requestable Workspace Agent, cannot access the result scope, or cannot legally be requested by the author receives `not_requested(reason)` and creates no Agent Request. These are establishment failures, not Request rejection.
- Once a Mention Outcome is `requested`, later `waiting`, `blocked`, `rejected`, `cancelled`, or `accepted` results belong only to its Agent Request and never rewrite the immutable Outcome.
- Once a Mention Outcome is `not_requested`, later authority, membership, or scope-access changes do not create a Request or change the Outcome. Only a new explicit Agent Mention under current facts can establish a new Request.
- Accepting a request and creating its one Run are one atomic transition. `accepted` is terminal for intake even while the Run remains non-terminal in the execution model.

### 5.2 Creation

- A valid `@Agent` target is an existing requestable Workspace Agent that may access the result scope. A suspended Agent is valid; its pending request projects a blocked intake disposition.
- A Human Message or Thread reply in a fixed Human–Agent DM implicitly targets its one direct Agent participant. The target comes from fixed Membership references rather than body parsing; explicitly mentioning the same Agent does not create a second outcome or request. Human–Human DMs and unmentioned Channel Messages create no implicit request.
- A Message mentioning multiple Agents resolves each distinct target independently. Duplicate mentions of the same target share one outcome. A valid target gets `requested` and one Agent Request; an invalid or unauthorized target gets `not_requested` with a structured reason and no Request.
- The Message, every target's immutable Mention Outcome, and all Requests for `requested` outcomes commit in one transaction. One target's `not_requested` outcome does not block the Message or other targets, but no target may be silently omitted. A transaction or Message-level authorization failure commits none of them.
- Every reader who may read the Message may also read each target's `requested / not_requested` status. The Outcome retains exactly one authoritative reason. Only a current Workspace Owner or the target Agent's current Owner receives the exact governance reason; every other reader receives a safe summary derived at read time. The summary is not persisted as another domain fact, and all snapshot, follow, search, cache, and audit projections apply the same authorization rule.
- `@Human` creates no Agent Request.

The following creation paths are deferred beyond MVP:

- Direct Assignment to an Agent atomically establishes the sole assignee and creates an Agent Request. Assignment to a Human creates no request.
- A successful Agent Claim atomically establishes the assignee, closes claimability, and creates an Agent Request even if its Node is offline.
- Creating a Review with an Agent reviewer atomically creates a Review-associated Agent Request; it does not make that Agent the WorkItem assignee.

### 5.3 Cancellation and races

- The Human requestor may cancel their own pending request.
- An Agent may cancel only a pending request it initiated and only with an explicit `cancel_own_agent_request` capability.
- The Human requestor, target Agent's current Owner, or a current Workspace Owner may cancel a pending request.
- Once accepted, a stop intent may come from the Human requestor, a capability-granted initiating Agent, the target Agent's current Owner, a current Workspace Owner, or an enclosing authority fence. It targets the Run, not the request.
- Cancellation is a shared, audited Workspace command. It does not delete its trigger Message or change WorkItem assignment.
- Concurrent accept and cancel are serialized by Workspace commit order; the first valid transition wins.
- If target or result-scope authority is revoked before acceptance, a pending request is cancelled with reason `authority_revoked`. If already accepted, the request remains accepted while the Run loses further shared-write authority, is fenced, and receives a stop/cancel intent. Suspension instead changes the pending request's derived intake disposition and does not cancel it. Neither path automatically releases or reassigns an associated WorkItem.

There is no `ContinueWorkWithAgent`. When a temporary condition clears, an existing pending Request is reevaluated automatically. A prior `not_requested` Outcome is not reevaluated because no Request exists; a new explicit `@Agent` Message is required to create a new Outcome and possible Request. Ordinary Messages and later permission changes never start execution by inference.

## 6. WorkItem — deferred beyond MVP

### 6.1 Identity and immutable intent

- Only an authorized Human creates a top-level WorkItem.
- An authorized Agent may create a Child WorkItem using the parent's Primary Discussion Scope or another existing scope it may access; no Agent-created hidden Conversation or Thread is allowed.
- Goal is the explicit outcome statement managed by the WorkItem; Goal, source Message, and Primary Discussion Scope are immutable. There is no generic `UpdateWorkItem`.
- Materially changed requirements use a new Message and a new related or Child WorkItem; the old WorkItem may be explicitly cancelled when appropriate.
- The same source Message may support several explicitly created WorkItems.

### 6.2 Lifecycle and orthogonal dimensions

```text
open → blocked
blocked → open
open → completed
open|blocked → cancelled
```

`completed` and `cancelled` are irreversible terminal states. There is no reopen or archive operation. A later defect or additional need creates a new related WorkItem.

Lifecycle, assignee, and claimability are separate dimensions:

```text
lifecycle:    open | blocked | completed | cancelled
assignee:     unassigned | one Human | one Agent
claimability: closed | claimable   (only while open + unassigned)
```

Completion or cancellation ends the current assignment while preserving its history. A terminal WorkItem cannot be assigned or claimed.

Every acquisition, release, revocation, reassignment, completion, or cancellation that changes current responsibility advances `assignment_revision`. The WorkItem stores the current assignee and current assignment kind; audit facts retain the previous assignee, kind, revision, actor, and reason. No separate Assignment Tenure lifecycle exists.

### 6.3 Blocking

- Blocking means the goal remains valid but cannot currently advance. It never releases an existing assignee automatically.
- The current assignee or an authorized Human may block with a mandatory structured reason; an authorized Human may unblock.
- Blocking closes claimability and does not automatically release assignment, cancel an active Run, or start another Run.
- A pending request created by the current assignment action projects `blocked(work_item_blocked)` and becomes eligible for `ready` after unblock. Review and ordinary mention requests do not inherit WorkItem blocking. An active assignment Run may finish its current response unless an authorized Human cancels it.
- A blocked WorkItem cannot complete but may be cancelled by an authorized Human.

### 6.4 Assignment, claim, release, and reassignment

- A WorkItem has at most one current assignee.
- Only an authorized Human publishes or retracts claimability, except an Agent with explicit delegation authority may publish its own Child WorkItem as claimable.
- Claim requires `open + unassigned + claimable`. The first valid Workspace commit wins.
- Assignment, blocking, completion, and cancellation close claimability.
- Only the current Agent assignee with `assignment_kind = agent_claim` may release responsibility. Release requires a matching `assignment_revision` and a reason, preserves the WorkItem lifecycle (`open` or `blocked`), advances the revision, and produces `unassigned + closed`; it never unblocks or silently republishes the work.
- A directly assigned Agent cannot self-release; it may block and request Human reassignment.
- An authorized Human may revoke the current assignment with a reason, leaving the lifecycle unchanged and the WorkItem `unassigned + closed`.
- An authorized Human may force reassignment while a Run is active or a Node is offline. Reassignment atomically revokes the former assignee's structured WorkItem authority, changes the sole assignee, creates a new request when the new assignee is an Agent, and requests cancellation of the old Run.
- Reassignment replaces current assignee and kind and advances `assignment_revision` in the same commit. Assignment to the already-current member is not a responsibility change or a way to start another Run; a new explicit Agent Mention creates a separate conversational request.
- Release, revocation, and reassignment clear the Current Submission relationship and cancel its pending Review with reason `assignment_changed`; the reviewer request is cancelled or its active Run is fenced. Immutable Submission and Review history remain. Blocking retains both assignment and Current Submission. Completion and cancellation retain the Current Submission reference as historical terminal evidence.
- Already committed Messages remain. After the revision advances, a command carrying the former revision cannot submit a Result Submission or issue other assignee-authorized WorkItem state changes, even if the same Agent later becomes assignee again.
- Device failure, lease expiry, or an Agent becoming idle never automatically reassigns or releases responsibility.

### 6.5 Cancellation

Only an authorized Human cancels a WorkItem, with a mandatory reason. The command atomically:

- changes it to `cancelled` and ends the current assignment;
- cancels associated pending Agent Requests;
- revokes the active Run's authority for structured WorkItem results and requests stop;
- cancels a pending Review;
- preserves all Messages, Runs, Submissions, Reviews, and audit history.

Child WorkItems are not cascade-cancelled. The UI must warn about non-terminal Children, but each Child receives its own explicit lifecycle decision.

## 7. Work relationships and delegation — deferred beyond MVP

The current model has only:

- `child-of`: one immutable direct parent; every direct Child must be `completed` or `cancelled` before the parent may complete;
- `related-to`: symmetric navigation only, with no permission or lifecycle effect.

Parent and Child lifecycles are otherwise independent. A parent does not automatically complete, block, or cancel a Child, and vice versa. A blocked Child does not change the parent's lifecycle; it only prevents parent completion. The check needs only direct Children because a Child with its own non-terminal Child cannot itself complete. A no-longer-needed Child must be explicitly cancelled. Non-blocking exploratory or navigational work uses `related-to`; the model has no `blocking_child` flag or general dependency graph.

Agent-to-Agent delegation in the parent's Primary Discussion Scope is one atomic command boundary:

```text
publish delegation Message
+ create Child WorkItem with that source
+ establish child-of relation
+ assign Agent-B
+ create Agent Request for Agent-B
```

If a separate discussion is needed, the delegating Agent first publishes an explicit Message in the desired existing scope and uses it as the Child source. No hidden Conversation or Thread is created.

## 8. Result Submission, Completion Policy, and Review — deferred beyond MVP

### 8.1 Result Submission

A Result Submission is an immutable candidate outcome for one WorkItem, not a status and not a Message subtype.

`Result Submission`, `Current Submission`, and `SubmitResult` are deliberately different concepts. Result Submission is the immutable domain object. Current Submission is only the optional WorkItem → Result Submission relationship role used by completion; it is not another object or lifecycle. `SubmitResult` is the provisional name of a command intent that atomically creates the immutable object and replaces that WorkItem reference; Step 3 may refine the command name, and Step 4 may store the two objects separately.

- Only the current Agent assignee may submit while the WorkItem is `open`.
- Submission is issued by an authorized Run and records that Run plus the current assignment revision. It references one or more already committed ordinary Messages in the Primary Discussion Scope and/or stable Artifact versions; every reference retains its own producer provenance and need not have been produced by the submitting Run.
- Posting result Messages and `SubmitResult` are separate commands; neither implies the other.
- A Submission cannot be edited, deleted, withdrawn, accepted, or rejected. `SubmitResult` atomically makes the new Submission the WorkItem's sole Current Submission and supersedes the previous current one without overwriting it.
- Superseding a Submission cancels its pending Review with reason `submission_superseded`, cancels a not-yet-accepted reviewer request, and fences an active reviewer Run. A terminal Review is never rewritten. Workspace commit order deterministically decides a concurrent review decision versus supersession.
- Review state never writes back into the Submission.

### 8.2 Completion Policy

```text
manual          authorized Human explicitly completes; Submission optional
automatic       a valid Current Submission triggers completion checks
review_required Current Submission requires an accepted Review
```

Only an authorized Human changes policy. WorkItem stores the current policy and monotonically increasing `policy_revision`; the change applies immediately to its Current Submission and triggers completion reevaluation. Submission does not bind an older policy. Leaving `review_required` cancels the Current Submission's pending Review with reason `policy_changed` and cancels/fences its reviewer execution while retaining the Current Submission. Entering `review_required` exposes review-needed work but creates no Review automatically. A successful completion records the policy revision actually used. Human-assigned WorkItems use `manual`.

The unified completion preconditions are:

- WorkItem is `open`;
- no Child is `open` or `blocked`;
- the current assignment revision matches the Current Submission producer revision, except manual Human completion;
- the policy-specific evidence exists: explicit Human command under the current `manual` policy, a valid Current Submission under the current `automatic` policy, or an accepted Review of the Current Submission under the current `review_required` policy.

A failed check returns reasons and changes nothing. Agent Request and Run terminal states are not completion preconditions: a valid Submission or accepted Review may complete work while its producing execution is still winding down. Completion does not cancel Runs; it clears current assignment and advances `assignment_revision`, fencing later structured WorkItem commands while ordinary Message publication and Run outcome remain independent. Completion checks are re-evaluated after Submission, Review decision, Child terminal transition, unblock, or policy change.

### 8.3 Review

Review is explicitly created for the Current Submission. `review_required` exposes review-needed work but does not create a Review automatically.

```text
pending → accepted
pending → rejected
pending → cancelled
```

- One Submission has at most one Review, and a superseded Submission cannot receive a new Review.
- A Review has exactly one current Human or Agent reviewer. The reviewer cannot be the submitter. Review stores a monotonically increasing `reviewer_revision`; replacement history is retained as audit facts, not Reviewer Designation objects.
- An authorized Human may replace the reviewer only while pending. Replacement advances `reviewer_revision`, cancels the old reviewer's pending request or fences its active Run, then creates a request when the new reviewer is an Agent.
- The designated reviewer decides. An Agent reviewer must use `DecideReview` from its authorized review Run. Natural-language text alone has no effect.
- Accept or reject requires the current `reviewer_revision` and mandatory feedback, then atomically publishes an ordinary feedback Message in the WorkItem Primary Discussion Scope, commits the structured decision, and creates any Agent Mention Requests and Inbox Items from that Message. Authorization and revision fencing are checked at commit time; there is no separate final freshness-review phase. Review cancellation records a structured reason and publishes no feedback Message.
- Rejection does not automatically create a new Run. A feedback Message that explicitly `@mentions` an Agent creates a new ordinary Agent Request.
- An authorized Human may cancel a pending Review with a reason. Superseding its Submission cancels it with `submission_superseded`; cancelling its WorkItem uses the WorkItem cancellation as causation.
- An accepted Review triggers completion checks. If another prerequisite is missing, Review remains accepted and WorkItem completion is re-evaluated when relevant facts change.

## 9. Agent command authority — work commands deferred beyond MVP

Within current authorization and fencing, an Agent may be granted only these structured work commands:

- `ClaimWorkItem`
- `ReleaseClaimedWorkItem`
- `BlockAssignedWorkItem(reason)`
- `CreateChildWorkItem`
- `SubmitResult`
- `DecideReview(feedback_message, decision)` when designated reviewer
- `CancelOwnAgentRequest` when explicitly capability-granted

An Agent cannot complete, cancel, unblock, or reassign a WorkItem; modify Completion Policy; create, cancel, or reconfigure a Review; manage Conversation membership; or directly mutate Agent Request, Run, Attempt, or Review state outside the commands above.

State changes appear as structured Workspace activity and audit facts. They do not automatically publish Messages or advance a Discussion Frontier. The feedback Message in `DecideReview` and the delegation Message in the Child delegation command are deliberate atomic command boundaries, not hidden status prose.

## 10. Atomic command boundaries

MVP implements the Message/per-target-mention-outcome, first-Thread-reply, Agent-Request-acceptance, and Agent-Message-freshness boundaries below. All WorkItem, assignment, Submission, and Review boundaries are retained requirements for the deferred explicit-work layer and must not cause MVP schema or command placeholders.

The Workspace Authority must protect at least these all-or-nothing changes:

1. Message + exactly one immutable Mention Outcome per distinct `@Agent` target + Agent Requests for every `requested` outcome.
2. First reply to a top-level Message + its Thread + all per-target Mention Outcomes and Requests triggered by that reply.
3. Standalone Conversation + initial Message + WorkItem.
4. Direct Assignment to Agent + current assignment facts/revision + Agent Request.
5. Successful Agent Claim + closed claimability + current assignment facts/revision + Agent Request.
6. Agent delegation Message + Child + relation + current assignment facts/revision + Agent Request.
7. Agent Request acceptance + its sole Run.
8. `SubmitResult` + Current Submission replacement + superseded Review/request/run consequences.
9. Review creation with Agent reviewer + reviewer designation + Review-associated Agent Request.
10. Reviewer replacement + revision advance + old-reviewer fence + optional Agent Request.
11. Review accept/reject feedback Message + decision + any Message-triggered Agent Requests.
12. WorkItem cancellation and its assignment/request/run/review consequences.
13. Assignment release, revocation, or reassignment + revision advance + old-assignee/reviewer fences + optional Agent Request.
14. Agent message/return + trusted author, Run, Attempt, claim receipt and Binding revision provenance + zero-to-many Message append or `no_output`.
15. Agent Message first publication and its producing Run terminal transition share one Workspace concurrency decision and commit order; terminal closes later first publications without creating a second permission fact.
16. Workspace Membership terminal + immediate closure of all effective Conversation access + affected pending Request cancellation + active Run fencing; historical actor and membership-at-time remain.
17. Active Human Member Agent creation + new Workspace-local Agent identity + active `member` Membership + creator as sole Agent Owner. Creation grants Workspace Channel participation but no Project, DM, private context, credential, Runtime Binding, or local resource.
18. Human creates or joins a Workspace + a distinct Membership for that Human in that Workspace; no existing Membership, authority, Conversation, Message, Agent Request, Run, or Agent crosses the Workspace seam.
19. Workspace creation + creator's active Human Membership + owner role; any later owner, Membership, or exit mutation preserves at least one active Human owner.
20. Workspace-Owner-authorized Human Membership role change + the affected Membership fact and audit; ordinary Member self-exit cannot bypass last-owner continuity.
21. Matching Human acceptance of one pending Workspace Invitation + terminal `accepted` Invitation + exactly one new active `member` Membership; failure creates neither Membership nor partial acceptance.
22. Invitation creation serializes by Workspace + normalized verified email: the first valid pending Invitation wins, duplicate intent returns it unchanged, and replacement requires terminal old Invitation + new Invitation identity.
23. Channel creation + fixed scope + creator provenance; scope Membership changes automatically update Channel access and participant projections. DM has exactly two fixed direct participants and no mutation boundary.
24. Workspace Owner Agent-Membership termination/readmission or Agent-ownership transfer + all affected request/run fences and audit; Human Membership exit is rejected while it still owns an Agent.

Idempotency makes a retried intent return the same logical result. Expected object versions, assignment revisions, reviewer revisions, the claim receipt, and the producing Run's concurrency guard serialize structured state races. Context Version does not replace Run-state or structured-state fencing.

## 11. Transition and authority matrices

These matrices are normative domain transitions. Command names remain provisional until Step 3, but no later Interface may weaken their actors, preconditions, atomic effects, or conflict rules. Every successful row also records actor, causation, idempotency result, and committed object versions in audit.

### 11.0 Workspace creation and owner continuity

| Intent | Actor | Preconditions | Atomic result | Conflict result |
|---|---|---|---|---|
| Create Workspace | authenticated Human identity | valid creation intent in the current deployment | Workspace + creator's active `owner` Human Membership | duplicate/idempotent retry returns the prior result; partial Workspace or ownerless Workspace is impossible |
| Create Agent | any active Human Workspace Member | creator Membership and target Workspace are current | Agent identity + active `member` Membership + creator as Owner; Workspace Channel access follows that Membership, while Project, DM, context, credential and Runtime authority do not | invalid or partial creation commits nothing |
| Create Human invitation | current active Workspace Owner | authentication seam supplies a valid normalized email and expiry; no active Membership is already known for the resolved Human and no pending Invitation uses that Workspace/email | new `pending` Workspace Invitation; no Membership or access | exact duplicate returns existing pending Invitation unchanged; ordinary Member authority, invalid target, known active Membership, non-identical concurrent pending invitation, or stale owner authority creates nothing |
| Accept Human invitation | authenticated Human with matching verified email | Invitation is `pending`, unexpired, belongs to target Workspace, verified email matches exactly, and Human has no active Membership there | Invitation becomes `accepted` and creates one active `member` Membership with Workspace Channel access | invalid or concurrent acceptance creates no duplicate Membership |
| Revoke Human invitation | current active Workspace Owner | Invitation is `pending` in the same Workspace | Invitation becomes terminal `revoked`; no Membership exists from it | terminal Invitation, ordinary Member authority, stale owner authority, or acceptance winning first changes nothing |
| Expire Human invitation | Workspace Authority | Invitation is `pending` and its expiry has been reached | Invitation becomes terminal `expired`; no Membership exists from it | acceptance committed before expiry remains accepted; any later acceptance creates nothing |
| Change member to owner or owner to member | current Workspace Owner | target is an active Human Membership in the same Workspace; another owner remains when demoting the last owner | same Membership continues with its new base role | ordinary Member authority, stale/cross-Workspace target, or removal of the last owner changes nothing |
| Remove another Human Member | current Workspace Owner | target is another active Human Membership in the same Workspace; another active owner remains if target is owner; target owns no Agent | target Membership becomes terminal and its effective access closes | ordinary Member authority, stale/cross-Workspace target, ownerless Agent, or removal of the last owner changes nothing |
| Transfer Agent ownership | current Workspace Owner | Agent belongs to this Workspace; target is a different active Human Membership in it | Agent retains identity and Membership; accountable Owner changes with immutable old/new responsibility history | ordinary Member, Agent Owner, Host, inactive or cross-Workspace target, or stale Agent revision changes nothing |
| Leave Workspace | current active Human Member acting for self | target is the actor's own Membership; another active owner remains if actor is owner; actor owns no Agent | own terminal Membership commits and effective access closes | attempting to leave another Membership, stale state, ownerless Agent, or last-owner self-exit changes nothing |

### 11.1 Conversation, Message, and Context Version

| Intent | Actor | Preconditions | Atomic result | Conflict result |
|---|---|---|---|---|
| Create Conversation | any active Human Member of the target scope | valid preset; Project scope accepts Channel only; Workspace DM supplies one other active Workspace Membership | Conversation + fixed nullable Project scope + Timeline at frontier zero + creator provenance; Channel creates no member facts, DM creates two fixed direct references | Agent actor, inactive creator, Project DM, invalid direct participant, or failed authorization creates nothing |
| Publish top-level Message | authorized Human or Agent execution | current membership and Timeline write permission; Agent publication has one active Run/Attempt, matching claim receipt and Binding revision | append immutable Message; Agent Message records producing Run/Attempt while Human Message records neither; advance Conversation context version; record per-target outcomes, Requests and Inbox Items | missing/fenced/forged/terminal Agent Run authority appends nothing; target-level refusal does not block other targets; exact retry returns the prior result |
| Publish first Thread reply | authorized Human or Agent execution | root is a top-level Message; current Conversation access; Agent publication has matching active Run/Attempt/receipt | Thread + first immutable reply + producing Run/Attempt only for Agent author + per-target outcomes, Requests and Inbox Items; advance Conversation context version | missing/fenced/forged/terminal authority or invalid root creates nothing; concurrent replies converge on one Thread and are ordered by commit; target-level refusals do not block the reply |
| Publish later Thread reply | authorized Human or Agent execution | Thread exists; current Conversation access; Agent publication has matching active Run/Attempt/receipt | append immutable reply + producing Run/Attempt only for Agent author + per-target outcomes, Requests and Inbox Items; advance Conversation context version | missing/fenced/forged/terminal authority appends no Message; target-level refusals do not block the reply; exact retry returns prior result |
| Change scope Membership | Workspace Owner or Project Manager according to the scope contract | target Membership is valid for that scope | every Channel in the scope immediately reflects the new participant set; removal cancels affected pending requests and fences accepted Runs | no Conversation-local participant command exists |
| Remove Agent Workspace Member | current Workspace Owner | target is this Workspace's Agent with a current active Membership; expected Agent revision | make Membership terminal; close effective access; cancel affected Requests and fence active Runs; retain Agent identity, accountable Owner and history | Agent Owner/Host/ordinary Member authority, stale version or wrong Workspace changes nothing |
| Readmit Workspace Agent | current Workspace Owner | Agent identity belongs to this Workspace and has no active Membership | create a new active `member` Membership with Workspace Channel access but no inherited DM or execution authority | invalid authority or attempted old-Membership reuse creates nothing |

DM participant changes are not transitions: a different participant set creates another Conversation. Message correction and retraction publish new Messages rather than mutating old ones.

Conversation ownership, administrator transitions and Channel participant governance do not exist. Creator provenance never participates in later authorization. Workspace and Project Membership are the only Channel access authorities. Workspace DM has no mutation path, and Project has no DM path.

Channel access is the current scope Membership fact. Active Workspace Membership grants Workspace Channel access; Project Channel additionally requires active Project Membership. Regular Human and Agent members list and read all Channels in their current scopes. Workspace DM remains undiscoverable without one of its fixed direct Membership references.

Stable actor identity is not an authorization reference. A Membership is the participation fence: current scope access belongs to it, while audit uses both actor and membership-at-time. This avoids a separate permission generation and prevents an old fixed DM or execution reference from matching a later participation by the same actor.

Agent identity is Workspace-local, not a federated principal. No command can transfer it, attach it to another Workspace, or resolve a cross-Workspace Agent reference. This is an aggregate ownership invariant rather than a permission check that a caller may bypass.

### 11.2 Agent Request

Only the Message/Agent Mention creation row is active in the MVP. WorkItem assignment and Review designation are deferred trigger alternatives.

| From | Intent / actor | Preconditions | Atomic result | Conflict result |
|---|---|---|---|---|
| absent | create from `requested` Mention Outcome, WorkItem assignment action, or Review designation / actor authorized for enclosing intent | exactly one legally valid trigger; target may access result scope | create one `pending` request; current intake disposition is derived separately | a failed Message-target establishment records `not_requested` and creates no Request; deferred non-Message enclosing intents define their own atomic failure |
| `pending` | evaluate intake / Workspace Intake Module | current source facts and policies are readable | return `ready`, `waiting`, or `blocked(reason codes)` as a projection; persist no Request lifecycle change | a concurrent source-fact change causes reevaluation before acceptance |
| `pending` | accept / Workspace intake authority | target, scope, budget, capability, and active trigger fence remain valid | `accepted` + exactly one Run | concurrent cancel/reject/accept: first Workspace commit wins |
| `pending` | reject / Workspace intake authority | a hard refusal or irrecoverable intake condition is established | `rejected` with structured reason | terminal request is unchanged |
| `pending` | cancel / Human requestor, capability-granted initiating Agent, target Agent Owner, current Workspace Owner, or enclosing authority revocation | actor matches one allowed cancellation path | `cancelled` with structured reason; authority loss uses `authority_revoked` | concurrent accept: first Workspace commit wins |
| `accepted` | request stop / Human requestor, capability-granted initiating Agent, target Agent Owner, current Workspace Owner, or enclosing authority fence | Run is non-terminal and actor matches one allowed stop path | request remains `accepted`; authority loss immediately fences further shared writes and execution layer receives cancellation/stop intent; WorkItem assignment is unchanged | Run terminal commit order decides the execution outcome in Step 5 |

The Step 5 Run transition table must place first publication of an Agent Message and Run terminal on the same Workspace concurrency guard. They are independent facts but not independent authorities: publication-first may append before terminal; terminal-first rejects a new publication. A Runtime's local exit does not itself choose either order.

`accepted`, `rejected`, and `cancelled` never transition again. Notification delivery, Node availability, or technical retry does not create another request.

### 11.3 WorkItem, claimability, and assignment revision

| Intent | Actor | Preconditions | Atomic result | Conflict result |
|---|---|---|---|---|
| Create top-level WorkItem | authorized Human | valid Goal, source Message, and Primary Discussion Scope | `open + unassigned + closed`; optional direct assignment follows in the same use case | invalid reference or authorization creates nothing |
| Create standalone WorkItem | authorized Human | no existing discussion location selected | Conversation + initial Human Message + `open + unassigned + closed` WorkItem | any failure creates none of the three facts |
| Publish / retract claimability | authorized Human; delegation-authorized Agent only for its Child | `open + unassigned`; expected WorkItem version | toggle `closed` / `claimable` | assignment or lifecycle race wins by first commit |
| Claim | eligible Agent | `open + unassigned + claimable`; expected version | close claimability; set assignee and `agent_claim` kind; advance assignment revision; create assignment request | one concurrent claimant wins; all others get conflict and no request |
| Direct assign | authorized Human, or delegation-authorized Agent for a new Child | `open` or `blocked`; unassigned; member can access Primary Scope | set assignee and `direct_assignment` kind; advance revision; close claimability; create request iff assignee is Agent | stale version or lost access changes nothing |
| Block | current assignee or authorized Human | `open`; current assignee supplies matching assignment revision; mandatory structured reason | `blocked`; close claimability; retain assignment facts; block its unaccepted assignment request | concurrent terminal transition wins by first commit |
| Unblock | authorized Human | `blocked`; blocking condition intentionally cleared | `open`; retain assignment facts; request returns to pending when no other blocker remains; claimability stays closed | stale version changes nothing |
| Release claimed work | current Agent assignee | `open` or `blocked`; assignment kind is `agent_claim`; matching assignment revision; mandatory reason | preserve lifecycle; clear assignee/kind and Current Submission; advance revision; become `unassigned + closed`; cancel/fence prior-revision execution and cancel pending Review with `assignment_changed` | wrong kind or stale revision changes nothing |
| Revoke assignment | authorized Human | assigned; expected version; mandatory reason | preserve lifecycle; clear assignee/kind and Current Submission; advance revision; become `unassigned + closed`; cancel/fence prior-revision execution and cancel pending Review with `assignment_changed` | stale revision changes nothing |
| Reassign | authorized Human | `open` or `blocked`; assigned; different eligible member | replace assignee/kind; clear Current Submission; advance revision; fence prior-revision authority and cancel pending Review with `assignment_changed`; create optional Agent request | concurrent old-assignee command carries the prior revision and loses after reassignment commits |
| Complete | authorized Human under `manual`, or Workspace completion evaluator | unified completion preconditions hold; Request/Run terminal state is irrelevant | `completed`; clear assignee/kind and advance revision; retain all discussion and evidence; do not stop Runs | failed preconditions return all current reasons and change nothing |
| Cancel | authorized Human | `open` or `blocked`; mandatory reason | `cancelled`; clear assignee/kind and advance revision when assigned; retain Current Submission as terminal evidence; close claimability; cancel/fence assignment and pending review work | concurrent complete/cancel: first valid commit wins |

Agent Claim does not have a second mutable lifecycle. It remains current exactly while the WorkItem has that Agent as assignee, `assignment_kind = agent_claim`, and the same assignment revision; release, Human revocation/reassignment, completion, or cancellation changes those facts and records the reason in audit.

### 11.4 Result Submission, Review, and completion

| Intent | Actor | Preconditions | Atomic result | Conflict result |
|---|---|---|---|---|
| Submit result | current Agent assignee through an authorized Run | WorkItem `open`; matching assignment revision; valid committed references | immutable Submission records assignment revision and submitting Run, then becomes Current Submission; prior current is superseded and its pending review work is cancelled/fenced | reassignment, cancellation, or concurrent submission is ordered by WorkItem version; retry idempotency cannot create duplicates |
| Change Completion Policy | authorized Human | WorkItem non-terminal; expected version | replace current policy and advance revision; leaving `review_required` cancels pending Review/reviewer work with `policy_changed`; retain Current Submission and immediately re-evaluate completion; entering `review_required` creates no Review | stale WorkItem version, concurrent Review decision, or completion is ordered by first valid commit; successful completion records the revision used |
| Create Review | authorized Human | WorkItem `open`; current policy is `review_required`; target is Current Submission; no Review exists; valid non-submitter reviewer | `pending` Review + reviewer revision; create request iff reviewer is Agent | supersession, policy change, or duplicate creation wins by first commit; loser changes nothing |
| Replace reviewer | authorized Human | Review `pending`; expected reviewer revision; valid non-submitter replacement | replace current reviewer; advance revision; cancel/fence old reviewer work; create optional Agent request | old reviewer decision versus replacement: first valid commit wins |
| Accept / reject | current reviewer | Review `pending`; matching reviewer revision; mandatory valid feedback; Agent uses its authorized review Run/Attempt | ordinary feedback Message + structured decision + any mention requests and Inbox Items; accepted decision invokes completion checks | stale revision or fenced Run commits nothing; replacement, cancellation, or supersession is ordered by first valid commit |
| Cancel Review | authorized Human, Submission supersession, or WorkItem cancellation | Review `pending` | `cancelled`; cancel/fence current reviewer work | terminal Review is unchanged |
| Re-evaluate completion | Workspace completion evaluator | a relevant fact committed | complete exactly once if all unified predicates now hold; otherwise persist no new domain state | WorkItem version serialization prevents double completion |

There is at most one WorkItem reference in the Current Submission role, so completion never chooses among competing candidates. Current Submission is not a separate object. Review decision affects only its Review; Submission immutability and history are preserved.

## 12. Step 1 scenario reconciliation

| Step 1 scenario group | Deterministic Step 2 mapping |
|---|---|
| `S-MENTION-CHANNEL-01`, `S-MENTION-DM-01`, `S-MENTION-PER-TARGET-OUTCOME-01`, `S-RUN-NO-MESSAGE-01`, `S-RUN-TERMINAL-MESSAGE-RACE-01` | Message + complete per-target Mention Outcomes + valid Requests are atomic; target establishment failures are isolated and durable. Outcome status follows Message visibility while exact refusal reasons use authority-filtered projections over one fact. Legally established Requests alone express waiting, blocking, rejection, acceptance, and cancellation; these never rewrite Outcome. Existing pending Requests may be reevaluated, but `not_requested` never activates retroactively and requires a new mention. Request acceptance creates one Run; Run outcome and zero-to-many Messages remain independent, while Run terminal and new Message publication share one Workspace commit order. Conversation preset changes membership policy only. |
| `S-WORK-FROM-MESSAGE-01`, `S-WORK-STANDALONE-ATOMIC-01` | Explicit WorkItem creation fixes Goal, source, and Primary Scope; standalone creation is the three-fact atomic boundary; assignment sets current assignment facts and creates an optional request. |
| `S-MENTION-VS-DELEGATION-01`, `S-AGENT-DELEGATION-01` | Mention trigger and assignment-action trigger are disjoint; only the Child command creates relation, current assignment, and WorkItem-associated request. |
| `S-CLAIM-RACE-01`, `S-WORK-RELEASE-REASSIGN-01` | Claim is a compare-and-commit acquisition; assignment kind and revision make release, revocation, reassignment, and ABA fencing deterministic without a tenure object. |
| `S-WORK-REVIEW-01` | Current Submission, independent Review, reviewer revision, atomic feedback decision, and explicit feedback mention request preserve one WorkItem responsibility chain without implicit execution. |
| `S-CONVERSATION-WITHOUT-THREAD-01` | Timeline is a complete Discussion Scope; Thread exists only after the first reply and has no work lifecycle. |
| `S-CONVERSATION-SCOPE-MEMBERSHIP-01`, `S-CONVERSATION-NO-OWNER-01`, `S-WORKSPACE-MEMBERSHIP-INCARNATION-01` | Channel access and participants derive from current scope Membership; creator is provenance only; DM direct participants and execution grants still reference exact Memberships. Membership terminal immediately revokes access and execution authority, while re-entry restores only scope-derived Channel access. |
| `S-HUMAN-MEMBERSHIP-GOVERNANCE-01`, `S-AGENT-WORKSPACE-OWNERSHIP-01`, `S-AGENT-CREATION-01`, `S-AGENT-MEMBERSHIP-GOVERNANCE-01` | Workspace Owner governs the Human trust boundary and Agent Membership lifecycle. Any active Human Member may create an Agent; its active Membership grants Workspace Channel participation but no Project, DM, private context, credential, Runtime Binding, or local resource. |
| `S-AGENT-MESSAGE-FRESHNESS-01`, `S-AGENT-MESSAGE-FRESHNESS-DECISION-01` | Workspace/Conversation version comparison locates exact changes; the Local Agent Module injects relevant ordered Addenda into the same Runtime Session and returns at the acknowledged cursor. |
| `S-OWNER-SUSPEND-01`, `S-OFFLINE-RECONCILIATION-01` | Suspension blocks intake; assignment survives. Authority loss and assignment revisions fence shared writes while Step 5 owns Attempt recovery and terminal outcomes. |
| `S-WORK-CONVERSATION-LIFECYCLE-01`, `S-RUNTIME-REPLACEMENT-01`, `S-RUNTIME-CANNOT-FORGE-AUTHORITY-01`, `S-WORKSPACE-SINGLE-AUTHORITY-01`, `S-AUDIT-CHAIN-01` | Independent lifecycles, server-bound actor/Run/revisions, one commit order, and retained trigger/assignment/reviewer audit history preserve the supplemental architecture scenarios. |

All Step 1 scenarios now map to explicit facts, transitions, fences, or a named downstream execution/context concern without changing their observable success, failure, or authority semantics.

## 13. Explicit exclusions and downstream work

The current domain deliberately excludes:

- Message edit/delete, Conversation hard delete, and Thread/WorkItem archive or restore;
- WorkItem reopen;
- nested Threads, per-Thread membership, co-assignees, multi-reviewer sign-off;
- generic work dependencies beyond `child-of` and `related-to`;
- implicit state changes from natural language;
- `ContinueWorkWithAgent`;
- special final/result Message types;
- response-expectation, response-outcome, or `no_response` state.

## 14. Step 2 closure

Step 2 is complete for the Workspace authorization prerequisites and Conversation MVP facts in sections 1–5 and the active atomic/transition rows. Every in-scope relationship, lifecycle, actor authority, atomic boundary, conflict result, access fence, and observable scenario is fixed without naming storage or transport structures.

Sections 6–9 and their related matrices preserve accepted vocabulary for a future explicit-work layer and are not MVP, Step 3, schema, or release requirements. Step 3 may now name the narrow Workspace Collaboration Module commands and query results against these stable seams. Step 4 will choose persistence structures; Step 5 will define detailed Run/Attempt terminal outcomes, cancellation, steering, and recovery without reopening Step 2 facts.
