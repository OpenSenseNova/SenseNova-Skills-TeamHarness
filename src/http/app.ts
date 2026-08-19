import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import multipart from '@fastify/multipart';
import { Type } from '@sinclair/typebox';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { DomainError, invariant } from '../lib/errors.js';
import type { ComputerPrincipal, HumanPrincipal, Principal } from '../domain/types.js';
import { WorkspaceService } from '../domain/workspace-service.js';
import { attachArtifactCollaboration } from '../realtime/artifact-collaboration.js';
import { MAX_ARTIFACT_BYTES } from '../storage/content-blob-store.js';

const Id = Type.String({ format: 'uuid' });
const SESSION_COOKIE = 'anc_session';
const HumanSecurity = [{ cookieAuth: [] }, { bearerAuth: [] }];
const BearerSecurity = [{ bearerAuth: [] }];
const IdempotencyHeaders = Type.Object({
  'idempotency-key': Type.String({ minLength: 1, maxLength: 200 }),
});
const VerificationChallengeResponse = Type.Object({
  registrationId: Id,
  verifiedEmail: Type.String(),
  verificationExpiresAt: Type.Integer(),
  developmentVerificationCode: Type.Optional(Type.String({ pattern: '^\\d{6}$' })),
});
const WorkspaceParams = Type.Object({ workspaceId: Id });
const WorkspaceDocumentParams = Type.Object({ workspaceId: Id, documentId: Id });
const ProjectParams = Type.Object({ projectId: Id });
const ProjectMemberParams = Type.Object({ projectId: Id, projectMembershipId: Id });
const ProjectResourceLinkParams = Type.Object({ projectId: Id, linkId: Id });
const ProjectArtifactParams = Type.Object({ projectId: Id, artifactId: Id });
const ArtifactParams = Type.Object({ artifactId: Id });
const ArtifactSnapshotParams = Type.Object({ artifactId: Id, snapshotId: Id });
const AgentParams = Type.Object({ workspaceId: Id, agentId: Id });
const ComputerAgentParams = Type.Object({ agentId: Id });
const ComputerAgentMessageParams = Type.Object({ agentId: Id, messageId: Id });
const ConversationParams = Type.Object({ conversationId: Id });
const MessageParams = Type.Object({ messageId: Id });
const AgentRequestParams = Type.Object({ agentRequestId: Id });
const InvitationParams = Type.Object({ invitationId: Id });
const WorkspaceMemberParams = Type.Object({ workspaceId: Id, membershipId: Id });
const AttemptParams = Type.Object({ attemptId: Id });
const RunParams = Type.Object({ runId: Id });
const PrivateGrantParams = Type.Object({ grantId: Id });
const CursorQuery = Type.Object({
  cursor: Type.Optional(Type.String({ minLength: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 100 })),
});
const ConversationLifecycleStatusSchema = Type.Union([
  Type.Literal('active'),
  Type.Literal('archived'),
]);
const ConversationListQuery = Type.Object({
  cursor: Type.Optional(Type.String({ minLength: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 100 })),
  lifecycleStatus: Type.Optional(ConversationLifecycleStatusSchema),
});
const RevisionBody = Type.Object({ expectedRevision: Type.Integer({ minimum: 1 }) });
const RuntimeIdSchema = Type.String({ minLength: 1, maxLength: 80, pattern: '^[a-z0-9._-]+$' });
const ReasoningEffortSchema = Type.Union([
  Type.Literal('none'),
  Type.Literal('minimal'),
  Type.Literal('low'),
  Type.Literal('medium'),
  Type.Literal('high'),
  Type.Literal('xhigh'),
  Type.Literal('max'),
  Type.Literal('ultra'),
]);
const RuntimeAvailabilitySchema = Type.Union([
  Type.Literal('ready'),
  Type.Literal('not_installed'),
  Type.Literal('adapter_missing'),
  Type.Literal('unauthenticated'),
  Type.Literal('unhealthy'),
]);
const RuntimeConfigurationOptionSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 200 }),
  label: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.Union([Type.String({ maxLength: 1000 }), Type.Null()]),
});
const RuntimeModelOptionSchema = Type.Composite([
  RuntimeConfigurationOptionSchema,
  Type.Object({
    supportedReasoningEfforts: Type.Union([
      Type.Array(ReasoningEffortSchema, { uniqueItems: true, maxItems: 8 }),
      Type.Null(),
    ]),
  }),
]);
const RuntimeConfigurationCapabilitiesSchema = Type.Object({
  models: Type.Array(RuntimeModelOptionSchema, { maxItems: 500 }),
  defaultModelId: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
  reasoningEfforts: Type.Array(RuntimeConfigurationOptionSchema, { maxItems: 8 }),
  defaultReasoningEffort: Type.Union([ReasoningEffortSchema, Type.Null()]),
  modes: Type.Array(RuntimeConfigurationOptionSchema, { maxItems: 500 }),
  defaultModeId: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
});
const RuntimeSkillSchema = Type.Object({
  id: Type.String({ minLength: 64, maxLength: 64, pattern: '^[a-f0-9]+$' }),
  name: Type.String({ minLength: 1, maxLength: 200, pattern: '^[a-zA-Z0-9._-]+$' }),
  displayName: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.String({ maxLength: 2000 }),
  source: Type.String({ minLength: 1, maxLength: 80, pattern: '^[a-z0-9._-]+$' }),
  scope: Type.Union([Type.Literal('global'), Type.Literal('workspace')]),
  installed: Type.Boolean(),
  enabled: Type.Boolean(),
  runtimeCompatible: Type.Boolean(),
  version: Type.Union([Type.String({ minLength: 1, maxLength: 120 }), Type.Null()]),
  revision: Type.String({ minLength: 64, maxLength: 64, pattern: '^[a-f0-9]+$' }),
  userInvocable: Type.Boolean(),
  unavailableReason: Type.Union([
    Type.Object({ code: Type.String({ minLength: 1, maxLength: 120 }), message: Type.String({ minLength: 1, maxLength: 500 }) }),
    Type.Null(),
  ]),
});
const RuntimeSkillCatalogSchema = Type.Object({
  global: Type.Array(RuntimeSkillSchema, { maxItems: 2000 }),
  workspace: Type.Array(RuntimeSkillSchema, { maxItems: 2000 }),
});
const AgentRuntimeSkillsResponse = Type.Object({
  agentId: Id,
  computerId: Id,
  runtimeId: RuntimeIdSchema,
  runtimeAvailability: RuntimeAvailabilitySchema,
  bindingRevision: Type.Integer({ minimum: 1 }),
  runtimeCatalogRevision: Type.Integer({ minimum: 0 }),
  items: Type.Array(RuntimeSkillSchema, { maxItems: 4000 }),
});
const RuntimeUnavailableReasonSchema = Type.Object({
  code: Type.Union([
    Type.Literal('not_installed'),
    Type.Literal('adapter_missing'),
    Type.Literal('unauthenticated'),
    Type.Literal('version_unsupported'),
    Type.Literal('runtime_unhealthy'),
    Type.Literal('capability_probe_failed'),
  ]),
  message: Type.String({ minLength: 1, maxLength: 500 }),
});
const RuntimeConfigurationSelectionSchema = Type.Object({
  model: Type.Union([Type.String(), Type.Null()]),
  reasoningEffort: Type.Union([ReasoningEffortSchema, Type.Null()]),
  mode: Type.Union([Type.String(), Type.Null()]),
});
const RuntimeConfigurationValueSourceSchema = Type.Union([
  Type.Literal('explicit'), Type.Literal('runtime_default'), Type.Literal('unavailable'),
]);
const RuntimeConfigurationIssueSchema = Type.Union([
  Type.Object({
    code: Type.Union([
      Type.Literal('computer_offline'),
      Type.Literal('runtime_not_installed'),
      Type.Literal('runtime_adapter_missing'),
      Type.Literal('runtime_unauthenticated'),
      Type.Literal('runtime_version_unsupported'),
      Type.Literal('runtime_capability_probe_failed'),
      Type.Literal('runtime_unhealthy'),
      Type.Literal('runtime_configuration_unavailable'),
      Type.Literal('runtime_model_unavailable'),
      Type.Literal('runtime_reasoning_effort_unavailable'),
      Type.Literal('runtime_mode_unavailable'),
      Type.Literal('runtime_configuration_combination_unsupported'),
    ]),
    message: Type.String(),
  }),
  Type.Null(),
]);
const RuntimeConfigurationStateSchema = Type.Object({
  requested: RuntimeConfigurationSelectionSchema,
  effective: Type.Object({
    model: Type.Object({
      value: Type.Union([Type.String(), Type.Null()]),
      source: RuntimeConfigurationValueSourceSchema,
    }),
    reasoningEffort: Type.Object({
      value: Type.Union([ReasoningEffortSchema, Type.Null()]),
      source: RuntimeConfigurationValueSourceSchema,
    }),
    mode: Type.Object({
      value: Type.Union([Type.String(), Type.Null()]),
      source: RuntimeConfigurationValueSourceSchema,
    }),
  }),
  status: Type.Union([
    Type.Literal('valid'),
    Type.Literal('computer_offline'),
    Type.Literal('runtime_unavailable'),
    Type.Literal('selection_unavailable'),
  ]),
  invalidReason: RuntimeConfigurationIssueSchema,
});
const RuntimeBindingInput = Type.Object({
  computerId: Id,
  runtimeId: RuntimeIdSchema,
  model: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()])),
  reasoningEffort: Type.Optional(Type.Union([ReasoningEffortSchema, Type.Null()])),
  mode: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 120 }), Type.Null()])),
});
const RuntimeBindingUpdateInput = Type.Composite([
  RuntimeBindingInput,
  Type.Object({ expectedRevision: Type.Integer({ minimum: 0 }) }),
]);
const RuntimeBindingResponse = Type.Object({
  id: Id,
  workspaceId: Id,
  agentId: Id,
  computerId: Id,
  computerName: Type.String(),
  computerConnectionStatus: Type.Union([Type.Literal('online'), Type.Literal('offline')]),
  runtimeId: RuntimeIdSchema,
  runtimeAvailability: RuntimeAvailabilitySchema,
  detectedVersion: Type.Union([Type.String(), Type.Null()]),
  validatedRuntimeCatalogRevision: Type.Integer({ minimum: 1 }),
  runtimeCatalogRevision: Type.Integer({ minimum: 0 }),
  configuration: RuntimeConfigurationStateSchema,
  bindingRevision: Type.Integer(),
  createdAt: Type.Integer(),
});
const ComputerResponse = Type.Object({
  id: Id,
  name: Type.String(),
  status: Type.Union([Type.Literal('active'), Type.Literal('disabled')]),
  connectionStatus: Type.Union([Type.Literal('online'), Type.Literal('offline')]),
  lastSeenAt: Type.Union([Type.Integer(), Type.Null()]),
  runtimeCatalogRevision: Type.Integer({ minimum: 0 }),
  runtimes: Type.Array(Type.Object({
    runtimeId: RuntimeIdSchema,
    label: Type.String(),
    availability: RuntimeAvailabilitySchema,
    detectedVersion: Type.Union([Type.String(), Type.Null()]),
    configuration: Type.Union([RuntimeConfigurationCapabilitiesSchema, Type.Null()]),
    skills: RuntimeSkillCatalogSchema,
    unavailableReason: Type.Union([RuntimeUnavailableReasonSchema, Type.Null()]),
    checkedAt: Type.Integer(),
  })),
  createdAt: Type.Integer(),
});
const ComputerPresenceResponse = Type.Object({
  computerId: Id,
  runtimeCatalogRevision: Type.Integer({ minimum: 0 }),
  lastSeenAt: Type.Integer(),
});
const WorkspaceResponse = Type.Object({
  id: Id,
  name: Type.String(),
  revision: Type.Integer(),
  contextVersion: Type.Integer(),
  membershipId: Id,
  membershipRole: Type.Union([Type.Literal('owner'), Type.Literal('member')]),
  createdAt: Type.Integer(),
  updatedAt: Type.Integer(),
});
const WorkspaceBootstrapResponse = Type.Object({ workspace: WorkspaceResponse, changeCursor: Type.Integer() });
const WorkspaceMemberResponse = Type.Object({
  membershipId: Id,
  actorId: Id,
  actorType: Type.Union([Type.Literal('human'), Type.Literal('agent')]),
  displayName: Type.String(),
  membershipRole: Type.Union([Type.Literal('owner'), Type.Literal('member')]),
  revision: Type.Integer(),
  joinedAt: Type.Integer(),
});
const ProjectRoleSchema = Type.Union([Type.Literal('manager'), Type.Literal('member')]);
const ProjectRepositoryResponse = Type.Object({
  id: Id,
  cloneUrl: Type.String({ minLength: 1, maxLength: 2000 }),
  repositoryIdentity: Type.String({ minLength: 3, maxLength: 1000 }),
  defaultBranch: Type.String({ minLength: 1, maxLength: 255 }),
  revision: Type.Integer({ minimum: 1 }),
});
const ProjectResourceLinkResponse = Type.Object({
  id: Id,
  projectId: Id,
  title: Type.String(),
  url: Type.String({ format: 'uri' }),
  description: Type.Union([Type.String(), Type.Null()]),
  revision: Type.Integer({ minimum: 1 }),
  createdByMembershipId: Id,
  createdAt: Type.Integer(),
  updatedAt: Type.Integer(),
});
const ProjectWorkingCopyAvailability = Type.Union([
  Type.Literal('ready'), Type.Literal('unavailable'), Type.Literal('mismatch'),
]);
const ProjectWorkingCopyResponse = Type.Object({
  computerId: Id,
  computerName: Type.String(),
  connectionStatus: Type.Union([Type.Literal('online'), Type.Literal('offline')]),
  availability: ProjectWorkingCopyAvailability,
  branch: Type.Union([Type.String(), Type.Null()]),
  headCommit: Type.Union([Type.String(), Type.Null()]),
  dirty: Type.Union([Type.Boolean(), Type.Null()]),
  checkedAt: Type.Integer(),
});
const ProjectWorkingCopyReportBody = Type.Object({
  repositoryId: Id,
  repositoryIdentity: Type.String({ minLength: 3, maxLength: 1000 }),
  availability: ProjectWorkingCopyAvailability,
  branch: Type.Union([Type.String({ minLength: 1, maxLength: 255 }), Type.Null()]),
  headCommit: Type.Union([
    Type.String({ pattern: '^(?:[0-9a-f]{40}|[0-9a-f]{64})$' }), Type.Null(),
  ]),
  dirty: Type.Union([Type.Boolean(), Type.Null()]),
}, { additionalProperties: false });
const NewProjectWorkingCopyReportBody = Type.Omit(ProjectWorkingCopyReportBody, ['repositoryId']);
const ProjectResponse = Type.Object({
  id: Id,
  workspaceId: Id,
  name: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  revision: Type.Integer(),
  contextVersion: Type.Integer(),
  membershipId: Type.Union([Id, Type.Null()]),
  role: Type.Union([ProjectRoleSchema, Type.Null()]),
  governanceOnly: Type.Boolean(),
  activeMemberCount: Type.Integer(),
  conversationCount: Type.Integer(),
  repository: Type.Union([ProjectRepositoryResponse, Type.Null()]),
  connectedComputerCount: Type.Integer({ minimum: 0 }),
  readyComputerCount: Type.Integer({ minimum: 0 }),
  workingCopySummary: Type.Union([
    Type.Literal('connected'), Type.Literal('not_connected'),
    Type.Literal('mismatch'), Type.Literal('computer_offline'),
  ]),
  createdByMembershipId: Id,
  createdAt: Type.Integer(),
  updatedAt: Type.Integer(),
});
const ProjectMemberResponse = Type.Object({
  projectMembershipId: Id,
  workspaceMembershipId: Id,
  actorId: Id,
  actorType: Type.Union([Type.Literal('human'), Type.Literal('agent')]),
  displayName: Type.String(),
  role: ProjectRoleSchema,
  revision: Type.Integer(),
  joinedAt: Type.Integer(),
});
const InvitationResponse = Type.Object({
  id: Id,
  workspaceId: Id,
  verifiedEmail: Type.String(),
  membershipRole: Type.Union([Type.Literal('owner'), Type.Literal('member')]),
  status: Type.Union([Type.Literal('pending'), Type.Literal('accepted'), Type.Literal('revoked')]),
  revision: Type.Integer(),
  invitedByMembershipId: Id,
  acceptedMembershipId: Type.Union([Id, Type.Null()]),
  createdAt: Type.Integer(),
  updatedAt: Type.Integer(),
  terminalAt: Type.Union([Type.Integer(), Type.Null()]),
});
const AgentResponse = Type.Object({
  id: Id,
  workspaceId: Id,
  createdByHumanId: Id,
  ownerMembershipId: Id,
  ownerHumanId: Id,
  ownerDisplayName: Type.String(),
  name: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  lifecycleStatus: Type.Union([Type.Literal('active'), Type.Literal('suspended')]),
  revision: Type.Integer(),
  membershipId: Id,
  membershipStatus: Type.Union([Type.Literal('active'), Type.Literal('removed')]),
  executionPolicyVersion: Type.Integer(),
  runtimeBinding: Type.Union([RuntimeBindingResponse, Type.Null()]),
  createdAt: Type.Integer(),
  updatedAt: Type.Integer(),
});
const TerminateAgentMembershipResponse = Type.Object({
  agentId: Id,
  membershipId: Id,
  terminatedAt: Type.Integer(),
});
const DeleteAgentResponse = Type.Object({
  agentId: Id,
  deletedAt: Type.Integer(),
});
const ConversationResponse = Type.Object({
  id: Id,
  workspaceId: Id,
  projectId: Type.Union([Id, Type.Null()]),
  kind: Type.Union([Type.Literal('channel'), Type.Literal('dm')]),
  title: Type.Union([Type.String(), Type.Null()]),
  lifecycleStatus: ConversationLifecycleStatusSchema,
  revision: Type.Integer({ minimum: 1 }),
  archivedAt: Type.Union([Type.Integer(), Type.Null()]),
  archivedByMembershipId: Type.Union([Id, Type.Null()]),
  contextVersion: Type.Integer(),
  timelineFrontier: Type.Integer(),
  createdByMembershipId: Id,
  createdByProjectMembershipId: Type.Union([Id, Type.Null()]),
  createdAt: Type.Integer(),
  updatedAt: Type.Integer(),
});
const MentionReasonResponse = Type.Union([
  Type.Object({
    code: Type.Union([
      Type.Literal('target_not_in_workspace'),
      Type.Literal('target_not_in_project'),
      Type.Literal('target_not_requestable'),
      Type.Literal('target_cannot_access_scope'),
      Type.Literal('target_unavailable'),
    ]),
    visibility: Type.Union([Type.Literal('exact'), Type.Literal('summary')]),
  }),
  Type.Null(),
]);
const MentionOutcomeResponse = Type.Object({
  id: Id,
  targetReference: Id,
  targetAgentId: Type.Union([Id, Type.Null()]),
  outcome: Type.Union([Type.Literal('requested'), Type.Literal('not_requested')]),
  agentRequestId: Type.Union([Id, Type.Null()]),
  reason: MentionReasonResponse,
});
const MessageArtifactReferenceResponse = Type.Object({
  artifactId: Id,
  artifactSnapshotId: Id,
  artifactName: Type.String(),
  snapshotLabel: Type.Union([Type.String(), Type.Null()]),
  snapshotCreatedAt: Type.Integer(),
  mediaType: Type.String(),
  contentDigest: Type.String({ minLength: 64, maxLength: 64 }),
  byteLength: Type.Integer({ minimum: 0 }),
  contentAvailable: Type.Boolean(),
});
const MessageMentionResponse = Type.Object({
  actorId: Id,
  actorType: Type.Union([Type.Literal('human'), Type.Literal('agent')]),
  displayName: Type.String(),
});
const MessageResponse = Type.Object({
  id: Id,
  workspaceId: Id,
  conversationId: Id,
  projectId: Type.Union([Id, Type.Null()]),
  threadId: Type.Union([Id, Type.Null()]),
  threadRootMessageId: Type.Union([Id, Type.Null()]),
  authorActorId: Id,
  authorMembershipId: Id,
  authorProjectMembershipId: Type.Union([Id, Type.Null()]),
  authorActorType: Type.Union([Type.Literal('human'), Type.Literal('agent')]),
  authorDisplayName: Type.String(),
  authorDeleted: Type.Boolean(),
  body: Type.String(),
  conversationVersion: Type.Integer(),
  scopePosition: Type.Integer(),
  producingRunId: Type.Union([Id, Type.Null()]),
  producingAttemptId: Type.Union([Id, Type.Null()]),
  mentions: Type.Array(MessageMentionResponse),
  mentionOutcomes: Type.Array(MentionOutcomeResponse),
  artifactReferences: Type.Array(MessageArtifactReferenceResponse),
  createdAt: Type.Integer(),
});

