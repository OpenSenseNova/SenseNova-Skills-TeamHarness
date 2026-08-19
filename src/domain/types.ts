export type ActorType = 'human' | 'agent';
export type MembershipRole = 'owner' | 'member';
export type ProjectRole = 'manager' | 'member';
export type ConversationKind = 'channel' | 'dm';
export type ConversationLifecycleStatus = 'active' | 'archived';
export type AgentMentionOutcomeStatus = 'requested' | 'not_requested';
export type ContextSourceKind =
  | 'message'
  | 'conversation'
  | 'document'
  | 'workspace_memory'
  | 'attachment'
  | 'artifact'
  | 'decision'
  | 'work_item'
  | 'project'
  | 'change';
export type DeliveryClass = 'runtime_invariant' | 'reloadable' | 'turn_only';
export type ContinuityClass = 'immutable' | 'reloadable' | 'ephemeral';
export type ReturnDisposition = 'publish' | 'no_output' | 'discard';
export type RuntimeId = string;
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type RuntimeAvailability =
  | 'ready'
  | 'not_installed'
  | 'adapter_missing'
  | 'unauthenticated'
  | 'unhealthy';
export type RuntimeConfigurationStatus =
  | 'valid'
  | 'computer_offline'
  | 'runtime_unavailable'
  | 'selection_unavailable';
export type RuntimeConfigurationValueSource = 'explicit' | 'runtime_default' | 'unavailable';
export type RuntimeConfigurationIssueCode =
  | 'computer_offline'
  | 'runtime_not_installed'
  | 'runtime_adapter_missing'
  | 'runtime_unauthenticated'
  | 'runtime_version_unsupported'
  | 'runtime_capability_probe_failed'
  | 'runtime_unhealthy'
  | 'runtime_configuration_unavailable'
  | 'runtime_model_unavailable'
  | 'runtime_reasoning_effort_unavailable'
  | 'runtime_mode_unavailable'
  | 'runtime_configuration_combination_unsupported';
export type MentionNotRequestedReason =
  | 'target_not_in_workspace'
  | 'target_not_in_project'
  | 'target_not_requestable'
  | 'target_cannot_access_scope';
export type AgentRequestStatus = 'pending' | 'accepted' | 'rejected' | 'cancelled';
export type AgentRequestTerminalReason = 'requestor_cancelled' | 'authority_revoked' | 'intake_rejected';

export interface HumanPrincipal {
  kind: 'human';
  actorId: string;
}

export interface ComputerPrincipal {
  kind: 'computer';
  computerId: string;
  ownerHumanId: string;
}

export type Principal = HumanPrincipal | ComputerPrincipal;

