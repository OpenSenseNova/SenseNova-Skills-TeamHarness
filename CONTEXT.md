# AI-Native Collaboration

This context defines the shared language for humans and agents collaborating in a Workspace.

## Current delivery scope

The MVP first establishes the Workspace identity, Membership, Invitation, role, Agent-creation, and governance facts required for authorization, then implements Conversation, Conversation Timeline, Thread, Discussion Scope, immutable Message, Agent Mention Outcome, Agent Request, and the Run/Attempt execution path needed for an Agent to publish ordinary Messages back to the exact source scope. Thread support is required even though an individual Conversation may contain zero Threads.

WorkItem, assignment, claim, delegation, Result Submission, Completion Policy, and Review are accepted vocabulary for a later explicit-work layer. They are not MVP objects, storage structures, commands, projections, or release gates.

## Language

**Human**:
A stable person identity in one product deployment that may create and participate in multiple Workspaces through a distinct Workspace Membership in each. It remains stable when verified email attributes change; installing or running a client does not create another Human identity or itself constitute a Workspace, and independent deployments do not implicitly federate identity.
_Avoid_: Workspace-local user, installation identity, Workspace Membership

**Agent**:
A stable non-human collaboration identity created in exactly one Workspace by an active Human Member and permanently belonging to that Workspace, with its own authorship, accountable Owner, capabilities, and history. Creation atomically establishes its active `member` Membership and makes the creator its sole accountable Owner, but inherits none of the creator's audience, permissions, private context, credentials, Runtime Binding, or local resources. Its current participation and permissions belong to its own Workspace Membership and remain independent of the Runtime; it cannot migrate to or act as the same Agent in another Workspace.
_Avoid_: Runtime, model Session, Owner proxy

**Agent Mention**:
An explicit structured `@` reference to an Agent in a Message. At Message commit, each distinct target independently receives one immutable Agent Mention Outcome: either `requested` with a durable Agent Request, or `not_requested` with a structured reason. It never creates, assigns, or advances a WorkItem unless the author separately expresses that explicit work-management intent.
_Avoid_: Direct Assignment, passive notification, implicit WorkItem

**Agent Mention Outcome**:
The durable per-target result of resolving one Agent Mention when its Message commits: `requested` means the request was legally allowed to exist and references the created Agent Request, while `not_requested` means the request itself could not legally be established and records one authoritative structured reason. Intake waiting, blocking, or rejection after `requested` belongs only to Agent Request and never rewrites the Mention Outcome. A later authority or access change also never upgrades `not_requested` or creates a Request retroactively; a new explicit Agent Mention is required. Every reader of the Message can see whether the target was requested; only a current Workspace Owner or that target Agent's current Owner receives the exact governance reason, while others receive a safe summary projected from the same fact. One target's outcome never prevents the Message or another target's valid Request from being committed, and a failure is never silently omitted.
_Avoid_: Agent Request lifecycle, transient API response, all-or-nothing target batch, duplicate public/private reason facts

**Agent Request**:
A durable, legally established request for a named Agent to respond or advance explicitly associated work. It has exactly one direct trigger—a `requested` Agent Mention Outcome, WorkItem assignment action, or Agent Review designation—plus a target Agent and result Discussion Scope, and may exist without a WorkItem or Run. Temporary execution conditions are derived intake dispositions; an irrecoverable intake refusal becomes `rejected`. Neither outcome changes its trigger back to `not_requested`.
_Avoid_: WorkItem, Run, notification

**Direct Assignment**:
The explicit assignment of a WorkItem to a named member. When the assignee is an Agent it may create an Agent Request, but an Agent Mention alone is not Direct Assignment; assignment bypasses the open claim decision but not authorization or intake constraints.
_Avoid_: Agent Mention, Agent Claim, automatic rerouting

**Child WorkItem**:
A distinct WorkItem explicitly created to track a delegated or decomposed outcome related to a parent WorkItem. Mentioning another Agent or asking for conversational input does not implicitly create one.
_Avoid_: Agent Mention, co-assignment, unrelated task

