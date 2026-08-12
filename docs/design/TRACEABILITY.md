# Architecture Traceability

This matrix links the numbered invariants in `docs/ARCHITECTURE_V2.md` to their decision records, downstream design topics, and planned observable scenarios. Scenario identifiers are reserved here and become executable specifications in `docs/design/01-core-scenarios.md` during Step 1.

| Invariant | Decision record | Downstream design | Planned acceptance scenario |
|---|---|---|---|
| I-01 Conversation is the sole discussion entity; it has a timeline and optional Threads; Channel and DM are presets | ADR-0005, ADR-0019, ADR-0020 | Conversation & Work; Human Experience | `S-CONVERSATION-INDEPENDENT-01`, `S-CONVERSATION-PRESETS-01`, `S-CONVERSATION-WITHOUT-THREAD-01` |
| I-02 Thread is an optional focused branch, never a mandatory message container or work state | ADR-0005, ADR-0020 | Conversation & Work; Human Experience | `S-THREAD-OPTIONAL-BRANCH-01`, `S-THREAD-NO-WORK-STATE-01` |
| I-03 Every Agent execution has a durable Agent Request; WorkItem is optional | ADR-0001 | Conversation & Work; Execution Model | `S-MENTION-REQUEST-01`, `S-WORK-REQUEST-01` |
| I-04 Agent Mention does not implicitly mutate WorkItem state | ADR-0001, ADR-0017, ADR-0018 | Conversation & Work; Workspace Interface | `S-MENTION-NO-WORKITEM-01`, `S-MENTION-IN-WORK-01` |
| I-05 A successful Run requires a committed Final Message in its result Discussion Scope | ADR-0001 | Execution Model; Runtime Integration | `S-RUN-FINAL-MESSAGE-01`, `S-RUN-MISSING-FINAL-01` |
| I-06 WorkItem is explicit and has source Message plus Primary Discussion Scope | ADR-0018, ADR-0020 | Conversation & Work; Human Experience | `S-WORK-FROM-MESSAGE-01` |
| I-07 Standalone WorkItem creation atomically creates a Conversation, source Message, and WorkItem using the new timeline as its discussion home | ADR-0020 | Conversation & Work; Workspace Interface; Storage & Delivery | `S-WORK-STANDALONE-ATOMIC-01` |
| I-08 WorkItem and Conversation lifecycles and visibility remain separate | ADR-0005, ADR-0020 | Conversation & Work; Authorization; Human Experience | `S-WORK-CONVERSATION-LIFECYCLE-01`, `S-WORK-ASSIGNEE-NO-ACCESS-01` |
| I-09 Direct Assignment and open Claim are distinct WorkItem inputs sharing Agent Request execution | ADR-0017 | Conversation & Work; Execution Model | `S-WORK-DIRECT-ASSIGN-01`, `S-WORK-OPEN-CLAIM-01` |
| I-10 A WorkItem has at most one current assignee | ADR-0013 | Conversation & Work; Storage & Delivery | `S-WORK-SINGLE-ASSIGNEE-01` |
| I-11 Device or Runtime failure does not release Agent Claim | ADR-0002 | Execution Model; Storage & Delivery | `S-CLAIM-SURVIVES-DEVICE-FAILURE-01` |
| I-12 Run target, Agent Claim, and Execution Lease remain distinct | ADR-0002 | Execution Model | `S-CLAIM-RACE-01`, `S-LEASE-FENCING-01` |
| I-13 Agent identity is independent of execution machinery | ADR-0007 | Agent Governance; Runtime Integration | `S-RUNTIME-REPLACEMENT-01` |
| I-14 Every Agent has one active accountable Human Owner | ADR-0004 | Agent Governance | `S-OWNER-ACCOUNTABILITY-01` |
| I-15 Workspace governance, Owner accountability, and Local Custody are distinct | ADR-0003, ADR-0004 | Agent Governance; Threat Model | `S-AUTHORITY-SEPARATION-01` |
| I-16 A Workspace has one logical authority for shared facts | ADR-0012 | Workspace Interface; Storage & Delivery | `S-WORKSPACE-SINGLE-AUTHORITY-01` |
| I-17 Only explicit Child WorkItem creation establishes delegation responsibility | ADR-0009, ADR-0018 | Conversation & Work; Agent Governance | `S-MENTION-VS-DELEGATION-01`, `S-AGENT-DELEGATION-01` |
| I-18 Run Context Snapshot is stable and permission-bounded | ADR-0006 | Context & Privacy; Execution Model | `S-CONTEXT-SNAPSHOT-STABLE-01` |
| I-19 Private context use and disclosure are separately granted | ADR-0011 | Context & Privacy | `S-PRIVATE-CONTEXT-GRANT-01`, `S-PRIVATE-DISCLOSURE-DENIED-01` |
| I-20 Runtime has no independent Workspace authority | ADR-0007, ADR-0008 | Runtime Integration; Workspace Interaction; Authorization | `S-RUNTIME-CANNOT-FORGE-AUTHORITY-01` |
| I-21 Runtime Integration semantics are protocol-neutral | ADR-0015 | Runtime Integration | `S-RUNTIME-ADAPTER-CONTRACT-01` |
| I-22 Runtime Workspace actions pass through the mediated gateway | ADR-0008 | Workspace Interaction; Authorization | `S-GATEWAY-REAUTHORIZATION-01` |
| I-23 Acceptance exists only for explicit governed WorkItems | ADR-0010 | Artifact & Completion; Human Experience | `S-CONVERSATION-NO-ACCEPTANCE-01`, `S-WORK-REVIEW-01` |
| I-24 Workspace governs Artifact lineage, not every content byte | ADR-0016 | Artifact & Completion | `S-EXTERNAL-ARTIFACT-DISAPPEARS-01` |
| I-25 Projection, delivery, and Session failures do not break authoritative correctness | ADR-0001, ADR-0012 | Storage & Delivery; Execution Model | `S-NOTIFICATION-LOSS-01`, `S-LOCAL-RESTART-01` |
| I-26 Offline execution cannot create shared facts or unauthorized side effects | ADR-0014 | Execution Model; Side Effects & Approval | `S-OFFLINE-RECONCILIATION-01` |
| I-27 Shared behavior remains attributable through request and execution, with optional WorkItem | ADR-0004, ADR-0007, ADR-0008, ADR-0012 | Workspace Interface; Storage & Delivery; Threat Model | `S-AUDIT-CHAIN-01` |
| I-28 Final Message publication requires a current Discussion Frontier; stale candidates are held for reconciliation | ADR-0021 | Conversation & Work; Workspace Interface; Execution Model; Storage & Delivery; Human Experience | `S-FINAL-PUBLISH-CONTEXT-ADVANCED-01`, `S-FINAL-PUBLISH-RECONCILE-01`, `S-FINAL-PUBLISH-UNRELATED-SCOPE-01` |
