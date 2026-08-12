# Workspace has one logical authority

Each Workspace has one logical authority for shared Messages, Agent Requests, Final Messages, optional WorkItem state, Agent Claims, permissions, audit, and optional Acceptance. Human clients and Local Nodes submit authenticated, idempotent changes to that authority; offline execution may retain local progress and candidate results but cannot create shared facts until they are committed. Deployment may later use multiple service nodes without introducing multi-master domain semantics or CRDT merging for ownership, authorization, and lifecycle state.
