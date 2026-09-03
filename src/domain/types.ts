export type ActorType = 'human' | 'agent';
export type MembershipRole = 'owner' | 'member';
export type ProjectRole = 'owner' | 'manager' | 'member';
export type WorkItemLifecycleStatus = 'open' | 'blocked' | 'completed' | 'cancelled';
export type ConversationKind = 'channel' | 'dm';
export type ConversationVisibility = 'public' | 'private';
export type ConversationAccessMode = 'content' | 'governance';
export type ConversationLifecycleStatus = 'active' | 'archived';
export type ConversationScope =
  | { type: 'workspace_general' }
  | { type: 'direct_message' }
  | {
      type: 'project_group';
      projectId: string;
      membershipMode: 'project_all' | 'explicit';
    };
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
  /** Set by an Agent-scoped gateway request to prevent one Computer from
   * borrowing another Agent's Project membership and to preserve provenance. */
  agentId?: string;
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
  createdByMembershipId: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectMemberView {
  projectMembershipId: string;
  workspaceMembershipId: string;
  actorId: string;
  actorType: ActorType;
  displayName: string;
  role: ProjectRole;
  sponsoredByProjectMembershipId: string | null;
  revision: number;
  joinedAt: number;
}

export interface WorkItemAssigneeView {
  projectMembershipId: string;
  workspaceMembershipId: string;
  actorId: string;
  actorType: ActorType;
  displayName: string;
}

export interface WorkItemSubmissionView {
  id: string;
  commentId: string | null;
  submittedByMembershipId: string;
  submittedByProjectMembershipId: string;
  submittedByActorId: string;
  submittedByDisplayName: string;
  assignmentRevision: number;
  artifactReferences: WorkItemArtifactReferenceView[];
  createdAt: number;
}

export interface WorkItemArtifactReferenceView {
  artifactId: string;
  artifactVersionId: string;
  artifactName: string;
  version: number;
  fileName: string;
  mediaType: string;
  contentDigest: string;
  byteLength: number;
  contentAvailable: boolean;
  artifactStatus: 'active' | 'deleted' | 'purged';
}

export interface WorkItemCommentView {
  id: string;
  workspaceId: string;
  projectId: string;
  workItemId: string;
  authorActorId: string;
  authorMembershipId: string;
  authorProjectMembershipId: string;
  authorActorType: ActorType;
  authorDisplayName: string;
  body: string;
  mentionedActorIds: string[];
  mentions: MessageMentionView[];
  workItemReferences: MessageWorkItemReferenceView[];
  artifactReferences: WorkItemArtifactReferenceView[];
  position: number;
  createdAt: number;
}

