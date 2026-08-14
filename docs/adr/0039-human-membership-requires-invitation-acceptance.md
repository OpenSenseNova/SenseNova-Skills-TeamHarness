# Human Membership requires Invitation acceptance

A Workspace Owner cannot directly create an active Membership for another Human. The Owner creates a durable Workspace Invitation for one normalized verified email; pending grants no access, and only the authenticated Human proving that email can accept it, atomically making it terminal `accepted`, recording stable Human identity, and creating one new active `member` Membership. Owners may revoke pending Invitations, expiry is terminal, and accepted, revoked, or expired Invitations cannot be reused.

This keeps another person's participation and identity binding consensual and auditable while providing revocation, expiry, idempotent acceptance, and safe re-entry. The cost is one explicit Invitation lifecycle instead of treating an email entry or Owner command as Membership.

For one Workspace and normalized email, at most one Invitation may be pending. Repeating the same intent returns that Invitation without extending it; replacement first terminates the old Invitation and creates a new identity, so revocation never leaves another concurrent join capability active for the same target.