export interface WorkspaceView {
  id: string;
  name: string;
  revision: number;
  contextVersion: number;
  membershipId: string;
  membershipRole: MembershipRole;
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceBootstrapView {
  workspace: WorkspaceView;
  changeCursor: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface WorkspaceMemberView {
  membershipId: string;
  actorId: string;
  actorType: ActorType;
  displayName: string;
  membershipRole: MembershipRole;
  revision: number;
  joinedAt: number;
}

export interface ProjectView {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  revision: number;
  contextVersion: number;
  membershipId: string | null;
  role: ProjectRole | null;
  governanceOnly: boolean;
  activeMemberCount: number;
  conversationCount: number;
  repository: ProjectRepositoryView | null;
  connectedComputerCount: number;
  readyComputerCount: number;
  workingCopySummary: 'connected' | 'not_connected' | 'mismatch' | 'computer_offline';
  createdByMembershipId: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectRepositoryView {
  id: string;
  cloneUrl: string;
  repositoryIdentity: string;
  defaultBranch: string;
  revision: number;
}

export interface ProjectResourceLinkView {
  id: string;
  projectId: string;
  title: string;
  url: string;
  description: string | null;
  revision: number;
  createdByMembershipId: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectWorkingCopyView {
  computerId: string;
  computerName: string;
  connectionStatus: 'online' | 'offline';
  availability: 'ready' | 'unavailable' | 'mismatch';
  branch: string | null;
  headCommit: string | null;
  dirty: boolean | null;
  checkedAt: number;
}

export interface ProjectWorkingCopyReport {
  repositoryId: string;
  repositoryIdentity: string;
  availability: ProjectWorkingCopyView['availability'];
  branch: string | null;
  headCommit: string | null;
  dirty: boolean | null;
}

export interface ProjectMemberView {
  projectMembershipId: string;
  workspaceMembershipId: string;
  actorId: string;
  actorType: ActorType;
  displayName: string;
  role: ProjectRole;
  revision: number;
  joinedAt: number;
}

export interface ProjectGovernanceView {
  id: string;
  workspaceId: string;
  name: string;
  revision: number;
  activeMemberCount: number;
  conversationCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceInvitationView {
  id: string;
  workspaceId: string;
  verifiedEmail: string;
  membershipRole: MembershipRole;
  status: 'pending' | 'accepted' | 'revoked';
  revision: number;
  invitedByMembershipId: string;
  acceptedMembershipId: string | null;
  createdAt: number;
  updatedAt: number;
  terminalAt: number | null;
}

export interface AgentView {
  id: string;
  workspaceId: string;
  createdByHumanId: string;
  ownerMembershipId: string;
  ownerHumanId: string;
  ownerDisplayName: string;
  name: string;
  description: string | null;
  lifecycleStatus: 'active' | 'suspended';
  revision: number;
  membershipId: string;
  membershipStatus: 'active' | 'removed';
  executionPolicyVersion: number;
  runtimeBinding: RuntimeBindingView | null;
  createdAt: number;
  updatedAt: number;
}

export interface ComputerView {
  id: string;
  name: string;
  status: 'active' | 'disabled';
  connectionStatus: 'online' | 'offline';
  lastSeenAt: number | null;
  runtimeCatalogRevision: number;
  runtimes: RuntimeCapabilityView[];
  createdAt: number;
}

export interface RuntimeCapabilityView {
  runtimeId: RuntimeId;
  label: string;
  availability: RuntimeAvailability;
  detectedVersion: string | null;
  configuration: RuntimeConfigurationCapabilities | null;
  skills: RuntimeSkillCatalog;
  unavailableReason: RuntimeCapabilityUnavailableReason | null;
  checkedAt: number;
}

export interface RuntimeCapabilityReport {
  runtimeId: RuntimeId;
  availability: RuntimeAvailability;
  detectedVersion?: string;
  configuration?: RuntimeConfigurationCapabilities;
  skills: RuntimeSkillCatalog;
  unavailableReason?: RuntimeCapabilityUnavailableReason;
}

export interface RuntimeSkillSummary {
  id: string;
  name: string;
  displayName: string;
  description: string;
  source: string;
  scope: 'global' | 'workspace';
  installed: boolean;
  enabled: boolean;
  runtimeCompatible: boolean;
  version: string | null;
  revision: string;
  userInvocable: boolean;
  unavailableReason: { code: string; message: string } | null;
}

export interface RuntimeSkillCatalog {
  global: RuntimeSkillSummary[];
  workspace: RuntimeSkillSummary[];
}

export interface AgentRuntimeSkillsView {
  agentId: string;
  computerId: string;
  runtimeId: RuntimeId;
  runtimeAvailability: RuntimeAvailability;
  bindingRevision: number;
  runtimeCatalogRevision: number;
  items: RuntimeSkillSummary[];
}

export interface RuntimeConfigurationOption {
  id: string;
  label: string;
  description: string | null;
}

export interface RuntimeModelOption extends RuntimeConfigurationOption {
  supportedReasoningEfforts: ReasoningEffort[] | null;
}

export interface RuntimeConfigurationCapabilities {
  models: RuntimeModelOption[];
  defaultModelId: string | null;
  reasoningEfforts: RuntimeConfigurationOption[];
  defaultReasoningEffort: ReasoningEffort | null;
  modes: RuntimeConfigurationOption[];
  defaultModeId: string | null;
}

export interface RuntimeCapabilityUnavailableReason {
  code:
    | 'not_installed'
    | 'adapter_missing'
    | 'unauthenticated'
    | 'version_unsupported'
    | 'runtime_unhealthy'
    | 'capability_probe_failed';
  message: string;
}

export interface RuntimeConfigurationSelection {
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  mode: string | null;
}

export interface EffectiveRuntimeConfigurationValue<T extends string> {
  value: T | null;
  source: RuntimeConfigurationValueSource;
}

export interface RuntimeConfigurationState {
  requested: RuntimeConfigurationSelection;
  effective: {
    model: EffectiveRuntimeConfigurationValue<string>;
    reasoningEffort: EffectiveRuntimeConfigurationValue<ReasoningEffort>;
    mode: EffectiveRuntimeConfigurationValue<string>;
  };
  status: RuntimeConfigurationStatus;
  invalidReason: { code: RuntimeConfigurationIssueCode; message: string } | null;
}

export interface RuntimeBindingView {
  id: string;
  workspaceId: string;
  agentId: string;
  computerId: string;
  computerName: string;
  computerConnectionStatus: 'online' | 'offline';
  runtimeId: RuntimeId;
  runtimeAvailability: RuntimeAvailability;
  detectedVersion: string | null;
  validatedRuntimeCatalogRevision: number;
  runtimeCatalogRevision: number;
  configuration: RuntimeConfigurationState;
  bindingRevision: number;
  createdAt: number;
}

export interface ConversationView {
  id: string;
  workspaceId: string;
  projectId: string | null;
  kind: ConversationKind;
  title: string | null;
  lifecycleStatus: ConversationLifecycleStatus;
  revision: number;
  archivedAt: number | null;
  archivedByMembershipId: string | null;
  contextVersion: number;
  timelineFrontier: number;
  createdByMembershipId: string;
  createdByProjectMembershipId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MessageView {
  id: string;
  workspaceId: string;
  conversationId: string;
  projectId: string | null;
  threadId: string | null;
  threadRootMessageId: string | null;
  authorActorId: string;
  authorMembershipId: string;
  authorProjectMembershipId: string | null;
  authorActorType: ActorType;
  authorDisplayName: string;
  authorDeleted: boolean;
  body: string;
  conversationVersion: number;
  scopePosition: number;
  producingRunId: string | null;
  producingAttemptId: string | null;
  mentions: MessageMentionView[];
  mentionOutcomes: AgentMentionOutcomeView[];
  artifactReferences: MessageArtifactReferenceView[];
  createdAt: number;
}

export type ArtifactType = 'markdown' | 'file';
export type ArtifactStatus = 'active' | 'deleted' | 'purged';

export interface ArtifactSnapshotView {
  snapshotId: string;
  artifactId: string;
  label: string | null;
  parentSnapshotId: string | null;
  contentDigest: string;
  mediaType: string;
  byteLength: number;
  createdByActorId: string;
  createdByMembershipId: string;
  createdByDisplayName: string;
  revision: number;
  status: 'active' | 'deleted';
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ArtifactDraftView {
  artifactId: string;
  baseVersionId: string | null;
  draftRevision: number;
  updatedByMembershipId: string;
  updatedAt: number;
}

export interface ArtifactCurrentStateView {
  artifactId: string;
  currentRevision: number;
  contentDigest: string;
  mediaType: string;
  byteLength: number;
  updatedByMembershipId: string;
  updatedAt: number;
}

export interface ArtifactSnapshotSaveView {
  artifact: ArtifactView;
  snapshot: ArtifactSnapshotView;
  created: boolean;
  labelChanged: boolean;
}

export interface ArtifactView {
  id: string;
  workspaceId: string;
  name: string;
  artifactType: ArtifactType;
  currentState: ArtifactCurrentStateView;
  latestSnapshot: ArtifactSnapshotView | null;
  projectIds: string[];
  createdByMembershipId: string;
  revision: number;
  status: ArtifactStatus;
  deletedAt: number | null;
  purgeAfter: number | null;
  purgedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface MessageArtifactReferenceView {
  artifactId: string;
  artifactSnapshotId: string;
  artifactName: string;
  snapshotLabel: string | null;
  snapshotCreatedAt: number;
  mediaType: string;
  contentDigest: string;
  byteLength: number;
  contentAvailable: boolean;
}

export interface MessageMentionView {
  actorId: string;
  actorType: ActorType;
  displayName: string;
}

export interface StagedBlobView {
  id: string;
  workspaceId: string;
  runId: string;
  attemptId: string;
  contentDigest: string;
  mediaType: string;
  byteLength: number;
  expiresAt: number;
}

export interface AgentMentionOutcomeView {
  id: string;
  targetReference: string;
  targetAgentId: string | null;
  outcome: AgentMentionOutcomeStatus;
  agentRequestId: string | null;
  reason: {
    code: MentionNotRequestedReason | 'target_unavailable';
    visibility: 'exact' | 'summary';
  } | null;
}

export interface AgentRequestView {
  id: string;
  workspaceId: string;
  sourceMessageId: string;
  targetAgentId: string;
  resultConversationId: string;
  resultThreadId: string | null;
  status: AgentRequestStatus;
  version: number;
  intake: {
    disposition: 'ready' | 'waiting' | 'blocked';
    reasons: Array<'runtime_unavailable' | 'project_working_copy_unavailable' | 'agent_suspended' | 'authority_revoked'>;
  } | null;
  terminalReason: {
    code: AgentRequestTerminalReason;
    detail: string | null;
  } | null;
  run: {
    id: string;
    status: 'active' | 'terminal';
    outcome: RunView['outcome'];
    deadlineAt: number;
    contextSnapshotId: string;
    policyVersion: number;
    workspaceContextVersion: number;
    projectId: string | null;
    projectContextVersion: number | null;
    conversationContextVersion: number;
    triggerFrontier: DiscussionFrontier;
    sourceCount: number;
    attempt: {
      id: string;
      status: AttemptView['status'];
      failureReason: {
        code: 'runtime_failure';
        message: string;
      } | null;
    } | null;
  } | null;
  createdAt: number;
  updatedAt: number;
  terminalAt: number | null;
}

export interface ConversationParticipantView {
  workspaceMembershipId: string;
  projectMembershipId: string | null;
  actorId: string;
  actorType: ActorType;
  displayName: string;
  joinedAt: number;
}

export interface ChangeRecord {
  position: number;
  workspaceId: string;
  workspaceContextVersion: number | null;
  projectId: string | null;
  projectContextVersion: number | null;
  conversationId: string | null;
  conversationContextVersion: number | null;
  changeType: string;
  sourceType: string;
  sourceId: string;
  payload: unknown;
  createdAt: number;
}

export interface ChangePage {
  items: ChangeRecord[];
  nextCursor: number;
}

export interface DiscussionScopeRef {
  kind: 'timeline' | 'thread';
  conversationId: string;
  threadId: string | null;
  rootMessageId: string | null;
}

export interface DiscussionFrontier extends DiscussionScopeRef {
  position: number;
}

interface ContextSourceMetadataBase {
  mediaType?: string;
  byteLength?: number;
  [key: string]: unknown;
}

export interface ContextSourceMetadataByKind {
  message: ContextSourceMetadataBase & {
    scope?: DiscussionScopeRef;
    authorActorId?: string;
    authorActorType?: ActorType;
    authorDisplayName?: string;
    createdAt?: number;
  };
  conversation: ContextSourceMetadataBase & { scope?: DiscussionScopeRef };
  document: ContextSourceMetadataBase & { title?: string; documentVersionId?: string };
  workspace_memory: ContextSourceMetadataBase & { visibility?: 'shared' | 'private' };
  attachment: ContextSourceMetadataBase;
  artifact: ContextSourceMetadataBase;
  decision: ContextSourceMetadataBase;
  work_item: ContextSourceMetadataBase;
  project: ContextSourceMetadataBase & { name?: string };
  change: ContextSourceMetadataBase & {
    position?: number;
    changeType?: string;
    sourceType?: string;
    sourceId?: string;
  };
}

export type ContextSourceRef<K extends ContextSourceKind = ContextSourceKind> = {
  [P in K]: {
    kind: P;
    sourceId: string;
    sourceVersion: string;
    sourceOrder: number;
    contentDigest: string;
    metadata: ContextSourceMetadataByKind[P];
  }
}[K];

export interface WorkspaceDocumentView {
  id: string;
  workspaceId: string;
  version: number;
  revision: number;
  status: 'active' | 'archived';
  title: string;
  contentMarkdown: string;
  contentDigest: string;
  createdByMembershipId: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentExecutionPolicy {
  maxParallelAttempts: number;
  maxWallTimeMs: number;
  maxContextBytes: number;
  maxToolCalls: number;
  allowedContextKinds: ContextSourceKind[];
  privateContextAllowed: boolean;
}

export interface AgentExecutionPolicyView extends AgentExecutionPolicy {
  id: string;
  workspaceId: string;
  agentId: string;
  version: number;
  createdByMembershipId: string;
  createdAt: number;
}

export interface EffectiveRunBudget {
  maxWallTimeMs: number;
  maxContextBytes: number;
  maxToolCalls: number;
}

export interface RunView {
  id: string;
  workspaceId: string;
  agentRequestId: string;
  agentId: string;
  agentMembershipId: string;
  projectId: string | null;
  agentProjectMembershipId: string | null;
  bindingId: string;
  bindingRevision: number;
  policyVersionId: string;
  policyVersion: number;
  budget: EffectiveRunBudget;
  status: 'active' | 'terminal';
  outcome: ReturnDisposition | 'cancelled' | 'failed' | null;
  deadlineAt: number;
  createdAt: number;
  terminalAt: number | null;
}

export interface AttemptView {
  id: string;
  workspaceId: string;
  runId: string;
  attemptNumber: number;
  status: 'running' | 'finished' | 'failed' | 'cancelled';
  bindingRevision: number;
  policyVersionId: string;
  budget: EffectiveRunBudget;
  deadlineAt: number;
  createdAt: number;
  finishedAt: number | null;
}

export interface RunContextSnapshotView {
  id: string;
  workspaceId: string;
  runId: string;
  objective: string;
  triggerMessageId: string;
  mentionOutcomeId: string;
  sourceScope: DiscussionScopeRef;
  resultScope: DiscussionScopeRef;
  triggerFrontier: DiscussionFrontier;
  agentMembershipId: string;
  policyVersionId: string;
  policyVersion: number;
  budget: EffectiveRunBudget;
  workspaceContextVersion: number;
  projectId: string | null;
  projectContextVersion: number | null;
  repositoryId: string | null;
  repositoryIdentity: string | null;
  repositoryBaseCommit: string | null;
  conversationContextVersion: number;
  changeCursor: number;
  sources: ContextSourceRef[];
  createdAt: number;
}

export interface AttemptExecutionInputView {
  workspaceId: string;
  agentId: string;
  runId: string;
  attemptId: string;
  deadlineAt: number;
  runtimeId: RuntimeId;
  runtimeBindingRevision: number;
  runtimeConfiguration: {
    model: string | null;
    reasoningEffort: ReasoningEffort | null;
    mode: string | null;
  };
  executionScope:
    | { kind: 'workspace_scratch' }
    | {
        kind: 'project_repository';
        projectId: string;
        repositoryId: string;
        repositoryIdentity: string;
        baseCommit: string;
      };
  runContext: RunContextSnapshotView;
  developerInstructions: string;
}

export type AgentInboxAttentionKind = 'direct_message' | 'mention';

export interface AgentInboxTargetView {
  conversationId: string;
  threadId: string | null;
  target: string;
  pendingCount: number;
  firstSequence: number;
  lastSequence: number;
}

export interface AgentInboxSummaryView {
  agentId: string;
  highestSequence: number;
  targets: AgentInboxTargetView[];
}

export interface AgentInboxWakeEventView {
  type: 'agent.inbox_changed';
  agentId: string;
  highestSequence: number;
}

export interface AgentInboxWakeBatchView {
  events: AgentInboxWakeEventView[];
  cursor: Record<string, number>;
}

export interface AgentInboxAttentionView {
  inboxItemId: string;
  sequence: number;
  attentionKind: AgentInboxAttentionKind;
  agentRequestId: string;
  messageId: string;
}

export interface AgentInboxDiscussionDeltaView {
  conversationId: string;
  threadId: string | null;
  sincePositionExclusive: number;
  throughPosition: number;
  rootMessage: MessageView | null;
  messages: MessageView[];
}

export interface AgentInboxClaimView {
  agentId: string;
  runId: string;
  attemptId: string;
  receipt: string;
  target: string;
  attention: AgentInboxAttentionView[];
  discussion: AgentInboxDiscussionDeltaView;
}

export interface PrivateContextGrantView {
  id: string;
  workspaceId: string;
  runId: string;
  grantedByMembershipId: string;
  sourceCategory: 'local_file' | 'local_memory' | 'local_tool';
  readAllowed: boolean;
  disclosureAllowed: boolean;
  policyVersionId: string;
  expiresAt: number;
  revokedAt: number | null;
  createdAt: number;
}

export interface RuntimeContextReadView {
  id: string;
  workspaceId: string;
  runId: string;
  attemptId: string;
  source: ContextSourceRef;
  agentMembershipId: string;
  privateGrantId: string | null;
  purpose: string;
  createdAt: number;
}

export interface RuntimeReturnEnvelope {
  disposition: ReturnDisposition;
  messages: Array<{ body: string; privateGrantIds?: string[] }>;
  artifactPublications: Array<{
    stagedBlobId: string;
    artifactId?: string;
    name: string;
    artifactType: ArtifactType;
    projectIds?: string[];
    expectedCurrentRevision?: number;
    expectedContentDigest?: string;
    attachToMessageIndexes?: number[];
    privateGrantIds?: string[];
  }>;
}

export interface RuntimeReturnResult {
  run: RunView;
  attempt: AttemptView;
  publishedMessages: MessageView[];
  publishedArtifacts: ArtifactView[];
}

export interface RuntimeFailureResult {
  run: RunView;
  attempt: AttemptView;
}
