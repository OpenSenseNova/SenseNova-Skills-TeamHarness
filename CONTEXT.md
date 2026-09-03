# AI-Native Collaboration

This context defines the shared language for humans and agents collaborating in a Workspace.

## Current delivery scope

The MVP first establishes the Workspace identity, Membership, Workspace Join Link, role, Agent-creation, and governance facts required for authorization, then implements Conversation, Conversation Timeline, Thread, Discussion Scope, immutable Message, Agent Mention Outcome, Agent Request, the persistent Agent Inbox, isolated Logical Sessions (one per Mention `agentRequestId` or WorkItem `workItemId`) and a bounded Project WorkItem slice backed by disposable local ACP caches. Conversation replies and Workspace-change handling do not create Run/Attempt. Thread support is required even though an individual Conversation may contain zero Threads.

The current WorkItem slice includes Human-created Project WorkItems, direct assignment and reassignment, blocking/unblocking, independent comments, Agent Result Submission, and Human completion/cancellation. Claimability, Agent delegation/Child WorkItem, Completion Policy, and Review remain later layers; they are not MVP objects, commands, projections, or release gates.

## Language

**Human**:
A stable person identity in one product deployment that may create and participate in multiple Workspaces through a distinct Workspace Membership in each. It remains stable when verified email attributes change; installing or running a client does not create another Human identity or itself constitute a Workspace, and independent deployments do not implicitly federate identity.
_Avoid_: Workspace-local user, installation identity, Workspace Membership

**Agent**:
A stable non-human collaboration identity created in exactly one Workspace by an active Human Member and permanently belonging to that Workspace, with its own authorship, capabilities, and history. Creation atomically establishes its active `member` Membership and the creator's active Human Membership as its sole accountable Agent Owner. The Agent therefore participates in Workspace Channels through its own Membership, but inherits none of the creator's permissions, private context, credentials, Runtime Binding, or local resources.
_Avoid_: Runtime, model Session, creator proxy

**Agent Mention**:
An explicit structured `@` reference to an Agent in a Message. At Message commit, each distinct target independently receives one immutable Agent Mention Outcome: either `requested` with a durable Agent Request, or `not_requested` with a structured reason. It never creates, assigns, or advances a WorkItem unless the author separately expresses that explicit work-management intent.
_Avoid_: Direct Assignment, passive notification, implicit WorkItem

**Agent Mention Outcome**:
The durable per-target result of resolving one Agent Mention when its Message commits: `requested` means the request was legally allowed to exist and references the created Agent Request, while `not_requested` means the request itself could not legally be established and records one authoritative structured reason. Intake waiting, blocking, or rejection after `requested` belongs only to Agent Request and never rewrites the Mention Outcome. A later authority or access change also never upgrades `not_requested` or creates a Request retroactively; a new explicit Agent Mention is required. Every reader of the Message can see whether the target was requested; only a current Workspace Owner or the target Agent's current Owner receives the exact governance reason, while others receive a safe summary projected from the same fact. One target's outcome never prevents the Message or another target's valid Request from being committed, and a failure is never silently omitted.
_Avoid_: Agent Request lifecycle, transient API response, all-or-nothing target batch, duplicate public/private reason facts

**Agent Request**:
A durable, legally established request for a named Agent to attend to a Message or advance explicitly associated work. A conversational Request has one `requested` Agent Mention Outcome, target Agent and result Discussion Scope; its isolated Mention Logical Session accepts it through Inbox claim without creating Run/Attempt. Future explicit WorkItem assignment or Review triggers may use a Run when independent execution facts are required. Temporary availability is derived and an irrecoverable intake refusal becomes `rejected`; neither outcome changes its trigger back to `not_requested`.
_Avoid_: WorkItem, Run, notification

**Direct Assignment**:
The explicit assignment of a WorkItem to a named member. When the assignee is an Agent it may create an Agent Request, but an Agent Mention alone is not Direct Assignment; assignment bypasses the open claim decision but not authorization or intake constraints.
_Avoid_: Agent Mention, Agent Claim, automatic rerouting

**Child WorkItem**:
A distinct WorkItem explicitly created to track a delegated or decomposed outcome related to a parent WorkItem. Mentioning another Agent or asking for conversational input does not implicitly create one.
_Avoid_: Agent Mention, co-assignment, unrelated task

