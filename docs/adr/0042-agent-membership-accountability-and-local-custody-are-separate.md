# Agent Membership, accountability, and Local Custody are separate

Only a current Workspace Owner may terminate or readmit an Agent Workspace Membership or transfer its ownership to another active Human Membership in that Workspace. Agent Owner governs accountability, suspension, and constraints without changing Membership; Agent Host governs only local execution. A Human Membership cannot terminate while it still owns an Agent, although ownership transfers and Human exit/removal may commit atomically.

This prevents a local Host or accountable Human from redefining the Workspace principal set while ensuring every Agent always has a responsible active Human. The trade-off is that permanent Agent participation changes require Workspace Owner governance even when the Agent Owner controls its day-to-day execution.
