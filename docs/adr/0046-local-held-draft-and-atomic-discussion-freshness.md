# Local Held Publications with Discussion and Artifact freshness

Persistent Agent Message publication uses exact Discussion freshness. `message send` first stores the candidate body on the Local Computer, then submits its `draftId`, claim receipt, expected Timeline or Thread frontier, and `check | override` mode. Workspace compares and publishes in one transaction. If the frontier advanced, it publishes nothing, extends the receipt, returns the exact delta, and records a body-free `message.freshness_hold` audit. Exact idempotent retries replay an earlier `published` or `held` result before receipt completion is checked.

Message Held Draft custody supports revision, unchanged retry, discard after a current-frontier no-output check, and informed override after at least one hold. Message candidate bodies are not shared Workspace state and have no Run/Attempt provenance.

Artifact publication has an independent resource-level held stage. `artifact read` returns an opaque `stateHash`. An update draft stores the Artifact identity, the state hash observed before editing, the proposed publication hash, and frozen managed bytes. In the publication transaction Workspace compares `baseStateHash` with the current Artifact `stateHash`:

- equal: publish the candidate and return explicit `baseStateHash` / `publishedStateHash` plus the Artifact with the same new `stateHash`;
- different: publish nothing, return `held { draftId, artifactId, baseStateHash, currentStateHash, proposedStateHash }`, and record a content-free `artifact.freshness_hold` audit;
- `override`: require a prior hold for the same Agent, Binding revision, and draft, then publish while recording `artifact.freshness_override`.

After an Artifact hold, Local Computer starts an explicit review turn in the same ACP Session. Unchanged retry requires the Agent to run `artifact read` for the held Artifact first, proving that the returned current state was actually fetched. The Agent may instead revise the candidate with the same `draftId`, discard it without mutating shared state, or knowingly use `--anyway` after a prior hold. Managed bytes and all draft content remain Local Computer data; Workspace stores only idempotency results and metadata-only audits.

Artifact publication is not tied to a Discussion target or Inbox receipt. A successful publication writes the Artifact and `workspace_changes` history with its recipient audience, but does not create an Agent Inbox Item and does not wake any Agent. Cross-Agent handoff uses an ordinary Message with an Artifact reference.

Discussion `return no-output` retains exact frontier comparison and returns `review_required` rather than completing a stale receipt. Agent Restart fences old receipts and both Local Held Draft kinds. Held Draft protects only the final publication window; ordinary Messages do not cancel or steer an in-flight tool call.

The Local Node draft schema is replaced outright without a compatibility migration; development databases at the old baseline must be rebuilt.
