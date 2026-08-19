# Agent Runtime pulls Discussion context from Inbox

The Workspace commits an Agent Inbox Item for a Human message in an Agent DM or an explicit structured `@Agent` mention. Its Computer wake carries only the Agent ID and highest Inbox sequence. Message bodies, history, Workspace changes, file paths, manifests, and context cursors are never embedded in the wake.

The Runtime responds to the lightweight wake by using the Agent-level `teamctl` IPC proxy. `message check` atomically claims the pending attention items for one Discussion Scope and returns the complete scope delta since the last successfully handled receipt. The attention list identifies why the Agent was woken; the discussion payload contains each Message body once. A later explicit mention can therefore bring preceding ordinary Channel messages into context without those messages waking the Agent themselves.

Claim receipts are replayable until the Run becomes terminal. New attention arriving while the Runtime is busy sets a pending wake and is handled at the next safe boundary; it never starts a second parallel Agent process for the same active work. Replies are published immediately as ordinary Conversation Messages through `teamctl message send` with Agent, Run, Attempt, receipt, and Binding revision provenance.
