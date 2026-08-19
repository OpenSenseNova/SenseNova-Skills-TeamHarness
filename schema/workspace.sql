BEGIN;

CREATE TABLE actors (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'agent')),
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE humans (
  actor_id TEXT PRIMARY KEY REFERENCES actors(id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
  verified_email TEXT NOT NULL UNIQUE CHECK (
    verified_email = lower(trim(verified_email))
    AND length(verified_email) BETWEEN 3 AND 320
    AND instr(verified_email, '@') > 1
  ),
  status TEXT NOT NULL DEFAULT 'pending_verification' CHECK (status IN ('pending_verification', 'active', 'disabled')),
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE human_password_credentials (
  human_actor_id TEXT PRIMARY KEY REFERENCES humans(actor_id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE email_verification_challenges (
  id TEXT PRIMARY KEY,
  human_actor_id TEXT NOT NULL REFERENCES humans(actor_id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL CHECK (length(code_hash) = 64),
  attempts_remaining INTEGER NOT NULL DEFAULT 5 CHECK (attempts_remaining BETWEEN 0 AND 5),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX email_verification_challenges_human
  ON email_verification_challenges(human_actor_id, created_at DESC);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  created_by_human_id TEXT NOT NULL REFERENCES humans(actor_id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  context_version INTEGER NOT NULL DEFAULT 0 CHECK (context_version >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE agents (
  actor_id TEXT PRIMARY KEY REFERENCES actors(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  created_by_human_id TEXT NOT NULL REFERENCES humans(actor_id) ON DELETE RESTRICT,
  owner_membership_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  description TEXT,
  lifecycle_status TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_status IN ('active', 'suspended')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE (workspace_id, actor_id),
  FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES workspace_memberships(workspace_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER agents_creator_immutable
BEFORE UPDATE OF created_by_human_id ON agents
BEGIN
  SELECT RAISE(ABORT, 'agent creator is immutable');
END;

CREATE TRIGGER agents_workspace_immutable
BEFORE UPDATE OF workspace_id ON agents
BEGIN
  SELECT RAISE(ABORT, 'agent workspace is immutable');
END;

CREATE TABLE workspace_memberships (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  membership_role TEXT NOT NULL CHECK (membership_role IN ('owner', 'member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  joined_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  removed_at INTEGER,
  CHECK ((status = 'active' AND removed_at IS NULL) OR (status = 'removed' AND removed_at IS NOT NULL)),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, actor_id)
) STRICT;

CREATE UNIQUE INDEX workspace_memberships_one_active_actor
  ON workspace_memberships(workspace_id, actor_id)
  WHERE status = 'active';

CREATE INDEX workspace_memberships_workspace_status
  ON workspace_memberships(workspace_id, status, actor_id);

CREATE TRIGGER workspace_memberships_owner_must_be_human_insert
BEFORE INSERT ON workspace_memberships
WHEN NEW.membership_role = 'owner'
BEGIN
  SELECT CASE WHEN (SELECT actor_type FROM actors WHERE id = NEW.actor_id) <> 'human'
    THEN RAISE(ABORT, 'workspace owner must be human') END;
END;

CREATE TRIGGER workspace_memberships_owner_must_be_human_update
BEFORE UPDATE OF membership_role ON workspace_memberships
WHEN NEW.membership_role = 'owner'
BEGIN
  SELECT CASE WHEN (SELECT actor_type FROM actors WHERE id = NEW.actor_id) <> 'human'
    THEN RAISE(ABORT, 'workspace owner must be human') END;
END;

CREATE TRIGGER workspace_memberships_agent_is_member_insert
BEFORE INSERT ON workspace_memberships
WHEN (SELECT actor_type FROM actors WHERE id = NEW.actor_id) = 'agent'
BEGIN
  SELECT CASE WHEN NEW.membership_role <> 'member'
    THEN RAISE(ABORT, 'agent membership must be member') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM agents
    WHERE actor_id = NEW.actor_id AND workspace_id = NEW.workspace_id
  ) THEN RAISE(ABORT, 'agent membership must belong to its owning workspace') END;
  SELECT CASE WHEN NEW.status = 'active' AND NOT EXISTS (
    SELECT 1 FROM agents
    WHERE actor_id = NEW.actor_id AND workspace_id = NEW.workspace_id
      AND lifecycle_status IN ('active', 'suspended')
  ) THEN RAISE(ABORT, 'active membership requires a live agent') END;
END;

CREATE TRIGGER workspace_memberships_agent_is_member_update
BEFORE UPDATE OF workspace_id, actor_id, membership_role, status ON workspace_memberships
WHEN (SELECT actor_type FROM actors WHERE id = NEW.actor_id) = 'agent'
BEGIN
  SELECT CASE WHEN NEW.membership_role <> 'member'
    THEN RAISE(ABORT, 'agent membership must be member') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM agents
    WHERE actor_id = NEW.actor_id AND workspace_id = NEW.workspace_id
  ) THEN RAISE(ABORT, 'agent membership must belong to its owning workspace') END;
  SELECT CASE WHEN NEW.status = 'active' AND NOT EXISTS (
    SELECT 1 FROM agents
    WHERE actor_id = NEW.actor_id AND workspace_id = NEW.workspace_id
      AND lifecycle_status IN ('active', 'suspended')
  ) THEN RAISE(ABORT, 'active membership requires a live agent') END;
END;

CREATE TRIGGER agents_owner_must_be_active_human_insert
BEFORE INSERT ON agents
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM workspace_memberships m
    JOIN actors a ON a.id = m.actor_id AND a.actor_type = 'human'
    WHERE m.workspace_id = NEW.workspace_id
      AND m.id = NEW.owner_membership_id
      AND m.status = 'active'
  ) THEN RAISE(ABORT, 'agent owner must be an active Human Membership in the same Workspace') END;
END;

CREATE TRIGGER agents_owner_must_be_active_human_update
BEFORE UPDATE OF owner_membership_id ON agents
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM workspace_memberships m
    JOIN actors a ON a.id = m.actor_id AND a.actor_type = 'human'
    WHERE m.workspace_id = NEW.workspace_id
      AND m.id = NEW.owner_membership_id
      AND m.status = 'active'
  ) THEN RAISE(ABORT, 'agent owner must be an active Human Membership in the same Workspace') END;
END;

CREATE TRIGGER workspace_memberships_identity_immutable
BEFORE UPDATE OF workspace_id, actor_id ON workspace_memberships
BEGIN
  SELECT RAISE(ABORT, 'workspace membership identity is immutable');
END;

CREATE TRIGGER workspace_memberships_owned_agents_block_removal
BEFORE UPDATE OF status ON workspace_memberships
WHEN OLD.status = 'active' AND NEW.status = 'removed'
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM agents
    WHERE workspace_id = OLD.workspace_id AND owner_membership_id = OLD.id
  ) THEN RAISE(ABORT, 'Human Membership must transfer all owned Agents before removal') END;
END;

CREATE TRIGGER workspace_memberships_owned_agents_block_delete
BEFORE DELETE ON workspace_memberships
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM agents
    WHERE workspace_id = OLD.workspace_id AND owner_membership_id = OLD.id
  ) THEN RAISE(ABORT, 'Human Membership must transfer all owned Agents before deletion') END;
END;

CREATE TABLE agent_ownership_history (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  owner_membership_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  ended_by_membership_id TEXT,
  CHECK (
    (ended_at IS NULL AND ended_by_membership_id IS NULL)
    OR (ended_at IS NOT NULL AND ended_by_membership_id IS NOT NULL AND ended_at >= started_at)
  ),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, agent_id)
    REFERENCES agents(workspace_id, actor_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES workspace_memberships(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, ended_by_membership_id)
    REFERENCES workspace_memberships(workspace_id, id) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX agent_ownership_history_one_current
  ON agent_ownership_history(workspace_id, agent_id)
  WHERE ended_at IS NULL;

CREATE INDEX agent_ownership_history_owner
  ON agent_ownership_history(workspace_id, owner_membership_id, started_at);

CREATE TRIGGER agent_ownership_history_identity_immutable
BEFORE UPDATE OF workspace_id, agent_id, owner_membership_id, started_at ON agent_ownership_history
BEGIN
  SELECT RAISE(ABORT, 'historical Agent ownership identity is immutable');
END;

CREATE TRIGGER agent_ownership_history_terminal_immutable
BEFORE UPDATE OF ended_at, ended_by_membership_id ON agent_ownership_history
WHEN OLD.ended_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'historical Agent ownership interval is terminal');
END;

CREATE TABLE workspace_documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  current_version INTEGER NOT NULL DEFAULT 1 CHECK (current_version > 0),
  created_by_membership_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES workspace_memberships(workspace_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE workspace_document_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  content_markdown TEXT NOT NULL CHECK (length(content_markdown) BETWEEN 1 AND 1048576),
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  created_by_membership_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, document_id, version),
  FOREIGN KEY (workspace_id, document_id)
    REFERENCES workspace_documents(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES workspace_memberships(workspace_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX workspace_documents_active
  ON workspace_documents(workspace_id, status, updated_at, id);

CREATE TABLE agent_execution_policy_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  max_parallel_attempts INTEGER NOT NULL CHECK (max_parallel_attempts BETWEEN 1 AND 64),
  max_wall_time_ms INTEGER NOT NULL CHECK (max_wall_time_ms BETWEEN 1000 AND 86400000),
  max_context_bytes INTEGER NOT NULL CHECK (max_context_bytes BETWEEN 1024 AND 1073741824),
  max_tool_calls INTEGER NOT NULL CHECK (max_tool_calls BETWEEN 0 AND 100000),
  allowed_context_kinds_json TEXT NOT NULL CHECK (json_valid(allowed_context_kinds_json)),
  private_context_allowed INTEGER NOT NULL CHECK (private_context_allowed IN (0, 1)),
  created_by_membership_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, agent_id, version),
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents(workspace_id, actor_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES workspace_memberships(workspace_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE workspace_invitations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  verified_email TEXT NOT NULL CHECK (
    verified_email = lower(trim(verified_email))
    AND length(verified_email) BETWEEN 3 AND 320
    AND instr(verified_email, '@') > 1
  ),
  membership_role TEXT NOT NULL CHECK (membership_role IN ('owner', 'member')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  invited_by_membership_id TEXT NOT NULL,
  accepted_by_human_id TEXT REFERENCES humans(actor_id) ON DELETE RESTRICT,
  accepted_membership_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  terminal_at INTEGER,
  CHECK (
    (status = 'pending' AND accepted_by_human_id IS NULL AND accepted_membership_id IS NULL AND terminal_at IS NULL)
    OR (status = 'accepted' AND accepted_by_human_id IS NOT NULL AND accepted_membership_id IS NOT NULL AND terminal_at IS NOT NULL)
    OR (status = 'revoked' AND accepted_by_human_id IS NULL AND accepted_membership_id IS NULL AND terminal_at IS NOT NULL)
  ),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, invited_by_membership_id)
    REFERENCES workspace_memberships(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, accepted_membership_id)
    REFERENCES workspace_memberships(workspace_id, id) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX workspace_invitations_one_pending_email
  ON workspace_invitations(workspace_id, verified_email)
  WHERE status = 'pending';

CREATE INDEX workspace_invitations_workspace_status
  ON workspace_invitations(workspace_id, status, created_at, id);
CREATE INDEX workspace_invitations_email_status
  ON workspace_invitations(verified_email, status, created_at, id);

CREATE TRIGGER workspace_memberships_keep_last_owner_update
BEFORE UPDATE OF membership_role, status ON workspace_memberships
WHEN OLD.status = 'active' AND OLD.membership_role = 'owner'
 AND (NEW.status <> 'active' OR NEW.membership_role <> 'owner')
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM workspace_memberships
    WHERE workspace_id = OLD.workspace_id
      AND id <> OLD.id
      AND status = 'active'
      AND membership_role = 'owner'
  ) THEN RAISE(ABORT, 'workspace must retain an active owner') END;
END;

CREATE TRIGGER workspace_memberships_keep_last_owner_delete
BEFORE DELETE ON workspace_memberships
WHEN OLD.status = 'active' AND OLD.membership_role = 'owner'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM workspace_memberships
    WHERE workspace_id = OLD.workspace_id
      AND id <> OLD.id
      AND status = 'active'
      AND membership_role = 'owner'
  ) THEN RAISE(ABORT, 'workspace must retain an active owner') END;
END;

CREATE TABLE content_blobs (
  hash TEXT PRIMARY KEY CHECK (length(hash) = 64),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 0 AND 104857600),
  media_type TEXT NOT NULL CHECK (length(trim(media_type)) BETWEEN 1 AND 200),
  storage_path TEXT NOT NULL CHECK (length(trim(storage_path)) > 0),
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  description TEXT CHECK (description IS NULL OR length(description) <= 3000),
  created_by_membership_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  context_version INTEGER NOT NULL DEFAULT 0 CHECK (context_version >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES workspace_memberships(workspace_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX projects_workspace_created
  ON projects(workspace_id, created_at, id);

CREATE TRIGGER projects_identity_immutable
BEFORE UPDATE OF workspace_id, created_by_membership_id ON projects
BEGIN
  SELECT RAISE(ABORT, 'project workspace and creator are immutable');
END;

CREATE TABLE project_repositories (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  clone_url TEXT NOT NULL CHECK (length(trim(clone_url)) BETWEEN 1 AND 2000),
  repository_identity TEXT NOT NULL CHECK (length(trim(repository_identity)) BETWEEN 3 AND 2000),
  default_branch TEXT NOT NULL CHECK (length(trim(default_branch)) BETWEEN 1 AND 255),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'detached')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  detached_at INTEGER,
  CHECK ((status = 'active' AND detached_at IS NULL) OR (status = 'detached' AND detached_at IS NOT NULL)),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX project_repositories_one_active
  ON project_repositories(workspace_id, project_id) WHERE status = 'active';

CREATE TRIGGER project_repositories_identity_immutable
BEFORE UPDATE OF workspace_id, project_id, clone_url, repository_identity ON project_repositories
BEGIN
  SELECT RAISE(ABORT, 'project repository identity is immutable');
END;

CREATE TABLE project_resource_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  url TEXT NOT NULL CHECK (
    length(trim(url)) BETWEEN 8 AND 4000
    AND (lower(url) LIKE 'http://%' OR lower(url) LIKE 'https://%')
  ),
  description TEXT CHECK (description IS NULL OR length(description) <= 3000),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_membership_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES workspace_memberships(workspace_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX project_resource_links_project
  ON project_resource_links(workspace_id, project_id, created_at, id);

CREATE TABLE project_memberships (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  workspace_membership_id TEXT NOT NULL,
  project_role TEXT NOT NULL CHECK (project_role IN ('manager', 'member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  joined_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  removed_at INTEGER,
  CHECK ((status = 'active' AND removed_at IS NULL) OR (status = 'removed' AND removed_at IS NOT NULL)),
  UNIQUE (workspace_id, project_id, id),
  UNIQUE (workspace_id, project_id, id, workspace_membership_id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, workspace_membership_id)
    REFERENCES workspace_memberships(workspace_id, id) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX project_memberships_one_active_workspace_member
  ON project_memberships(project_id, workspace_membership_id)
  WHERE status = 'active';

CREATE INDEX project_memberships_project_status
  ON project_memberships(workspace_id, project_id, status, joined_at, id);

CREATE INDEX project_memberships_workspace_member_status
  ON project_memberships(workspace_id, workspace_membership_id, status, project_id);

CREATE TRIGGER project_memberships_manager_must_be_human_insert
BEFORE INSERT ON project_memberships
WHEN NEW.project_role = 'manager'
BEGIN
  SELECT CASE WHEN (
    SELECT a.actor_type
    FROM workspace_memberships wm
    JOIN actors a ON a.id = wm.actor_id
    WHERE wm.workspace_id = NEW.workspace_id AND wm.id = NEW.workspace_membership_id
  ) <> 'human' THEN RAISE(ABORT, 'project manager must be human') END;
END;

CREATE TRIGGER project_memberships_manager_must_be_human_update
BEFORE UPDATE OF project_role ON project_memberships
WHEN NEW.project_role = 'manager'
BEGIN
  SELECT CASE WHEN (
    SELECT a.actor_type
    FROM workspace_memberships wm
    JOIN actors a ON a.id = wm.actor_id
    WHERE wm.workspace_id = NEW.workspace_id AND wm.id = NEW.workspace_membership_id
  ) <> 'human' THEN RAISE(ABORT, 'project manager must be human') END;
END;

CREATE TRIGGER project_memberships_require_active_workspace_member_insert
BEFORE INSERT ON project_memberships
WHEN NEW.status = 'active'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM workspace_memberships wm
    WHERE wm.workspace_id = NEW.workspace_id
      AND wm.id = NEW.workspace_membership_id
      AND wm.status = 'active'
  ) THEN RAISE(ABORT, 'active project membership requires an active workspace membership') END;
END;

CREATE TRIGGER project_memberships_require_active_workspace_member_update
BEFORE UPDATE OF status ON project_memberships
WHEN NEW.status = 'active'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM workspace_memberships wm
    WHERE wm.workspace_id = NEW.workspace_id
      AND wm.id = NEW.workspace_membership_id
      AND wm.status = 'active'
  ) THEN RAISE(ABORT, 'active project membership requires an active workspace membership') END;
END;

CREATE TRIGGER project_memberships_identity_immutable
BEFORE UPDATE OF workspace_id, project_id, workspace_membership_id ON project_memberships
BEGIN
  SELECT RAISE(ABORT, 'project membership identity is immutable');
END;

CREATE TRIGGER project_memberships_removed_is_terminal
BEFORE UPDATE OF status ON project_memberships
WHEN OLD.status = 'removed' AND NEW.status <> 'removed'
BEGIN
  SELECT RAISE(ABORT, 'removed project membership is terminal');
END;

CREATE TRIGGER project_memberships_keep_last_manager_update
BEFORE UPDATE OF project_role, status ON project_memberships
WHEN OLD.status = 'active' AND OLD.project_role = 'manager'
 AND (NEW.status <> 'active' OR NEW.project_role <> 'manager')
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM project_memberships
    WHERE project_id = OLD.project_id
      AND id <> OLD.id
      AND status = 'active'
      AND project_role = 'manager'
  ) THEN RAISE(ABORT, 'project must retain an active human manager') END;
END;

CREATE TRIGGER project_memberships_keep_last_manager_delete
BEFORE DELETE ON project_memberships
WHEN OLD.status = 'active' AND OLD.project_role = 'manager'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM project_memberships
    WHERE project_id = OLD.project_id
      AND id <> OLD.id
      AND status = 'active'
      AND project_role = 'manager'
  ) THEN RAISE(ABORT, 'project must retain an active human manager') END;
END;

CREATE TRIGGER workspace_memberships_remove_requires_project_memberships_removed
BEFORE UPDATE OF status ON workspace_memberships
WHEN OLD.status = 'active' AND NEW.status = 'removed'
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM project_memberships pm
    WHERE pm.workspace_id = OLD.workspace_id
      AND pm.workspace_membership_id = OLD.id
      AND pm.status = 'active'
  ) THEN RAISE(ABORT, 'workspace membership cannot be removed while project memberships are active') END;
END;

CREATE TABLE computers (
  id TEXT PRIMARY KEY,
  owner_human_id TEXT NOT NULL REFERENCES humans(actor_id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_seen_at INTEGER,
  runtime_catalog_revision INTEGER NOT NULL DEFAULT 0 CHECK (runtime_catalog_revision >= 0),
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE computer_project_working_copies (
  computer_id TEXT NOT NULL REFERENCES computers(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  availability TEXT NOT NULL CHECK (availability IN ('ready', 'unavailable', 'mismatch')),
  branch TEXT CHECK (branch IS NULL OR length(trim(branch)) BETWEEN 1 AND 255),
  head_commit TEXT CHECK (head_commit IS NULL OR length(head_commit) IN (40, 64)),
  dirty INTEGER CHECK (dirty IS NULL OR dirty IN (0, 1)),
  checked_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (availability = 'ready' AND branch IS NOT NULL AND head_commit IS NOT NULL AND dirty IS NOT NULL)
    OR (availability <> 'ready' AND branch IS NULL AND head_commit IS NULL AND dirty IS NULL)
  ),
  PRIMARY KEY (computer_id, project_id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, project_id, repository_id)
    REFERENCES project_repositories(workspace_id, project_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX computer_project_working_copies_project
  ON computer_project_working_copies(workspace_id, project_id, availability, checked_at);

CREATE TABLE computer_runtime_capabilities (
  computer_id TEXT NOT NULL REFERENCES computers(id) ON DELETE CASCADE,
  runtime_id TEXT NOT NULL CHECK (
    length(runtime_id) BETWEEN 1 AND 80 AND runtime_id NOT GLOB '*[^a-z0-9._-]*'
  ),
  availability TEXT NOT NULL CHECK (availability IN (
    'ready', 'not_installed', 'adapter_missing', 'unauthenticated', 'unhealthy'
  )),
  detected_version TEXT CHECK (detected_version IS NULL OR length(detected_version) BETWEEN 1 AND 120),
  configuration_json TEXT CHECK (configuration_json IS NULL OR json_valid(configuration_json)),
  configuration_digest TEXT CHECK (configuration_digest IS NULL OR length(configuration_digest) = 64),
  skills_json TEXT NOT NULL CHECK (json_valid(skills_json)),
  skills_digest TEXT NOT NULL CHECK (length(skills_digest) = 64),
  unavailable_reason_code TEXT CHECK (unavailable_reason_code IS NULL OR unavailable_reason_code IN (
    'not_installed', 'adapter_missing', 'unauthenticated', 'version_unsupported',
    'runtime_unhealthy', 'capability_probe_failed'
  )),
  unavailable_reason_message TEXT CHECK (
    unavailable_reason_message IS NULL OR length(trim(unavailable_reason_message)) BETWEEN 1 AND 500
  ),
  checked_at INTEGER NOT NULL,
  CHECK (
    (availability = 'ready'
      AND configuration_json IS NOT NULL
      AND configuration_digest IS NOT NULL
      AND unavailable_reason_code IS NULL
      AND unavailable_reason_message IS NULL)
    OR
    (availability <> 'ready'
      AND configuration_json IS NULL
      AND configuration_digest IS NULL
      AND unavailable_reason_code IS NOT NULL
      AND unavailable_reason_message IS NOT NULL)
  ),
  PRIMARY KEY (computer_id, runtime_id)
) STRICT;

CREATE TABLE agent_runtime_bindings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  computer_id TEXT NOT NULL REFERENCES computers(id) ON DELETE RESTRICT,
  runtime_id TEXT NOT NULL CHECK (
    length(runtime_id) BETWEEN 1 AND 80 AND runtime_id NOT GLOB '*[^a-z0-9._-]*'
  ),
  requested_model TEXT CHECK (requested_model IS NULL OR length(trim(requested_model)) BETWEEN 1 AND 200),
  requested_reasoning_effort TEXT CHECK (requested_reasoning_effort IS NULL OR requested_reasoning_effort IN (
    'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'
  )),
  requested_mode TEXT CHECK (requested_mode IS NULL OR length(trim(requested_mode)) BETWEEN 1 AND 120),
  runtime_catalog_revision INTEGER NOT NULL CHECK (runtime_catalog_revision > 0),
  binding_revision INTEGER NOT NULL DEFAULT 1 CHECK (binding_revision > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents(workspace_id, actor_id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, id)
) STRICT;

CREATE UNIQUE INDEX agent_runtime_bindings_one_active
  ON agent_runtime_bindings(workspace_id, agent_id)
  WHERE status = 'active';

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('human', 'computer')),
  human_actor_id TEXT REFERENCES humans(actor_id) ON DELETE CASCADE,
  computer_id TEXT REFERENCES computers(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_used_at INTEGER,
  revoked_at INTEGER,
  CHECK (
    (principal_type = 'human' AND human_actor_id IS NOT NULL AND computer_id IS NULL)
    OR
    (principal_type = 'computer' AND human_actor_id IS NULL AND computer_id IS NOT NULL)
  )
) STRICT;

CREATE INDEX api_tokens_human_status ON api_tokens(human_actor_id, status);
CREATE INDEX api_tokens_computer_status ON api_tokens(computer_id, status);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT,
  conversation_kind TEXT NOT NULL CHECK (conversation_kind IN ('channel', 'dm')),
  title TEXT,
  lifecycle_status TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_status IN ('active', 'archived')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  archived_at INTEGER,
  archived_by_membership_id TEXT,
  created_by_membership_id TEXT NOT NULL,
  created_by_project_membership_id TEXT,
  context_version INTEGER NOT NULL DEFAULT 0 CHECK (context_version >= 0),
  timeline_frontier INTEGER NOT NULL DEFAULT 0 CHECK (timeline_frontier >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (project_id IS NULL AND created_by_project_membership_id IS NULL)
    OR (project_id IS NOT NULL AND created_by_project_membership_id IS NOT NULL)
  ),
  CHECK (
    (lifecycle_status = 'active' AND archived_at IS NULL AND archived_by_membership_id IS NULL)
    OR (lifecycle_status = 'archived' AND archived_at IS NOT NULL AND archived_by_membership_id IS NOT NULL)
  ),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES workspace_memberships(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, archived_by_membership_id)
    REFERENCES workspace_memberships(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, project_id, created_by_project_membership_id, created_by_membership_id)
    REFERENCES project_memberships(workspace_id, project_id, id, workspace_membership_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX conversations_workspace_created
  ON conversations(workspace_id, project_id, lifecycle_status, updated_at DESC, id DESC);
CREATE INDEX conversations_project_created
  ON conversations(workspace_id, project_id, lifecycle_status, updated_at DESC, id DESC);

CREATE TRIGGER conversations_scope_immutable
BEFORE UPDATE OF workspace_id, project_id, created_by_membership_id, created_by_project_membership_id ON conversations
BEGIN
  SELECT RAISE(ABORT, 'conversation scope and creator are immutable');
END;

CREATE TRIGGER conversations_lifecycle_state_insert
BEFORE INSERT ON conversations
WHEN NOT (
  (NEW.lifecycle_status = 'active' AND NEW.archived_at IS NULL AND NEW.archived_by_membership_id IS NULL)
  OR (NEW.lifecycle_status = 'archived' AND NEW.archived_at IS NOT NULL AND NEW.archived_by_membership_id IS NOT NULL)
)
OR (
  NEW.archived_by_membership_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM workspace_memberships membership
    WHERE membership.workspace_id = NEW.workspace_id AND membership.id = NEW.archived_by_membership_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid conversation lifecycle state');
END;

CREATE TRIGGER conversations_lifecycle_state_update
BEFORE UPDATE OF lifecycle_status, archived_at, archived_by_membership_id ON conversations
WHEN NOT (
  (NEW.lifecycle_status = 'active' AND NEW.archived_at IS NULL AND NEW.archived_by_membership_id IS NULL)
  OR (NEW.lifecycle_status = 'archived' AND NEW.archived_at IS NOT NULL AND NEW.archived_by_membership_id IS NOT NULL)
)
OR (
  NEW.archived_by_membership_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM workspace_memberships membership
    WHERE membership.workspace_id = NEW.workspace_id AND membership.id = NEW.archived_by_membership_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid conversation lifecycle state');
END;

CREATE TABLE conversation_direct_memberships (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, conversation_id, membership_id),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, membership_id) REFERENCES workspace_memberships(workspace_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX conversation_direct_by_membership
  ON conversation_direct_memberships(workspace_id, membership_id, conversation_id);

CREATE TRIGGER conversation_direct_requires_workspace_dm
BEFORE INSERT ON conversation_direct_memberships
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.workspace_id = NEW.workspace_id
      AND c.id = NEW.conversation_id
      AND c.project_id IS NULL
      AND c.conversation_kind = 'dm'
  ) THEN RAISE(ABORT, 'direct participants require a Workspace DM') END;
END;

CREATE TRIGGER conversation_direct_identity_immutable
BEFORE UPDATE OF workspace_id, conversation_id, membership_id, joined_at
ON conversation_direct_memberships
BEGIN
  SELECT RAISE(ABORT, 'direct participant identity is immutable');
END;

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  root_message_id TEXT NOT NULL,
  reply_frontier INTEGER NOT NULL DEFAULT 0 CHECK (reply_frontier >= 0),
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, conversation_id, id),
  UNIQUE (workspace_id, conversation_id, root_message_id),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, conversation_id, root_message_id)
    REFERENCES messages(workspace_id, conversation_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX threads_conversation ON threads(workspace_id, conversation_id, created_at, id);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  project_id TEXT,
  thread_id TEXT,
  author_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  author_membership_id TEXT NOT NULL,
  author_project_membership_id TEXT,
  body TEXT NOT NULL CHECK (length(trim(body)) > 0),
  conversation_version INTEGER NOT NULL CHECK (conversation_version > 0),
  scope_position INTEGER NOT NULL CHECK (scope_position > 0),
  producing_run_id TEXT,
  producing_attempt_id TEXT,
  created_at INTEGER NOT NULL,
  CHECK (
    (project_id IS NULL AND author_project_membership_id IS NULL)
    OR (project_id IS NOT NULL AND author_project_membership_id IS NOT NULL)
  ),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, conversation_id, id),
  UNIQUE (workspace_id, conversation_id, conversation_version),
  CHECK (
    (producing_run_id IS NULL AND producing_attempt_id IS NULL)
    OR
    (producing_run_id IS NOT NULL AND producing_attempt_id IS NOT NULL)
  ),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, conversation_id, thread_id)
    REFERENCES threads(workspace_id, conversation_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, author_membership_id, author_actor_id)
    REFERENCES workspace_memberships(workspace_id, id, actor_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, project_id, author_project_membership_id, author_membership_id)
    REFERENCES project_memberships(workspace_id, project_id, id, workspace_membership_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 500),
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('markdown', 'file')),
  current_snapshot_id TEXT,
  created_by_membership_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted', 'purged')),
  deleted_at INTEGER,
  purge_after INTEGER,
  purged_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (status = 'active' AND deleted_at IS NULL AND purge_after IS NULL AND purged_at IS NULL)
    OR (status = 'deleted' AND deleted_at IS NOT NULL AND purge_after IS NOT NULL AND purged_at IS NULL)
    OR (status = 'purged' AND deleted_at IS NOT NULL AND purge_after IS NOT NULL AND purged_at IS NOT NULL
        AND current_snapshot_id IS NULL)
  ),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, current_snapshot_id),
  FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES workspace_memberships(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, id, current_snapshot_id)
    REFERENCES artifact_snapshots(workspace_id, artifact_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX artifacts_workspace_status
  ON artifacts(workspace_id, status, updated_at DESC, id);

CREATE TABLE artifact_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  label TEXT CHECK (label IS NULL OR length(trim(label)) BETWEEN 1 AND 200),
  parent_snapshot_id TEXT,
  blob_hash TEXT,
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  media_type TEXT NOT NULL CHECK (length(trim(media_type)) BETWEEN 1 AND 200),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 0 AND 104857600),
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  created_by_membership_id TEXT NOT NULL,
  producing_run_id TEXT,
  producing_attempt_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
  deleted_at INTEGER,
  purge_after INTEGER,
  content_purged_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (producing_run_id IS NULL AND producing_attempt_id IS NULL)
    OR (producing_run_id IS NOT NULL AND producing_attempt_id IS NOT NULL)
  ),
  CHECK (
    (status = 'active' AND deleted_at IS NULL AND purge_after IS NULL
      AND blob_hash IS NOT NULL AND content_purged_at IS NULL)
    OR (status = 'deleted' AND deleted_at IS NOT NULL AND purge_after IS NOT NULL
      AND ((blob_hash IS NOT NULL AND content_purged_at IS NULL)
        OR (blob_hash IS NULL AND content_purged_at IS NOT NULL)))
  ),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, artifact_id, id),
  FOREIGN KEY (workspace_id, artifact_id) REFERENCES artifacts(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, artifact_id, parent_snapshot_id)
    REFERENCES artifact_snapshots(workspace_id, artifact_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (blob_hash) REFERENCES content_blobs(hash) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by_membership_id, created_by_actor_id)
    REFERENCES workspace_memberships(workspace_id, id, actor_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, producing_attempt_id, producing_run_id)
    REFERENCES attempts(workspace_id, id, run_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX artifact_snapshots_artifact
  ON artifact_snapshots(workspace_id, artifact_id, created_at DESC, id DESC);

CREATE TABLE artifact_drafts (
  workspace_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  base_snapshot_id TEXT,
  yjs_state BLOB NOT NULL,
  draft_revision INTEGER NOT NULL DEFAULT 0 CHECK (draft_revision >= 0),
  updated_by_membership_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, artifact_id),
  FOREIGN KEY (workspace_id, artifact_id) REFERENCES artifacts(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, artifact_id, base_snapshot_id)
    REFERENCES artifact_snapshots(workspace_id, artifact_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, updated_by_membership_id)
    REFERENCES workspace_memberships(workspace_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE artifact_file_states (
  workspace_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  blob_hash TEXT NOT NULL,
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  media_type TEXT NOT NULL CHECK (length(trim(media_type)) BETWEEN 1 AND 200),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 0 AND 104857600),
  current_revision INTEGER NOT NULL DEFAULT 1 CHECK (current_revision > 0),
  updated_by_membership_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, artifact_id),
  FOREIGN KEY (workspace_id, artifact_id) REFERENCES artifacts(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (blob_hash) REFERENCES content_blobs(hash) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, updated_by_membership_id)
    REFERENCES workspace_memberships(workspace_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE artifact_project_associations (
  workspace_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  associated_by_membership_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, artifact_id, project_id),
  FOREIGN KEY (workspace_id, artifact_id) REFERENCES artifacts(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, associated_by_membership_id)
    REFERENCES workspace_memberships(workspace_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX artifact_project_associations_project
  ON artifact_project_associations(workspace_id, project_id, created_at, artifact_id);

CREATE TABLE message_artifact_references (
  workspace_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  reference_order INTEGER NOT NULL CHECK (reference_order >= 0),
  artifact_id TEXT NOT NULL,
  artifact_snapshot_id TEXT NOT NULL,
  artifact_name_snapshot TEXT NOT NULL CHECK (length(trim(artifact_name_snapshot)) BETWEEN 1 AND 500),
  artifact_snapshot_label_snapshot TEXT,
  snapshot_created_at INTEGER NOT NULL,
  media_type_snapshot TEXT NOT NULL,
  content_digest_snapshot TEXT NOT NULL CHECK (length(content_digest_snapshot) = 64),
  byte_length_snapshot INTEGER NOT NULL CHECK (byte_length_snapshot BETWEEN 0 AND 104857600),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, message_id, reference_order),
  UNIQUE (workspace_id, message_id, artifact_snapshot_id),
  FOREIGN KEY (workspace_id, message_id) REFERENCES messages(workspace_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE message_mentions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_type_snapshot TEXT NOT NULL CHECK (actor_type_snapshot IN ('human', 'agent')),
  display_name_snapshot TEXT NOT NULL CHECK (length(trim(display_name_snapshot)) > 0),
  mention_order INTEGER NOT NULL CHECK (mention_order >= 0),
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, message_id, actor_id),
  UNIQUE (workspace_id, message_id, mention_order),
  FOREIGN KEY (workspace_id, message_id) REFERENCES messages(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (actor_id) REFERENCES actors(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX message_mentions_message
  ON message_mentions(workspace_id, message_id, mention_order);

CREATE TABLE staged_blobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  blob_hash TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (length(trim(media_type)) BETWEEN 1 AND 200),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 0 AND 104857600),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, run_id, attempt_id) REFERENCES attempts(workspace_id, run_id, id) ON DELETE CASCADE,
  FOREIGN KEY (blob_hash) REFERENCES content_blobs(hash) ON DELETE RESTRICT
) STRICT;

CREATE INDEX staged_blobs_expiry ON staged_blobs(expires_at);

CREATE TRIGGER messages_match_conversation_scope
BEFORE INSERT ON messages
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.workspace_id = NEW.workspace_id
      AND c.id = NEW.conversation_id
      AND c.project_id IS NEW.project_id
  ) THEN RAISE(ABORT, 'message project must match conversation scope') END;
END;

CREATE UNIQUE INDEX messages_timeline_position
  ON messages(workspace_id, conversation_id, scope_position)
  WHERE thread_id IS NULL;
CREATE UNIQUE INDEX messages_thread_position
  ON messages(workspace_id, conversation_id, thread_id, scope_position)
  WHERE thread_id IS NOT NULL;

CREATE TRIGGER threads_root_must_be_top_level_insert
BEFORE INSERT ON threads
BEGIN
  SELECT CASE WHEN (
    SELECT thread_id FROM messages
    WHERE workspace_id = NEW.workspace_id
      AND conversation_id = NEW.conversation_id
      AND id = NEW.root_message_id
  ) IS NOT NULL THEN RAISE(ABORT, 'thread root message must be top-level') END;
END;

CREATE TRIGGER threads_root_must_be_top_level_update
BEFORE UPDATE OF workspace_id, conversation_id, root_message_id ON threads
BEGIN
  SELECT CASE WHEN (
    SELECT thread_id FROM messages
    WHERE workspace_id = NEW.workspace_id
      AND conversation_id = NEW.conversation_id
      AND id = NEW.root_message_id
  ) IS NOT NULL THEN RAISE(ABORT, 'thread root message must be top-level') END;
END;

CREATE INDEX messages_conversation_version
  ON messages(workspace_id, conversation_id, conversation_version);
CREATE INDEX messages_thread_created
  ON messages(workspace_id, thread_id, created_at, id);

CREATE TABLE agent_mention_outcomes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  target_reference TEXT NOT NULL CHECK (length(trim(target_reference)) > 0),
  target_order INTEGER NOT NULL CHECK (target_order >= 0),
  target_agent_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('requested', 'not_requested')),
  reason_code TEXT CHECK (
    reason_code IS NULL OR reason_code IN (
      'target_not_in_workspace',
      'target_not_in_project',
      'target_not_requestable',
      'target_cannot_access_scope'
    )
  ),
  agent_request_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, message_id, target_reference),
  UNIQUE (workspace_id, message_id, target_order),
  CHECK (
    (outcome = 'requested' AND target_agent_id IS NOT NULL AND reason_code IS NULL AND agent_request_id IS NOT NULL)
    OR
    (outcome = 'not_requested' AND reason_code IS NOT NULL AND agent_request_id IS NULL)
  ),
  FOREIGN KEY (workspace_id, message_id) REFERENCES messages(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, target_agent_id) REFERENCES agents(workspace_id, actor_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, agent_request_id) REFERENCES agent_requests(workspace_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX agent_mention_outcomes_message
  ON agent_mention_outcomes(workspace_id, message_id, target_order);

CREATE TRIGGER agent_mention_outcomes_immutable
BEFORE UPDATE ON agent_mention_outcomes
BEGIN
  SELECT RAISE(ABORT, 'agent mention outcome is immutable');
END;

CREATE TABLE agent_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  mention_outcome_id TEXT NOT NULL,
  target_agent_id TEXT NOT NULL,
  result_conversation_id TEXT NOT NULL,
  result_thread_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  terminal_reason_code TEXT CHECK (
    terminal_reason_code IS NULL OR terminal_reason_code IN (
      'requestor_cancelled',
      'authority_revoked',
      'intake_rejected'
    )
  ),
  terminal_reason_detail TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  terminal_at INTEGER,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, target_agent_id),
  UNIQUE (workspace_id, mention_outcome_id),
  CHECK (
    (status = 'pending' AND terminal_reason_code IS NULL AND terminal_reason_detail IS NULL AND terminal_at IS NULL)
    OR
    (status = 'accepted' AND terminal_reason_code IS NULL AND terminal_reason_detail IS NULL AND terminal_at IS NOT NULL)
    OR
    (status IN ('rejected', 'cancelled') AND terminal_reason_code IS NOT NULL AND terminal_at IS NOT NULL)
  ),
  FOREIGN KEY (workspace_id, mention_outcome_id)
    REFERENCES agent_mention_outcomes(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, target_agent_id) REFERENCES agents(workspace_id, actor_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, result_conversation_id) REFERENCES conversations(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, result_conversation_id, result_thread_id)
    REFERENCES threads(workspace_id, conversation_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX agent_requests_target_status
  ON agent_requests(workspace_id, target_agent_id, status, created_at, id);
CREATE INDEX agent_requests_result_scope
  ON agent_requests(workspace_id, result_conversation_id, result_thread_id, created_at, id);

CREATE TABLE agent_inbox_items (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  attention_kind TEXT NOT NULL CHECK (attention_kind IN ('direct_message', 'mention')),
  message_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  thread_id TEXT,
  agent_request_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'claimed', 'handled')),
  claimed_run_id TEXT,
  claim_receipt TEXT,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  handled_at INTEGER,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, agent_id, sequence),
  UNIQUE (workspace_id, agent_id, message_id),
  UNIQUE (workspace_id, agent_request_id),
  CHECK (
    (state = 'pending' AND claimed_run_id IS NULL AND claim_receipt IS NULL AND claimed_at IS NULL AND handled_at IS NULL)
    OR (state = 'claimed' AND claimed_run_id IS NOT NULL AND claim_receipt IS NOT NULL AND claimed_at IS NOT NULL AND handled_at IS NULL)
    OR (state = 'handled' AND handled_at IS NOT NULL AND (
      (claimed_run_id IS NULL AND claim_receipt IS NULL AND claimed_at IS NULL)
      OR (claimed_run_id IS NOT NULL AND claim_receipt IS NOT NULL AND claimed_at IS NOT NULL)
    ))
  ),
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents(workspace_id, actor_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, message_id) REFERENCES messages(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, conversation_id, thread_id) REFERENCES threads(workspace_id, conversation_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, agent_request_id) REFERENCES agent_requests(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, claimed_run_id) REFERENCES runs(workspace_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX agent_inbox_items_pending
  ON agent_inbox_items(workspace_id, agent_id, state, conversation_id, thread_id, sequence);

CREATE TABLE agent_inbox_claim_receipts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  receipt TEXT NOT NULL CHECK (length(trim(receipt)) BETWEEN 1 AND 500),
  run_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  binding_revision INTEGER NOT NULL CHECK (binding_revision > 0),
  conversation_id TEXT NOT NULL,
  thread_id TEXT,
  from_position INTEGER NOT NULL CHECK (from_position >= 0),
  through_position INTEGER NOT NULL CHECK (through_position >= from_position),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, agent_id, receipt),
  UNIQUE (workspace_id, run_id, receipt),
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents(workspace_id, actor_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, attempt_id, run_id)
    REFERENCES attempts(workspace_id, id, run_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, conversation_id, thread_id)
    REFERENCES threads(workspace_id, conversation_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX agent_inbox_claim_receipts_checkpoint
  ON agent_inbox_claim_receipts(
    workspace_id, agent_id, binding_revision, conversation_id, thread_id, through_position
  );

CREATE TRIGGER agent_requests_match_mention_outcome_insert
BEFORE INSERT ON agent_requests
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM agent_mention_outcomes o
    WHERE o.workspace_id = NEW.workspace_id
      AND o.id = NEW.mention_outcome_id
      AND o.outcome = 'requested'
      AND o.agent_request_id = NEW.id
      AND o.target_agent_id = NEW.target_agent_id
  ) THEN RAISE(ABORT, 'agent request must match its requested mention outcome') END;
END;

CREATE TRIGGER agent_requests_identity_immutable
BEFORE UPDATE OF workspace_id, mention_outcome_id, target_agent_id, result_conversation_id, result_thread_id ON agent_requests
BEGIN
  SELECT RAISE(ABORT, 'agent request trigger, target, and result scope are immutable');
END;

CREATE TRIGGER agent_requests_lifecycle_transition
BEFORE UPDATE OF status, version ON agent_requests
WHEN
  (NEW.status <> OLD.status AND (OLD.status <> 'pending' OR NEW.version <> OLD.version + 1))
  OR
  (NEW.status = OLD.status AND NEW.version <> OLD.version)
BEGIN
  SELECT RAISE(ABORT, 'invalid agent request lifecycle transition');
END;

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_request_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_membership_id TEXT NOT NULL,
  project_id TEXT,
  agent_project_membership_id TEXT,
  binding_id TEXT NOT NULL,
  binding_revision INTEGER NOT NULL CHECK (binding_revision > 0),
  policy_version_id TEXT NOT NULL,
  effective_budget_json TEXT NOT NULL CHECK (json_valid(effective_budget_json)),
  status TEXT NOT NULL CHECK (status IN ('active', 'terminal')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('publish', 'no_output', 'discard', 'cancelled', 'failed')),
  deadline_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  terminal_at INTEGER,
  CHECK (
    (project_id IS NULL AND agent_project_membership_id IS NULL)
    OR (project_id IS NOT NULL AND agent_project_membership_id IS NOT NULL)
  ),
  CHECK ((status = 'active' AND outcome IS NULL AND terminal_at IS NULL)
    OR (status = 'terminal' AND outcome IS NOT NULL AND terminal_at IS NOT NULL)),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, agent_id),
  UNIQUE (workspace_id, id, agent_membership_id),
  UNIQUE (workspace_id, id, agent_id, agent_membership_id),
  UNIQUE (workspace_id, agent_request_id),
  FOREIGN KEY (workspace_id, agent_request_id) REFERENCES agent_requests(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, agent_request_id, agent_id)
    REFERENCES agent_requests(workspace_id, id, target_agent_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents(workspace_id, actor_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, agent_membership_id, agent_id)
    REFERENCES workspace_memberships(workspace_id, id, actor_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, project_id, agent_project_membership_id, agent_membership_id)
    REFERENCES project_memberships(workspace_id, project_id, id, workspace_membership_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, binding_id) REFERENCES agent_runtime_bindings(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, policy_version_id)
    REFERENCES agent_execution_policy_versions(workspace_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER runs_match_result_conversation_scope
BEFORE INSERT ON runs
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM agent_requests ar
    JOIN conversations c
      ON c.workspace_id = ar.workspace_id AND c.id = ar.result_conversation_id
    WHERE ar.workspace_id = NEW.workspace_id
      AND ar.id = NEW.agent_request_id
      AND c.project_id IS NEW.project_id
  ) THEN RAISE(ABORT, 'run project must match result conversation scope') END;
END;

CREATE TABLE run_agent_requests (
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  agent_request_id TEXT NOT NULL,
  request_order INTEGER NOT NULL CHECK (request_order >= 0),
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, run_id, agent_request_id),
  UNIQUE (workspace_id, run_id, request_order),
  UNIQUE (workspace_id, agent_request_id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, agent_request_id) REFERENCES agent_requests(workspace_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  status TEXT NOT NULL CHECK (status IN ('running', 'finished', 'failed', 'cancelled')),
  binding_revision INTEGER NOT NULL CHECK (binding_revision > 0),
  policy_version_id TEXT NOT NULL,
  effective_budget_json TEXT NOT NULL CHECK (json_valid(effective_budget_json)),
  deadline_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  CHECK ((status = 'running' AND finished_at IS NULL) OR (status <> 'running' AND finished_at IS NOT NULL)),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, run_id),
  UNIQUE (workspace_id, run_id, attempt_number),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, policy_version_id)
    REFERENCES agent_execution_policy_versions(workspace_id, id) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX attempts_one_active_per_run
  ON attempts(workspace_id, run_id) WHERE status = 'running';

CREATE TABLE run_context_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  objective TEXT NOT NULL CHECK (length(trim(objective)) > 0),
  trigger_message_id TEXT NOT NULL,
  mention_outcome_id TEXT NOT NULL,
  source_scope_json TEXT NOT NULL CHECK (json_valid(source_scope_json)),
  result_scope_json TEXT NOT NULL CHECK (json_valid(result_scope_json)),
  trigger_frontier_json TEXT NOT NULL CHECK (json_valid(trigger_frontier_json)),
  agent_membership_id TEXT NOT NULL,
  policy_version_id TEXT NOT NULL,
  effective_budget_json TEXT NOT NULL CHECK (json_valid(effective_budget_json)),
  workspace_context_version INTEGER NOT NULL CHECK (workspace_context_version >= 0),
  project_id TEXT,
  project_context_version INTEGER,
  repository_id TEXT,
  repository_identity TEXT,
  repository_base_commit TEXT CHECK (repository_base_commit IS NULL OR length(repository_base_commit) IN (40, 64)),
  conversation_id TEXT NOT NULL,
  conversation_context_version INTEGER NOT NULL CHECK (conversation_context_version >= 0),
  change_cursor INTEGER NOT NULL CHECK (change_cursor >= 0),
  created_at INTEGER NOT NULL,
  CHECK (
    (project_id IS NULL AND project_context_version IS NULL
      AND repository_id IS NULL AND repository_identity IS NULL AND repository_base_commit IS NULL)
    OR (project_id IS NOT NULL AND project_context_version IS NOT NULL AND project_context_version >= 0
      AND ((repository_id IS NULL AND repository_identity IS NULL AND repository_base_commit IS NULL)
        OR (repository_id IS NOT NULL AND repository_identity IS NOT NULL AND repository_base_commit IS NOT NULL)))
  ),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, run_id),
  FOREIGN KEY (workspace_id, run_id, agent_membership_id)
    REFERENCES runs(workspace_id, id, agent_membership_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, trigger_message_id) REFERENCES messages(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, mention_outcome_id)
    REFERENCES agent_mention_outcomes(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, policy_version_id)
    REFERENCES agent_execution_policy_versions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, project_id, repository_id)
    REFERENCES project_repositories(workspace_id, project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations(workspace_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE run_context_sources (
  snapshot_id TEXT NOT NULL REFERENCES run_context_snapshots(id) ON DELETE RESTRICT,
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'message', 'conversation', 'document', 'workspace_memory', 'attachment',
    'artifact', 'decision', 'work_item', 'project', 'change'
  )),
  source_id TEXT NOT NULL,
  source_version TEXT NOT NULL CHECK (length(source_version) > 0),
  source_order INTEGER NOT NULL CHECK (source_order >= 0),
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  PRIMARY KEY (snapshot_id, source_order),
  UNIQUE (snapshot_id, source_kind, source_id, source_version)
) STRICT;

