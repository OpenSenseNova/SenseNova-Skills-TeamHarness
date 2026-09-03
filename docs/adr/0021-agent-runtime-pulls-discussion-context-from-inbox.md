# Agent Runtime pulls Messages from Inbox

Agent Inbox is the Agent's Message delivery history. Every ordinary Message visible to an Agent creates a silent Inbox Item. Human-Agent direct Messages and structured `@Agent` mentions additionally append a separate wake sequence. A wake carries only Agent identity and wake position; it does not duplicate, acknowledge, or contain Message content.

Workspace, Project, membership, File, Document, and Artifact changes do not create Agent Inbox Items. They remain authoritative records in `workspace_changes` with their frozen recipient audience and are queryable through the Workspace history API. An Agent that must learn about an Artifact receives a Message containing an Artifact reference. This keeps shared change history, Message delivery, and Runtime activation as three separate concerns.

`message check` atomically claims pending deliveries for one Discussion Scope and returns the complete Message delta since the last successfully handled receipt. The attention list contains only direct/mention signals; silent ordinary Messages remain represented in the Discussion payload. A later mention can therefore bring preceding ordinary messages into context without those messages waking the Agent themselves.

Claim receipts are replayable until explicitly completed or fenced by a Runtime Binding revision. New wake-eligible attention arriving while a Runtime is busy is routed to its own Logical Session and is not merged into the current Mention/WorkItem context. No Workspace change starts or prolongs a Logical Session.

Before `message send` or Discussion `return no-output`, Workspace compares the exact Timeline or Thread frontier inside the final transaction. Artifact publication is independent: it uses the Artifact's opaque state hash, Local Computer Held Draft custody, and a resource-level compare-and-set.
