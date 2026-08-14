# Current Conversation audience governs complete history

A member currently in a Conversation audience may read its complete immutable history. Explicitly adding a Channel member grants full-history access, while removal blocks every subsequent Workspace read of both old and new content; authored Messages remain, and DM audience remains fixed. The Workspace uses neither join/leave visibility windows nor per-Message ACLs.

This preserves Conversation and Thread as complete shared contexts and keeps authorization at the Conversation seam. The trade-off is that adding a member discloses all history and must be presented clearly, while content already downloaded during legitimate access cannot be recalled after removal.