CREATE TABLE private_context_grants (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  granted_by_membership_id TEXT NOT NULL,
  source_category TEXT NOT NULL CHECK (source_category IN ('local_file', 'local_memory', 'local_tool')),
  read_allowed INTEGER NOT NULL CHECK (read_allowed IN (0, 1)),
  disclosure_allowed INTEGER NOT NULL CHECK (disclosure_allowed IN (0, 1)),
  policy_version_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, run_id, id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, granted_by_membership_id)
    REFERENCES workspace_memberships(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, policy_version_id)
    REFERENCES agent_execution_policy_versions(workspace_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX private_context_grants_run_active
  ON private_context_grants(workspace_id, run_id, source_category, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE runtime_context_reads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'message', 'conversation', 'document', 'workspace_memory', 'attachment',
    'artifact', 'decision', 'work_item', 'project', 'change'
  )),
  source_id TEXT NOT NULL,
  source_version TEXT NOT NULL CHECK (length(source_version) > 0),
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  agent_membership_id TEXT NOT NULL,
  private_grant_id TEXT,
  authorization_path TEXT NOT NULL CHECK (authorization_path IN ('snapshot', 'private_grant')),
  purpose TEXT NOT NULL CHECK (length(trim(purpose)) BETWEEN 1 AND 500),
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, attempt_id, run_id)
    REFERENCES attempts(workspace_id, id, run_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, run_id, agent_membership_id)
    REFERENCES runs(workspace_id, id, agent_membership_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, private_grant_id)
    REFERENCES private_context_grants(workspace_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE run_return_records (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('publish', 'no_output', 'discard')),
  publication_results_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(publication_results_json)),
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, run_id),
  UNIQUE (workspace_id, attempt_id),
  FOREIGN KEY (workspace_id, attempt_id, run_id)
    REFERENCES attempts(workspace_id, id, run_id) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER messages_provenance_matches_author
