# Runtime interacts with Workspace through a mediated gateway

A Runtime may actively query shared context, publish collaboration updates and a final Message, create explicit work, address other Agents, and submit governed WorkItem results while executing a Run, but every operation passes through a Workspace Interaction Gateway bound to the current Agent and execution authority. CLI, MCP, and future mechanisms are adapters to this protocol-neutral capability boundary; the Runtime receives neither long-lived Workspace credentials nor authority to assert its own identity, scope, or permissions.
