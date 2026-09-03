# Conversation MVP and Deferred Work Domain Model

> 2026-08-27 模型替换：当前实现只有 Workspace 唯一全员大群、Workspace 一对一 DM、Project 主群与显式成员长期群聊。WorkItem 使用独立评论区，不再创建来源 Message、Primary Discussion Scope、Topic 或专用 Conversation。本文后续仍保留的旧 Channel visibility、WorkItem Discussion Scope 与 Session 推演仅是历史设计材料；以 `docs/design/11-workspace-project-vfs-boundaries.md`、schema、OpenAPI 和当前测试为实现基线。Agent Session 重构未纳入本轮。

> Status: Active — Conversation MVP and the Project-bound top-level WorkItem foundation are implemented
>
> MVP scope: Workspace identity/Membership/Join Link/role and Agent-creation facts required by authorization; Conversation, Conversation Timeline, Thread, Message, Discussion Scope, Agent Mention Outcome, Agent Request, and their command boundaries
>
> Implemented Work slice: Human-created Project WorkItem, optional source references, description edits while unassigned, direct assignment and reassignment, blocking/unblocking, Agent Result Submission, Human completion/cancellation, and assignment revision fencing
>
> Deferred Work scope: claimability, Agent delegation/Child WorkItem, Completion Policy, and Review. Confirmed facts remain recorded below as the target model.
>
> Out of scope: Run/Attempt execution details (Step 5), storage schema (Step 4), wire protocol and error codes (Step 3)

## 1. Design boundary

The full model keeps four kinds of fact independent. The current product implements discussion, Agent Request handoff, and the bounded Project WorkItem slice above; claim/delegation and review remain later product layers. The relationship tree below retains the deferred target model where noted; current runtime and API behavior is defined by the MVP scope above, schema, OpenAPI, and tests.

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
    ├── Workspace Join Link 0..N
    │   ├── high-entropy token digest; no invitee identity or email
    │   ├── active | revoked
    │   ├── reusable by authenticated holders while active
    │   └── confirmation → exactly one active `member` Membership per Human
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
        ├── immutable description
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

An explicit task execution that publishes with producing-Run provenance may first-publish that Run's Message only while the Run is non-terminal and its current shared-write authority remains valid. Run terminal fences only that explicit execution path. Persistent Agent Session chat publication is independent of Run/Attempt and instead uses the current Binding, claim receipt, exact Discussion frontier and Local Held Draft contract.

In the full model, the trigger source is a mandatory tagged alternative, not three nullable associations that may be combined arbitrarily. The MVP implements only the `requested` Agent Mention Outcome alternative and does not create unused WorkItem or Review associations. Other related facts are causation/provenance only. When the explicit-work layer is introduced, an Agent delegation Request is directly triggered by the Child WorkItem assignment action; the delegation Message is its causation, so the Request cannot also be interpreted as an ordinary mention request. WorkItem stores its current assignee and whether that responsibility came from Direct Assignment or Agent Claim. Every assignment change advances `assignment_revision`; structured assignee commands must match it, preventing delayed commands from an earlier assignment—including an earlier assignment to the same Agent—from gaining authority. Responsibility history is retained as audit facts rather than a separate tenure object.

## 3. Conversation and Message

### 3.1 Creation and permanence

- Only an active Human Workspace Owner may create a Workspace Channel, and only an active Human Project Manager may create a Project Channel. Creation fixes the scope, immutable `public | private` visibility, and creator provenance. Public creates no audience rows; private atomically creates its exact audience and includes the creator. An Agent execution cannot create one.
- Conversation records its creator as immutable provenance rather than transferable ownership. The matching Workspace Owner or Project Manager, or either DM participant, may operate its explicit lifecycle within their current access scope.
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
- A Channel stores a fixed Workspace or Project scope and immutable visibility. Public Workspace participants are all active Workspace Memberships; public Project participants are all active Project Memberships backed by active Workspace Memberships. Private Workspace Channels store exact Workspace Membership audience rows; private Project Channels store exact Project Membership audience rows. DM exists only at Workspace scope, is always private, and stores exactly two fixed Workspace Membership references in the same audience model.
- Public participants are a read-only current-scope projection and have no join/leave mutation. Private Channel audience is revisioned Conversation state: the matching Workspace Owner or Project Manager may add or remove current Human or Agent Memberships, including self and the last participant. DM rejects all participant changes.
- A Workspace DM preset has fixed participants. A different participant set creates a new Conversation; Project scope does not expose or create DM.
- Joining a Workspace or Project immediately grants every public Channel in that scope without writing per-Conversation audience rows. Private access requires an explicit exact Membership row, and the complete active Membership chain remains necessary for Project access.
- Removing an Agent prevents future requests and publication by active execution. It does not erase Messages or cancel WorkItems. Removing its Project Membership releases any current non-terminal WorkItem assignment, advances both revisions, and preserves the prior responsibility in audit history.
- A Channel creator who leaves its scope has no residual content authority and causes no ownership transfer. Scope administrator governance continues independently. DM participants remain fixed regardless of creator status; a different pair is a new Conversation.