BEFORE INSERT ON messages
BEGIN
  SELECT CASE WHEN (SELECT actor_type FROM actors WHERE id = NEW.author_actor_id) = 'human'
    AND (NEW.producing_run_id IS NOT NULL OR NEW.producing_attempt_id IS NOT NULL)
    THEN RAISE(ABORT, 'human message provenance must be empty') END;
  SELECT CASE WHEN (SELECT actor_type FROM actors WHERE id = NEW.author_actor_id) = 'agent'
    AND (NEW.producing_run_id IS NULL OR NEW.producing_attempt_id IS NULL)
    THEN RAISE(ABORT, 'agent message provenance is required') END;
  SELECT CASE WHEN NEW.producing_run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM runs r
    JOIN attempts a
      ON a.workspace_id = r.workspace_id
      AND a.run_id = r.id
      AND a.id = NEW.producing_attempt_id
    WHERE r.workspace_id = NEW.workspace_id
      AND r.id = NEW.producing_run_id
      AND r.agent_id = NEW.author_actor_id
      AND r.agent_membership_id = NEW.author_membership_id
      AND r.agent_project_membership_id IS NEW.author_project_membership_id
      AND r.status = 'active'
      AND a.status = 'running'
  ) THEN RAISE(ABORT, 'agent message must use the active producing run and attempt') END;
