# Conversation audience is an explicit member set

Every MVP Conversation records an explicit audience of Workspace Membership references, of which only active references grant current access. A current active Human audience member or current Workspace Owner may explicitly change a Channel audience, while a DM audience is fixed and a different participant set creates another Conversation; owner override is audited and does not itself grant content access. No Conversation dynamically inherits all current Workspace members or grants access by stable actor identity alone.

This makes content disclosure deterministic and auditable instead of allowing Workspace membership changes to silently expose existing history. The trade-off is that a newly joined Workspace member does not automatically enter existing Channels and must be explicitly added; discoverability, if provided, remains separate from content access.
