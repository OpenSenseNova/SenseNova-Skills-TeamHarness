# AI-Native Collaboration

This context defines the shared language for humans and agents collaborating in a Workspace.

## Language

**Agent**:
A stable non-human Workspace member with its own identity, authorship, accountable Owner, permissions, capabilities, and collaboration history. An Agent is independent of the Runtime currently used to execute it.
_Avoid_: Runtime, model Session, Owner proxy

**Agent Mention**:
An explicit `@` reference to an Agent in a Message. It creates a durable Agent Request addressed to that Agent but does not create, assign, or advance a WorkItem unless the author separately expresses that explicit work-management intent.
_Avoid_: Direct Assignment, passive notification, implicit WorkItem

**Agent Request**:
A durable request for a named Agent to respond or advance explicitly associated work. It records the trigger, target Agent, and result Discussion Scope before execution begins, may be sourced by a Message or a WorkItem action, and may exist without a WorkItem or Run.
_Avoid_: WorkItem, Run, notification

**Direct Assignment**:
The explicit assignment of a WorkItem to a named member. When the assignee is an Agent it may create an Agent Request, but an Agent Mention alone is not Direct Assignment; assignment bypasses the open claim decision but not authorization or intake constraints.
_Avoid_: Agent Mention, Agent Claim, automatic rerouting

**Child WorkItem**:
A distinct WorkItem explicitly created to track a delegated or decomposed outcome related to a parent WorkItem. Mentioning another Agent or asking for conversational input does not implicitly create one.
_Avoid_: Agent Mention, co-assignment, unrelated task

**Conversation**:
A durable discussion with an explicit audience, visibility policy, one Conversation Timeline, and optional Threads. Channel and DM are participation and presentation presets over Conversation rather than separate domain entities; a Conversation may exist without a WorkItem and never carries work ownership or completion state.
_Avoid_: Runtime Session, WorkItem, task queue, Channel entity, DM entity

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
An authored, durable statement published in one Discussion Scope. A top-level Message belongs to a Conversation Timeline; a reply belongs to one Thread; either may trigger an Agent Request, source a WorkItem, or present a Run result without becoming execution or work state.
_Avoid_: Agent Request, Result Submission, task record

**Final Message**:
The Agent-authored Message explicitly linked as a Run's readable result and published to its result Discussion Scope. A Run cannot succeed before this Message is committed, but a Final Message is not a Result Submission or Acceptance.
_Avoid_: Runtime output, Result Submission, hidden final

**Discussion Frontier**:
The stable observed position of one Discussion Scope used to detect whether its context advanced before a candidate Final Message was published. It is scoped to that Conversation Timeline or Thread, not to the whole Conversation.
_Avoid_: Workspace version, Conversation-wide room version, message count

**Publication Hold**:
The authoritative outcome when a candidate Final Message was prepared against an older Discussion Frontier and therefore is not published. The Run remains incomplete until the Agent explicitly reconciles the new content and publishes against a current frontier or reaches another terminal outcome.
_Avoid_: Final Message, transient network error, automatic retry

**Workspace Authority**:
The single logical authority that authenticates and commits shared collaboration facts. Local work and pending changes may continue offline, but messages, task ownership, permissions, and acceptance become shared facts only after this authority commits them.
_Avoid_: Local replica authority, Runtime state, multi-master Workspace

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
The logical execution by a named Agent of one accepted Agent Request under a stable objective, Run Context Snapshot, policy, and budget. A Run may be associated with a WorkItem but never requires one.
_Avoid_: Agent Request, Attempt, Runtime Session, WorkItem

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
The single Human accountable for an Agent's conduct in the Workspace, with authority to suspend the Agent and restrict its capabilities, budget, and local resources. Ownership does not make the Human the author of Agent actions, permit expansion beyond Workspace authority, or permit rewriting history.
_Avoid_: Agent author, Agent Host, Workspace administrator

**Agent Host**:
The team member who supplies a Device on which an Agent's Runtime and local state reside and execute. A Host controls their Device, local resources, credentials, and willingness to continue hosting, but does not own the Agent's shared identity or Workspace authority.
_Avoid_: Agent Owner, Workspace governor

**Local Custody**:
Authority over the Device, private context, credentials, and other local resources used to execute an Agent. Local Custody can restrict or stop local execution but cannot expand or redefine the Agent's Workspace permissions.
_Avoid_: Agent governance, Workspace authorization

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
An Agent's candidate outcome for an explicitly managed WorkItem, referencing its readable result Message and any Artifacts. Ordinary conversational Runs finish with a result Message and do not require a Result Submission.
_Avoid_: Runtime completion, automatic acceptance

**Completion Policy**:
The optional Workspace-governed rule that determines whether a Result Submission completes a WorkItem automatically or requires acceptance by an authorized Human, Agent, or verifier. Agent Requests without a WorkItem have no Completion Policy.
_Avoid_: Mandatory Human review, Runtime self-declaration

**Acceptance**:
An authorized decision that a Result Submission satisfies the WorkItem under its Completion Policy. Rejection continues the same WorkItem through further execution rather than creating unrelated work.
_Avoid_: Runtime success, result upload

**Artifact**:
A stable, versioned result reference with Workspace-governed identity, access, provenance, and relationships to work and execution. Its content may be stored by the Workspace or referenced at a verified version in an external system.
_Avoid_: Unversioned link, mandatory uploaded copy, execution log