**Conversation**:
A durable discussion with one Conversation Audience, a visibility policy, one Conversation Timeline, and optional Threads; it may exist without a WorkItem and never carries work ownership or completion state. Channel and DM are participation presets, creator is provenance rather than Owner or Administrator, and an Agent may speak only inside currently authorized Discussion Scopes.
_Avoid_: Runtime Session, WorkItem, task queue, Channel entity, DM entity, Conversation Owner, Conversation Administrator

**Conversation Audience**:
The explicit set of Workspace Membership references governing access to one Conversation and its complete immutable history; only referenced active Memberships have current access. A Channel's current active Human audience members and Workspace Owners may explicitly change its references, while a DM's references are fixed; Workspace ownership alone does not grant content access, authored Messages survive access loss, and a later Membership never inherits an old reference.
_Avoid_: Dynamic Workspace audience, Message ACL, historical access window, membership epoch

**Conversation Timeline**:
The top-level sequence of Messages in a Conversation. It is a Discussion Scope in its own right rather than an implicit or default Thread.
_Avoid_: Main Thread, default Thread, root Thread

**Thread**:
An optional focused branch rooted in a Message from a Conversation Timeline and containing its replies. It inherits the Conversation's audience and visibility and does not carry assignment, execution, or completion state.
_Avoid_: Conversation Timeline, mandatory message container, WorkItem, task state

**Discussion Scope**:
The exact message stream in which context is read and Messages are published: either a Conversation Timeline or one Thread. It is a location value, not another discussion container or lifecycle entity.
_Avoid_: Conversation, Message stream entity, implicit Thread

**Message**:
An authored, immutable statement published in one Discussion Scope. A top-level Message belongs to a Conversation Timeline and a reply belongs to one Thread. Every Agent-authored Message is produced by exactly one Run for that same Agent; a Human-authored Message has no producing Run. This provenance proves execution authority and attribution but never makes Message into execution, work, submission, or review state.
_Avoid_: Final Message, Run Result Message, Agent Request, Result Submission, task record

**Discussion Frontier**:
The stable observed position of one Discussion Scope used to detect whether its context advanced before an Agent publishes a candidate Message. It is scoped to that Conversation Timeline or Thread, not to the whole Conversation.
_Avoid_: Workspace version, Conversation-wide room version, message count

**Freshness Review**:
The required Agent decision when its candidate Message was prepared against an older Discussion Frontier. The Workspace withholds the first publication and supplies the intervening Messages, but does not decide whether the candidate is semantically stale or prevent an informed Agent from later publishing it.
_Avoid_: Publication Hold, content rejection, automatic retry, Run failure

**Held Draft**:
An unpublished Agent candidate retained locally after a Freshness Review is required. It is not a Message or shared Workspace fact, does not advance a Discussion Frontier, and may be revised, discarded, retried unchanged, or explicitly published after informed review.
_Avoid_: Message, Final Message, Result Submission, shared draft

**Workspace**:
A single team's highest shared collaboration, authorization, and data-isolation context, containing Workspace-level collaboration and optional Projects. One deployment may contain multiple isolated Workspaces, and one Human may create or join several without merging their authority or data; the current product has no separate Organization domain entity.
_Avoid_: Organization, Customer Account, Project

**Workspace Invitation**:
A durable, Workspace-scoped offer created by a current Workspace Owner for the Human who proves control of one normalized verified email to join as `member`. At most one Invitation is `pending` for the same Workspace and normalized email; while pending neither it nor its link grants Membership or access, and only an authenticated Human with that verified email may accept it, atomically producing its terminal `accepted` state, one new active Membership, and an immutable accepted Human reference. `revoked` and `expired` are the other terminal states, after which a new Invitation may be created.
_Avoid_: Workspace Membership, direct member creation, access grant, owner offer

**Workspace Membership**:
One durable, continuous participation of a Human or Agent identity in exactly one Workspace, carrying exactly one current MVP base role: `owner` or `member`. Only an active Human Membership may be `owner`; Agent Memberships are always `member`. At most one Membership is active for the same actor in the same Workspace; removal is terminal, later re-entry to that Workspace creates a new Membership, and shared actions retain both stable actor and membership-at-time. A Human may simultaneously hold active Memberships in different Workspaces, while an Agent's Memberships are confined to its owning Workspace.
_Avoid_: Member identity, reusable membership, permission generation, reactivated membership