**Conversation**:
A durable discussion with one fixed collaboration scope, one Conversation Timeline, optional Threads, and an `active | archived` lifecycle; it may exist without a WorkItem and never carries work ownership or completion state. Archiving preserves complete history and provenance but makes every Discussion Scope read-only until restore. A Channel derives current access from its Workspace or Project, a DM stores two fixed direct participants, creator is provenance rather than ownership, and an Agent may speak only inside an active, currently authorized Discussion Scope.
_Avoid_: Runtime Session, WorkItem, task queue, Channel entity, DM entity, Conversation Owner, Conversation Administrator

**Conversation Membership Projection**:
The read-only current participant projection for a Conversation. A Workspace Channel projects all active Workspace Memberships; a Project Channel projects all active Project Memberships backed by active Workspace Memberships; a DM projects its two fixed direct Membership references while they remain active. Channel membership is never stored or mutated on the Conversation.
_Avoid_: Per-Conversation Channel participant list, Message ACL, historical access window, membership epoch

**Conversation Timeline**:
The top-level sequence of Messages in a Conversation. It is a Discussion Scope in its own right rather than an implicit or default Thread.
_Avoid_: Main Thread, default Thread, root Thread

**Thread**:
An optional focused branch rooted in a Message from a Conversation Timeline and containing its replies. It inherits the Conversation's scope-derived access and does not carry assignment, execution, or completion state.
_Avoid_: Conversation Timeline, mandatory message container, WorkItem, task state

**Discussion Scope**:
The exact message stream in which context is read and Messages are published: either a Conversation Timeline or one Thread. It is a location value, not another discussion container or lifecycle entity.
_Avoid_: Conversation, Message stream entity, implicit Thread

**Message**:
An authored, immutable statement published in one Discussion Scope. A top-level Message belongs to a Conversation Timeline and a reply belongs to one Thread. A Mention Logical Session publishes with an active Inbox claim receipt and Runtime Binding revision but no producing Run/Attempt. A separate explicit task execution may record producing Run/Attempt provenance. A Human-authored Message has no execution provenance. These facts prove authority and attribution but never make Message into execution, work, submission, or review state.
_Avoid_: Final Message, Run Result Message, Agent Request, Result Submission, task record

**Discussion Frontier**:
The monotonically increasing position of one exact Discussion Scope. A Conversation Timeline and each Thread advance independently; Conversation context version never substitutes for this value.
_Avoid_: whole-Conversation message frontier, permission epoch, Runtime loop counter

**Context Version**:
A monotonically increasing Workspace or Conversation counter used to detect whether broader shared facts changed while a Runtime was running. It is combined with the exact Discussion Frontier and stable source versions; it never authorizes content or selects Messages by itself.
_Avoid_: Discussion Frontier, permission epoch, cancellation flag

**Workspace Document**:
A shared team rule, process, guide, or knowledge document with one stable Workspace identity and immutable content versions. It does not belong to an Agent and does not define an Agent persona. Document changes remain in Workspace change history and do not create Agent Inbox Items; an Agent receives a Message reference when it must inspect a Document.
_Avoid_: Agent role prompt, mutable shared file, Runtime Session, Run objective

**Run Context Snapshot**:
The exactly-one immutable execution provenance accepted with a Run, including objective, trigger and result scopes, trigger frontier, Agent membership-at-time, policy version, effective budget, context versions, and optional Repository identity/base commit. It stays fixed across technical Attempt retries but is not a Runtime Prompt or a copy of Conversation history.
_Avoid_: Prompt, live Conversation history, Inbox payload

**Agent Inbox Item**:
A durable delivery record for one ordinary Message visible to an Agent. Human-Agent DM and explicit structured `@Agent` Messages additionally carry attention and create a separate wake entry. It stores a stable Message reference and a monotonically increasing Agent sequence without copying the Message body.
_Avoid_: Workspace Change, Message copy, Runtime prompt payload, wake event

**Agent Inbox Claim Receipt**:
A replayable capability proving that one Mention Logical Session (identified by `agentRequestId`) claimed its pending Message item and preceding Discussion changes under one Runtime Binding revision. It records the exact position range returned by `message check` and remains replayable until that request is explicitly completed. It contains no Run/Attempt identity.
_Avoid_: Message, Runtime credential, Run lease, global Workspace cursor

