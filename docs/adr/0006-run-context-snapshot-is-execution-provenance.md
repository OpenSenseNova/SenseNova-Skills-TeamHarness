# Run context snapshot is execution provenance

Each Run records one immutable context snapshot containing its trigger/result scope, Agent Membership, policy, budget, Runtime Binding revision, context versions, and optional Repository identity/base commit. This snapshot is authorization and audit provenance shared by technical Attempt retries; it is not a serialized Runtime Prompt or a copy of Conversation history.

Runtime message context is obtained through the Agent Inbox and `teamctl` message APIs. The Workspace never asks a Runtime to read server-local context files and never pushes mutable Workspace changes into an Attempt manifest.