export interface WorkItemView {
  id: string;
  workspaceId: string;
  projectId: string;
  taskNumber: number;
  description: string;
  relatedWorkItemReferences: MessageWorkItemReferenceView[];
  sourceConversationId: string | null;
  sourceMessageId: string | null;
  sourceThreadId: string | null;
  lifecycleStatus: WorkItemLifecycleStatus;
  blockerReason: string | null;
  cancellationReason: string | null;
  assignee: WorkItemAssigneeView | null;
  assignees: WorkItemAssigneeView[];
  currentSubmission: WorkItemSubmissionView | null;
  assignmentRevision: number;
  commentFrontier: number;
  revision: number;
  createdByMembershipId: string;
  createdByProjectMembershipId: string;
  createdByDisplayName: string;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  cancelledAt: number | null;
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

export interface WorkspaceJoinLinkView {
  id: string;
  workspaceId: string;
  token: string | null;
  status: 'active' | 'revoked';
  revision: number;
  createdByMembershipId: string;
  useCount: number;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface WorkspaceJoinLinkCreatedView extends WorkspaceJoinLinkView {
  token: string;
}

export interface WorkspaceJoinLinkPreviewView {
  workspaceId: string;
  workspaceName: string;
  status: 'active' | 'revoked';
  alreadyMember: boolean;
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
  scope: ConversationScope;
  kind: ConversationKind;
  visibility: ConversationVisibility;
  accessMode: ConversationAccessMode;
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
  replyToMessageId: string | null;
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
  workItemReferences: MessageWorkItemReferenceView[];
  createdAt: number;
}

/** Project-scoped resources and immutable Artifact v2 contracts. */
export type ProjectResourceKind = 'file' | 'directory';
export type ProjectResourceStatus = 'active' | 'deleted' | 'purged';
export interface ProjectResourceView {
  resourceId: string;
  projectId: string;
  parentResourceId: string | null;
  name: string;
  path: string;
  kind: ProjectResourceKind;
  status: ProjectResourceStatus;
  revision: number;
  digest: string | null;
  mediaType: string | null;
  byteLength: number | null;
  createdByActorId: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  purgeAfter: number | null;
}

export interface ProjectLinkView {
  linkId: string;
  projectId: string;
  locator: string;
  name: string;
  description: string | null;
  status: ProjectResourceStatus;
  revision: number;
  createdByActorId: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  purgeAfter: number | null;
}

export type ArtifactPreviewStatus = 'pending' | 'ready' | 'failed';
export interface ArtifactVersionView {
  versionId: string;
  artifactId: string;
  version: number;
  fileName: string;
  mediaType: string;
  byteLength: number;
  digest: string;
  parentVersionId: string | null;
  status: ProjectResourceStatus;
  createdByActorId: string;
  createdAt: number;
  taskId: string | null;
  messageId: string | null;
  publishBatchId: string | null;
  note: string | null;
  preview: { status: ArtifactPreviewStatus; errorMessage: string | null };
  deletedAt: number | null;
  purgeAfter: number | null;
}

export interface ArtifactV2View {
  artifactId: string;
  projectId: string;
  name: string;
  projectPath: string;
  status: ProjectResourceStatus;
  latestVersionId: string | null;
  latestVersion: ArtifactVersionView | null;
  createdByActorId: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  purgeAfter: number | null;
  derivationParentVersionIds: string[];
}

export interface ArtifactVersionMessageReferenceView {
  artifactId: string;
  artifactVersionId: string;
  artifactName: string;
  version: number;
  fileName: string;
  mediaType: string;
  contentDigest: string;
  byteLength: number;
  contentAvailable: boolean;
  artifactStatus: ProjectResourceStatus;
}

export type MessageArtifactReferenceView = ArtifactVersionMessageReferenceView;

export interface MessageWorkItemReferenceView {
  workItemId: string;
  taskNumber: number;
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
    reasons: Array<'runtime_unavailable' | 'agent_suspended' | 'authority_revoked'>;
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
  scopeMembershipId: string;
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
        kind: 'project_scratch';
        projectId: string;
      }
  runContext: RunContextSnapshotView;
  developerInstructions: string;
}

export type AgentSessionKind = 'mention' | 'work_item';

export interface AgentSessionRef {
  kind: AgentSessionKind;
  key: string;
}

export type AgentSessionWindowMode = 'dm' | 'isolated';
export type AgentSessionWindowStatus = 'accepting' | 'frozen' | 'completed';

export interface AgentSessionWindowView {
  mode: AgentSessionWindowMode;
  acceptedMessages: number;
  maxMessages: 10;
  status: AgentSessionWindowStatus;
}

/**
 * Optional Discussion capability carried by a WorkItem Session that was
 * created from a Conversation message mentioning the same Agent.  The
 * WorkItem remains the Session's primary identity; this binding lets the
 * Session claim and answer the source Discussion without opening a second
 * Runtime Session.
 */
export interface AgentDiscussionBindingView {
  target: string;
  agentRequestId: string;
  initialDiscussionFrontier: number;
  sessionWindow: AgentSessionWindowView;
}

export interface AgentInboxSessionTriggerView {
  session: AgentSessionRef;
  inboxItemId: string;
  sequence: number;
  target: string | null;
  agentRequestId: string | null;
  messageId: string | null;
  conversationId: string | null;
  threadId: string | null;
  workItemId: string | null;
  requiresAction: boolean;
}

export interface AgentSessionInputView {
  workspaceId: string;
  agentId: string;
  session: AgentSessionRef;
  target: string | null;
  projectId: string | null;
  /** Discussion position already materialized in the immutable Session JSONL snapshot. */
  initialDiscussionFrontier: number | null;
  /** Source Conversation capability for a composite WorkItem Session, if any. */
  discussion: AgentDiscussionBindingView | null;
  sessionWindow: AgentSessionWindowView;
  contextHash: string;
  contextJsonl: string;
  /** WorkItems explicitly referenced by the Mention source message. The Agent may read these via teamctl. */
  referencedWorkItemIds: string[];
  runtimeId: RuntimeId;
  runtimeBindingRevision: number;
  runtimeConfiguration: {
    model: string | null;
    reasoningEffort: ReasoningEffort | null;
    mode: string | null;
  };
  developerInstructions: string;
}

export type AgentActivityEventType =
  | 'turn_started'
  | 'thought'
  | 'tool'
  | 'plan'
  | 'message'
  | 'turn_completed'
  | 'turn_failed';

export type AgentActivityStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface AgentActivityEventInput {
  eventId: string;
  turnId: string;
  sequence: number;
  eventType: AgentActivityEventType;
  title: string;
  status: AgentActivityStatus;
}

export interface AgentActivityEventView extends AgentActivityEventInput {
  workspaceId: string;
  agentId: string;
  agentName: string;
  turnStatus: 'active' | 'completed' | 'failed';
  turnStartedAt: number;
  turnUpdatedAt: number;
  turnFinishedAt: number | null;
  createdAt: number;
}

export type AgentInboxAttentionKind = 'direct_message' | 'mention' | 'work_item_assignment' | 'work_item_mention';

export type AgentInboxTargetView =
  | {
      kind: 'discussion';
      conversationId: string;
      threadId: string | null;
      workItemId: null;
      target: string;
      pendingCount: number;
      firstSequence: number;
      lastSequence: number;
      requiresAction: boolean;
    }
  | {
      kind: 'work_item';
      conversationId: null;
      threadId: null;
      workItemId: string;
      target: string;
      pendingCount: number;
      firstSequence: number;
      lastSequence: number;
      requiresAction: true;
    };

export interface AgentInboxSummaryView {
  agentId: string;
  highestSequence: number;
  targets: AgentInboxTargetView[];
  sessionTriggers: AgentInboxSessionTriggerView[];
}

export interface AgentInboxWakeEventView {
  type: 'agent.inbox_changed';
  agentId: string;
  wakeSequence: number;
}

export interface AgentInboxWakeBatchView {
  events: AgentInboxWakeEventView[];
  cursor: Record<string, number>;
}

export interface AgentInboxAttentionView {
  inboxItemId: string;
  sequence: number;
  attentionKind: AgentInboxAttentionKind;
  agentRequestId: string | null;
  messageId: string | null;
  workItemId: string | null;
  workItemCommentId: string | null;
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
  receipt: string;
  target: string;
  targetKind: 'discussion';
  sessionWindow: AgentSessionWindowView;
  attention: AgentInboxAttentionView[];
  discussion: AgentInboxDiscussionDeltaView;
}

export type AgentMessagePublicationResultView =
  | {
      status: 'published';
      message: MessageView;
    }
  | {
      status: 'held';
      draftId: string;
      expectedDiscussionFrontier: number;
      currentDiscussionFrontier: number;
      attention: AgentInboxAttentionView[];
      discussionDelta: AgentInboxDiscussionDeltaView;
    };

export type AgentInboxCompletionResultView =
  | {
      status: 'completed';
      receipt: string;
      handledAt: number;
    }
  | {
      status: 'review_required';
      expectedDiscussionFrontier: number;
      currentDiscussionFrontier: number;
      attention: AgentInboxAttentionView[];
      discussionDelta: AgentInboxDiscussionDeltaView;
    };

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
  messages: Array<{
    body: string;
    mentionedActorIds?: string[];
    workItemIds?: string[];
    privateGrantIds?: string[];
  }>;
  artifactPublications: Array<{
    stagedBlobId?: string;
    artifactId?: string;
    fileName?: string;
    artifactName?: string;
    artifactPath?: string;
    expectedLatestVersionId?: string;
    parentVersionIds?: string[];
    sourceResourceRefs?: Array<{ resourceId: string; revision?: number; digest?: string }>;
    taskId?: string;
    messageId?: string;
    publishBatchId?: string;
    note?: string;
    attachToMessageIndexes?: number[];
    privateGrantIds?: string[];
  }>;
}

export interface RuntimeReturnResult {
  run: RunView;
  attempt: AttemptView;
  publishedMessages: MessageView[];
  publishedArtifacts: ArtifactV2View[];
}

export interface RuntimeFailureResult {
  run: RunView;
  attempt: AttemptView;
}