**Held Draft**:
An unpublished persistent-Agent Message or Artifact-operation candidate durably retained only on its Local Computer. A Message draft is bound to a Discussion receipt and exact frontier. An Artifact draft is independently bound to Agent, Runtime Binding revision, Artifact identity, observed base state hash, proposed hash, and optional frozen managed bytes. Workspace stores only idempotent results and content-free freshness audit. Either draft may be revised, retried unchanged, discarded, or knowingly published after at least one hold. Artifact success writes Workspace change history but no Agent Inbox Item.
_Avoid_: Message, Artifact, Final Message, Result Submission, shared draft

**Workspace**:
A single team's highest shared collaboration, authorization, and data-isolation context, containing Workspace-level collaboration and optional Projects. One deployment may contain multiple isolated Workspaces, and one Human may create or join several without merging their authority or data; the current product has no separate Organization domain entity.
_Avoid_: Organization, Customer Account, Project

**Workspace Join Link**:
A revocable, Workspace-scoped bearer capability created by a current Workspace Owner. It targets no email or preselected Human and is reusable while `active`; every active Human Workspace Member may view and copy it, and any authenticated Human holding the complete high-entropy URL may explicitly confirm and join as `member`. Acceptance creates a new active Membership only when that Human has no active Membership in the Workspace. The server retains the digest for lookup and an authenticated encryption of the token for authorized listing; revocation deletes the ciphertext and the link can never be used again.
_Avoid_: Workspace Membership, email invitation, direct member creation, owner-role grant

**Workspace Membership**:
One durable, continuous participation of a Human or Agent identity in exactly one Workspace, carrying the closed base role `owner | member`. Only Human Memberships may be `owner`; Agent Memberships are fixed to `member`. At most one Membership is active for the same actor in the same Workspace; removal is terminal and later re-entry creates a new Membership.
_Avoid_: Member identity, reusable membership, permission generation, reactivated membership

**Workspace Owner**:
A Workspace's highest governance role, held by one or more active Human Memberships rather than by a separate object. Workspace creation gives the creator the `owner` role, and a Workspace must always retain at least one active Owner. No independent admin/normal permission dimension exists.
_Avoid_: Admin role, permanent creator privilege, WorkspaceOwner object

**Workspace Authority**:
The single logical authority that authenticates and commits shared collaboration facts. Local work and pending changes may continue offline, but Messages, WorkItem responsibility, permissions, Submissions, and Reviews become shared facts only after this authority commits them.
_Avoid_: Local replica authority, Runtime state, multi-master Workspace

**Project**:
A Workspace collaboration scope for one sustained body of work, with its own participation, Conversations, Artifact associations, and zero or one active Primary Git Repository. It is optional and is not any Computer's absolute path; a Conversation may belong to one Project or remain Workspace-level, while an Artifact may be explicitly associated with several Projects without changing ownership.
_Avoid_: Workspace, mandatory parent, OS path, arbitrary folder label

**Primary Git Repository**:
The optional current Git source attached to a Project across Computers, identified independently of any local checkout path and carrying the clone source and default branch needed to resolve the same work elsewhere. A Project has at most one active association; identity replacement is detach then attach, and detached history remains for Run provenance. It never contains Human credentials or local Git configuration.
_Avoid_: Project identity, Local Working Copy, absolute directory, Attempt Worktree, Artifact

**Local Working Copy**:
One Computer's active local checkout of a Project's Primary Git Repository. Its absolute path, credentials, file permissions, and uncommitted contents remain under Local Custody; another Computer may bind the same Project at a different path.
_Avoid_: Project identity, shared path, Workspace fact store, Attempt Worktree

**Project Participation**:
A Human's or Agent's role-bearing access to a Project. It is required but not sufficient for access to a private Project Conversation and does not by itself grant an Agent permission to execute every Project-bound capability.
_Avoid_: Workspace Membership, Project Membership, Agent execution grant

**WorkItem**:
An optional, explicit, user-visible unit for managing an outcome, responsibility, and progress across discussion and one or more Runs. Every WorkItem has a source Message and Primary Discussion Scope, but ordinary Agent Requests and Runs do not require a WorkItem.
_Avoid_: Agent Request, Run, hidden task, implicit mention work

**Primary Discussion Scope**:
The single Conversation Timeline or Thread in which a WorkItem's ongoing discussion and Agent results are published. A standalone WorkItem creation also creates its dedicated Conversation and initial source Message when no discussion location is supplied.
_Avoid_: Primary Discussion Thread, WorkItem state, execution log, source Message

