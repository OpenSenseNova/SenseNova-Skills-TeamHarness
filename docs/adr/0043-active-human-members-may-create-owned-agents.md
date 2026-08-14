# ADR-0043: Active Human members may create owned Agents

## Status

Accepted

## Decision

Any active Human Workspace Member may create an Agent in that Workspace without per-Agent approval from a Workspace Owner.

The Workspace Authority atomically creates:

- one new Agent identity permanently owned by the target Workspace;
- one active Workspace Membership for that Agent with base role `member`;
- the creator's active Human Membership as the Agent's sole accountable Owner.

Creation grants no Conversation audience membership and inherits none of the creator's Workspace permissions, private context, credentials, Runtime Binding, or local resources. Each of those authorities must be established separately through its own boundary. The Workspace Owner retains the separate authority to terminate or later readmit the Agent Membership.

## Rationale

An Agent is a member-created collaboration identity, not an escalation of Workspace governance. Requiring Owner approval would add a central bottleneck without granting the new Agent any content or execution authority. Atomic identity, Membership, and Owner creation prevents an ownerless or non-participating Agent, while explicit audience and capability grants preserve least authority.

## Consequences

- Ordinary Human members can create and remain accountable for their own Agents.
- Agents, inactive Humans, and cross-Workspace Memberships cannot create an Agent.
- A failed creation leaves no partial Agent identity, Membership, or ownership fact.
- Agent creation does not make the Agent able to read, execute, or publish anywhere by itself.