Conversation creation and audience change are governance intents; Message publication is a content intent inside an already governed scope. Only the matching active Human Workspace Owner or Project Manager may create a Channel and govern a private audience. Visibility never changes after creation; a different disclosure boundary requires a new Conversation. Workspace DM has no participant-change intent and cannot be created under a Project. A Run that may post to one Timeline or Thread cannot create another Conversation or govern audience.

Current public scope Membership or an explicit current private audience Membership grants access to the whole Channel, including its Timeline, Thread roots, all replies, and visible request outcomes. There is no join-time cutoff, leave-time historical window, or per-Message reader list. Adding a scope member to public or adding a private participant therefore discloses complete Channel history; removal blocks all subsequent reads without deleting authored Messages.

Workspace Membership is one continuous participation of a stable Human or Agent identity in one Workspace. Removal is terminal and re-entry creates another Membership. Channel authorization evaluates the current exact Membership; every shared action retains stable actor plus membership-at-time. Removing a Membership immediately closes public, private, and DM access, cancels affected pending Agent Requests, and fences active Runs. Re-entry restores public scope-derived access only; a new Membership satisfies none of an old private audience, DM reference, or execution grant.

A scope administrator who is not in a private audience receives `governance`, not content access. Governance permits basic Conversation metadata, participant projection, and audience mutation, but forbids Message and search reads, Conversation changes, mentions, requests, Runs, and Agent inbox claims. Adding that administrator's current exact Membership changes later reads to content access; removing it returns to governance without exposing content through the management projection.

Human identity is stable across all Workspaces in one product deployment. Creating or joining another Workspace adds a distinct Membership and selects another isolated collaboration context; it does not copy or expose Conversations, Messages, Agent Requests, Runs, Agents, or permissions. A client or Local Node installation is only an access/execution mechanism, not a Workspace.

Workspace Owner is the highest governance role on an active Human Workspace Membership, not a separate identity, aggregate, or permanent creator privilege. Workspace creation atomically establishes the Workspace and the creator's `owner` Membership. Several active Human Memberships may hold owner responsibility, but no change may remove the last active owner.

Every active Workspace Membership has the closed base role `owner | member`. Only Human Memberships may be owner; Agent Memberships are fixed to member. There is no admin, custom-role, inheritance, or hierarchy dimension. Role changes update the same continuous Membership and record an audit fact.

Only a current Workspace Owner may invite a Human, terminate another Human's Membership, or change a Human Membership between owner and member. An ordinary Human Member may only terminate their own Membership; a self-exit that would remove the last active owner is rejected.

Only a current Workspace Owner may terminate or readmit an Agent Membership or transfer Agent ownership to another active Human Membership in the same Workspace. Agent Owner accountability may suspend/resume and constrain the Agent but cannot mutate its Membership; Agent Host local custody may stop execution but cannot mutate Membership, ownership, or shared authority. A Human Membership that still owns any Agent cannot terminate; it must transfer all owned Agents first, and ownership history remains immutable.

Only a current Workspace Owner may permanently delete an Agent. Deletion first terminates any active Agent Membership and task authority, then removes the Agent from discovery and direct access with no readmission path. Existing Channel and DM messages remain readable under the original display name and carry a deleted-author marker.

A Human joins or rejoins only by opening an active Workspace Join Link created by a current Owner and explicitly confirming. The link targets no email or preselected identity and grants no access before confirmation. Confirmation atomically creates a new active `member` Membership, which immediately participates in Workspace Channels.

