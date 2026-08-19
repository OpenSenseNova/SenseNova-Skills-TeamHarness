# ADR-0043: Active Human members may create owned Agents

## Status

Accepted

## Decision

Any active Human Workspace Member may create an Agent in that Workspace without per-Agent approval from a Workspace Owner.

The Workspace Authority atomically creates:

- one new Agent identity permanently owned by the target Workspace;
- one active Workspace Membership for that Agent with base role `member`;
- the creator's active Human Membership as the Agent's sole accountable Owner.

Creation makes the Agent an active Workspace Member, so it immediately participates in Workspace Channels. It does not add the Agent to any Project, fixed DM, private context, credentials, Runtime Binding, or local resource. Each of those authorities must be established separately through its own boundary. The Workspace Owner retains the separate authority to terminate or later readmit the Agent Membership.

## Rationale

An Agent is a member-created collaboration identity, not an escalation of Workspace governance. Requiring Owner approval would add a central bottleneck. Atomic identity, Membership, and Owner creation prevents an ownerless or non-participating Agent, while Project Membership, DM participants and execution capabilities remain separate authority boundaries.

## Consequences

- Ordinary Human members can create and remain accountable for their own Agents.
- Agents, inactive Humans, and cross-Workspace Memberships cannot create an Agent.
- A failed creation leaves no partial Agent identity, Membership, or ownership fact.
- Agent creation grants Workspace Channel participation but no Project, DM, Runtime, credential, or local-computer authority.
