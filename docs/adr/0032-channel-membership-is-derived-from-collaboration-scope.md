# Channel membership is derived from its collaboration scope

Every Channel belongs either to a Workspace or to one Project. A Workspace Channel is readable and writable by every active Workspace Membership. A Project Channel is readable and writable by every active Project Membership whose backing Workspace Membership is active. The Channel stores no participant set and exposes no participant-mutation command; its participant list is a read-only projection of the current scope.

Membership changes therefore apply immediately to every Channel in that scope. A newly admitted member can read complete existing Channel history, removal closes both old and new reads, and rejoining the same Project restores access through the new current Membership. DM is the only fixed-participant Conversation preset and stores exactly two direct Workspace Membership references.