An active Join Link is reusable by multiple authenticated Humans until an Owner revokes it. Links are independently revocable, always grant `member`, and never collect invitee email. A Human with an active Membership gets that existing Membership rather than a duplicate; a removed Human who confirms again receives a new participation tenure without restoring old private access.

Every active Human Workspace Member may list and copy active Join Links. Only a current Workspace Owner may create or revoke one. The token digest remains the acceptance lookup key; an authenticated ciphertext protected by a separate data-directory key makes authorized listing possible and is deleted on revocation.

An Agent identity is created in and permanently scoped to exactly one Workspace. Its Memberships and accountable Owner can only be in that Workspace, and every mention target, Agent Request, Run, Message provenance link, ownership relation, and audit chain must remain there. Another Workspace creates another Agent identity even if it copies an equivalent configuration; Agent history and authority never transfer or merge.

## 4. Agent Inbox 与 Discussion pull

Agent DM Message 或明确 `@Agent` 的 Message 会创建 durable Inbox Item。Workspace wake 不含正文，Runtime 必须主动读取：

```text
agent.inbox_changed { agentId, wakeSequence }
→ teamctl inbox check
→ teamctl message check --target <scope>
→ atomically claim pending attention for that Scope
→ return attention references and ordered Messages since the last handled position
→ optionally read / resolve history
→ send ordinary Message or return no-output
```

`@` selects the current Mention Session and does not make Project or unrelated Conversation context implicit. An ordinary Channel Message does not wake the Agent, but a later mention creates a new `agentRequestId` Session whose JSONL contains the bounded Discussion Scope context up to that trigger. Agent Inbox claim receipts are independent of Run/Attempt and remain replayable until that logical Session explicitly completes the request; structured state commands retain their own object revisions and fencing rules.

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
- If target or result-scope authority is revoked before acceptance, a pending request is cancelled with reason `authority_revoked`. If already accepted, the request remains accepted while the Run loses further shared-write authority, is fenced, and receives a stop/cancel intent. Suspension instead changes the pending request's derived intake disposition and does not cancel it. Request cancellation alone does not release or reassign an associated WorkItem; Project Membership removal separately releases that member's current assignment.

There is no `ContinueWorkWithAgent`. When a temporary condition clears, an existing pending Request is reevaluated automatically. A prior `not_requested` Outcome is not reevaluated because no Request exists; a new explicit `@Agent` Message is required to create a new Outcome and possible Request. Ordinary Messages and later permission changes never start execution by inference.

## 6. WorkItem — foundation active, advanced model deferred

The current implementation covers top-level Project WorkItems with direct Human assignment, a dedicated Project Conversation, blocking, immutable Agent Result Submissions, Human terminal decisions, and revision fencing. The claimability, Child/delegation, Completion Policy, and Review rules below remain target-model requirements until their commands and storage are added.

### 6.1 Identity and immutable intent

- Only an authorized Human creates a top-level WorkItem.
- An authorized Agent may create a Child WorkItem using the parent's Primary Discussion Scope or another existing scope it may access; no Agent-created hidden Conversation or Thread is allowed.
- Description is the explicit outcome statement managed by the WorkItem. In the current slice it can be edited only while the WorkItem is open and unassigned; source references are fixed when present. The full target model treats the intent as immutable and uses a new WorkItem for materially changed requirements.
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