const ArtifactSnapshotResponse = Type.Object({
  snapshotId: Id,
  artifactId: Id,
  label: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
  parentSnapshotId: Type.Union([Id, Type.Null()]),
  contentDigest: Type.String({ minLength: 64, maxLength: 64 }),
  mediaType: Type.String(),
  byteLength: Type.Integer({ minimum: 0, maximum: MAX_ARTIFACT_BYTES }),
  createdByActorId: Id,
  createdByMembershipId: Id,
  createdByDisplayName: Type.String(),
  revision: Type.Integer({ minimum: 1 }),
  status: Type.Union([Type.Literal('active'), Type.Literal('deleted')]),
  deletedAt: Type.Union([Type.Integer(), Type.Null()]),
  createdAt: Type.Integer(),
  updatedAt: Type.Integer(),
});
const ArtifactCurrentStateResponse = Type.Object({
  artifactId: Id,
  currentRevision: Type.Integer({ minimum: 0 }),
  contentDigest: Type.String({ minLength: 64, maxLength: 64 }),
  mediaType: Type.String(),
  byteLength: Type.Integer({ minimum: 0, maximum: MAX_ARTIFACT_BYTES }),
  updatedByMembershipId: Id,
  updatedAt: Type.Integer(),
});
const ArtifactResponse = Type.Object({
  id: Id,
  workspaceId: Id,
  name: Type.String(),
  artifactType: Type.Union([Type.Literal('markdown'), Type.Literal('file')]),
  currentState: ArtifactCurrentStateResponse,
  latestSnapshot: Type.Union([ArtifactSnapshotResponse, Type.Null()]),
  projectIds: Type.Array(Id),
  createdByMembershipId: Id,
  revision: Type.Integer({ minimum: 1 }),
  status: Type.Union([Type.Literal('active'), Type.Literal('deleted'), Type.Literal('purged')]),
  deletedAt: Type.Union([Type.Integer(), Type.Null()]),
  purgeAfter: Type.Union([Type.Integer(), Type.Null()]),
  purgedAt: Type.Union([Type.Integer(), Type.Null()]),
  createdAt: Type.Integer(),
  updatedAt: Type.Integer(),
});
const ArtifactSnapshotSaveResponse = Type.Object({
  artifact: ArtifactResponse,
  snapshot: ArtifactSnapshotResponse,
  created: Type.Boolean(),
  labelChanged: Type.Boolean(),
});
const StagedBlobResponse = Type.Object({
  id: Id,
  workspaceId: Id,
  runId: Id,
  attemptId: Id,
  contentDigest: Type.String({ minLength: 64, maxLength: 64 }),
  mediaType: Type.String(),
  byteLength: Type.Integer({ minimum: 0, maximum: MAX_ARTIFACT_BYTES }),
  expiresAt: Type.Integer(),
});
const AgentRequestResponse = Type.Object({
  id: Id,
  workspaceId: Id,
  sourceMessageId: Id,
  targetAgentId: Id,
  resultConversationId: Id,
  resultThreadId: Type.Union([Id, Type.Null()]),
  status: Type.Union([
    Type.Literal('pending'), Type.Literal('accepted'), Type.Literal('rejected'), Type.Literal('cancelled'),
  ]),
  version: Type.Integer(),
  intake: Type.Union([
    Type.Object({
      disposition: Type.Union([Type.Literal('ready'), Type.Literal('waiting'), Type.Literal('blocked')]),
      reasons: Type.Array(Type.Union([
        Type.Literal('runtime_unavailable'), Type.Literal('project_working_copy_unavailable'),
        Type.Literal('agent_suspended'), Type.Literal('authority_revoked'),
      ])),
    }),
    Type.Null(),
  ]),
  terminalReason: Type.Union([
    Type.Object({
      code: Type.Union([
        Type.Literal('requestor_cancelled'), Type.Literal('authority_revoked'), Type.Literal('intake_rejected'),
      ]),
      detail: Type.Union([Type.String(), Type.Null()]),
    }),
    Type.Null(),
  ]),
  run: Type.Union([
    Type.Object({
      id: Id,
      status: Type.Union([Type.Literal('active'), Type.Literal('terminal')]),
      outcome: Type.Union([
        Type.Literal('publish'), Type.Literal('no_output'), Type.Literal('discard'),
        Type.Literal('cancelled'), Type.Literal('failed'), Type.Null(),
      ]),
      deadlineAt: Type.Integer(),
      contextSnapshotId: Id,
      policyVersion: Type.Integer(),
      workspaceContextVersion: Type.Integer(),
      projectId: Type.Union([Id, Type.Null()]),
      projectContextVersion: Type.Union([Type.Integer(), Type.Null()]),
      conversationContextVersion: Type.Integer(),
      triggerFrontier: Type.Object({
        kind: Type.Union([Type.Literal('timeline'), Type.Literal('thread')]),
        conversationId: Id,
        threadId: Type.Union([Id, Type.Null()]),
        rootMessageId: Type.Union([Id, Type.Null()]),
        position: Type.Integer(),
      }),
      sourceCount: Type.Integer(),
      attempt: Type.Union([
        Type.Object({
          id: Id,
          status: Type.Union([
            Type.Literal('running'), Type.Literal('finished'), Type.Literal('failed'), Type.Literal('cancelled'),
          ]),
          failureReason: Type.Union([
            Type.Object({
              code: Type.Literal('runtime_failure'),
              message: Type.String({ minLength: 1, maxLength: 2000 }),
            }),
            Type.Null(),
          ]),
        }),
        Type.Null(),
      ]),
    }),
    Type.Null(),
  ]),
  createdAt: Type.Integer(),
  updatedAt: Type.Integer(),
  terminalAt: Type.Union([Type.Integer(), Type.Null()]),
});
const ConversationParticipantResponse = Type.Object({
  workspaceMembershipId: Id,
  projectMembershipId: Type.Union([Id, Type.Null()]),
  actorId: Id,
  actorType: Type.Union([Type.Literal('human'), Type.Literal('agent')]),
  displayName: Type.String(),
  joinedAt: Type.Integer(),
});
const ChangeResponse = Type.Object({
  position: Type.Integer(),
  workspaceId: Id,
  workspaceContextVersion: Type.Union([Type.Integer(), Type.Null()]),
  projectId: Type.Union([Id, Type.Null()]),
  projectContextVersion: Type.Union([Type.Integer(), Type.Null()]),
  conversationId: Type.Union([Id, Type.Null()]),
  conversationContextVersion: Type.Union([Type.Integer(), Type.Null()]),
  changeType: Type.String(),
  sourceType: Type.String(),
  sourceId: Type.String(),
  payload: Type.Unknown(),
  createdAt: Type.Integer(),
});
const ContextSourceKindSchema = Type.Union([
  Type.Literal('message'), Type.Literal('conversation'), Type.Literal('document'),
  Type.Literal('workspace_memory'), Type.Literal('attachment'), Type.Literal('artifact'),
  Type.Literal('decision'), Type.Literal('work_item'), Type.Literal('project'), Type.Literal('change'),
]);
const ScopeResponse = Type.Object({
  kind: Type.Union([Type.Literal('timeline'), Type.Literal('thread')]),
  conversationId: Id,
  threadId: Type.Union([Id, Type.Null()]),
  rootMessageId: Type.Union([Id, Type.Null()]),
});
const FrontierResponse = Type.Intersect([ScopeResponse, Type.Object({ position: Type.Integer() })]);
const ContextSourceResponse = Type.Object({
  kind: ContextSourceKindSchema,
  sourceId: Type.String({ minLength: 1 }),
  sourceVersion: Type.String({ minLength: 1 }),
  sourceOrder: Type.Integer({ minimum: 0 }),
  contentDigest: Type.String({ minLength: 64, maxLength: 64 }),
  metadata: Type.Record(Type.String(), Type.Unknown()),
});
const BudgetResponse = Type.Object({
  maxWallTimeMs: Type.Integer(), maxContextBytes: Type.Integer(), maxToolCalls: Type.Integer(),
});
const RunResponse = Type.Object({
  id: Id, workspaceId: Id, agentRequestId: Id, agentId: Id, agentMembershipId: Id,
  projectId: Type.Union([Id, Type.Null()]),
  agentProjectMembershipId: Type.Union([Id, Type.Null()]),
  bindingId: Id, bindingRevision: Type.Integer(), policyVersionId: Id, policyVersion: Type.Integer(),
  budget: BudgetResponse,
  status: Type.Union([Type.Literal('active'), Type.Literal('terminal')]),
  outcome: Type.Union([
    Type.Literal('publish'), Type.Literal('no_output'), Type.Literal('discard'),
    Type.Literal('cancelled'), Type.Literal('failed'), Type.Null(),
  ]),
  deadlineAt: Type.Integer(), createdAt: Type.Integer(), terminalAt: Type.Union([Type.Integer(), Type.Null()]),
});
const AttemptResponse = Type.Object({
  id: Id, workspaceId: Id, runId: Id, attemptNumber: Type.Integer(),
  status: Type.Union([Type.Literal('running'), Type.Literal('finished'), Type.Literal('failed'), Type.Literal('cancelled')]),
  bindingRevision: Type.Integer(), policyVersionId: Id, budget: BudgetResponse,
  deadlineAt: Type.Integer(), createdAt: Type.Integer(), finishedAt: Type.Union([Type.Integer(), Type.Null()]),
});
const RunContextSnapshotResponse = Type.Object({
  id: Id, workspaceId: Id, runId: Id, objective: Type.String(), triggerMessageId: Id, mentionOutcomeId: Id,
  sourceScope: ScopeResponse, resultScope: ScopeResponse, triggerFrontier: FrontierResponse,
  agentMembershipId: Id, policyVersionId: Id, policyVersion: Type.Integer(), budget: BudgetResponse,
  workspaceContextVersion: Type.Integer(),
  projectId: Type.Union([Id, Type.Null()]),
  projectContextVersion: Type.Union([Type.Integer(), Type.Null()]),
  repositoryId: Type.Union([Id, Type.Null()]),
  repositoryIdentity: Type.Union([Type.String(), Type.Null()]),
  repositoryBaseCommit: Type.Union([Type.String(), Type.Null()]),
  conversationContextVersion: Type.Integer(), changeCursor: Type.Integer(),
  sources: Type.Array(ContextSourceResponse), createdAt: Type.Integer(),
});
const WorkspaceDocumentResponse = Type.Object({
  id: Id,
  workspaceId: Id,
  version: Type.Integer({ minimum: 1 }),
  revision: Type.Integer({ minimum: 1 }),
  status: Type.Union([Type.Literal('active'), Type.Literal('archived')]),
  title: Type.String({ minLength: 1, maxLength: 200 }),
  contentMarkdown: Type.String({ minLength: 1, maxLength: 1048576 }),
  contentDigest: Type.String({ minLength: 64, maxLength: 64 }),
  createdByMembershipId: Id,
  createdAt: Type.Integer(),
  updatedAt: Type.Integer(),
});
const ExecutionPolicyFields = {
  maxParallelAttempts: Type.Integer({ minimum: 1, maximum: 64 }),
  maxWallTimeMs: Type.Integer({ minimum: 1000, maximum: 86400000 }),
  maxContextBytes: Type.Integer({ minimum: 1024, maximum: 1073741824 }),
  maxToolCalls: Type.Integer({ minimum: 0, maximum: 100000 }),
  allowedContextKinds: Type.Array(ContextSourceKindSchema, { minItems: 1, uniqueItems: true }),
  privateContextAllowed: Type.Boolean(),
};
const ExecutionPolicyResponse = Type.Object({
  id: Id, workspaceId: Id, agentId: Id, version: Type.Integer(),
  ...ExecutionPolicyFields,
  createdByMembershipId: Id, createdAt: Type.Integer(),
});
const PrivateGrantResponse = Type.Object({
  id: Id, workspaceId: Id, runId: Id, grantedByMembershipId: Id,
  sourceCategory: Type.Union([Type.Literal('local_file'), Type.Literal('local_memory'), Type.Literal('local_tool')]),
  readAllowed: Type.Boolean(), disclosureAllowed: Type.Boolean(), policyVersionId: Id,
  expiresAt: Type.Integer(), revokedAt: Type.Union([Type.Integer(), Type.Null()]), createdAt: Type.Integer(),
});
const AttemptExecutionInputResponse = Type.Object({
  workspaceId: Id,
  agentId: Id,
  runId: Id,
  attemptId: Id,
  deadlineAt: Type.Integer(),
  runtimeId: RuntimeIdSchema,
  runtimeBindingRevision: Type.Integer({ minimum: 1 }),
  runtimeConfiguration: Type.Object({
    model: Type.Union([Type.String(), Type.Null()]),
    reasoningEffort: Type.Union([ReasoningEffortSchema, Type.Null()]),
    mode: Type.Union([Type.String(), Type.Null()]),
  }),
  executionScope: Type.Union([
    Type.Object({ kind: Type.Literal('workspace_scratch') }, { additionalProperties: false }),
    Type.Object({
      kind: Type.Literal('project_repository'),
      projectId: Id,
      repositoryId: Id,
      repositoryIdentity: Type.String({ minLength: 3 }),
      baseCommit: Type.String({ pattern: '^(?:[0-9a-f]{40}|[0-9a-f]{64})$' }),
    }, { additionalProperties: false }),
  ]),
  runContext: RunContextSnapshotResponse,
  developerInstructions: Type.String(),
});
const AgentInboxTargetResponse = Type.Object({
  conversationId: Id,
  threadId: Type.Union([Id, Type.Null()]),
  target: Type.String({ minLength: 1 }),
  pendingCount: Type.Integer({ minimum: 1 }),
  firstSequence: Type.Integer({ minimum: 1 }),
  lastSequence: Type.Integer({ minimum: 1 }),
});
const AgentInboxSummaryResponse = Type.Object({
  agentId: Id,
  highestSequence: Type.Integer({ minimum: 0 }),
  targets: Type.Array(AgentInboxTargetResponse),
});
const AgentInboxWakeBatchResponse = Type.Object({
  events: Type.Array(Type.Object({
    type: Type.Literal('agent.inbox_changed'),
    agentId: Id,
    highestSequence: Type.Integer({ minimum: 1 }),
  })),
  cursor: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
});
const AgentInboxClaimResponse = Type.Object({
  agentId: Id,
  runId: Id,
  attemptId: Id,
  receipt: Type.String({ minLength: 1 }),
  target: Type.String({ minLength: 1 }),
  attention: Type.Array(Type.Object({
    inboxItemId: Id,
    sequence: Type.Integer({ minimum: 1 }),
    attentionKind: Type.Union([Type.Literal('direct_message'), Type.Literal('mention')]),
    agentRequestId: Id,
    messageId: Id,
  })),
  discussion: Type.Object({
    conversationId: Id,
    threadId: Type.Union([Id, Type.Null()]),
    sincePositionExclusive: Type.Integer({ minimum: 0 }),
    throughPosition: Type.Integer({ minimum: 0 }),
    rootMessage: Type.Union([MessageResponse, Type.Null()]),
    messages: Type.Array(MessageResponse),
  }),
});

