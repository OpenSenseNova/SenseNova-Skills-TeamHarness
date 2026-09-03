# Workspace Join Links are revocable bearer capabilities

A Workspace Owner shares access through a high-entropy Workspace Join Link rather than selecting another person's registered email. A link targets no Human identity, contains no invitee data, always grants the `member` role, and may be used by multiple authenticated Humans until an Owner revokes it. Each Human must explicitly confirm joining; the Owner still cannot create another Human's active Membership directly.

Every active Human Workspace Member may list and copy active links, while only an Owner may create or revoke them. Shared storage keeps a SHA-256 digest for acceptance lookup and an AES-256-GCM ciphertext protected by a separate data-directory key; Workspace and Link identity are authenticated encryption context. Revocation deletes the ciphertext, and no invitee email is stored. A valid confirmation and a new active Membership commit atomically. Re-entry after removal creates a new Membership tenure, while a Human who is already active simply re-enters the Workspace without creating a duplicate Membership.

Because possession of the URL is the join authority, the product clearly tells Members that anyone with the link can join, makes every link individually revocable by an Owner, and never uses a join link to grant `owner`. Owner promotion remains a separate, audited Membership-governance action.