MVP implements the Message/per-target-mention-outcome, first-Thread-reply, Agent-Request-acceptance, Agent-Message-freshness, and bounded Project WorkItem boundaries below. Claimability, Agent delegation, and Review remain deferred and must not cause placeholder commands or a second execution model.

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
14. Persistent Agent Message publication or return uses trusted author, claim receipt, Binding revision and Discussion frontier; Artifact publication independently uses Agent, Binding revision, Artifact identity and base state hash. Either can return `held` and start an explicit same-Session review turn. Artifact success emits Workspace change history but no Agent Inbox Item or wake; explicit task returns may additionally carry Run/Attempt provenance.
15. Persistent chat Message publication and Run terminal are independent. If an explicit task return carries producing-Run provenance, only that path is fenced by the Run's terminal state.
16. Workspace Membership terminal + immediate closure of all effective Conversation access + affected pending Request cancellation + active Run fencing; historical actor and membership-at-time remain.
17. Active Human Member Agent creation + new Workspace-local Agent identity + active `member` Membership + creator as sole Agent Owner. Creation grants public Workspace Channel participation but no private Channel, Project, DM, private context, credential, Runtime Binding, or local resource.
18. Human creates or joins a Workspace + a distinct Membership for that Human in that Workspace; no existing Membership, authority, Conversation, Message, Agent Request, Run, or Agent crosses the Workspace seam.
19. Workspace creation + creator's active Human Membership + owner role; any later owner, Membership, or exit mutation preserves at least one active Human owner.
20. Workspace-Owner-authorized Human Membership role change + the affected Membership fact and audit; ordinary Member self-exit cannot bypass last-owner continuity.
21. Authenticated Human confirmation of one active Workspace Join Link + exactly one new active `member` Membership; failure creates neither Membership nor partial acceptance.
22. Join Link creation stores only the high-entropy token digest; active links may be used by multiple Humans and independently revoked, while replay by an already-active Human cannot create a duplicate Membership.
23. Channel creation + fixed scope + immutable visibility + creator provenance; public access dynamically follows scope Membership, while private creation includes an exact audience and private audience mutations atomically advance Conversation revision/context version. DM has exactly two fixed participants and no mutation boundary.
24. Workspace Owner Agent-Membership termination/readmission or Agent-ownership transfer + all affected request/run fences and audit; Human Membership exit is rejected while it still owns an Agent.

Idempotency makes a retried intent return the same logical result. Expected object versions, assignment revisions, reviewer revisions, claim receipts, exact Discussion frontiers and, for explicit task returns, the producing Run's concurrency guard serialize structured state races. Context Version does not replace these scope-specific fences.

## 11. Transition and authority matrices

These matrices are normative domain transitions. Command names remain provisional until Step 3, but no later Interface may weaken their actors, preconditions, atomic effects, or conflict rules. Every successful row also records actor, causation, idempotency result, and committed object versions in audit.

### 11.0 Workspace creation and owner continuity

| Intent | Actor | Preconditions | Atomic result | Conflict result |
|---|---|---|---|---|
| Create Workspace | authenticated Human identity | valid creation intent in the current deployment | Workspace + creator's active `owner` Human Membership | duplicate/idempotent retry returns the prior result; partial Workspace or ownerless Workspace is impossible |
| Create Agent | any active Human Workspace Member | creator Membership and target Workspace are current | Agent identity + active `member` Membership + creator as Owner; public Workspace Channel access follows that Membership, while private Channel, Project, DM, context, credential and Runtime authority do not | invalid or partial creation commits nothing |
| Create Workspace Join Link | current active Workspace Owner | creator has current owner authority | new `active` high-entropy Join Link; digest and authenticated ciphertext are stored | ordinary Member authority or invalid Workspace creates nothing |
| List Workspace Join Links | current active Human Workspace Member | caller has current Workspace Membership | active links include the recoverable token; revoked links include metadata with a null token | inactive or non-member authority returns no link metadata or token |
| Confirm Workspace Join Link | authenticated Human holding the complete token | Join Link is `active` and belongs to an existing Workspace | exactly one active `member` Membership with public Workspace Channel access; aggregate use count advances | invalid/revoked token creates nothing; existing active Membership is returned without duplication |
| Revoke Workspace Join Link | current active Workspace Owner | Join Link is `active` in the same Workspace and revision is current | Join Link becomes terminal `revoked`; existing Memberships remain intact | revoked link, ordinary Member authority, or stale revision changes nothing |
| Change member to owner or owner to member | current Workspace Owner | target is an active Human Membership in the same Workspace; another owner remains when demoting the last owner | same Membership continues with its new base role | ordinary Member authority, stale/cross-Workspace target, or removal of the last owner changes nothing |
| Remove another Human Member | current Workspace Owner | target is another active Human Membership in the same Workspace; another active owner remains if target is owner; target owns no Agent | target Membership becomes terminal and its effective access closes | ordinary Member authority, stale/cross-Workspace target, ownerless Agent, or removal of the last owner changes nothing |
| Transfer Agent ownership | current Workspace Owner | Agent belongs to this Workspace; target is a different active Human Membership in it | Agent retains identity and Membership; accountable Owner changes with immutable old/new responsibility history | ordinary Member, Agent Owner, Host, inactive or cross-Workspace target, or stale Agent revision changes nothing |
| Leave Workspace | current active Human Member acting for self | target is the actor's own Membership; another active owner remains if actor is owner; actor owns no Agent | own terminal Membership commits and effective access closes | attempting to leave another Membership, stale state, ownerless Agent, or last-owner self-exit changes nothing |

