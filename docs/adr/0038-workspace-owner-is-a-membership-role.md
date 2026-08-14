# Workspace Owner is a Membership role

Workspace Owner is the highest governance role on an active Human Workspace Membership, not a separate ownership object or permanent creator privilege. Workspace creation atomically creates the creator's owner-bearing Membership; multiple active Human owners are allowed, and leaving, removal, or role changes cannot remove the last one.

This provides an accountable governance root without a unique-owner transfer state machine or a single-person availability risk. Workspace ownership remains distinct from Agent Owner accountability and does not introduce Conversation ownership.

The MVP keeps the base role set closed to exactly `owner | member`: only Human Memberships may be owners, all Agent Memberships are members, and no admin, custom-role, inheritance, or hierarchy model is introduced. A role change retains the same Membership tenure and does not replace scope-specific authorization.

Only a current Workspace Owner may invite a Human, terminate another Human's Membership, or change a Human Membership's base role. An ordinary Human Member may terminate only their own Membership, and no path bypasses last-owner continuity; Agent Membership governance is a separate decision.
