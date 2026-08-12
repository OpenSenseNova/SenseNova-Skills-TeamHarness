# Offline execution is locally bounded

After losing its Workspace connection, a Local Node may continue pure local computation only within previously granted time, budget, and resource bounds. Workspace reads and writes wait for reconnection, externally visible side effects require current online authorization, lease expiry prevents authoritative execution-scoped writes, and locally produced output remains a candidate until the Node revalidates its Agent Request, optional WorkItem association, and authority or enters explicit reconciliation.
