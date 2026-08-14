# Human identity spans isolated Workspaces

A Human identity is stable within one product deployment and may create or join multiple Workspaces through an independent Membership in each. Human identity is therefore outside any one Workspace, while Membership, roles, authority, Conversations, Agents, Requests, Runs, and all collaboration data remain Workspace-scoped; client installation does not create a Workspace and independent deployments do not implicitly federate identity.

This supports the normal model of one person owning or joining several teams without weakening Workspace isolation. The trade-off is that every authorization and audit path must bind both the stable Human and the exact Workspace Membership rather than treating either one alone as sufficient authority.
