BEGIN;

CREATE TABLE local_runtime_executions (
  attempt_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt_root TEXT NOT NULL,
  working_directory TEXT NOT NULL,
  execution_kind TEXT NOT NULL CHECK (execution_kind IN ('workspace_scratch', 'project_scratch')),
  project_id TEXT,
  phase TEXT NOT NULL CHECK (phase IN ('assembling', 'running', 'returning', 'finished', 'failed')),
  started_at INTEGER NOT NULL,
  return_prepared_at INTEGER,
  finished_at INTEGER,
  CHECK (
    (execution_kind = 'workspace_scratch' AND project_id IS NULL)
    OR (execution_kind = 'project_scratch' AND project_id IS NOT NULL)
  )
) STRICT;

CREATE TABLE local_private_materializations (
  attempt_id TEXT NOT NULL REFERENCES local_runtime_executions(attempt_id) ON DELETE CASCADE,
  grant_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  materialized_at INTEGER NOT NULL,
  PRIMARY KEY (attempt_id, grant_id, relative_path)
) STRICT;

CREATE TABLE runtime_context_events (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES local_runtime_executions(attempt_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'context_usage', 'context_compaction_started', 'context_compaction_completed',
    'context_reloaded', 'context_continuity_unknown'
  )),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX runtime_context_events_attempt
  ON runtime_context_events(attempt_id, created_at, id);

CREATE TABLE wake_hints (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  adapter_instance_id TEXT NOT NULL,
  source_change_position INTEGER NOT NULL CHECK (source_change_position > 0),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'injected')),
  received_at INTEGER NOT NULL,
  injected_at INTEGER,
  UNIQUE (workspace_id, agent_id, adapter_instance_id, source_change_position)
) STRICT;

CREATE INDEX wake_hints_pending
  ON wake_hints(state, received_at);

CREATE TABLE held_drafts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  binding_revision INTEGER NOT NULL CHECK (binding_revision > 0),
  session_kind TEXT NOT NULL DEFAULT 'mention' CHECK (session_kind IN ('mention', 'work_item')),
  session_key TEXT NOT NULL DEFAULT 'legacy' CHECK (length(trim(session_key)) > 0),
  target TEXT NOT NULL,
  receipt TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(trim(body)) > 0),
  body_hash TEXT NOT NULL CHECK (length(body_hash) = 64),
  artifact_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(artifact_ids_json) AND json_type(artifact_ids_json) = 'array'
  ),
  mentioned_actor_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(mentioned_actor_ids_json) AND json_type(mentioned_actor_ids_json) = 'array'
  ),
  work_item_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(work_item_ids_json) AND json_type(work_item_ids_json) = 'array'
  ),
  based_on_position INTEGER NOT NULL CHECK (based_on_position >= 0),
  reviewed_through_position INTEGER NOT NULL CHECK (reviewed_through_position >= based_on_position),
  rehold_count INTEGER NOT NULL DEFAULT 0 CHECK (rehold_count >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'held', 'published', 'discarded', 'fenced')),
  pending_mode TEXT NOT NULL CHECK (pending_mode IN ('check', 'override', 'discard')),
  idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX held_drafts_active_target
  ON held_drafts(workspace_id, agent_id, binding_revision, session_kind, session_key, target)
  WHERE status IN ('pending', 'held');

CREATE INDEX held_drafts_recovery
  ON held_drafts(status, workspace_id, agent_id, binding_revision, updated_at);

CREATE TABLE held_artifact_drafts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  binding_revision INTEGER NOT NULL CHECK (binding_revision > 0),
  session_kind TEXT NOT NULL DEFAULT 'mention' CHECK (session_kind IN ('mention', 'work_item')),
  session_key TEXT NOT NULL DEFAULT 'legacy' CHECK (length(trim(session_key)) > 0),
  draft_key TEXT NOT NULL,
  artifact_id TEXT,
  publication_json TEXT NOT NULL CHECK (
    json_valid(publication_json) AND json_type(publication_json) = 'object'
  ),
  publication_hash TEXT NOT NULL CHECK (length(publication_hash) = 64),
  content_path TEXT,
  expected_latest_version_id TEXT,
  held_current_latest_version_id TEXT,
  proposed_digest TEXT NOT NULL CHECK (length(proposed_digest) = 64),
  rehold_count INTEGER NOT NULL DEFAULT 0 CHECK (rehold_count >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'held', 'published', 'discarded', 'fenced')),
  pending_mode TEXT NOT NULL CHECK (pending_mode IN ('check', 'override', 'discard')),
  idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX held_artifact_drafts_active_key
  ON held_artifact_drafts(workspace_id, agent_id, binding_revision, session_kind, session_key, draft_key)
  WHERE status IN ('pending', 'held');

CREATE INDEX held_artifact_drafts_recovery
  ON held_artifact_drafts(status, workspace_id, agent_id, binding_revision, updated_at);

CREATE TABLE runtime_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  adapter_instance_id TEXT NOT NULL,
  runtime_session_id TEXT NOT NULL,
  session_kind TEXT NOT NULL DEFAULT 'mention' CHECK (session_kind IN ('mention', 'work_item')),
  session_key TEXT NOT NULL DEFAULT 'legacy' CHECK (length(trim(session_key)) > 0),
  context_hash TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000' CHECK (length(context_hash) = 64),
  context_jsonl TEXT NOT NULL DEFAULT '',
  session_target TEXT,
  window_mode TEXT NOT NULL DEFAULT 'isolated' CHECK (window_mode IN ('dm', 'isolated')),
  window_initial_frontier INTEGER NOT NULL DEFAULT 0 CHECK (window_initial_frontier >= 0),
  window_message_count INTEGER NOT NULL DEFAULT 0 CHECK (window_message_count >= 0 AND window_message_count <= 10),
  window_status TEXT NOT NULL DEFAULT 'accepting' CHECK (window_status IN ('accepting', 'frozen', 'completed')),
  initial_prompt_sent INTEGER NOT NULL DEFAULT 0 CHECK (initial_prompt_sent IN (0, 1)),
  return_committed INTEGER NOT NULL DEFAULT 0 CHECK (return_committed IN (0, 1)),
  last_seen_position INTEGER NOT NULL DEFAULT 0 CHECK (last_seen_position >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'lost')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX runtime_sessions_active_lane
  ON runtime_sessions(workspace_id, agent_id, adapter_instance_id, session_kind, session_key)
  WHERE status = 'active';

CREATE TABLE local_receipts (
  id TEXT PRIMARY KEY,
  operation_type TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  wake_enqueued INTEGER NOT NULL DEFAULT 0 CHECK (wake_enqueued IN (0, 1)),
  server_acked INTEGER NOT NULL DEFAULT 0 CHECK (server_acked IN (0, 1)),
  locally_consumed INTEGER NOT NULL DEFAULT 0 CHECK (locally_consumed IN (0, 1)),
  updated_at INTEGER NOT NULL,
  UNIQUE (operation_type, operation_id)
) STRICT;

PRAGMA application_id = 1095648076;
PRAGMA user_version = 1;

COMMIT;
