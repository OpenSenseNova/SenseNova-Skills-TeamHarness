BEGIN;

CREATE TABLE local_runtime_executions (
  attempt_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt_root TEXT NOT NULL,
  working_directory TEXT NOT NULL,
  execution_kind TEXT NOT NULL CHECK (execution_kind IN ('workspace_scratch', 'project_repository')),
  project_id TEXT,
  repository_id TEXT,
  repository_identity TEXT,
  phase TEXT NOT NULL CHECK (phase IN ('assembling', 'running', 'returning', 'finished', 'failed')),
  started_at INTEGER NOT NULL,
  return_prepared_at INTEGER,
  finished_at INTEGER,
  CHECK (
    (execution_kind = 'workspace_scratch' AND project_id IS NULL AND repository_id IS NULL AND repository_identity IS NULL)
    OR (execution_kind = 'project_repository' AND project_id IS NOT NULL AND repository_id IS NOT NULL AND repository_identity IS NOT NULL)
  )
) STRICT;

CREATE TABLE local_project_working_copies (
  project_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  repository_identity TEXT NOT NULL,
  absolute_path TEXT NOT NULL,
  bound_at INTEGER NOT NULL,
  checked_at INTEGER NOT NULL
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
  attempt_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  content_blob_hash TEXT,
  attachment_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(attachment_refs_json)),
  based_on_workspace_version INTEGER NOT NULL CHECK (based_on_workspace_version >= 0),
  based_on_conversation_version INTEGER NOT NULL CHECK (based_on_conversation_version >= 0),
  rehold_count INTEGER NOT NULL DEFAULT 0 CHECK (rehold_count >= 0),
  status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'returned', 'discarded')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX held_drafts_attempt ON held_drafts(attempt_id, status);

CREATE TABLE runtime_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  adapter_instance_id TEXT NOT NULL,
  runtime_session_id TEXT NOT NULL,
  initial_prompt_sent INTEGER NOT NULL DEFAULT 0 CHECK (initial_prompt_sent IN (0, 1)),
  return_committed INTEGER NOT NULL DEFAULT 0 CHECK (return_committed IN (0, 1)),
  last_seen_position INTEGER NOT NULL DEFAULT 0 CHECK (last_seen_position >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'lost')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (agent_id, adapter_instance_id, runtime_session_id)
) STRICT;

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
