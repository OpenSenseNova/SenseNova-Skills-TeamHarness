# Runtime integration is protocol-neutral

The overall architecture fixes the responsibility of a Runtime Integration Boundary but does not prescribe its concrete protocol. The boundary covers the common execution semantics the Local Node needs, while ACP, CLI, MCP-related integration, and future mechanisms remain replaceable adapters or topic-level decisions; protocol-specific objects and sessions do not enter the Workspace domain model.