export async function buildApp(service: WorkspaceService) {
  const app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(multipart, {
    limits: { fileSize: MAX_ARTIFACT_BYTES, files: 1, fields: 20 },
  });
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'AI Native Collaboration MVP API',
        version: '1.0.0',
        description: 'Workspace authority, pull-based Agent Inbox, privacy grants, and mediated local runtime execution.',
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer' },
          cookieAuth: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE },
        },
      },
      servers: [{ url: '/' }],
    },
    transformObject: (document) => {
      if (!('openapiObject' in document)) return document.swaggerObject;
      const { openapiObject } = document;
      const paths = openapiObject.paths as Record<string, {
        post?: Record<string, unknown>;
        put?: Record<string, unknown>;
      }>;
      const multipartBody = (properties: Record<string, unknown>, required: string[]) => ({
        required: true,
        content: {
          'multipart/form-data': {
            schema: { type: 'object', properties, required, additionalProperties: false },
          },
        },
      });
      if (paths['/v1/workspaces/{workspaceId}/artifacts/files']?.post) {
        paths['/v1/workspaces/{workspaceId}/artifacts/files'].post.requestBody = multipartBody({
          file: { type: 'string', format: 'binary' },
          name: { type: 'string', minLength: 1, maxLength: 500 },
          projectIds: { type: 'string', description: 'JSON array of Project UUIDs.' },
        }, ['file']);
      }
      if (paths['/v1/artifacts/{artifactId}/current/file']?.put) {
        paths['/v1/artifacts/{artifactId}/current/file'].put.requestBody = multipartBody({
          file: { type: 'string', format: 'binary' },
          expectedCurrentRevision: { type: 'integer', minimum: 0 },
        }, ['file', 'expectedCurrentRevision']);
      }
      if (paths['/v1/attempts/{attemptId}/staged-blobs']?.post) {
        paths['/v1/attempts/{attemptId}/staged-blobs'].post.requestBody = multipartBody({
          file: { type: 'string', format: 'binary' },
        }, ['file']);
      }
      return openapiObject;
    },
  });
  const artifactCollaboration = attachArtifactCollaboration(app, service);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) {
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details ?? null },
      });
    }
    if (typeof error === 'object' && error !== null && 'validation' in error && error.validation) {
      const validationError = error as { message?: string; validation: unknown };
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: validationError.message ?? 'Request validation failed.', details: validationError.validation },
      });
    }
    if (typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 413) {
      return reply.status(413).send({
        error: { code: 'ARTIFACT_FILE_TOO_LARGE', message: 'Artifact files may not exceed 100 MiB.', details: null },
      });
    }
    app.log.error(error);
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error.', details: null } });
  });

  app.get('/health', {
    schema: {
      tags: ['system'],
      response: { 200: Type.Object({ status: Type.Literal('ok') }) },
    },
  }, async () => ({ status: 'ok' as const }));

  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  app.post('/v1/auth/register', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    schema: {
      tags: ['auth'],
      body: Type.Object({
        displayName: Type.String({ minLength: 1, maxLength: 120 }),
        email: Type.String({ minLength: 3, maxLength: 320 }),
        password: Type.String({ minLength: 10, maxLength: 128 }),
      }),
      response: {
        202: VerificationChallengeResponse,
      },
    },
  }, async (request, reply) => reply.status(202).send(await service.auth.register(request.body)));

  app.post('/v1/auth/resend-verification', {
    config: { rateLimit: { max: 3, timeWindow: '1 minute' } },
    schema: {
      tags: ['auth'],
      body: Type.Object({ registrationId: Id }),
      response: {
        202: VerificationChallengeResponse,
      },
    },
  }, async (request, reply) => reply.status(202).send(service.auth.resendVerification(request.body.registrationId)));

  app.post('/v1/auth/verify-email', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      tags: ['auth'],
      body: Type.Object({ registrationId: Id, code: Type.String({ pattern: '^\\d{6}$' }) }),
      response: { 200: Type.Object({ id: Id, displayName: Type.String(), verifiedEmail: Type.String() }) },
    },
  }, async (request, reply) => {
    const session = service.auth.verifyEmail(request.body.registrationId, request.body.code);
    setSessionCookie(reply, session.token, session.expiresAt);
    return session.human;
  });

  app.post('/v1/auth/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      tags: ['auth'],
      body: Type.Object({
        email: Type.String({ minLength: 3, maxLength: 320 }),
        password: Type.String({ minLength: 10, maxLength: 128 }),
      }),
      response: { 200: Type.Object({ id: Id, displayName: Type.String(), verifiedEmail: Type.String() }) },
    },
  }, async (request, reply) => {
    const session = await service.auth.login(request.body.email, request.body.password);
    setSessionCookie(reply, session.token, session.expiresAt);
    return session.human;
  });

  app.get('/v1/auth/session', {
    schema: {
      tags: ['auth'], security: HumanSecurity,
      response: { 200: Type.Object({ id: Id, displayName: Type.String(), verifiedEmail: Type.String() }) },
    },
  }, async (request) => service.auth.getSession(authToken(request)));

  app.post('/v1/auth/logout', {
    schema: { tags: ['auth'], security: HumanSecurity, response: { 204: Type.Null() } },
  }, async (request, reply) => {
    service.auth.logout(authToken(request));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.status(204).send(null);
  });

  app.post('/v1/workspaces', {
    schema: {
      tags: ['workspace'], security: HumanSecurity, headers: IdempotencyHeaders,
      body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 120 }) }),
      response: { 201: WorkspaceResponse },
    },
  }, async (request, reply) => {
    const principal = requireHuman(authenticate(request, service));
    return reply.status(201).send(service.createWorkspace(principal, request.body.name, idempotencyKey(request)));
  });

  app.get('/v1/workspaces', {
    schema: {
      tags: ['workspace'], security: HumanSecurity, querystring: CursorQuery,
      response: { 200: Type.Object({ items: Type.Array(WorkspaceResponse), nextCursor: Type.Union([Type.String(), Type.Null()]) }) },
    },
  }, async (request) => {
    const principal = requireHuman(authenticate(request, service));
    return service.listWorkspaces(principal, request.query.cursor, request.query.limit ?? 100);
  });

  app.get('/v1/workspaces/:workspaceId', {
    schema: { tags: ['workspace'], security: HumanSecurity, params: WorkspaceParams, response: { 200: WorkspaceResponse } },
  }, async (request) => {
    const principal = requireHuman(authenticate(request, service));
    return service.getWorkspace(principal, request.params.workspaceId);
  });

  app.get('/v1/workspaces/:workspaceId/bootstrap', {
    schema: {
      tags: ['workspace'], security: HumanSecurity, params: WorkspaceParams,
      response: { 200: WorkspaceBootstrapResponse },
    },
  }, async (request) => {
    const principal = requireHuman(authenticate(request, service));
    return service.bootstrapWorkspace(principal, request.params.workspaceId);
  });

  app.post('/v1/workspaces/:workspaceId/documents', {
    schema: {
      tags: ['document'], security: HumanSecurity, headers: IdempotencyHeaders, params: WorkspaceParams,
      body: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 200 }),
        contentMarkdown: Type.String({ minLength: 1, maxLength: 1048576 }),
      }),
      response: { 201: WorkspaceDocumentResponse },
    },
  }, async (request, reply) => reply.status(201).send(service.createWorkspaceDocument(
    requireHuman(authenticate(request, service)),
    request.params.workspaceId,
    request.body,
    idempotencyKey(request),
  )));

  app.get('/v1/workspaces/:workspaceId/documents', {
    schema: {
      tags: ['document'], security: HumanSecurity, params: WorkspaceParams, querystring: CursorQuery,
      response: {
        200: Type.Object({
          items: Type.Array(WorkspaceDocumentResponse),
          nextCursor: Type.Union([Type.String(), Type.Null()]),
        }),
      },
    },
  }, async (request) => service.listWorkspaceDocuments(
    requireHuman(authenticate(request, service)),
    request.params.workspaceId,
    request.query.cursor,
    request.query.limit ?? 100,
  ));

  app.get('/v1/workspaces/:workspaceId/documents/:documentId', {
    schema: {
      tags: ['document'], security: HumanSecurity, params: WorkspaceDocumentParams,
      response: { 200: WorkspaceDocumentResponse },
    },
  }, async (request) => service.getWorkspaceDocument(
    requireHuman(authenticate(request, service)),
    request.params.workspaceId,
    request.params.documentId,
  ));

  app.put('/v1/workspaces/:workspaceId/documents/:documentId', {
    schema: {
      tags: ['document'], security: HumanSecurity, headers: IdempotencyHeaders, params: WorkspaceDocumentParams,
      body: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 200 }),
        contentMarkdown: Type.String({ minLength: 1, maxLength: 1048576 }),
        expectedRevision: Type.Integer({ minimum: 1 }),
      }),
      response: { 200: WorkspaceDocumentResponse },
    },
  }, async (request) => service.updateWorkspaceDocument(
    requireHuman(authenticate(request, service)),
    request.params.workspaceId,
    request.params.documentId,
    request.body,
    idempotencyKey(request),
  ));

  app.get('/v1/workspaces/:workspaceId/artifacts', {
    schema: {
      tags: ['artifact'], security: HumanSecurity, params: WorkspaceParams,
      querystring: Type.Object({ projectId: Type.Optional(Id) }),
      response: { 200: Type.Object({ items: Type.Array(ArtifactResponse) }) },
    },
  }, async (request) => ({
    items: service.artifacts.list(
      requireHuman(authenticate(request, service)),
      request.params.workspaceId,
      request.query.projectId ? { projectId: request.query.projectId } : {},
    ),
  }));

  app.get('/v1/workspaces/:workspaceId/artifacts/trash', {
    schema: {
      tags: ['artifact'], security: HumanSecurity, params: WorkspaceParams,
      response: { 200: Type.Object({ items: Type.Array(ArtifactResponse) }) },
    },
  }, async (request) => ({
    items: service.artifacts.list(
      requireHuman(authenticate(request, service)),
      request.params.workspaceId,
      { trash: true },
    ),
  }));

  app.get('/v1/workspaces/:workspaceId/artifacts/cleanup-status', {
    schema: {
      tags: ['artifact'], security: HumanSecurity, params: WorkspaceParams,
      response: { 200: Type.Object({
        deletedCount: Type.Integer({ minimum: 0 }),
        expiredDeletedCount: Type.Integer({ minimum: 0 }),
        stagedBlobCount: Type.Integer({ minimum: 0 }),
        expiredStagedBlobCount: Type.Integer({ minimum: 0 }),
        nextPurgeAt: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
        checkedAt: Type.Integer({ minimum: 0 }),
      }) },
    },
  }, async (request) => service.artifacts.cleanupStatus(
    requireHuman(authenticate(request, service)), request.params.workspaceId,
  ));

  app.post('/v1/workspaces/:workspaceId/artifacts/markdown', {
    schema: {
      tags: ['artifact'], security: HumanSecurity, headers: IdempotencyHeaders, params: WorkspaceParams,
      body: Type.Object({
        name: Type.String({ minLength: 1, maxLength: 500 }),
        projectIds: Type.Optional(Type.Array(Id, { uniqueItems: true, maxItems: 100 })),
      }, { additionalProperties: false }),
      response: { 201: ArtifactResponse },
    },
  }, async (request, reply) => reply.status(201).send(service.artifacts.createMarkdown(
    requireHuman(authenticate(request, service)), request.params.workspaceId, request.body, idempotencyKey(request),
  )));

  app.post('/v1/workspaces/:workspaceId/artifacts/files', {
    schema: {
      tags: ['artifact'], security: HumanSecurity, headers: IdempotencyHeaders, params: WorkspaceParams,
      consumes: ['multipart/form-data'],
      response: { 201: ArtifactResponse },
    },
  }, async (request, reply) => {
    const principal = requireHuman(authenticate(request, service));
    const upload = await request.file({ limits: { fileSize: MAX_ARTIFACT_BYTES, files: 1 } });
    invariant(upload, 'ARTIFACT_FILE_REQUIRED', 'A file upload is required.');
    const stored = await service.artifacts.blobs.write(upload.file, upload.mimetype);
    const name = multipartString(upload.fields, 'name') ?? upload.filename;
    const projectIds = multipartJsonIds(upload.fields, 'projectIds');
    return reply.status(201).send(await service.artifacts.createFile(
      principal, request.params.workspaceId, { name, projectIds }, stored, idempotencyKey(request),
    ));
  });

  app.get('/v1/artifacts/:artifactId', {
    schema: { tags: ['artifact'], security: HumanSecurity, params: ArtifactParams, response: { 200: ArtifactResponse } },
  }, async (request) => service.artifacts.get(
    requireHuman(authenticate(request, service)), request.params.artifactId,
  ));

  app.post('/v1/artifacts/:artifactId/draft/flush', {
    schema: {
      tags: ['artifact'], security: HumanSecurity, params: ArtifactParams,
      response: { 200: ArtifactResponse },
    },
  }, async (request) => {
    const principal = requireHuman(authenticate(request, service));
    service.artifacts.authorizeDraft(principal, request.params.artifactId);
    await artifactCollaboration.flushDocument(request.params.artifactId);
    return service.artifacts.get(principal, request.params.artifactId);
  });

  app.patch('/v1/artifacts/:artifactId', {
    schema: {
      tags: ['artifact'], security: HumanSecurity, headers: IdempotencyHeaders, params: ArtifactParams,
      body: Type.Object({
        name: Type.String({ minLength: 1, maxLength: 500 }),
        expectedRevision: Type.Integer({ minimum: 1 }),
      }, { additionalProperties: false }),
      response: { 200: ArtifactResponse },
    },
  }, async (request) => service.artifacts.rename(
    requireHuman(authenticate(request, service)), request.params.artifactId, request.body, idempotencyKey(request),
  ));

  app.delete('/v1/artifacts/:artifactId', {
    schema: {
      tags: ['artifact'], security: HumanSecurity, headers: IdempotencyHeaders, params: ArtifactParams,
      body: RevisionBody,
      response: { 200: ArtifactResponse },
    },
  }, async (request) => service.artifacts.delete(
    requireHuman(authenticate(request, service)), request.params.artifactId,
    request.body.expectedRevision, idempotencyKey(request),
  ));

  app.post('/v1/artifacts/:artifactId/restore', {
    schema: {
      tags: ['artifact'], security: HumanSecurity, headers: IdempotencyHeaders, params: ArtifactParams,
      body: RevisionBody,
      response: { 200: ArtifactResponse },
    },
  }, async (request) => service.artifacts.restore(
    requireHuman(authenticate(request, service)), request.params.artifactId,
    request.body.expectedRevision, idempotencyKey(request),
  ));

  app.post('/v1/artifacts/:artifactId/snapshots', {
    schema: {
      tags: ['artifact'], security: HumanSecurity, headers: IdempotencyHeaders, params: ArtifactParams,
      body: Type.Object({
        expectedCurrentRevision: Type.Integer({ minimum: 0 }),
        label: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
      }, { additionalProperties: false }),
      response: { 200: ArtifactSnapshotSaveResponse },
    },
  }, async (request) => service.artifacts.saveCurrentSnapshot(
    requireHuman(authenticate(request, service)), request.params.artifactId, request.body, idempotencyKey(request),
  ));

  app.put('/v1/artifacts/:artifactId/current/file', {
    schema: {
      tags: ['artifact'], security: HumanSecurity, headers: IdempotencyHeaders, params: ArtifactParams,
      consumes: ['multipart/form-data'],
      response: { 200: ArtifactResponse },
    },
  }, async (request) => {
    const principal = requireHuman(authenticate(request, service));
    const upload = await request.file({ limits: { fileSize: MAX_ARTIFACT_BYTES, files: 1 } });
    invariant(upload, 'ARTIFACT_FILE_REQUIRED', 'A file upload is required.');
    const expectedCurrentRevisionValue = multipartString(upload.fields, 'expectedCurrentRevision');
    invariant(expectedCurrentRevisionValue, 'EXPECTED_CURRENT_REVISION_REQUIRED', 'expectedCurrentRevision is required.');
    const expectedCurrentRevision = Number(expectedCurrentRevisionValue);
    invariant(Number.isSafeInteger(expectedCurrentRevision) && expectedCurrentRevision >= 0,
      'INVALID_CURRENT_REVISION', 'expectedCurrentRevision must be a non-negative integer.');
    const stored = await service.artifacts.blobs.write(upload.file, upload.mimetype);
    return service.artifacts.replaceFileCurrent(
      principal, request.params.artifactId, { expectedCurrentRevision }, stored, idempotencyKey(request),
    );
  });

  app.get('/v1/artifacts/:artifactId/snapshots', {
    schema: {
      tags: ['artifact'], security: HumanSecurity, params: ArtifactParams,
      response: { 200: Type.Object({ items: Type.Array(ArtifactSnapshotResponse) }) },
    },
  }, async (request) => ({
    items: service.artifacts.listSnapshots(requireHuman(authenticate(request, service)), request.params.artifactId),
  }));

  app.get('/v1/artifacts/:artifactId/snapshots/:snapshotId', {
    schema: {
      tags: ['artifact'], security: HumanSecurity, params: ArtifactSnapshotParams,
      response: { 200: ArtifactSnapshotResponse },
    },
  }, async (request) => service.artifacts.getSnapshot(
    requireHuman(authenticate(request, service)), request.params.artifactId, request.params.snapshotId,
  ));

  app.patch('/v1/artifacts/:artifactId/snapshots/:snapshotId', {
    schema: {
      tags: ['artifact'], security: HumanSecurity, headers: IdempotencyHeaders, params: ArtifactSnapshotParams,
      body: Type.Object({
        label: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
        expectedRevision: Type.Integer({ minimum: 1 }),
      }, { additionalProperties: false }),
      response: { 200: ArtifactSnapshotResponse },
    },
  }, async (request) => service.artifacts.renameSnapshot(
    requireHuman(authenticate(request, service)), request.params.artifactId, request.params.snapshotId,
    request.body, idempotencyKey(request),
  ));

  app.delete('/v1/artifacts/:artifactId/snapshots/:snapshotId', {
    schema: {
      tags: ['artifact'], security: HumanSecurity, headers: IdempotencyHeaders, params: ArtifactSnapshotParams,
      body: RevisionBody,
      response: { 200: ArtifactResponse },
    },
  }, async (request) => service.artifacts.deleteSnapshot(
    requireHuman(authenticate(request, service)), request.params.artifactId, request.params.snapshotId,
    request.body.expectedRevision, idempotencyKey(request),
  ));

  app.post('/v1/artifacts/:artifactId/snapshots/:snapshotId/restore', {
    schema: {
      tags: ['artifact'], security: HumanSecurity, headers: IdempotencyHeaders, params: ArtifactSnapshotParams,
      body: Type.Object({ expectedCurrentRevision: Type.Integer({ minimum: 0 }) }),
      response: { 200: ArtifactResponse },
    },
  }, async (request) => service.artifacts.restoreSnapshot(
    requireHuman(authenticate(request, service)), request.params.artifactId, request.params.snapshotId,
    request.body.expectedCurrentRevision, idempotencyKey(request),
  ));

  app.get('/v1/artifacts/:artifactId/snapshots/:snapshotId/download', {
    schema: { tags: ['artifact'], security: HumanSecurity, params: ArtifactSnapshotParams },
  }, async (request, reply) => {
    const result = service.artifacts.snapshotBlob(
      requireHuman(authenticate(request, service)), request.params.artifactId, request.params.snapshotId,
    );
    reply.header('Content-Type', result.snapshot.mediaType);
    reply.header('Content-Length', String(result.snapshot.byteLength));
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''snapshot-${result.snapshot.snapshotId}`);
    return reply.send(service.artifacts.blobs.read(result.storagePath));
  });

  app.get('/v1/artifacts/:artifactId/current/download', {
    schema: { tags: ['artifact'], security: HumanSecurity, params: ArtifactParams },
  }, async (request, reply) => {
    const result = service.artifacts.currentBlob(
      requireHuman(authenticate(request, service)), request.params.artifactId,
    );
    reply.header('Content-Type', result.state.mediaType);
    reply.header('Content-Length', String(result.state.byteLength));
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''artifact-${request.params.artifactId}`);
    return reply.send(service.artifacts.blobs.read(result.storagePath));
  });

  app.put('/v1/projects/:projectId/artifacts/:artifactId', {
    schema: {
      tags: ['artifact'], security: HumanSecurity, headers: IdempotencyHeaders, params: ProjectArtifactParams,
      response: { 200: ArtifactResponse },
    },
  }, async (request) => service.artifacts.associate(
    requireHuman(authenticate(request, service)), request.params.projectId, request.params.artifactId,
    idempotencyKey(request),
  ));

  app.delete('/v1/projects/:projectId/artifacts/:artifactId', {
    schema: {
      tags: ['artifact'], security: HumanSecurity, headers: IdempotencyHeaders, params: ProjectArtifactParams,
      response: { 200: ArtifactResponse },
    },
  }, async (request) => service.artifacts.dissociate(
    requireHuman(authenticate(request, service)), request.params.projectId, request.params.artifactId,
    idempotencyKey(request),
  ));

  app.patch('/v1/workspaces/:workspaceId', {
    schema: {
      tags: ['workspace'], security: HumanSecurity, headers: IdempotencyHeaders, params: WorkspaceParams,
      body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 120 }), expectedRevision: Type.Integer({ minimum: 1 }) }),
      response: { 200: WorkspaceResponse },
    },
  }, async (request) => {
    const principal = requireHuman(authenticate(request, service));
    return service.updateWorkspace(principal, request.params.workspaceId, request.body, idempotencyKey(request));
  });

  app.get('/v1/workspaces/:workspaceId/members', {
    schema: {
      tags: ['membership'], security: HumanSecurity, params: WorkspaceParams, querystring: CursorQuery,
      response: { 200: Type.Object({ items: Type.Array(WorkspaceMemberResponse), nextCursor: Type.Union([Type.String(), Type.Null()]) }) },
    },
  }, async (request) => {
    const principal = requireHuman(authenticate(request, service));
    return service.listWorkspaceMembers(principal, request.params.workspaceId, request.query.cursor, request.query.limit ?? 100);
  });

  app.post('/v1/workspaces/:workspaceId/projects', {
    schema: {
      tags: ['project'], security: HumanSecurity, headers: IdempotencyHeaders, params: WorkspaceParams,
      body: Type.Object({
        name: Type.String({ minLength: 1, maxLength: 120 }),
        description: Type.Optional(Type.Union([Type.String({ maxLength: 3000 }), Type.Null()])),
        repository: Type.Optional(Type.Object({
          cloneUrl: Type.String({ minLength: 1, maxLength: 2000 }),
          defaultBranch: Type.String({ minLength: 1, maxLength: 255, default: 'main' }),
        }, { additionalProperties: false })),
      }, { additionalProperties: false }),
      response: { 201: ProjectResponse },
    },
  }, async (request, reply) => {
    const principal = requireHuman(authenticate(request, service));
    return reply.status(201).send(
      service.createProject(principal, request.params.workspaceId, request.body, idempotencyKey(request)),
    );
  });

  app.get('/v1/workspaces/:workspaceId/projects', {
    schema: {
      tags: ['project'], security: HumanSecurity, params: WorkspaceParams, querystring: CursorQuery,
      response: {
        200: Type.Object({ items: Type.Array(ProjectResponse), nextCursor: Type.Union([Type.String(), Type.Null()]) }),
      },
    },
  }, async (request) => service.listProjects(
    requireHuman(authenticate(request, service)),
    request.params.workspaceId,
    request.query.cursor,
    request.query.limit ?? 100,
  ));

  app.get('/v1/projects/:projectId', {
    schema: { tags: ['project'], security: HumanSecurity, params: ProjectParams, response: { 200: ProjectResponse } },
  }, async (request) => service.getProject(
    requireHuman(authenticate(request, service)),
    request.params.projectId,
  ));

  app.patch('/v1/projects/:projectId', {
    schema: {
      tags: ['project'], security: HumanSecurity, headers: IdempotencyHeaders, params: ProjectParams,
      body: Type.Object({
        name: Type.String({ minLength: 1, maxLength: 120 }),
        description: Type.Optional(Type.Union([Type.String({ maxLength: 3000 }), Type.Null()])),
        expectedRevision: Type.Integer({ minimum: 1 }),
      }),
      response: { 200: ProjectResponse },
    },
  }, async (request) => service.updateProject(
    requireHuman(authenticate(request, service)),
    request.params.projectId,
    request.body,
    idempotencyKey(request),
  ));

  app.put('/v1/projects/:projectId/repository', {
    schema: {
      tags: ['project'], security: HumanSecurity, headers: IdempotencyHeaders, params: ProjectParams,
      body: Type.Object({
        cloneUrl: Type.String({ minLength: 1, maxLength: 2000 }),
        defaultBranch: Type.String({ minLength: 1, maxLength: 255 }),
        expectedProjectRevision: Type.Integer({ minimum: 1 }),
        expectedRepositoryRevision: Type.Optional(Type.Integer({ minimum: 1 })),
      }, { additionalProperties: false }),
      response: { 200: ProjectResponse },
    },
  }, async (request) => service.putProjectRepository(
    requireHuman(authenticate(request, service)),
    request.params.projectId,
    request.body,
    idempotencyKey(request),
  ));

  app.delete('/v1/projects/:projectId/repository', {
    schema: {
      tags: ['project'], security: HumanSecurity, headers: IdempotencyHeaders, params: ProjectParams,
      body: Type.Object({
        expectedProjectRevision: Type.Integer({ minimum: 1 }),
        expectedRepositoryRevision: Type.Integer({ minimum: 1 }),
      }, { additionalProperties: false }),
      response: { 200: ProjectResponse },
    },
  }, async (request) => service.deleteProjectRepository(
    requireHuman(authenticate(request, service)),
    request.params.projectId,
    request.body,
    idempotencyKey(request),
  ));

  app.get('/v1/projects/:projectId/resource-links', {
    schema: {
      tags: ['project'], security: HumanSecurity, params: ProjectParams,
      response: { 200: Type.Object({ items: Type.Array(ProjectResourceLinkResponse) }) },
    },
  }, async (request) => ({
    items: service.listProjectResourceLinks(requireHuman(authenticate(request, service)), request.params.projectId),
  }));

  app.post('/v1/projects/:projectId/resource-links', {
    schema: {
      tags: ['project'], security: HumanSecurity, headers: IdempotencyHeaders, params: ProjectParams,
      body: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 200 }),
        url: Type.String({ minLength: 8, maxLength: 4000 }),
        description: Type.Optional(Type.Union([Type.String({ maxLength: 3000 }), Type.Null()])),
      }, { additionalProperties: false }),
      response: { 201: ProjectResourceLinkResponse },
    },
  }, async (request, reply) => reply.status(201).send(service.createProjectResourceLink(
    requireHuman(authenticate(request, service)),
    request.params.projectId,
    request.body,
    idempotencyKey(request),
  )));

  app.patch('/v1/projects/:projectId/resource-links/:linkId', {
    schema: {
      tags: ['project'], security: HumanSecurity, headers: IdempotencyHeaders, params: ProjectResourceLinkParams,
      body: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 200 }),
        url: Type.String({ minLength: 8, maxLength: 4000 }),
        description: Type.Optional(Type.Union([Type.String({ maxLength: 3000 }), Type.Null()])),
        expectedRevision: Type.Integer({ minimum: 1 }),
      }, { additionalProperties: false }),
      response: { 200: ProjectResourceLinkResponse },
    },
  }, async (request) => service.updateProjectResourceLink(
    requireHuman(authenticate(request, service)), request.params.projectId, request.params.linkId,
    request.body, idempotencyKey(request),
  ));

  app.delete('/v1/projects/:projectId/resource-links/:linkId', {
    schema: {
      tags: ['project'], security: HumanSecurity, headers: IdempotencyHeaders, params: ProjectResourceLinkParams,
      body: RevisionBody,
      response: { 200: Type.Object({ id: Id, deletedAt: Type.Integer() }) },
    },
  }, async (request) => service.deleteProjectResourceLink(
    requireHuman(authenticate(request, service)), request.params.projectId, request.params.linkId,
    request.body.expectedRevision, idempotencyKey(request),
  ));

  app.get('/v1/projects/:projectId/working-copies', {
    schema: {
      tags: ['project'], security: HumanSecurity, params: ProjectParams,
      response: { 200: Type.Object({ items: Type.Array(ProjectWorkingCopyResponse) }) },
    },
  }, async (request) => ({
    items: service.listProjectWorkingCopies(
      requireHuman(authenticate(request, service)),
      request.params.projectId,
    ),
  }));

  app.get('/v1/projects/:projectId/members', {
    schema: {
      tags: ['project'], security: HumanSecurity, params: ProjectParams, querystring: CursorQuery,
      response: {
        200: Type.Object({ items: Type.Array(ProjectMemberResponse), nextCursor: Type.Union([Type.String(), Type.Null()]) }),
      },
    },
  }, async (request) => service.listProjectMembers(
    requireHuman(authenticate(request, service)),
    request.params.projectId,
    request.query.cursor,
    request.query.limit ?? 100,
  ));

  app.post('/v1/projects/:projectId/members', {
    schema: {
      tags: ['project'], security: HumanSecurity, headers: IdempotencyHeaders, params: ProjectParams,
      body: Type.Object({ workspaceMembershipId: Id, role: ProjectRoleSchema }),
      response: { 201: ProjectMemberResponse },
    },
  }, async (request, reply) => reply.status(201).send(service.addProjectMember(
    requireHuman(authenticate(request, service)),
    request.params.projectId,
    request.body,
    idempotencyKey(request),
  )));

  app.patch('/v1/projects/:projectId/members/:projectMembershipId', {
    schema: {
      tags: ['project'], security: HumanSecurity, headers: IdempotencyHeaders, params: ProjectMemberParams,
      body: Type.Object({ role: ProjectRoleSchema, expectedRevision: Type.Integer({ minimum: 1 }) }),
      response: { 200: ProjectMemberResponse },
    },
  }, async (request) => service.updateProjectMember(
    requireHuman(authenticate(request, service)),
    request.params.projectId,
    request.params.projectMembershipId,
    request.body,
    idempotencyKey(request),
  ));

  const ProjectMemberRemovalResponse = Type.Object({
    projectMembershipId: Id,
    revision: Type.Integer(),
    removedAt: Type.Integer(),
    cancelledAgentRequestIds: Type.Array(Id),
  });

  app.delete('/v1/projects/:projectId/members/:projectMembershipId', {
    schema: {
      tags: ['project'], security: HumanSecurity, headers: IdempotencyHeaders, params: ProjectMemberParams,
      body: RevisionBody,
      response: { 200: ProjectMemberRemovalResponse },
    },
  }, async (request) => service.removeProjectMember(
    requireHuman(authenticate(request, service)),
    request.params.projectId,
    request.params.projectMembershipId,
    request.body.expectedRevision,
    idempotencyKey(request),
  ));

  app.post('/v1/projects/:projectId/leave', {
    schema: {
      tags: ['project'], security: HumanSecurity, headers: IdempotencyHeaders, params: ProjectParams,
      body: RevisionBody,
      response: { 200: ProjectMemberRemovalResponse },
    },
  }, async (request) => service.leaveProject(
    requireHuman(authenticate(request, service)),
    request.params.projectId,
    request.body.expectedRevision,
    idempotencyKey(request),
  ));

  app.get('/v1/workspaces/:workspaceId/invitations', {
    schema: {
      tags: ['membership'], security: HumanSecurity, params: WorkspaceParams, querystring: CursorQuery,
      response: { 200: Type.Object({ items: Type.Array(InvitationResponse), nextCursor: Type.Union([Type.String(), Type.Null()]) }) },
    },
  }, async (request) => {
    const principal = requireHuman(authenticate(request, service));
    return service.listInvitations(principal, request.params.workspaceId, request.query.cursor, request.query.limit ?? 100);
  });

  app.post('/v1/workspaces/:workspaceId/invitations', {
    schema: {
      tags: ['membership'], security: HumanSecurity, headers: IdempotencyHeaders, params: WorkspaceParams,
      body: Type.Object({
        verifiedEmail: Type.String({ minLength: 3, maxLength: 320 }),
        membershipRole: Type.Union([Type.Literal('owner'), Type.Literal('member')]),
      }),
      response: { 201: InvitationResponse },
    },
  }, async (request, reply) => {
    const principal = requireHuman(authenticate(request, service));
    return reply.status(201).send(
      service.createInvitation(principal, request.params.workspaceId, request.body, idempotencyKey(request)),
    );
  });

  app.post('/v1/invitations/:invitationId/accept', {
    schema: {
      tags: ['membership'], security: HumanSecurity, headers: IdempotencyHeaders, params: InvitationParams,
      body: RevisionBody, response: { 200: WorkspaceMemberResponse },
    },
  }, async (request) => {
    const principal = requireHuman(authenticate(request, service));
    return service.acceptInvitation(
      principal,
      request.params.invitationId,
      request.body.expectedRevision,
      idempotencyKey(request),
    );
  });

  app.post('/v1/invitations/:invitationId/revoke', {
    schema: {
      tags: ['membership'], security: HumanSecurity, headers: IdempotencyHeaders, params: InvitationParams,
      body: RevisionBody, response: { 200: InvitationResponse },
    },
  }, async (request) => {
    const principal = requireHuman(authenticate(request, service));
    return service.revokeInvitation(
      principal,
      request.params.invitationId,
      request.body.expectedRevision,
      idempotencyKey(request),
    );
  });

  app.patch('/v1/workspaces/:workspaceId/members/:membershipId', {
    schema: {
      tags: ['membership'], security: HumanSecurity, headers: IdempotencyHeaders, params: WorkspaceMemberParams,
      body: Type.Object({
        membershipRole: Type.Union([Type.Literal('owner'), Type.Literal('member')]),
        expectedRevision: Type.Integer({ minimum: 1 }),
      }),
      response: { 200: WorkspaceMemberResponse },
    },
  }, async (request) => {
    const principal = requireHuman(authenticate(request, service));
    return service.updateWorkspaceMember(
      principal,
      request.params.workspaceId,
      request.params.membershipId,
      request.body,
      idempotencyKey(request),
    );
  });

  app.delete('/v1/workspaces/:workspaceId/members/:membershipId', {
    schema: {
      tags: ['membership'], security: HumanSecurity, headers: IdempotencyHeaders, params: WorkspaceMemberParams,
      body: RevisionBody,
      response: { 200: Type.Object({ membershipId: Id, revision: Type.Integer(), removedAt: Type.Integer() }) },
    },
  }, async (request) => {
    const principal = requireHuman(authenticate(request, service));
    return service.removeWorkspaceMember(
      principal,
      request.params.workspaceId,
      request.params.membershipId,
      request.body.expectedRevision,
      idempotencyKey(request),
    );
  });

  app.post('/v1/workspaces/:workspaceId/leave', {
    schema: {
      tags: ['membership'], security: HumanSecurity, headers: IdempotencyHeaders, params: WorkspaceParams,
      body: RevisionBody,
      response: { 200: Type.Object({ membershipId: Id, revision: Type.Integer(), removedAt: Type.Integer() }) },
    },
  }, async (request) => {
    const principal = requireHuman(authenticate(request, service));
    return service.leaveWorkspace(
      principal,
      request.params.workspaceId,
      request.body.expectedRevision,
      idempotencyKey(request),
    );
  });

  app.post('/v1/computers', {
    schema: {
      tags: ['runtime'], security: HumanSecurity, headers: IdempotencyHeaders,
      body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 120 }), label: Type.Optional(Type.String({ maxLength: 120 })) }),
      response: {
        201: Type.Object({ computerId: Id, token: Type.String(), name: Type.String(), createdAt: Type.Integer() }),
      },
    },
  }, async (request, reply) => {
    const principal = requireHuman(authenticate(request, service));
    return reply.status(201).send(service.registerComputer(principal, request.body, idempotencyKey(request)));
  });

  app.get('/v1/computers', {
    schema: {
      tags: ['runtime'], security: HumanSecurity,
      response: { 200: Type.Object({ items: Type.Array(ComputerResponse) }) },
    },
  }, async (request) => {
    const principal = requireHuman(authenticate(request, service));
    return { items: service.listComputers(principal) };
  });

  app.put('/v1/computers/self/runtime-catalog', {
    schema: {
      tags: ['runtime'], security: BearerSecurity,
      body: Type.Object({
        runtimes: Type.Array(Type.Object({
          runtimeId: RuntimeIdSchema,
          availability: RuntimeAvailabilitySchema,
          detectedVersion: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
          configuration: Type.Optional(RuntimeConfigurationCapabilitiesSchema),
          skills: RuntimeSkillCatalogSchema,
          unavailableReason: Type.Optional(RuntimeUnavailableReasonSchema),
        }), { minItems: 1, maxItems: 100 }),
      }),
      response: { 200: ComputerPresenceResponse },
    },
  }, async (request) => service.reportComputerRuntimeCatalog(
    requireComputer(authenticate(request, service)),
    request.body,
  ));

  app.post('/v1/computers/self/heartbeat', {
    schema: {
      tags: ['runtime'], security: BearerSecurity,
      response: { 200: ComputerPresenceResponse },
    },
  }, async (request) => service.heartbeatComputer(requireComputer(authenticate(request, service))));

  app.post('/v1/computers/self/projects', {
    schema: {
      tags: ['project'], security: BearerSecurity, headers: IdempotencyHeaders,
      body: Type.Object({
        workspaceId: Id,
        name: Type.String({ minLength: 1, maxLength: 120 }),
        description: Type.Optional(Type.Union([Type.String({ maxLength: 3000 }), Type.Null()])),
        repository: Type.Object({
          cloneUrl: Type.String({ minLength: 1, maxLength: 2000 }),
          repositoryIdentity: Type.String({ minLength: 3, maxLength: 1000 }),
          defaultBranch: Type.String({ minLength: 1, maxLength: 255 }),
        }, { additionalProperties: false }),
        workingCopy: NewProjectWorkingCopyReportBody,
      }, { additionalProperties: false }),
      response: { 201: ProjectResponse },
    },
  }, async (request, reply) => reply.status(201).send(service.createProjectFromComputer(
    requireComputer(authenticate(request, service)),
    request.body,
    idempotencyKey(request),
  )));

  app.get('/v1/computers/self/projects/:projectId/repository', {
    schema: {
      tags: ['project'], security: BearerSecurity, params: ProjectParams,
      response: { 200: Type.Object({
        projectId: Id,
        workspaceId: Id,
        repository: ProjectRepositoryResponse,
      }) },
    },
  }, async (request) => service.getComputerProjectRepository(
    requireComputer(authenticate(request, service)),
    request.params.projectId,
  ));

  app.put('/v1/computers/self/projects/:projectId/working-copy', {
    schema: {
      tags: ['project'], security: BearerSecurity, headers: IdempotencyHeaders,
      params: ProjectParams,
      body: ProjectWorkingCopyReportBody,
      response: { 200: ProjectWorkingCopyResponse },
    },
  }, async (request) => service.reportProjectWorkingCopy(
    requireComputer(authenticate(request, service)),
    request.params.projectId,
    request.body,
    idempotencyKey(request),
  ));

  app.delete('/v1/computers/self/projects/:projectId/working-copy', {
    schema: {
      tags: ['project'], security: BearerSecurity, headers: IdempotencyHeaders,
      params: ProjectParams,
      response: { 200: Type.Object({ projectId: Id, computerId: Id, removedAt: Type.Integer() }) },
    },
  }, async (request) => service.removeProjectWorkingCopy(
    requireComputer(authenticate(request, service)),
    request.params.projectId,
    idempotencyKey(request),
  ));

  app.get('/v1/computers/self/agent-requests', {
    schema: {
      tags: ['execution'], security: BearerSecurity,
      querystring: Type.Object({
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
      }),
      response: { 200: Type.Object({ items: Type.Array(AgentRequestResponse) }) },
    },
  }, async (request) => {
    const principal = requireComputer(authenticate(request, service));
    return { items: service.listComputerAgentRequests(principal.computerId, request.query.limit ?? 20) };
  });

  app.post('/v1/workspaces/:workspaceId/agents', {
    schema: {
      tags: ['agent'], security: HumanSecurity, headers: IdempotencyHeaders, params: WorkspaceParams,
      body: Type.Object({
        name: Type.String({ minLength: 1, maxLength: 120 }),
        description: Type.Optional(Type.String({ maxLength: 2000 })),
        runtimeBinding: Type.Optional(RuntimeBindingInput),
      }),
      response: { 201: AgentResponse },
    },
  }, async (request, reply) => {
    const principal = requireHuman(authenticate(request, service));
    return reply.status(201).send(
      service.createAgent(principal, request.params.workspaceId, request.body, idempotencyKey(request)),
    );
  });

  app.get('/v1/workspaces/:workspaceId/agents', {
    schema: {
      tags: ['agent'], security: HumanSecurity, params: WorkspaceParams, querystring: CursorQuery,
      response: { 200: Type.Object({ items: Type.Array(AgentResponse), nextCursor: Type.Union([Type.String(), Type.Null()]) }) },
    },
  }, async (request) => {
    const principal = requireHuman(authenticate(request, service));
    return service.listAgents(principal, request.params.workspaceId, request.query.cursor, request.query.limit ?? 100);
  });

  app.get('/v1/workspaces/:workspaceId/agents/:agentId', {
    schema: {
      tags: ['agent'], security: HumanSecurity, params: AgentParams, response: { 200: AgentResponse },
    },
  }, async (request) => {
    const principal = requireHuman(authenticate(request, service));
    return service.getAgent(principal, request.params.workspaceId, request.params.agentId);
  });

  app.delete('/v1/workspaces/:workspaceId/agents/:agentId', {
    schema: {
      tags: ['agent'], security: HumanSecurity, headers: IdempotencyHeaders, params: AgentParams,
      body: RevisionBody, response: { 200: DeleteAgentResponse },
    },
  }, async (request) => service.deleteAgent(
    requireHuman(authenticate(request, service)),
    request.params.workspaceId,
    request.params.agentId,
    request.body.expectedRevision,
    idempotencyKey(request),
  ));

  app.get('/v1/workspaces/:workspaceId/agents/:agentId/skills', {
    schema: {
      tags: ['runtime'], security: HumanSecurity, params: AgentParams,
      response: { 200: AgentRuntimeSkillsResponse },
    },
  }, async (request) => service.getAgentRuntimeSkills(
    requireHuman(authenticate(request, service)),
    request.params.workspaceId,
    request.params.agentId,
  ));

  app.get('/v1/workspaces/:workspaceId/agents/:agentId/execution-policy', {
    schema: { tags: ['context'], security: HumanSecurity, params: AgentParams, response: { 200: ExecutionPolicyResponse } },
  }, async (request) => service.getExecutionPolicy(
    requireHuman(authenticate(request, service)), request.params.workspaceId, request.params.agentId,
  ));

  app.put('/v1/workspaces/:workspaceId/agents/:agentId/execution-policy', {
    schema: {
      tags: ['context'], security: HumanSecurity, headers: IdempotencyHeaders, params: AgentParams,
      body: Type.Object({ expectedVersion: Type.Integer({ minimum: 1 }), ...ExecutionPolicyFields }),
      response: { 200: ExecutionPolicyResponse },
    },
  }, async (request) => service.updateExecutionPolicy(
    requireHuman(authenticate(request, service)), request.params.workspaceId, request.params.agentId,
    request.body, idempotencyKey(request),
  ));

  app.patch('/v1/workspaces/:workspaceId/agents/:agentId', {
    schema: {
      tags: ['agent'], security: HumanSecurity, headers: IdempotencyHeaders, params: AgentParams,
      body: Type.Object({
        name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
        description: Type.Optional(Type.Union([Type.String({ maxLength: 2000 }), Type.Null()])),
        expectedRevision: Type.Integer({ minimum: 1 }),
      }),
      response: { 200: AgentResponse },
    },
  }, async (request) => {
    const principal = requireHuman(authenticate(request, service));
    return service.updateAgent(
      principal,
      request.params.workspaceId,
      request.params.agentId,
      request.body,
      idempotencyKey(request),
    );
  });

  app.post('/v1/workspaces/:workspaceId/agents/:agentId/suspend', {
    schema: {
      tags: ['agent'], security: HumanSecurity, headers: IdempotencyHeaders, params: AgentParams,
      body: RevisionBody, response: { 200: AgentResponse },
    },
  }, async (request) => {
    const principal = requireHuman(authenticate(request, service));
    return service.suspendAgent(
      principal,
      request.params.workspaceId,
      request.params.agentId,
      request.body.expectedRevision,
      idempotencyKey(request),
    );
  });

  app.post('/v1/workspaces/:workspaceId/agents/:agentId/resume', {
    schema: {
      tags: ['agent'], security: HumanSecurity, headers: IdempotencyHeaders, params: AgentParams,
      body: RevisionBody, response: { 200: AgentResponse },
    },
  }, async (request) => {
    const principal = requireHuman(authenticate(request, service));
    return service.resumeAgent(
      principal,
      request.params.workspaceId,
      request.params.agentId,
      request.body.expectedRevision,
      idempotencyKey(request),
    );
  });

  app.post('/v1/workspaces/:workspaceId/agents/:agentId/restart', {
    schema: {
      tags: ['agent'], security: HumanSecurity, headers: IdempotencyHeaders, params: AgentParams,
      body: RevisionBody, response: { 200: AgentResponse },
    },
  }, async (request) => {
    const principal = requireHuman(authenticate(request, service));
    return service.restartAgent(
      principal,
      request.params.workspaceId,
      request.params.agentId,
      request.body.expectedRevision,
      idempotencyKey(request),
    );
  });

  app.post('/v1/workspaces/:workspaceId/agents/:agentId/ownership', {
    schema: {
      tags: ['agent'], security: HumanSecurity, headers: IdempotencyHeaders, params: AgentParams,
      body: Type.Object({
        newOwnerMembershipId: Id,
        expectedRevision: Type.Integer({ minimum: 1 }),
      }),
      response: { 200: AgentResponse },
    },
  }, async (request) => {
    const principal = requireHuman(authenticate(request, service));
    return service.transferAgentOwnership(
      principal,
      request.params.workspaceId,
      request.params.agentId,
      request.body,
      idempotencyKey(request),
    );
  });

  app.delete('/v1/workspaces/:workspaceId/agents/:agentId/membership', {
    schema: {
      tags: ['agent'], security: HumanSecurity, headers: IdempotencyHeaders, params: AgentParams,
      body: RevisionBody, response: { 200: TerminateAgentMembershipResponse },
    },
  }, async (request) => service.terminateAgentMembership(
    requireHuman(authenticate(request, service)),
    request.params.workspaceId,
    request.params.agentId,
    request.body.expectedRevision,
    idempotencyKey(request),
  ));

  app.post('/v1/workspaces/:workspaceId/agents/:agentId/membership/readmit', {
    schema: {
      tags: ['agent'], security: HumanSecurity, headers: IdempotencyHeaders, params: AgentParams,
      body: RevisionBody, response: { 200: AgentResponse },
    },
  }, async (request) => service.readmitAgentMembership(
    requireHuman(authenticate(request, service)),
    request.params.workspaceId,
    request.params.agentId,
    request.body.expectedRevision,
    idempotencyKey(request),
  ));

  app.post('/v1/workspaces/:workspaceId/agents/:agentId/runtime-bindings', {
    schema: {
      tags: ['runtime'], security: HumanSecurity, headers: IdempotencyHeaders, params: AgentParams,
      body: RuntimeBindingUpdateInput,
      response: { 201: RuntimeBindingResponse },
    },
  }, async (request, reply) => {
    const principal = requireHuman(authenticate(request, service));
    return reply.status(201).send(
      service.bindAgentRuntime(
        principal,
        request.params.workspaceId,
        request.params.agentId,
        request.body,
        idempotencyKey(request),
      ),
    );
  });

  app.post('/v1/workspaces/:workspaceId/conversations', {
    schema: {
      tags: ['conversation'], security: HumanSecurity, headers: IdempotencyHeaders, params: WorkspaceParams,
      body: Type.Object({
        kind: Type.Union([Type.Literal('channel'), Type.Literal('dm')]),
        title: Type.Optional(Type.String({ maxLength: 200 })),
        directWorkspaceMembershipIds: Type.Optional(Type.Array(Id, { uniqueItems: true, maxItems: 1 })),
      }, { additionalProperties: false }),
      response: { 201: ConversationResponse },
    },
  }, async (request, reply) => {
    const principal = requireHuman(authenticate(request, service));
    return reply.status(201).send(
      service.createConversation(principal, request.params.workspaceId, request.body, idempotencyKey(request)),
    );
  });

  app.get('/v1/workspaces/:workspaceId/conversations', {
    schema: {
      tags: ['conversation'], security: HumanSecurity, params: WorkspaceParams, querystring: ConversationListQuery,
      response: { 200: Type.Object({ items: Type.Array(ConversationResponse), nextCursor: Type.Union([Type.String(), Type.Null()]) }) },
    },
  }, async (request) => {
    const principal = requireHuman(authenticate(request, service));
    return service.listConversations(
      principal,
      request.params.workspaceId,
      request.query.cursor,
      request.query.limit ?? 100,
      request.query.lifecycleStatus ?? 'active',
    );
  });

  app.post('/v1/projects/:projectId/conversations', {
    schema: {
      tags: ['conversation'], security: HumanSecurity, headers: IdempotencyHeaders, params: ProjectParams,
      body: Type.Object({
        kind: Type.Literal('channel'),
        title: Type.Optional(Type.String({ maxLength: 200 })),
      }, { additionalProperties: false }),
      response: { 201: ConversationResponse },
    },
  }, async (request, reply) => reply.status(201).send(service.createProjectConversation(
    requireHuman(authenticate(request, service)),
    request.params.projectId,
    request.body,
    idempotencyKey(request),
  )));

  app.get('/v1/projects/:projectId/conversations', {
    schema: {
      tags: ['conversation'], security: HumanSecurity, params: ProjectParams, querystring: ConversationListQuery,
      response: {
        200: Type.Object({ items: Type.Array(ConversationResponse), nextCursor: Type.Union([Type.String(), Type.Null()]) }),
      },
    },
  }, async (request) => service.listProjectConversations(
    requireHuman(authenticate(request, service)),
    request.params.projectId,
    request.query.cursor,
    request.query.limit ?? 100,
    request.query.lifecycleStatus ?? 'active',
  ));

  app.get('/v1/conversations/:conversationId', {
    schema: { tags: ['conversation'], security: HumanSecurity, params: ConversationParams, response: { 200: ConversationResponse } },
  }, async (request) => {
    const principal = requireHuman(authenticate(request, service));
    return service.getConversation(principal, request.params.conversationId);
  });

  app.post('/v1/conversations/:conversationId/archive', {
    schema: {
      tags: ['conversation'], security: HumanSecurity, headers: IdempotencyHeaders,
      params: ConversationParams, body: RevisionBody, response: { 200: ConversationResponse },
    },
  }, async (request) => service.archiveConversation(
    requireHuman(authenticate(request, service)),
    request.params.conversationId,
    request.body.expectedRevision,
    idempotencyKey(request),
  ));

  app.post('/v1/conversations/:conversationId/restore', {
    schema: {
      tags: ['conversation'], security: HumanSecurity, headers: IdempotencyHeaders,
      params: ConversationParams, body: RevisionBody, response: { 200: ConversationResponse },
    },
  }, async (request) => service.restoreConversation(
    requireHuman(authenticate(request, service)),
    request.params.conversationId,
    request.body.expectedRevision,
    idempotencyKey(request),
  ));

  app.post('/v1/conversations/:conversationId/messages', {
    schema: {
      tags: ['message'], security: HumanSecurity, headers: IdempotencyHeaders, params: ConversationParams,
      body: Type.Object({
        body: Type.String({ minLength: 1, maxLength: 100000 }),
        mentionedActorIds: Type.Optional(Type.Array(Id, { uniqueItems: true, maxItems: 50 })),
        artifactSelections: Type.Optional(Type.Array(Type.Object({
          artifactId: Id,
          snapshotId: Type.Union([Id, Type.Null()]),
        }, { additionalProperties: false }), { maxItems: 100 })),
      }, { additionalProperties: false }),
      response: { 201: MessageResponse },
    },
  }, async (request, reply) => {
    const principal = requireHuman(authenticate(request, service));
    return reply.status(201).send(
      service.postMessage(principal, request.params.conversationId, request.body, idempotencyKey(request)),
    );
  });

  app.post('/v1/messages/:messageId/replies', {
    schema: {
      tags: ['message'], security: HumanSecurity, headers: IdempotencyHeaders, params: MessageParams,
      body: Type.Object({
        body: Type.String({ minLength: 1, maxLength: 100000 }),
        mentionedActorIds: Type.Optional(Type.Array(Id, { uniqueItems: true, maxItems: 50 })),
        artifactSelections: Type.Optional(Type.Array(Type.Object({
          artifactId: Id,
          snapshotId: Type.Union([Id, Type.Null()]),
        }, { additionalProperties: false }), { maxItems: 100 })),
      }, { additionalProperties: false }),
      response: { 201: MessageResponse },
    },
  }, async (request, reply) => {
    const principal = requireHuman(authenticate(request, service));
    return reply.status(201).send(
      service.replyToMessage(principal, request.params.messageId, request.body, idempotencyKey(request)),
    );
  });

  app.get('/v1/conversations/:conversationId/messages', {
    schema: {
      tags: ['message'], security: HumanSecurity, params: ConversationParams,
      querystring: Type.Object({
        afterVersion: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 100 })),
      }),
      response: { 200: Type.Object({ items: Type.Array(MessageResponse) }) },
    },
  }, async (request) => {
    const principal = requireHuman(authenticate(request, service));
    return {
      items: service.listMessages(
        principal,
        request.params.conversationId,
        request.query.afterVersion ?? 0,
        request.query.limit ?? 100,
      ),
    };
  });

  app.get('/v1/conversations/:conversationId/participants', {
    schema: {
      tags: ['conversation'], security: HumanSecurity, params: ConversationParams,
      response: { 200: Type.Object({ items: Type.Array(ConversationParticipantResponse) }) },
    },
  }, async (request) => {
    const principal = requireHuman(authenticate(request, service));
    return { items: service.listConversationParticipants(principal, request.params.conversationId) };
  });

  app.get('/v1/conversations/:conversationId/agent-requests', {
    schema: {
      tags: ['agent-request'], security: HumanSecurity, params: ConversationParams,
      querystring: Type.Object({
        threadId: Type.Optional(Id),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 100 })),
      }),
      response: { 200: Type.Object({ items: Type.Array(AgentRequestResponse) }) },
    },
  }, async (request) => {
    const principal = requireHuman(authenticate(request, service));
    return {
      items: service.listAgentRequests(
        principal,
        request.params.conversationId,
        request.query.threadId,
        request.query.limit ?? 100,
      ),
    };
  });

  app.get('/v1/agent-requests/:agentRequestId', {
    schema: {
      tags: ['agent-request'], security: HumanSecurity, params: AgentRequestParams,
      response: { 200: AgentRequestResponse },
    },
  }, async (request) => {
    const principal = requireHuman(authenticate(request, service));
    return service.getAgentRequest(principal, request.params.agentRequestId);
  });

  app.post('/v1/agent-requests/:agentRequestId/cancel', {
    schema: {
      tags: ['agent-request'], security: HumanSecurity, headers: IdempotencyHeaders, params: AgentRequestParams,
      body: Type.Object({
        expectedVersion: Type.Integer({ minimum: 1 }),
      }),
      response: { 200: AgentRequestResponse },
    },
  }, async (request) => {
    const principal = requireHuman(authenticate(request, service));
    return service.cancelAgentRequest(principal, request.params.agentRequestId, request.body, idempotencyKey(request));
  });

  app.post('/v1/agent-requests/:agentRequestId/accept', {
    schema: {
      tags: ['execution'], security: BearerSecurity, headers: IdempotencyHeaders, params: AgentRequestParams,
      body: Type.Object({
        expectedVersion: Type.Integer({ minimum: 1 }),
        budget: Type.Optional(Type.Partial(BudgetResponse)),
      }),
      response: { 201: RunResponse },
    },
  }, async (request, reply) => {
    const principal = requireComputer(authenticate(request, service));
    return reply.status(201).send(service.acceptAgentRequest(
      principal.computerId, request.params.agentRequestId, request.body, idempotencyKey(request),
    ));
  });

  app.post('/v1/runs/:runId/attempts', {
    schema: {
      tags: ['execution'], security: BearerSecurity, headers: IdempotencyHeaders, params: RunParams,
      response: { 201: AttemptResponse },
    },
  }, async (request, reply) => {
    const principal = requireComputer(authenticate(request, service));
    return reply.status(201).send(service.createAttempt(principal.computerId, request.params.runId, idempotencyKey(request)));
  });

  app.get('/v1/runs/:runId/context-snapshot', {
    schema: { tags: ['context'], security: BearerSecurity, params: RunParams, response: { 200: RunContextSnapshotResponse } },
  }, async (request) => {
    const principal = requireComputer(authenticate(request, service));
    service.authorizeComputerForRunRequest(principal.computerId, request.params.runId);
    return service.getRunContextSnapshot(request.params.runId);
  });

  app.get('/v1/workspaces/:workspaceId/changes', {
    schema: {
      tags: ['change-stream'], security: HumanSecurity, params: WorkspaceParams,
      querystring: Type.Object({
        after: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 100 })),
      }),
      response: { 200: Type.Object({ items: Type.Array(ChangeResponse), nextCursor: Type.Integer() }) },
    },
  }, async (request) => {
    const principal = requireHuman(authenticate(request, service));
    return service.followChanges(
      principal,
      request.params.workspaceId,
      request.query.after ?? 0,
      request.query.limit ?? 100,
    );
  });

  app.get('/v1/attempts/:attemptId/execution-input', {
    schema: {
      tags: ['execution'], security: BearerSecurity, params: AttemptParams,
      response: { 200: AttemptExecutionInputResponse },
    },
  }, async (request) => {
    const principal = requireComputer(authenticate(request, service));
    return service.getAttemptExecutionInput(principal.computerId, request.params.attemptId);
  });

  app.get('/v1/computers/self/agents/:agentId/inbox', {
    schema: {
      tags: ['agent-inbox'], security: BearerSecurity, params: ComputerAgentParams,
      response: { 200: AgentInboxSummaryResponse },
    },
  }, async (request) => {
    const principal = requireComputer(authenticate(request, service));
    return service.getComputerAgentInbox(principal.computerId, request.params.agentId);
  });

  app.post('/v1/computers/self/agent-inbox-wakes', {
    schema: {
      tags: ['agent-inbox'], security: BearerSecurity,
      body: Type.Object({
        after: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
      }, { additionalProperties: false }),
      response: { 200: AgentInboxWakeBatchResponse },
    },
  }, async (request) => {
    const principal = requireComputer(authenticate(request, service));
    return service.waitForComputerAgentInboxWakes(principal.computerId, request.body.after);
  });

  app.post('/v1/computers/self/agents/:agentId/inbox/claim', {
    schema: {
      tags: ['agent-inbox'], security: BearerSecurity, headers: IdempotencyHeaders, params: ComputerAgentParams,
      body: Type.Object({
        attemptId: Id,
        conversationId: Id,
        threadId: Type.Union([Id, Type.Null()]),
        receipt: Type.String({ minLength: 1, maxLength: 500 }),
      }, { additionalProperties: false }),
      response: { 200: AgentInboxClaimResponse },
    },
  }, async (request) => {
    const principal = requireComputer(authenticate(request, service));
    return service.claimComputerAgentInbox(principal.computerId, request.params.agentId, request.body);
  });

  app.get('/v1/computers/self/agents/:agentId/messages', {
    schema: {
      tags: ['agent-inbox'], security: BearerSecurity, params: ComputerAgentParams,
      querystring: Type.Object({
        attemptId: Id,
        conversationId: Id,
        threadId: Type.Optional(Id),
        before: Type.Optional(Type.Integer({ minimum: 1 })),
        after: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      }),
      response: { 200: Type.Object({ items: Type.Array(MessageResponse) }) },
    },
  }, async (request) => {
    const principal = requireComputer(authenticate(request, service));
    return { items: service.readComputerAgentMessages(principal.computerId, request.params.agentId, {
      attemptId: request.query.attemptId,
      conversationId: request.query.conversationId,
      threadId: request.query.threadId ?? null,
      ...(request.query.before === undefined ? {} : { before: request.query.before }),
      ...(request.query.after === undefined ? {} : { after: request.query.after }),
      ...(request.query.limit === undefined ? {} : { limit: request.query.limit }),
    }) };
  });

  app.get('/v1/computers/self/agents/:agentId/messages/:messageId', {
    schema: {
      tags: ['agent-inbox'], security: BearerSecurity, params: ComputerAgentMessageParams,
      querystring: Type.Object({ attemptId: Id, conversationId: Id, threadId: Type.Optional(Id) }),
      response: { 200: MessageResponse },
    },
  }, async (request) => {
    const principal = requireComputer(authenticate(request, service));
    return service.resolveComputerAgentMessage(principal.computerId, request.params.agentId, {
      attemptId: request.query.attemptId,
      conversationId: request.query.conversationId,
      threadId: request.query.threadId ?? null,
      messageId: request.params.messageId,
    });
  });

  app.post('/v1/computers/self/agents/:agentId/messages', {
    schema: {
      tags: ['agent-inbox'], security: BearerSecurity, headers: IdempotencyHeaders, params: ComputerAgentParams,
      body: Type.Object({
        attemptId: Id,
        conversationId: Id,
        threadId: Type.Union([Id, Type.Null()]),
        receipt: Type.String({ minLength: 1, maxLength: 500 }),
        body: Type.String({ minLength: 1, maxLength: 100000 }),
      }, { additionalProperties: false }),
      response: { 201: MessageResponse },
    },
  }, async (request, reply) => {
    const principal = requireComputer(authenticate(request, service));
    return reply.status(201).send(service.sendComputerAgentMessage(
      principal.computerId,
      request.params.agentId,
      request.body,
      idempotencyKey(request),
    ));
  });

  app.post('/v1/attempts/:attemptId/context-reads', {
    schema: {
      tags: ['context'], security: BearerSecurity, params: AttemptParams,
      body: Type.Object({
        source: ContextSourceResponse,
        privateGrantId: Type.Optional(Id),
        purpose: Type.String({ minLength: 1, maxLength: 500 }),
      }),
      response: { 201: Type.Object({
        id: Id, workspaceId: Id, runId: Id, attemptId: Id, source: ContextSourceResponse,
        agentMembershipId: Id, privateGrantId: Type.Union([Id, Type.Null()]), purpose: Type.String(), createdAt: Type.Integer(),
      }) },
    },
  }, async (request, reply) => {
    const principal = requireComputer(authenticate(request, service));
    return reply.status(201).send(service.recordContextRead(principal.computerId, request.params.attemptId, request.body));
  });

  app.post('/v1/runs/:runId/private-context-grants', {
    schema: {
      tags: ['privacy'], security: HumanSecurity, headers: IdempotencyHeaders, params: RunParams,
      body: Type.Object({
        sourceCategory: Type.Union([Type.Literal('local_file'), Type.Literal('local_memory'), Type.Literal('local_tool')]),
        readAllowed: Type.Boolean(), disclosureAllowed: Type.Boolean(), expiresAt: Type.Integer(),
      }),
      response: { 201: PrivateGrantResponse },
    },
  }, async (request, reply) => reply.status(201).send(service.createPrivateContextGrant(
    requireHuman(authenticate(request, service)), request.params.runId, request.body, idempotencyKey(request),
  )));

  app.get('/v1/runs/:runId/private-context-grants', {
    schema: {
      tags: ['privacy'], security: HumanSecurity, params: RunParams,
      response: { 200: Type.Object({ items: Type.Array(PrivateGrantResponse) }) },
    },
  }, async (request) => ({
    items: service.listPrivateContextGrants(requireHuman(authenticate(request, service)), request.params.runId),
  }));

  app.post('/v1/private-context-grants/:grantId/revoke', {
    schema: {
      tags: ['privacy'], security: HumanSecurity, headers: IdempotencyHeaders, params: PrivateGrantParams,
      response: { 200: PrivateGrantResponse },
    },
  }, async (request) => service.revokePrivateContextGrant(
    requireHuman(authenticate(request, service)), request.params.grantId, idempotencyKey(request),
  ));

  const ReturnMessageDraft = Type.Object({
    body: Type.String({ minLength: 1, maxLength: 100000 }),
    privateGrantIds: Type.Optional(Type.Array(Id, { uniqueItems: true })),
  });
  const ArtifactPublicationIntent = Type.Object({
    stagedBlobId: Id,
    artifactId: Type.Optional(Id),
    name: Type.String({ minLength: 1, maxLength: 500 }),
    artifactType: Type.Union([Type.Literal('markdown'), Type.Literal('file')]),
    projectIds: Type.Optional(Type.Array(Id, { uniqueItems: true, maxItems: 100 })),
    expectedCurrentRevision: Type.Optional(Type.Integer({ minimum: 0 })),
    expectedContentDigest: Type.Optional(Type.String({ minLength: 64, maxLength: 64 })),
    attachToMessageIndexes: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }), { uniqueItems: true, maxItems: 50 })),
    privateGrantIds: Type.Optional(Type.Array(Id, { uniqueItems: true })),
  }, { additionalProperties: false });
  app.post('/v1/attempts/:attemptId/staged-blobs', {
    schema: {
      tags: ['execution', 'artifact'], security: BearerSecurity, params: AttemptParams,
      consumes: ['multipart/form-data'], response: { 201: StagedBlobResponse },
    },
  }, async (request, reply) => {
    const principal = requireComputer(authenticate(request, service));
    const upload = await request.file({ limits: { fileSize: MAX_ARTIFACT_BYTES, files: 1 } });
    invariant(upload, 'STAGED_BLOB_FILE_REQUIRED', 'A staged file upload is required.');
    const stored = await service.artifacts.blobs.write(upload.file, upload.mimetype);
    return reply.status(201).send(service.stageAttemptBlob(principal.computerId, request.params.attemptId, stored));
  });
  app.post('/v1/attempts/:attemptId/return', {
    schema: {
      tags: ['execution'], security: BearerSecurity, headers: IdempotencyHeaders, params: AttemptParams,
      body: Type.Object({
        disposition: Type.Union([Type.Literal('publish'), Type.Literal('no_output'), Type.Literal('discard')]),
        messages: Type.Array(ReturnMessageDraft, { maxItems: 50 }),
        artifactPublications: Type.Array(ArtifactPublicationIntent, { maxItems: 100 }),
      }),
      response: { 200: Type.Object({
        run: RunResponse,
        attempt: AttemptResponse,
        publishedMessages: Type.Array(MessageResponse),
        publishedArtifacts: Type.Array(ArtifactResponse),
      }) },
    },
  }, async (request) => {
    const principal = requireComputer(authenticate(request, service));
    return service.returnAttempt(principal.computerId, request.params.attemptId, request.body, idempotencyKey(request));
  });

  app.post('/v1/attempts/:attemptId/fail', {
    schema: {
      tags: ['execution'], security: BearerSecurity, headers: IdempotencyHeaders, params: AttemptParams,
      body: Type.Object({ reason: Type.String({ minLength: 1, maxLength: 2000 }) }),
      response: { 200: Type.Object({ run: RunResponse, attempt: AttemptResponse }) },
    },
  }, async (request) => {
    const principal = requireComputer(authenticate(request, service));
    return service.failAttempt(
      principal.computerId,
      request.params.attemptId,
      request.body.reason,
      idempotencyKey(request),
    );
  });

  return app;
}

