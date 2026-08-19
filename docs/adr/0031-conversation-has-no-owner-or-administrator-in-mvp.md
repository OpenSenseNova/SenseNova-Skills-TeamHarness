# Conversation has no Owner or Administrator in the MVP

Conversation creator is immutable audit provenance, not a durable Owner or Administrator. A Channel has no participant-governance state: its participants and access are the active Memberships of its Workspace or Project. DM participants are fixed and a different participant pair creates a new Conversation. The MVP therefore has no Conversation ownership, administrator membership, participant mutation, transfer, recovery, or orphan lifecycle.

This keeps the collaboration scope as the single authority and avoids parallel permission states whose conflicts would require precedence rules. The trade-off is that the MVP cannot make a Channel private to a subset of its scope; that requires a future explicit scope or ACL model rather than Conversation-local members.