**Work Assignee**:
The single member currently responsible for advancing a WorkItem. Parallel collaboration is represented by related or child WorkItems with their own assignees rather than multiple co-assignees on one WorkItem.
_Avoid_: Co-assignee, Reviewer, Execution Lease holder

**Run**:
The optional logical execution by a named Agent for explicit work that requires a stable objective, Run Context Snapshot, policy, budget, cancellation or Repository execution scope. Conversation attention and Workspace Change processing do not create a Run. Its outcome is reported independently of Message, WorkItem, Result Submission or Review state.
_Avoid_: Agent Request receipt, Attempt, persistent Agent Runtime Session, conversation response

**Attempt**:
One concrete execution of an explicit Run by a Device through a Runtime. Technical retry creates another Attempt for the same Run. Inbox wake or ACP prompt turn is never an Attempt.
_Avoid_: Run, Agent Claim, WorkItem retry

**Attempt Worktree**:
The isolated writable Git working directory created or recovered for one Project-scoped Attempt from the selected Computer's matching Local Working Copy. It is the Runtime `cwd`, is never shared by concurrent Attempts, and does not become a Workspace fact merely because files changed inside it.
_Avoid_: Local Working Copy, Agent Home, repositories root, shared Artifact

**Private Context Grant**:
An Owner's explicit, policy-bound permission for a shared Agent execution to use a category of local private context. Permission to read private context does not imply permission to disclose it in Workspace output.
_Avoid_: Implicit Owner context, Workspace visibility, publication permission

**Claimable WorkItem**:
An unassigned WorkItem made visible to every eligible Agent. It remains available until one Agent successfully claims it.
_Avoid_: Agent Offer, device job

**Agent Claim**:
The atomic acquisition of a Claimable WorkItem by an eligible Agent. A successful claim gives that Agent exclusive responsibility until the Agent releases it, the Workspace revokes it, or an authorized member reassigns it; Device failure or lease expiry does not reopen it automatically.
_Avoid_: Device Claim, Lease

**Execution Lease**:
The temporary right of one eligible Device to execute a Run already addressed to an Agent. It protects execution across disconnects and retries but does not determine WorkItem responsibility or Agent Request ownership.
_Avoid_: Agent Claim, task assignment

**Offline Continuation**:
Bounded local computation that may continue after a Local Node loses its Workspace connection. It cannot create shared facts or initiate externally visible side effects without current authorization, and its output remains a candidate until ownership and authority are revalidated.
_Avoid_: Offline Workspace mutation, unlimited autonomous execution

**Claim Eligibility**:
The Workspace's authoritative determination that an Agent may discover and claim a particular WorkItem, based on permissions and explicit work constraints. Eligibility permits a claim but does not assert that the Agent is suitable or willing to perform the work.
_Avoid_: Agent self-qualification, automatic selection

**Claim Decision**:
An eligible Agent's autonomous decision whether to claim a visible WorkItem. The Workspace enforces eligibility but does not choose the most suitable Agent on the Agent's behalf.
_Avoid_: Scheduler assignment, eligibility decision

**Shared Agent**:
An Agent whose shared identity, lifecycle, and Workspace permissions are governed by the Workspace and that eligible members may address or assign work to. Shared governance does not imply shared execution infrastructure.
_Avoid_: Team server Agent, personal-only Agent

**Agent Creator**:
The immutable Human identity that created an Agent. It is audit provenance and remains distinct from the transferable current Agent Owner.
_Avoid_: Agent author, Agent Host, current Agent Owner

**Agent Owner**:
The exactly one active Human Workspace Membership currently accountable for an Agent. The Agent Owner may suspend/resume and constrain the Agent, but only a Workspace Owner may transfer Agent ownership or terminate/readmit the Agent Membership. A Human Membership cannot terminate while it still owns an Agent.
_Avoid_: Agent Creator, Agent Host, Workspace Owner

**Agent Host**:
The team member who supplies a Device on which an Agent's Runtime and local state reside and execute. A Host controls their Device, local resources, credentials, and willingness to continue hosting, but cannot change the Agent's shared identity, Workspace Membership, accountability, or Workspace authority.
_Avoid_: Agent Creator, Workspace governor

**Local Custody**:
Authority over the Device, private context, credentials, and other local resources used to execute an Agent. Local Custody can restrict or stop local execution but cannot expand or redefine the Agent's Workspace permissions.
_Avoid_: Agent governance, Workspace authorization

