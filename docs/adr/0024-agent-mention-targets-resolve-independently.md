# Agent Mention targets resolve independently

When a Message contains one or more Agent Mentions, the Workspace commits one immutable Mention Outcome per distinct target. A valid target has a `requested` outcome referencing its durable Agent Request; an invalid or unauthorized target has a `not_requested` outcome with one authoritative structured reason. One target's refusal does not block the Message or another target's valid Request, while the atomic Message commit guarantees that no mentioned target is silently omitted. Duplicate mentions of the same Agent share one target outcome.
