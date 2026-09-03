# Exact Discussion freshness closes stale persistent Message publication

Persistent Agent Message publication is independent of Run terminal. Workspace uses one transaction to validate the current Agent, Binding revision, target and receipt, compare the receipt's exact Discussion frontier, and either append the Message plus complete the receipt or return `held` without either effect. A recognized exact retry returns the stored `published` or `held` result before receipt completion is revalidated and creates no duplicate Message, attention claim or audit.

Run terminal may still fence an explicit task-execution publication that deliberately carries that Run's provenance. It does not fence ordinary chat from the Agent's current Persistent Session. The Local Held Draft contract and informed override are specified by ADR-0046.