END;

CREATE TRIGGER messages_immutable
BEFORE UPDATE ON messages
BEGIN
  SELECT RAISE(ABORT, 'message content, scope, and provenance are immutable');
END;

CREATE TABLE workspace_changes (
  position INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  workspace_context_version INTEGER,
  project_id TEXT,
  project_context_version INTEGER,
  conversation_id TEXT,
  conversation_context_version INTEGER,
  change_type TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  created_at INTEGER NOT NULL,
  CHECK (
    (project_id IS NULL AND project_context_version IS NULL)
    OR (project_id IS NOT NULL AND project_context_version IS NOT NULL AND project_context_version >= 0)
  ),
  UNIQUE (workspace_id, position),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations(workspace_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX workspace_changes_follow
  ON workspace_changes(workspace_id, position);
CREATE INDEX workspace_changes_conversation_version
  ON workspace_changes(workspace_id, conversation_id, conversation_context_version);
CREATE INDEX workspace_changes_project_version
  ON workspace_changes(workspace_id, project_id, project_context_version);
CREATE INDEX workspace_changes_workspace_version
  ON workspace_changes(workspace_id, workspace_context_version);

CREATE TABLE workspace_change_recipients (
  workspace_id TEXT NOT NULL,
  change_position INTEGER NOT NULL,
  membership_id TEXT NOT NULL,
  PRIMARY KEY (change_position, membership_id),
  FOREIGN KEY (workspace_id, change_position)
    REFERENCES workspace_changes(workspace_id, position) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, membership_id)
    REFERENCES workspace_memberships(workspace_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX workspace_change_recipients_membership
  ON workspace_change_recipients(workspace_id, membership_id, change_position);

CREATE TABLE delivery_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  topic TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  dedupe_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  UNIQUE (workspace_id, topic, dedupe_key)
) STRICT;

CREATE INDEX delivery_jobs_ready
  ON delivery_jobs(state, next_attempt_at, workspace_id);

CREATE TABLE consumer_cursors (
  consumer_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  last_position INTEGER NOT NULL DEFAULT 0 CHECK (last_position >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (consumer_id, workspace_id)
) STRICT;

CREATE TABLE idempotency_records (
  scope_key TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  command_name TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (scope_key, actor_id, command_name, idempotency_key)
) STRICT;

CREATE TABLE audit_events (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL CHECK (seq > 0),
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL CHECK (length(hash) = 64),
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  actor_membership_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, seq),
  FOREIGN KEY (workspace_id, actor_membership_id) REFERENCES workspace_memberships(workspace_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX audit_events_target
  ON audit_events(workspace_id, target_type, target_id, seq);

PRAGMA application_id = 1095648087;
PRAGMA user_version = 1;

COMMIT;