### 11.1 Conversation, Message, and Context Version

| Intent | Actor | Preconditions | Atomic result | Conflict result |
|---|---|---|---|---|
| Create Channel | active Human Workspace Owner or active Human Project Manager for the target scope | valid immutable visibility; public supplies no audience; private supplies only current Memberships of the exact scope and includes creator | Conversation + fixed nullable Project scope + Timeline at frontier zero + creator provenance; public creates no audience rows, private creates exact audience rows | ordinary Member/Agent actor, inactive creator, explicit public audience, cross-scope or inactive Membership, or failed authorization creates nothing |
| Create DM | active Human Workspace Member | exactly one other active Workspace Membership; visibility is private | Workspace Conversation + fixed two-Membership audience + Timeline at frontier zero | Project scope, public visibility, invalid participant, or failed authorization creates nothing |
| Publish top-level Message | authorized Human or bound Agent | current membership and Timeline write permission; persistent Agent publication has matching claim receipt, Binding revision and expected Timeline frontier | Human append, or Agent `published { message }`; persistent Agent Message has no Run/Attempt provenance; advance Conversation context version; record per-target outcomes, Requests and Inbox Items; complete the receipt atomically | stale Agent frontier returns `held` and an exact delta without a Message or receipt completion; missing/fenced/forged authority appends nothing; exact retry returns the prior result |
| Publish first Thread reply | authorized Human or bound Agent | root is a top-level Message; current Conversation access; persistent Agent publication has matching receipt, Binding revision and expected Thread frontier | Thread + first immutable reply + per-target outcomes, Requests and Inbox Items; persistent Agent reply has no Run/Attempt provenance | stale Agent frontier returns `held`; invalid root or missing/fenced authority creates nothing; concurrent replies converge on one Thread and are ordered by commit |
| Publish later Thread reply | authorized Human or bound Agent | Thread exists; current Conversation access; persistent Agent publication has matching receipt, Binding revision and expected Thread frontier | append immutable reply + per-target outcomes, Requests and Inbox Items; persistent Agent reply has no Run/Attempt provenance | stale Agent frontier returns `held`; missing/fenced authority appends no Message; exact retry returns the prior result |
| Change scope Membership | Workspace Owner or Project Manager according to the scope contract | target Membership is valid for that scope | every public Channel in the scope immediately reflects the new participant set; all effective private/DM access through the terminal Membership closes; affected pending Requests and active Runs are cancelled/fenced | stale, inactive, or cross-scope target changes nothing |
| Add private Channel participant | active Human Workspace Owner or Project Manager for the Channel scope | private active Channel; exact current scope Membership; expected Conversation revision | audience row + Conversation revision/context version advance; full-history content access begins | public/DM, ordinary Member/Agent, stale revision, inactive/cross-scope Membership, or duplicate participant changes nothing |
| Remove private Channel participant | active Human Workspace Owner or Project Manager for the Channel scope | private Channel; exact audience row; expected Conversation revision | delete audience row + Conversation revision/context version advance + pending Request cancellation + active Run/Attempt and Agent inbox fence | public/DM, ordinary Member/Agent, stale revision, or absent participant changes nothing; removing self or last participant is valid |
| Remove Agent Workspace Member | current Workspace Owner | target is this Workspace's Agent with a current active Membership; expected Agent revision | make Membership terminal; close effective access; cancel affected Requests and fence active Runs; retain Agent identity, accountable Owner and history | Agent Owner/Host/ordinary Member authority, stale version or wrong Workspace changes nothing |
| Readmit Workspace Agent | current Workspace Owner | Agent identity belongs to this Workspace and has no active Membership | create a new active `member` Membership with public Workspace Channel access but no inherited private Channel, DM, or execution authority | invalid authority or attempted old-Membership reuse creates nothing |

