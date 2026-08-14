# Agent identity is owned by one Workspace

An Agent identity is created by and permanently belongs to exactly one Workspace. It cannot migrate, join, or be shared with another Workspace, and all of its Memberships, Owner relations, permissions, requests, Runs, authorship, and history remain in that Workspace. A similar Agent elsewhere is a new identity; a future reusable template may copy non-authoritative configuration but never authority or history.

This keeps Workspace as the highest collaboration and isolation scope and prevents cross-Workspace conflicts in ownership, authorization, context, and audit. The trade-off is that logically similar assistants in different Workspaces have separate identities and histories.
