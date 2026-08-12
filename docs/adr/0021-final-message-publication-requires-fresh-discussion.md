# Final Message publication requires fresh discussion

An Agent publishes a candidate Final Message with the Discussion Frontier it observed for the result Discussion Scope. The Workspace atomically commits the Message and Run success only if that frontier is still current; otherwise it records or returns a Publication Hold with the exact intervening content range, keeps the Run incomplete, and requires explicit reconciliation rather than publishing a context-stale answer or blindly retrying it.
