# Agent Messages require a Workspace-bound producing Run

Every Agent-authored Message is associated with exactly one producing Run, and that Run belongs to the same Agent as the Message author. A Human-authored Message has no producing Run. Workspace binds the author and Run from trusted execution authority at commit time; Runtime, Local Node, and clients cannot self-report either as authoritative. The association supports publication authorization and traceability through Run to Attempt, Device, and Runtime, but creates no special Message type and never determines Run outcome.