**Personal Credential**:
Sensitive proof that authorizes actions in an external system under one Human's identity and may be used by that Human's locally hosted Agent under Local Custody. It is not shared Project context and never becomes available to another Agent merely through Project participation or a capability binding.
_Avoid_: Shared Project secret, Connector Definition, Workspace permission

**Runtime**:
A replaceable local execution engine that performs work for an Agent. A Runtime has no independent Workspace identity or authority and does not own the Agent's collaboration history.
_Avoid_: Agent, Workspace member

**Runtime Binding**:
The local association that enables an Agent to execute through a particular Runtime on its Host. Replacing the binding does not create a new Agent or rewrite its history.
_Avoid_: Agent identity, Runtime ownership

**Runtime Integration Boundary**:
The protocol-neutral boundary through which a Local Node starts, observes, interacts with, and cancels Runtime execution. Concrete protocols and Runtime-specific sessions remain replaceable adapter concerns.
_Avoid_: ACP domain model, Workspace protocol, Runtime-specific core interface

**Workspace Interaction Gateway**:
The mediated capability through which a Runtime acts in the Workspace as the current Agent. For persistent messaging it binds calls to Agent identity, Membership, Computer, Runtime Binding revision and Inbox receipt; for explicit task execution it may additionally bind Run/Attempt authority. It may be exposed through CLI, MCP, or another adapter and never trusts identity or permissions supplied by the Runtime.
_Avoid_: Direct Workspace credential, Runtime-owned API, protocol-specific domain interface

**Agent Delegation**:
The explicit creation or assignment by one Agent of a traceable Child WorkItem for another Agent. It may create an Agent Request without per-action Human approval only when both sides' policies, permissions, budgets, concurrency, and delegation bounds allow it.
_Avoid_: Agent Mention, Runtime-to-Runtime call, implicit sub-agent

**Result Submission**:
An immutable candidate outcome for an explicitly managed WorkItem, submitted by its current Agent assignee and referencing already published ordinary Messages and/or stable Artifacts. It has no accepted or rejected state; evaluation belongs to Completion Policy and Review.
_Avoid_: Message subtype, Runtime completion, Review decision

**Current Submission**:
The relationship role held by the sole Result Submission currently eligible to satisfy a WorkItem's Completion Policy. It is not another object or Submission state; a newer Submission replaces the WorkItem's reference without editing or deleting history.
_Avoid_: Best result heuristic, accepted Submission, mutable result

**Completion Policy**:
The current versioned Workspace-governed rule for completing a WorkItem: manual, automatic from its Current Submission, or review-required for that Current Submission. Policy changes apply immediately to a non-terminal WorkItem and completion records the revision actually used; Agent Requests without a WorkItem have no Completion Policy.
_Avoid_: Runtime self-declaration, Message semantics, Submission-bound policy

**Review**:
An explicit evaluation of one Result Submission by one designated Human or Agent. Review has its own pending, accepted, rejected, or cancelled lifecycle; its state never becomes Submission state, and an accepted Review is only one input to WorkItem completion checks.
_Avoid_: Result Submission status, Runtime success, implicit approval, multi-reviewer vote

**Artifact**:
A Workspace-level stable identity for a Markdown collaborative document, uploaded file, or external URL. Markdown/File own one autosaved Current State and zero or more UUID-addressed Artifact Snapshots; URL owns one immutable `http/https` locator and editable description without Workspace-managed content. All types share permissions, lineage, deletion lifecycle, and explicit Project associations. Messages pin either an exact managed-content Snapshot or the URL name, locator, and description at send time.
_Avoid_: Every Project file, arbitrary external locator, version-suffixed filename, staged blob, execution log

**Artifact Snapshot**:
An immutable content snapshot with a stable UUID, content digest, media type, byte length, creator, creation time, and mutable optional display label. Hashes deduplicate content but never replace snapshot identity. Rename, restore, and soft delete preserve the UUID.
_Avoid_: Mutable Current State, visible vN, filename suffix, source badge, Message attachment copy

**Project Artifact Association**:
An explicit relationship making an Artifact available to a Project without copying or changing its Workspace identity. An Artifact may have several such associations, but Projects never co-own it; exact historical references are expressed separately by snapshot UUID.
_Avoid_: Multiple Project ownership, Artifact copy, file-tree membership