function authenticate(request: FastifyRequest, service: WorkspaceService): Principal {
  return service.authenticate(authToken(request));
}

function authToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length);
  const session = request.cookies[SESSION_COOKIE];
  if (session) return session;
  throw new DomainError('UNAUTHORIZED', 'A valid login session or Bearer token is required.', 401);
}

function setSessionCookie(reply: FastifyReply, token: string, expiresAt: number): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    expires: new Date(expiresAt),
  });
}

function requireHuman(principal: Principal): HumanPrincipal {
  invariant(principal.kind === 'human', 'HUMAN_PRINCIPAL_REQUIRED', 'A Human bearer token is required.', 403);
  return principal;
}

function requireComputer(principal: Principal): ComputerPrincipal {
  invariant(principal.kind === 'computer', 'COMPUTER_PRINCIPAL_REQUIRED', 'A Local Node bearer token is required.', 403);
  return principal;
}

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'];
  invariant(typeof value === 'string' && value.length > 0, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required.');
  return value;
}

function multipartString(fields: object, name: string): string | null {
  const candidate = (fields as Record<string, unknown>)[name];
  const part = Array.isArray(candidate) ? candidate[0] : candidate;
  if (!part || typeof part !== 'object' || !('type' in part) || part.type !== 'field' || !('value' in part)) return null;
  const value = String(part.value).trim();
  return value || null;
}

function multipartJsonIds(fields: object, name: string): string[] {
  const value = multipartString(fields, name);
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new DomainError('INVALID_MULTIPART_FIELD', `${name} must be a JSON array of IDs.`, 400);
  }
  invariant(Array.isArray(parsed) && parsed.every((item) => typeof item === 'string'),
    'INVALID_MULTIPART_FIELD', `${name} must be a JSON array of IDs.`);
  return parsed;
}
