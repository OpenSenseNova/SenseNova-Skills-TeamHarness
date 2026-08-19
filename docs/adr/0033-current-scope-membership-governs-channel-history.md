# Current scope membership governs complete Channel history

A current active member of a Channel's Workspace or Project may read its complete immutable history. Joining the scope grants full-history access; leaving or removal blocks every subsequent read of both old and new content, while authored Messages remain. The Workspace uses neither join/leave visibility windows nor per-Message ACLs.

This preserves Conversation and Thread as complete shared contexts and keeps authorization at the collaboration-scope seam. The trade-off is that adding a Workspace or Project member discloses every Channel history in that scope and must be presented clearly; content already downloaded during legitimate access cannot be recalled after removal.