DM participant changes are not transitions: a different participant set creates another Conversation. Message correction and retraction publish new Messages rather than mutating old ones.

Conversation ownership and administrator roles do not exist. Creator provenance never participates in later authorization. Existing Workspace Owner and Project Manager roles govern private Channel audience, including when the administrator lacks content access. Workspace DM has no mutation path, and Project has no DM path.

Public Channel content access is the current scope Membership fact. Private Channel content access additionally requires the exact current scope Membership in its audience; a new tenure never matches an old row. Regular Human and Agent members list and read public Channels plus private Channels in whose audience they appear. A scope administrator may additionally list a private Channel in governance mode without any content endpoint. Workspace DM remains undiscoverable without one of its fixed Membership references.

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
| Create top-level WorkItem | authorized Human | valid description, source Message, and Primary Discussion Scope | `open + unassigned + closed`; optional direct assignment follows in the same use case | invalid reference or authorization creates nothing |
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
| `S-MENTION-CHANNEL-01`, `S-MENTION-DM-01`, `S-MENTION-PER-TARGET-OUTCOME-01`, `S-RUN-NO-MESSAGE-01`, `S-AGENT-MESSAGE-FRESHNESS-01` | Message + complete per-target Mention Outcomes + valid Requests are atomic; target establishment failures are isolated and durable. Outcome status follows Message visibility while exact refusal reasons use authority-filtered projections over one fact. Legally established Requests alone express waiting, blocking, rejection, acceptance, and cancellation; these never rewrite Outcome. Existing pending Requests may be reevaluated, but `not_requested` never activates retroactively and requires a new mention. Persistent Agent chat publication is independent of Run terminal and uses atomic Discussion freshness. Conversation preset changes membership policy only. |
| `S-WORK-FROM-MESSAGE-01`, `S-WORK-STANDALONE-ATOMIC-01` | Explicit WorkItem creation fixes description, source, and Primary Scope; standalone creation is the three-fact atomic boundary; assignment sets current assignment facts and creates an optional request. |
| `S-MENTION-VS-DELEGATION-01`, `S-AGENT-DELEGATION-01` | Mention trigger and assignment-action trigger are disjoint; only the Child command creates relation, current assignment, and WorkItem-associated request. |
| `S-CLAIM-RACE-01`, `S-WORK-RELEASE-REASSIGN-01` | Claim is a compare-and-commit acquisition; assignment kind and revision make release, revocation, reassignment, and ABA fencing deterministic without a tenure object. |
| `S-WORK-REVIEW-01` | Current Submission, independent Review, reviewer revision, atomic feedback decision, and explicit feedback mention request preserve one WorkItem responsibility chain without implicit execution. |
| `S-CONVERSATION-WITHOUT-THREAD-01` | Timeline is a complete Discussion Scope; Thread exists only after the first reply and has no work lifecycle. |
| `S-CONVERSATION-SCOPE-MEMBERSHIP-01`, `S-CONVERSATION-NO-OWNER-01`, `S-WORKSPACE-MEMBERSHIP-INCARNATION-01` | Public Channel access derives from current scope Membership; private Channel and DM content access reference exact Memberships; creator is provenance only. Membership terminal immediately revokes access and execution authority, while re-entry restores only public Channel access until a scope administrator explicitly adds the new tenure to a private audience. |
| `S-HUMAN-MEMBERSHIP-GOVERNANCE-01`, `S-AGENT-WORKSPACE-OWNERSHIP-01`, `S-AGENT-CREATION-01`, `S-AGENT-MEMBERSHIP-GOVERNANCE-01` | Workspace Owner governs the Human trust boundary, Agent Membership lifecycle, Workspace Channel creation, and private Workspace audience. Any active Human Member may create an Agent; its active Membership grants public Workspace Channel participation but no private Channel, Project, DM, private context, credential, Runtime Binding, or local resource. |
| `S-AGENT-MESSAGE-FRESHNESS-01`, `S-AGENT-MESSAGE-FRESHNESS-DECISION-01` | Workspace/Conversation version comparison locates exact changes; the current Mention Logical Session reviews the exact Discussion delta and returns at the acknowledged cursor. |
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
