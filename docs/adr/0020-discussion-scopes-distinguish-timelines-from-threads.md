# Discussion Scopes distinguish timelines from threads

A Conversation owns a top-level Conversation Timeline and may contain optional Threads rooted in top-level Messages; no implicit Thread is created merely to contain Messages. Agent results and WorkItem discussion target a Discussion Scope, which can be either the timeline or one Thread, preserving the product meaning of Thread as an actual focused branch while allowing the implementation to unify message streams internally.
