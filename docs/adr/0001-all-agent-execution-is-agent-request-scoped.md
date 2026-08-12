# All Agent execution is Agent Request-scoped

Every Agent execution belongs to a durable Agent Request that records its trigger, target Agent, result Discussion Scope, and optional WorkItem before a Run begins. A conversational `@Agent`, an explicit WorkItem assignment, an Agent Claim, delegation, and work continuation all enter the same Run and Attempt model through Agent Request; ordinary requests do not create WorkItems, and a Run succeeds only after the Agent commits an explicit final Message to its result Discussion Scope.
