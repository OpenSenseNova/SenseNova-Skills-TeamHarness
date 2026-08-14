# Workspace re-entry never restores Conversation access

Removing a Workspace Member immediately closes all effective Conversation access, cancels affected pending Agent Requests, and fences active Runs while retaining Messages, authorship, and participation history. If the same Human or Agent later rejoins the Workspace, no old Channel or DM access returns: Channels require an explicit new addition and DMs require a new Conversation.

This prevents revoked permissions from surviving as dormant grants. Projection and physical cleanup may converge after the authoritative revocation, but they can never be the security boundary or allow stale access while incomplete.