**Workspace Owner**:
The highest Workspace governance role, held by one or more active Human Workspace Memberships rather than by a separate ownership object. Workspace creation gives the creator's Membership this role, and a Workspace must always retain at least one active Workspace Owner. Only a current Workspace Owner may govern Human Memberships and roles, terminate or readmit an Agent Membership, or transfer Agent ownership; an Owner may also recover a Channel audience without thereby receiving content access, while DM audiences remain fixed.
_Avoid_: Agent Owner, Workspace Admin, permanent creator privilege, WorkspaceOwner object

**Workspace Authority**:
The single logical authority that authenticates and commits shared collaboration facts. Local work and pending changes may continue offline, but Messages, WorkItem responsibility, permissions, Submissions, and Reviews become shared facts only after this authority commits them.
_Avoid_: Local replica authority, Runtime state, multi-master Workspace

**Project**:
An optional Workspace collaboration and context grouping for a related body of work, with its own participation and shared resources. A Conversation or WorkItem may be associated with at most one Project or remain Workspace-level, and Project association never merges their lifecycles.
_Avoid_: Workspace, mandatory parent, folder label

**Project Participation**:
A Human's or Agent's role-bearing access to a Project. It is required but not sufficient for access to a private Project Conversation and does not by itself grant an Agent permission to execute every Project-bound capability.
_Avoid_: Workspace Membership, Conversation audience, Agent execution grant

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
The logical execution by a named Agent of one accepted Agent Request under a stable objective, Run Context Snapshot, policy, and budget. Its outcome is reported by the execution layer independently of any Messages, WorkItem state, Result Submission, or Review. A terminal Run has no authority to publish a new shared Message; a recognized retry of a Message publication already committed before terminal returns that prior result and is not a new publication.
_Avoid_: Agent Request, Attempt, Runtime Session, WorkItem, conversation response

**Attempt**:
One concrete execution of a Run by a Device through a Runtime. Technical retry creates another Attempt for the same Run rather than another Agent Request or WorkItem.
_Avoid_: Run, Agent Claim, WorkItem retry

**Run Context Snapshot**:
The stable set of shared context selected for an Agent Request's Run: the trigger source, preceding visible content and Discussion Frontier of its Discussion Scope, and explicitly referenced shared resources or WorkItem. Later conversation changes do not silently alter the snapshot, and explicit publication reconciliation does not rewrite it.
_Avoid_: Full Conversation, live context, Runtime context

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

**Agent Owner**:
The single active Human Workspace Member accountable for an Agent's conduct, with authority to suspend or resume the Agent and restrict its capabilities, budget, and local resources. Ownership does not make the Human the author of Agent actions, grant authority over the Agent's Workspace Membership, permit expansion beyond Workspace authority, or permit rewriting history; the Human Membership cannot terminate until ownership is transferred.
_Avoid_: Agent author, Agent Host, Workspace administrator

**Agent Host**:
The team member who supplies a Device on which an Agent's Runtime and local state reside and execute. A Host controls their Device, local resources, credentials, and willingness to continue hosting, but cannot change the Agent's shared identity, Workspace Membership, accountability, or Workspace authority.
_Avoid_: Agent Owner, Workspace governor

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
The mediated capability through which a Runtime acts in the Workspace as the current Agent while executing a Run. It may be exposed through CLI, MCP, or another adapter, but it always binds calls to server-verified Agent and execution authority rather than trusting identity or permissions supplied by the Runtime.
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
A stable, versioned result produced or registered by a Human or Agent for delivery, acceptance, or reuse, with Workspace-governed identity, access, provenance, and relationships to WorkItems and execution. Its content may be stored by the Workspace or referenced at a verified version in an external system.
_Avoid_: Every Project file, ordinary working document, unversioned link, execution log

**Project Artifact Association**:
An explicit relationship making an Artifact or exact Artifact version available to a Project without copying or changing its Workspace identity, provenance, or origin. An Artifact may have several such associations, but Projects never co-own it.
_Avoid_: Multiple Project ownership, Artifact copy, file-tree membership
