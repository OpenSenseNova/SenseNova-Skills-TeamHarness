# Agents may delegate work to other Agents

An authorized Agent may explicitly create or assign a Child WorkItem to another Agent without obtaining Human approval for every delegation. The Workspace must distinguish this action from a conversational Agent Mention, verify the delegator's authority, the recipient's intake policy and Owner delegation, and bounded budget, concurrency, and recursive depth, then create an Agent Request when execution should start; delegation never becomes an implicit mention or direct Runtime-to-Runtime invocation.
