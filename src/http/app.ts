import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import multipart from '@fastify/multipart';
import { Type } from '@sinclair/typebox';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { extension as mediaTypeExtension } from 'mime-types';
import { extname } from 'node:path';
import { readFileSync } from 'node:fs';
import { DomainError, invariant } from '../lib/errors.js';
import type { ComputerPrincipal, HumanPrincipal, Principal } from '../domain/types.js';
import { WorkspaceService } from '../domain/workspace-service.js';
import type { ArtifactV2Service } from '../domain/project-resource-service.js';
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
const ProjectArtifactParams = Type.Object({ projectId: Id, artifactId: Id });
const ResourceParams = Type.Object({ resourceId: Id });
const ProjectResourceParams = Type.Object({ projectId: Id, resourceId: Id });
const ProjectArtifactV2Params = Type.Object({ projectId: Id, artifactId: Id });
const ArtifactVersionV2Params = Type.Object({ artifactId: Id, versionId: Id });
const ProjectArtifactVersionV2Params = Type.Object({ projectId: Id, artifactId: Id, versionId: Id });
const ArtifactVersionOnlyParams = Type.Object({ versionId: Id });
const LinkParams = Type.Object({ linkId: Id });
const ArtifactParams = Type.Object({ artifactId: Id });
const AgentParams = Type.Object({ workspaceId: Id, agentId: Id });
const ComputerAgentParams = Type.Object({ agentId: Id });
const ComputerAgentProjectParams = Type.Object({ agentId: Id, projectId: Id });
const ComputerAgentProjectResourceParams = Type.Object({ agentId: Id, projectId: Id, resourceId: Id });
const ComputerAgentProjectArtifactParams = Type.Object({ agentId: Id, projectId: Id, artifactId: Id });
const ComputerAgentMessageParams = Type.Object({ agentId: Id, messageId: Id });
const ComputerAgentWorkItemParams = Type.Object({ agentId: Id, workItemId: Id });
const ConversationParams = Type.Object({ conversationId: Id });
const MessageParams = Type.Object({ messageId: Id });
const AgentRequestParams = Type.Object({ agentRequestId: Id });
const WorkItemParams = Type.Object({ workItemId: Id });
const WorkspaceJoinLinkParams = Type.Object({ joinLinkId: Id });
const WorkspaceJoinTokenParams = Type.Object({
  token: Type.String({ minLength: 47, maxLength: 47, pattern: '^anc_[A-Za-z0-9_-]{43}$' }),
});
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
const ProjectRoleSchema = Type.Union([
  Type.Literal('owner'), Type.Literal('manager'), Type.Literal('member'),
]);
const ProjectAssignableRoleSchema = Type.Union([
  Type.Literal('manager'), Type.Literal('member'),
]);
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
  sponsoredByProjectMembershipId: Type.Union([Id, Type.Null()]),
  revision: Type.Integer(),
  joinedAt: Type.Integer(),
});
const WorkItemArtifactReferenceResponse = Type.Object({
  artifactId: Id,
  artifactVersionId: Id,
  artifactName: Type.String(),
  version: Type.Integer({ minimum: 1 }),
  fileName: Type.String(),
  mediaType: Type.String(),
  contentDigest: Type.String({ minLength: 64, maxLength: 64 }),
  byteLength: Type.Integer({ minimum: 0 }),
  contentAvailable: Type.Boolean(),
  artifactStatus: Type.Union([Type.Literal('active'), Type.Literal('deleted'), Type.Literal('purged')]),
});
const WorkItemResponse = Type.Object({
  id: Id,
  workspaceId: Id,
  projectId: Id,
  taskNumber: Type.Integer({ minimum: 1 }),
  description: Type.String({ minLength: 1, maxLength: 10000 }),
  relatedWorkItemReferences: Type.Array(Type.Object({ workItemId: Id, taskNumber: Type.Integer({ minimum: 1 }) })),
  sourceConversationId: Type.Union([Id, Type.Null()]),
  sourceMessageId: Type.Union([Id, Type.Null()]),
  sourceThreadId: Type.Union([Id, Type.Null()]),
  lifecycleStatus: Type.Union([
    Type.Literal('open'), Type.Literal('blocked'), Type.Literal('completed'), Type.Literal('cancelled'),
  ]),
  blockerReason: Type.Union([Type.String(), Type.Null()]),
  cancellationReason: Type.Union([Type.String(), Type.Null()]),
  assignee: Type.Union([
    Type.Object({
      projectMembershipId: Id,
      workspaceMembershipId: Id,
      actorId: Id,
      actorType: Type.Union([Type.Literal('human'), Type.Literal('agent')]),
      displayName: Type.String(),
    }),
    Type.Null(),
  ]),
  assignees: Type.Array(Type.Object({
    projectMembershipId: Id,
    workspaceMembershipId: Id,
    actorId: Id,
    actorType: Type.Union([Type.Literal('human'), Type.Literal('agent')]),
    displayName: Type.String(),
  }), { maxItems: 50 }),
  currentSubmission: Type.Union([
    Type.Object({
      id: Id,
      commentId: Type.Union([Id, Type.Null()]),
      submittedByMembershipId: Id,
      submittedByProjectMembershipId: Id,
      submittedByActorId: Id,
      submittedByDisplayName: Type.String(),
      assignmentRevision: Type.Integer({ minimum: 0 }),
      artifactReferences: Type.Array(WorkItemArtifactReferenceResponse),
      createdAt: Type.Integer(),
    }),
    Type.Null(),
  ]),
  assignmentRevision: Type.Integer({ minimum: 0 }),
  commentFrontier: Type.Integer({ minimum: 0 }),
  revision: Type.Integer({ minimum: 1 }),
  createdByMembershipId: Id,
  createdByProjectMembershipId: Id,
  createdByDisplayName: Type.String(),
  createdAt: Type.Integer(),
  updatedAt: Type.Integer(),
  completedAt: Type.Union([Type.Integer(), Type.Null()]),
  cancelledAt: Type.Union([Type.Integer(), Type.Null()]),
});
const WorkItemCommentResponse = Type.Object({
  id: Id,
  workspaceId: Id,
  projectId: Id,
  workItemId: Id,
  authorActorId: Id,
  authorMembershipId: Id,
  authorProjectMembershipId: Id,
  authorActorType: Type.Union([Type.Literal('human'), Type.Literal('agent')]),
  authorDisplayName: Type.String(),
  body: Type.String(),
  mentionedActorIds: Type.Array(Id),
  mentions: Type.Array(Type.Object({
    actorId: Id,
    actorType: Type.Union([Type.Literal('human'), Type.Literal('agent')]),
    displayName: Type.String(),
  })),
  workItemReferences: Type.Array(Type.Object({ workItemId: Id, taskNumber: Type.Integer({ minimum: 1 }) })),
  artifactReferences: Type.Array(WorkItemArtifactReferenceResponse),
  position: Type.Integer({ minimum: 1 }),
  createdAt: Type.Integer(),
});
const WorkspaceJoinLinkResponseProperties = {
  id: Id,
  workspaceId: Id,
  status: Type.Union([Type.Literal('active'), Type.Literal('revoked')]),
  revision: Type.Integer(),
  createdByMembershipId: Id,
  useCount: Type.Integer({ minimum: 0 }),
  createdAt: Type.Integer(),
  updatedAt: Type.Integer(),
  lastUsedAt: Type.Union([Type.Integer(), Type.Null()]),
  revokedAt: Type.Union([Type.Integer(), Type.Null()]),
};
const WorkspaceJoinLinkResponse = Type.Object({
  ...WorkspaceJoinLinkResponseProperties,
  token: Type.Union([Type.String({ minLength: 47, maxLength: 47 }), Type.Null()]),
});
const WorkspaceJoinLinkCreatedResponse = Type.Object({
  ...WorkspaceJoinLinkResponseProperties,
  token: Type.String({ minLength: 47, maxLength: 47 }),
});
const WorkspaceJoinLinkPreviewResponse = Type.Object({
  workspaceId: Id,
  workspaceName: Type.String(),
  status: Type.Union([Type.Literal('active'), Type.Literal('revoked')]),
  alreadyMember: Type.Boolean(),
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
const AgentActivityEventTypeSchema = Type.Union([
  Type.Literal('turn_started'),
  Type.Literal('thought'),
  Type.Literal('tool'),
  Type.Literal('plan'),
  Type.Literal('message'),
  Type.Literal('turn_completed'),
  Type.Literal('turn_failed'),
]);
const AgentActivityStatusSchema = Type.Union([
  Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed'), Type.Literal('failed'),
]);
const AgentActivityEventInput = Type.Object({
  eventId: Id,
  turnId: Id,
  sequence: Type.Integer({ minimum: 1 }),
  eventType: AgentActivityEventTypeSchema,
  title: Type.String({ minLength: 1, maxLength: 500 }),
  status: AgentActivityStatusSchema,
}, { additionalProperties: false });
const AgentActivityEventResponse = Type.Composite([
  AgentActivityEventInput,
  Type.Object({
    workspaceId: Id,
    agentId: Id,
    agentName: Type.String({ minLength: 1, maxLength: 120 }),
    turnStatus: Type.Union([Type.Literal('active'), Type.Literal('completed'), Type.Literal('failed')]),
    turnStartedAt: Type.Integer(),
    turnUpdatedAt: Type.Integer(),
    turnFinishedAt: Type.Union([Type.Integer(), Type.Null()]),
    createdAt: Type.Integer(),
  }),
]);
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
  scope: Type.Union([
    Type.Object({ type: Type.Literal('workspace_general') }),
    Type.Object({ type: Type.Literal('direct_message') }),
    Type.Object({
      type: Type.Literal('project_group'),
      projectId: Id,
      membershipMode: Type.Union([Type.Literal('project_all'), Type.Literal('explicit')]),
    }),
  ]),
  kind: Type.Union([Type.Literal('channel'), Type.Literal('dm')]),
  visibility: Type.Union([Type.Literal('public'), Type.Literal('private')]),
  accessMode: Type.Union([Type.Literal('content'), Type.Literal('governance')]),
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
    artifactVersionId: Id,
    artifactName: Type.String(),
    version: Type.Integer({ minimum: 1 }),
    fileName: Type.String(),
    mediaType: Type.String(),
    contentDigest: Type.String({ minLength: 64, maxLength: 64 }),
    byteLength: Type.Integer({ minimum: 0 }),
    contentAvailable: Type.Boolean(),
    artifactStatus: Type.Union([Type.Literal('active'), Type.Literal('deleted'), Type.Literal('purged')]),
});
const MessageMentionResponse = Type.Object({
  actorId: Id,
  actorType: Type.Union([Type.Literal('human'), Type.Literal('agent')]),
  displayName: Type.String(),
});
const MessageWorkItemReferenceResponse = Type.Object({
  workItemId: Id,
  taskNumber: Type.Integer({ minimum: 1 }),
});
const MessageResponse = Type.Object({
  id: Id,
  workspaceId: Id,
  conversationId: Id,
  projectId: Type.Union([Id, Type.Null()]),
  threadId: Type.Union([Id, Type.Null()]),
  threadRootMessageId: Type.Union([Id, Type.Null()]),
  replyToMessageId: Type.Union([Id, Type.Null()]),
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
  workItemReferences: Type.Array(MessageWorkItemReferenceResponse),
  createdAt: Type.Integer(),
});

// Project-scoped resources and immutable Artifact v2 contracts.
const ProjectResourceResponse = Type.Object({
  resourceId: Id,
  projectId: Id,
  parentResourceId: Type.Union([Id, Type.Null()]),
  name: Type.String(),
  path: Type.String(),
  kind: Type.Union([Type.Literal('file'), Type.Literal('directory')]),
  status: Type.Union([Type.Literal('active'), Type.Literal('deleted'), Type.Literal('purged')]),
  revision: Type.Integer({ minimum: 1 }),
  digest: Type.Union([Type.String({ minLength: 64, maxLength: 64 }), Type.Null()]),
  mediaType: Type.Union([Type.String(), Type.Null()]),
  byteLength: Type.Union([Type.Integer({ minimum: 0, maximum: MAX_ARTIFACT_BYTES }), Type.Null()]),
  createdByActorId: Id,
  createdAt: Type.Integer(),
  updatedAt: Type.Integer(),
  deletedAt: Type.Union([Type.Integer(), Type.Null()]),
  purgeAfter: Type.Union([Type.Integer(), Type.Null()]),
});
const ProjectLinkResponse = Type.Object({
  linkId: Id,
  projectId: Id,
  locator: Type.String({ minLength: 8, maxLength: 2000 }),
  name: Type.String(),
  description: Type.Union([Type.String({ maxLength: 3000 }), Type.Null()]),
  status: Type.Union([Type.Literal('active'), Type.Literal('deleted'), Type.Literal('purged')]),
  revision: Type.Integer({ minimum: 1 }),
  createdByActorId: Id,
  createdAt: Type.Integer(),
  updatedAt: Type.Integer(),
  deletedAt: Type.Union([Type.Integer(), Type.Null()]),
  purgeAfter: Type.Union([Type.Integer(), Type.Null()]),
});
const ArtifactVersionV2Response = Type.Object({
  versionId: Id,
  artifactId: Id,
  version: Type.Integer({ minimum: 1 }),
  fileName: Type.String(),
  mediaType: Type.String(),
  byteLength: Type.Integer({ minimum: 0, maximum: MAX_ARTIFACT_BYTES }),
  digest: Type.String({ minLength: 64, maxLength: 64 }),
  parentVersionId: Type.Union([Id, Type.Null()]),
  status: Type.Union([Type.Literal('active'), Type.Literal('deleted'), Type.Literal('purged')]),
  createdByActorId: Id,
  createdAt: Type.Integer(),
  taskId: Type.Union([Id, Type.Null()]),
  messageId: Type.Union([Id, Type.Null()]),
  publishBatchId: Type.Union([Id, Type.Null()]),
  note: Type.Union([Type.String(), Type.Null()]),
  preview: Type.Object({
    status: Type.Union([Type.Literal('pending'), Type.Literal('ready'), Type.Literal('failed')]),
    errorMessage: Type.Union([Type.String(), Type.Null()]),
  }),
  deletedAt: Type.Union([Type.Integer(), Type.Null()]),
  purgeAfter: Type.Union([Type.Integer(), Type.Null()]),
});
const ArtifactV2Response = Type.Object({
  artifactId: Id,
  projectId: Id,
  name: Type.String(),
  projectPath: Type.String(),
  status: Type.Union([Type.Literal('active'), Type.Literal('deleted'), Type.Literal('purged')]),
  latestVersionId: Type.Union([Id, Type.Null()]),
  latestVersion: Type.Union([ArtifactVersionV2Response, Type.Null()]),
  createdByActorId: Id,
  createdAt: Type.Integer(),
  updatedAt: Type.Integer(),
  deletedAt: Type.Union([Type.Integer(), Type.Null()]),
  purgeAfter: Type.Union([Type.Integer(), Type.Null()]),
  derivationParentVersionIds: Type.Array(Id),
  contentBase64: Type.Optional(Type.String()),
  mediaType: Type.Optional(Type.String()),
});
const ArtifactV2PublishResponse = Type.Object({
  artifact: ArtifactV2Response,
  version: ArtifactVersionV2Response,
  created: Type.Boolean(),
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
        Type.Literal('runtime_unavailable'),
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
  scopeMembershipId: Id,
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
      kind: Type.Literal('project_scratch'),
      projectId: Id,
    }, { additionalProperties: false }),
  ]),
  runContext: RunContextSnapshotResponse,
  developerInstructions: Type.String(),
});
const AgentSessionInputResponse = Type.Object({
  workspaceId: Id,
  agentId: Id,
  session: Type.Object({ kind: Type.Union([Type.Literal('mention'), Type.Literal('work_item')]), key: Id }),
  target: Type.Union([Type.String(), Type.Null()]),
  projectId: Type.Union([Id, Type.Null()]),
  initialDiscussionFrontier: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  discussion: Type.Union([
    Type.Object({
      target: Type.String({ minLength: 1 }),
      agentRequestId: Id,
      initialDiscussionFrontier: Type.Integer({ minimum: 0 }),
      sessionWindow: Type.Object({
        mode: Type.Union([Type.Literal('dm'), Type.Literal('isolated')]),
        acceptedMessages: Type.Integer({ minimum: 0, maximum: 10 }),
        maxMessages: Type.Literal(10),
        status: Type.Union([Type.Literal('accepting'), Type.Literal('frozen'), Type.Literal('completed')]),
      }),
    }, { additionalProperties: false }),
    Type.Null(),
  ]),
  sessionWindow: Type.Object({
    mode: Type.Union([Type.Literal('dm'), Type.Literal('isolated')]),
    acceptedMessages: Type.Integer({ minimum: 0, maximum: 10 }),
    maxMessages: Type.Literal(10),
    status: Type.Union([Type.Literal('accepting'), Type.Literal('frozen'), Type.Literal('completed')]),
  }),
  contextHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  contextJsonl: Type.String(),
  referencedWorkItemIds: Type.Array(Id),
  runtimeId: RuntimeIdSchema,
  runtimeBindingRevision: Type.Integer({ minimum: 1 }),
  runtimeConfiguration: Type.Object({
    model: Type.Union([Type.String(), Type.Null()]),
    reasoningEffort: Type.Union([ReasoningEffortSchema, Type.Null()]),
    mode: Type.Union([Type.String(), Type.Null()]),
  }),
  developerInstructions: Type.String(),
});
const AgentInboxTargetResponse = Type.Union([
  Type.Object({
    kind: Type.Literal('discussion'),
    conversationId: Id,
    threadId: Type.Union([Id, Type.Null()]),
    workItemId: Type.Null(),
    target: Type.String({ minLength: 1 }),
    pendingCount: Type.Integer({ minimum: 1 }),
    firstSequence: Type.Integer({ minimum: 1 }),
    lastSequence: Type.Integer({ minimum: 1 }),
    requiresAction: Type.Boolean(),
  }),
  Type.Object({
    kind: Type.Literal('work_item'),
    conversationId: Type.Null(),
    threadId: Type.Null(),
    workItemId: Id,
    target: Type.String({ minLength: 1 }),
    pendingCount: Type.Integer({ minimum: 1 }),
    firstSequence: Type.Integer({ minimum: 1 }),
    lastSequence: Type.Integer({ minimum: 1 }),
    requiresAction: Type.Literal(true),
  }),
]);
const AgentInboxSummaryResponse = Type.Object({
  agentId: Id,
  highestSequence: Type.Integer({ minimum: 0 }),
  targets: Type.Array(AgentInboxTargetResponse),
  sessionTriggers: Type.Array(Type.Object({
    session: Type.Object({ kind: Type.Union([Type.Literal('mention'), Type.Literal('work_item')]), key: Id }),
    inboxItemId: Id,
    sequence: Type.Integer({ minimum: 1 }),
    target: Type.Union([Type.String(), Type.Null()]),
    agentRequestId: Type.Union([Id, Type.Null()]),
    messageId: Type.Union([Id, Type.Null()]),
    conversationId: Type.Union([Id, Type.Null()]),
    threadId: Type.Union([Id, Type.Null()]),
    workItemId: Type.Union([Id, Type.Null()]),
    requiresAction: Type.Boolean(),
  })),
});
const AgentInboxWakeBatchResponse = Type.Object({
  events: Type.Array(Type.Object({
    type: Type.Literal('agent.inbox_changed'),
    agentId: Id,
    wakeSequence: Type.Integer({ minimum: 1 }),
  })),
  cursor: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
});
const AgentInboxAttentionResponse = Type.Object({
    inboxItemId: Id,
    sequence: Type.Integer({ minimum: 1 }),
    attentionKind: Type.Union([
      Type.Literal('direct_message'), Type.Literal('mention'),
      Type.Literal('work_item_assignment'), Type.Literal('work_item_mention'),
    ]),
    agentRequestId: Type.Union([Id, Type.Null()]),
    messageId: Type.Union([Id, Type.Null()]),
    workItemId: Type.Union([Id, Type.Null()]),
    workItemCommentId: Type.Union([Id, Type.Null()]),
});
const AgentInboxDiscussionDeltaResponse = Type.Object({
      conversationId: Id,
      threadId: Type.Union([Id, Type.Null()]),
      sincePositionExclusive: Type.Integer({ minimum: 0 }),
      throughPosition: Type.Integer({ minimum: 0 }),
      rootMessage: Type.Union([MessageResponse, Type.Null()]),
      messages: Type.Array(MessageResponse),
});
const AgentInboxClaimResponse = Type.Object({
  agentId: Id,
  receipt: Type.String({ minLength: 1 }),
  target: Type.String({ minLength: 1 }),
  targetKind: Type.Literal('discussion'),
  sessionWindow: Type.Object({
    mode: Type.Union([Type.Literal('dm'), Type.Literal('isolated')]),
    acceptedMessages: Type.Integer({ minimum: 0, maximum: 10 }),
    maxMessages: Type.Literal(10),
    status: Type.Union([Type.Literal('accepting'), Type.Literal('frozen'), Type.Literal('completed')]),
  }),
  attention: Type.Array(AgentInboxAttentionResponse),
  discussion: AgentInboxDiscussionDeltaResponse,
});
const AgentMessagePublicationResponse = Type.Union([
  Type.Object({
    status: Type.Literal('published'),
    message: MessageResponse,
  }, { additionalProperties: false }),
  Type.Object({
    status: Type.Literal('held'),
    draftId: Id,
    expectedDiscussionFrontier: Type.Integer({ minimum: 0 }),
    currentDiscussionFrontier: Type.Integer({ minimum: 0 }),
    attention: Type.Array(AgentInboxAttentionResponse),
    discussionDelta: AgentInboxDiscussionDeltaResponse,
  }, { additionalProperties: false }),
]);
const AgentInboxCompletionResponse = Type.Union([
  Type.Object({
    status: Type.Literal('completed'),
    receipt: Type.String({ minLength: 1 }),
    handledAt: Type.Integer(),
  }, { additionalProperties: false }),
  Type.Object({
    status: Type.Literal('review_required'),
    expectedDiscussionFrontier: Type.Integer({ minimum: 0 }),
    currentDiscussionFrontier: Type.Integer({ minimum: 0 }),
    attention: Type.Array(AgentInboxAttentionResponse),
    discussionDelta: AgentInboxDiscussionDeltaResponse,
  }, { additionalProperties: false }),
]);

export interface BuildAppOptions {
  /** Keep cookie behavior deterministic for embedded servers and tests. */
  secureCookies?: boolean;
}

export async function buildApp(service: WorkspaceService, options: BuildAppOptions = {}) {
  const secureCookies = options.secureCookies ?? process.env.NODE_ENV === 'production';
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
        title: 'SenseNova Team Harness API',
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
      if (paths['/v1/attempts/{attemptId}/staged-blobs']?.post) {
        paths['/v1/attempts/{attemptId}/staged-blobs'].post.requestBody = multipartBody({
          file: { type: 'string', format: 'binary' },
        }, ['file']);
      }
      return openapiObject;
    },
  });

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
    setSessionCookie(reply, session.token, session.expiresAt, secureCookies);
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
    setSessionCookie(reply, session.token, session.expiresAt, secureCookies);
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

  // Artifact v2: Project-scoped resources, immutable file versions and links.
  // These routes intentionally do not expose Current State, snapshots or Yjs.
  app.get('/v1/projects/:projectId/resources', {
    schema: { tags: ['project-resource'], security: HumanSecurity, params: ProjectParams, response: { 200: Type.Object({ items: Type.Array(ProjectResourceResponse) }) } },
  }, async (request) => ({ items: service.projectResources.list(authenticate(request, service), request.params.projectId) }));

  app.get('/v1/projects/:projectId/resources/trash', {
    schema: { tags: ['project-resource'], security: HumanSecurity, params: ProjectParams, response: { 200: Type.Object({ items: Type.Array(ProjectResourceResponse) }) } },
  }, async (request) => ({ items: service.projectResources.list(authenticate(request, service), request.params.projectId, true).filter((item) => item.status !== 'active') }));

  app.get('/v1/projects/:projectId/resources/:resourceId', {
    schema: { tags: ['project-resource'], security: HumanSecurity, params: ProjectResourceParams, response: { 200: ProjectResourceResponse } },
  }, async (request) => service.projectResources.getInProject(authenticate(request, service), request.params.projectId, request.params.resourceId));
  app.get('/v1/projects/:projectId/resources/:resourceId/download', {
    schema: { tags: ['project-resource'], security: HumanSecurity, params: ProjectResourceParams },
  }, async (request, reply) => {
    const principal = authenticate(request, service);
    const resource = service.projectResources.getInProject(principal, request.params.projectId, request.params.resourceId);
    const result = service.projectResources.read(principal, resource.resourceId);
    reply.header('Content-Type', result.resource.mediaType ?? 'application/octet-stream');
    reply.header('Content-Length', String(result.resource.byteLength ?? 0));
    reply.header('Content-Disposition', artifactAttachmentDisposition(result.resource.name, result.resource.mediaType ?? 'application/octet-stream', result.resource.resourceId));
    return reply.send(service.projectResources.blobs.read(result.storagePath));
  });
  app.put('/v1/projects/:projectId/resources/:resourceId/content', {
    schema: { tags: ['project-resource'], security: HumanSecurity, params: ProjectResourceParams, consumes: ['multipart/form-data'], response: { 200: ProjectResourceResponse } },
  }, async (request) => {
    const principal = requireHuman(authenticate(request, service));
    service.projectResources.getInProject(principal, request.params.projectId, request.params.resourceId);
    const upload = await request.file({ limits: { fileSize: MAX_ARTIFACT_BYTES, files: 1 } });
    invariant(upload, 'RESOURCE_FILE_REQUIRED', 'A file upload is required.');
    const expected = Number(multipartString(upload.fields, 'expectedRevision'));
    invariant(Number.isSafeInteger(expected) && expected > 0, 'EXPECTED_REVISION_REQUIRED', 'expectedRevision is required.');
    const stored = await service.projectResources.blobs.write(upload.file, upload.mimetype);
    return service.projectResources.replace(principal, request.params.resourceId, expected, stored);
  });
  app.patch('/v1/projects/:projectId/resources/:resourceId', {
    schema: { tags: ['project-resource'], security: HumanSecurity, params: ProjectResourceParams, body: Type.Object({ name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })), parentResourceId: Type.Optional(Type.Union([Id, Type.Null()])) }), response: { 200: ProjectResourceResponse } },
  }, async (request) => {
    const principal = requireHuman(authenticate(request, service));
    service.projectResources.getInProject(principal, request.params.projectId, request.params.resourceId);
    if (request.body.name !== undefined) service.projectResources.rename(principal, request.params.resourceId, request.body.name);
    if (request.body.parentResourceId !== undefined) return service.projectResources.move(principal, request.params.resourceId, request.body.parentResourceId);
    return service.projectResources.getInProject(principal, request.params.projectId, request.params.resourceId);
  });
  app.delete('/v1/projects/:projectId/resources/:resourceId', {
    schema: { tags: ['project-resource'], security: HumanSecurity, params: ProjectResourceParams, response: { 200: ProjectResourceResponse } },
  }, async (request) => { const principal = requireHuman(authenticate(request, service)); service.projectResources.getInProject(principal, request.params.projectId, request.params.resourceId); return service.projectResources.delete(principal, request.params.resourceId); });
  app.post('/v1/projects/:projectId/resources/:resourceId/restore', {
    schema: { tags: ['project-resource'], security: HumanSecurity, params: ProjectResourceParams, response: { 200: ProjectResourceResponse } },
  }, async (request) => { const principal = requireHuman(authenticate(request, service)); service.projectResources.getInProject(principal, request.params.projectId, request.params.resourceId, true); return service.projectResources.restore(principal, request.params.resourceId); });

  app.post('/v1/projects/:projectId/resources/folders', {
    schema: {
      tags: ['project-resource'], security: HumanSecurity, params: ProjectParams,
      body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 255 }), parentResourceId: Type.Optional(Type.Union([Id, Type.Null()])) }),
      response: { 201: ProjectResourceResponse },
    },
  }, async (request, reply) => reply.status(201).send(service.projectResources.createFolder(requireHuman(authenticate(request, service)), request.params.projectId, request.body)));

  app.post('/v1/projects/:projectId/resources', {
    schema: { tags: ['project-resource'], security: HumanSecurity, params: ProjectParams, consumes: ['multipart/form-data'], response: { 201: ProjectResourceResponse } },
  }, async (request, reply) => {
    const principal = requireHuman(authenticate(request, service));
    const upload = await request.file({ limits: { fileSize: MAX_ARTIFACT_BYTES, files: 1 } });
    invariant(upload, 'RESOURCE_FILE_REQUIRED', 'A file upload is required.');
    const stored = await service.projectResources.blobs.write(upload.file, upload.mimetype);
    const parentResourceId = multipartString(upload.fields, 'parentResourceId');
    const path = multipartString(upload.fields, 'path');
    return reply.status(201).send(await service.projectResources.upload(principal, request.params.projectId, { name: upload.filename, parentResourceId, ...(path ? { path } : {}) }, stored));
  });

  app.get('/v1/project-resources/:resourceId', {
    schema: { tags: ['project-resource'], security: HumanSecurity, params: ResourceParams, response: { 200: ProjectResourceResponse } },
  }, async (request) => service.projectResources.get(authenticate(request, service), request.params.resourceId));

  app.get('/v1/project-resources/:resourceId/download', {
    schema: { tags: ['project-resource'], security: HumanSecurity, params: ResourceParams },
  }, async (request, reply) => {
    const result = service.projectResources.read(authenticate(request, service), request.params.resourceId);
    reply.header('Content-Type', result.resource.mediaType ?? 'application/octet-stream');
    reply.header('Content-Length', String(result.resource.byteLength ?? 0));
    reply.header('Content-Disposition', artifactAttachmentDisposition(result.resource.name, result.resource.mediaType ?? 'application/octet-stream', result.resource.resourceId));
    return reply.send(service.projectResources.blobs.read(result.storagePath));
  });

  app.put('/v1/project-resources/:resourceId/content', {
    schema: { tags: ['project-resource'], security: HumanSecurity, params: ResourceParams, consumes: ['multipart/form-data'], response: { 200: ProjectResourceResponse } },
  }, async (request) => {
    const principal = requireHuman(authenticate(request, service));
    const upload = await request.file({ limits: { fileSize: MAX_ARTIFACT_BYTES, files: 1 } });
    invariant(upload, 'RESOURCE_FILE_REQUIRED', 'A file upload is required.');
    const expected = Number(multipartString(upload.fields, 'expectedRevision'));
    invariant(Number.isSafeInteger(expected) && expected > 0, 'EXPECTED_REVISION_REQUIRED', 'expectedRevision is required.');
    const stored = await service.projectResources.blobs.write(upload.file, upload.mimetype);
    return service.projectResources.replace(principal, request.params.resourceId, expected, stored);
  });

  app.patch('/v1/project-resources/:resourceId', {
    schema: { tags: ['project-resource'], security: HumanSecurity, params: ResourceParams, body: Type.Object({ name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })), parentResourceId: Type.Optional(Type.Union([Id, Type.Null()])) }), response: { 200: ProjectResourceResponse } },
  }, async (request) => {
    const principal = requireHuman(authenticate(request, service));
    if (request.body.name !== undefined) service.projectResources.rename(principal, request.params.resourceId, request.body.name);
    if (request.body.parentResourceId !== undefined) return service.projectResources.move(principal, request.params.resourceId, request.body.parentResourceId);
    return service.projectResources.get(principal, request.params.resourceId);
  });

  app.delete('/v1/project-resources/:resourceId', {
    schema: { tags: ['project-resource'], security: HumanSecurity, params: ResourceParams, response: { 200: ProjectResourceResponse } },
  }, async (request) => service.projectResources.delete(requireHuman(authenticate(request, service)), request.params.resourceId));

  app.post('/v1/project-resources/:resourceId/restore', {
    schema: { tags: ['project-resource'], security: HumanSecurity, params: ResourceParams, response: { 200: ProjectResourceResponse } },
  }, async (request) => service.projectResources.restore(requireHuman(authenticate(request, service)), request.params.resourceId));

  app.get('/v1/projects/:projectId/links', {
    schema: { tags: ['project-link'], security: HumanSecurity, params: ProjectParams, response: { 200: Type.Object({ items: Type.Array(ProjectLinkResponse) }) } },
  }, async (request) => ({ items: service.projectResources.listLinks(authenticate(request, service), request.params.projectId) }));
  app.get('/v1/projects/:projectId/links/trash', {
    schema: { tags: ['project-link'], security: HumanSecurity, params: ProjectParams, response: { 200: Type.Object({ items: Type.Array(ProjectLinkResponse) }) } },
  }, async (request) => ({ items: service.projectResources.listLinks(authenticate(request, service), request.params.projectId, true).filter((item) => item.status !== 'active') }));

  app.patch('/v1/projects/:projectId/links/:linkId', {
    schema: { tags: ['project-link'], security: HumanSecurity, params: Type.Object({ projectId: Id, linkId: Id }), body: Type.Object({ name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })), description: Type.Optional(Type.Union([Type.String({ maxLength: 3000 }), Type.Null()])) }), response: { 200: ProjectLinkResponse } },
  }, async (request) => { const principal = requireHuman(authenticate(request, service)); const link = service.projectResources.listLinks(principal, request.params.projectId, true).find((item) => item.linkId === request.params.linkId); invariant(link, 'LINK_NOT_FOUND', 'Link does not belong to this Project.', 404); return service.projectResources.updateLink(principal, request.params.linkId, request.body); });
  app.delete('/v1/projects/:projectId/links/:linkId', {
    schema: { tags: ['project-link'], security: HumanSecurity, params: Type.Object({ projectId: Id, linkId: Id }), response: { 200: ProjectLinkResponse } },
  }, async (request) => { const principal = requireHuman(authenticate(request, service)); const link = service.projectResources.listLinks(principal, request.params.projectId, true).find((item) => item.linkId === request.params.linkId); invariant(link, 'LINK_NOT_FOUND', 'Link does not belong to this Project.', 404); return service.projectResources.deleteLink(principal, request.params.linkId); });
  app.post('/v1/projects/:projectId/links/:linkId/restore', {
    schema: { tags: ['project-link'], security: HumanSecurity, params: Type.Object({ projectId: Id, linkId: Id }), response: { 200: ProjectLinkResponse } },
  }, async (request) => { const principal = requireHuman(authenticate(request, service)); const link = service.projectResources.listLinks(principal, request.params.projectId, true).find((item) => item.linkId === request.params.linkId); invariant(link, 'LINK_NOT_FOUND', 'Link does not belong to this Project.', 404); return service.projectResources.restoreLink(principal, request.params.linkId); });

  app.post('/v1/projects/:projectId/links', {
    schema: { tags: ['project-link'], security: HumanSecurity, params: ProjectParams, body: Type.Object({ locator: Type.String({ minLength: 1, maxLength: 2000 }), name: Type.String({ minLength: 1, maxLength: 255 }), description: Type.Optional(Type.Union([Type.String({ maxLength: 3000 }), Type.Null()])) }), response: { 201: ProjectLinkResponse } },
  }, async (request, reply) => reply.status(201).send(service.projectResources.createLink(requireHuman(authenticate(request, service)), request.params.projectId, request.body)));

  app.patch('/v1/project-links/:linkId', {
    schema: { tags: ['project-link'], security: HumanSecurity, params: LinkParams, body: Type.Object({ name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })), description: Type.Optional(Type.Union([Type.String({ maxLength: 3000 }), Type.Null()])) }), response: { 200: ProjectLinkResponse } },
  }, async (request) => service.projectResources.updateLink(requireHuman(authenticate(request, service)), request.params.linkId, request.body));
  app.delete('/v1/project-links/:linkId', { schema: { tags: ['project-link'], security: HumanSecurity, params: LinkParams, response: { 200: ProjectLinkResponse } } }, async (request) => service.projectResources.deleteLink(requireHuman(authenticate(request, service)), request.params.linkId));
  app.post('/v1/project-links/:linkId/restore', { schema: { tags: ['project-link'], security: HumanSecurity, params: LinkParams, response: { 200: ProjectLinkResponse } } }, async (request) => service.projectResources.restoreLink(requireHuman(authenticate(request, service)), request.params.linkId));

  app.get('/v1/projects/:projectId/artifacts', {
    schema: { tags: ['artifact-v2'], security: HumanSecurity, params: ProjectParams, response: { 200: Type.Object({ items: Type.Array(ArtifactV2Response) }) } },
  }, async (request) => ({ items: service.artifactV2.listArtifacts(authenticate(request, service), request.params.projectId) }));
  app.get('/v1/projects/:projectId/artifacts/trash', {
    schema: { tags: ['artifact-v2'], security: HumanSecurity, params: ProjectParams, response: { 200: Type.Object({ items: Type.Array(ArtifactV2Response) }) } },
  }, async (request) => ({ items: service.artifactV2.listArtifacts(authenticate(request, service), request.params.projectId, true).filter((item) => item.status !== 'active') }));

  app.post('/v1/projects/:projectId/artifacts', {
    schema: { tags: ['artifact-v2'], security: HumanSecurity, headers: IdempotencyHeaders, params: ProjectParams, consumes: ['multipart/form-data'], response: { 200: ArtifactV2PublishResponse, 201: ArtifactV2PublishResponse } },
  }, async (request, reply) => {
    const principal = authenticate(request, service);
    const upload = await request.file({ limits: { fileSize: MAX_ARTIFACT_BYTES, files: 1 } });
    invariant(upload, 'ARTIFACT_FILE_REQUIRED', 'A file upload is required.');
    const stored = await service.artifactV2.blobs.write(upload.file, upload.mimetype);
    const jsonField = (name: string): unknown => {
      const value = multipartString(upload.fields, name); if (!value) return undefined;
      try { return JSON.parse(value); } catch { throw new DomainError('INVALID_MULTIPART_FIELD', `${name} must be valid JSON.`, 400); }
    };
    const sourceResourceRefs = jsonField('sourceResourceRefs') as Array<{ resourceId: string; revision?: number; digest?: string }> | undefined;
    const parentVersionIds = jsonField('parentVersionIds') as string[] | undefined;
    const artifactId = multipartString(upload.fields, 'artifactId');
    const draftId = multipartString(upload.fields, 'draftId');
    const artifactName = multipartString(upload.fields, 'artifactName');
    const artifactPath = multipartString(upload.fields, 'artifactPath');
    const expectedLatestVersionId = multipartString(upload.fields, 'expectedLatestVersionId');
    const taskId = multipartString(upload.fields, 'taskId');
    const messageId = multipartString(upload.fields, 'messageId');
    const publishBatchId = multipartString(upload.fields, 'publishBatchId');
    const note = multipartString(upload.fields, 'note');
    const result = await service.artifactV2.publish(principal, request.params.projectId, {
      ...(draftId ? { draftId } : {}),
      fileName: upload.filename,
      ...(artifactId ? { artifactId } : {}), ...(artifactName ? { artifactName } : {}),
      ...(artifactPath ? { artifactPath } : {}), ...(expectedLatestVersionId ? { expectedLatestVersionId } : {}),
      ...(parentVersionIds ? { parentVersionIds } : {}), ...(sourceResourceRefs ? { sourceResourceRefs } : {}),
      ...(taskId ? { taskId } : {}), ...(messageId ? { messageId } : {}),
      ...(publishBatchId ? { publishBatchId } : {}), ...(note ? { note } : {}),
    }, stored, optionalIdempotencyKey(request));
    return reply.status(result.created ? 201 : 200).send(result);
  });
  app.post('/v1/projects/:projectId/artifacts/from-resource', {
    schema: {
      tags: ['artifact-v2'], security: HumanSecurity, params: ProjectParams,
      body: Type.Object({
        resourceId: Id, artifactId: Type.Optional(Id), artifactName: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
        artifactPath: Type.Optional(Type.String({ maxLength: 2000 })), expectedLatestVersionId: Type.Optional(Id),
        taskId: Type.Optional(Id), messageId: Type.Optional(Id), publishBatchId: Type.Optional(Id), note: Type.Optional(Type.String({ maxLength: 2000 })),
      }),
      response: { 200: ArtifactV2PublishResponse, 201: ArtifactV2PublishResponse },
    },
  }, async (request, reply) => {
    const result = await service.artifactV2.publishFromResource(authenticate(request, service), request.params.projectId, request.body);
    return reply.status(result.created ? 201 : 200).send(result);
  });
  app.post('/v1/projects/:projectId/artifacts/from-resources', {
    schema: {
      tags: ['artifact-v2'], security: HumanSecurity, params: ProjectParams,
      body: Type.Object({
        // `items` is the v2 batch contract: each source file can explicitly
        // target an existing Artifact and carry its own CAS token/path.  The
        // resourceIds form remains a compact convenience for creating one
        // Artifact per file.
        items: Type.Optional(Type.Array(Type.Object({
          resourceId: Id,
          artifactId: Type.Optional(Id),
          artifactName: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
          artifactPath: Type.Optional(Type.String({ maxLength: 2000 })),
          expectedLatestVersionId: Type.Optional(Id),
          taskId: Type.Optional(Id),
          messageId: Type.Optional(Id),
          note: Type.Optional(Type.String({ maxLength: 2000 })),
        }), { minItems: 1, maxItems: 500 })),
        resourceIds: Type.Optional(Type.Array(Id, { minItems: 1, maxItems: 500 })),
        publishBatchId: Type.Optional(Id),
        artifactPathPrefix: Type.Optional(Type.String({ maxLength: 2000 })),
      }),
      response: { 200: Type.Object({ publishBatchId: Type.Union([Id, Type.Null()]), results: Type.Array(Type.Object({ resourceId: Id, ok: Type.Boolean(), result: Type.Optional(ArtifactV2PublishResponse), error: Type.Optional(Type.Object({ code: Type.String(), message: Type.String() })) })) }) },
    },
  }, async (request) => {
    const principal = authenticate(request, service);
    const results: Array<{ resourceId: string; ok: true; result: Awaited<ReturnType<ArtifactV2Service['publishFromResource']>> } | { resourceId: string; ok: false; error: { code: string; message: string } }> = [];
    const items: Array<{
      resourceId: string; artifactId?: string; artifactName?: string; artifactPath?: string;
      expectedLatestVersionId?: string; taskId?: string; messageId?: string; note?: string;
    }> = request.body.items ?? (request.body.resourceIds ?? []).map((resourceId) => ({ resourceId }));
    invariant(items.length > 0, 'BATCH_RESOURCES_REQUIRED', 'At least one Resource is required.');
    for (const item of items) {
      const resourceId = item.resourceId;
      try {
        const result = await service.artifactV2.publishFromResource(principal, request.params.projectId, {
          resourceId, ...(request.body.publishBatchId ? { publishBatchId: request.body.publishBatchId } : {}),
          ...(item.artifactId ? { artifactId: item.artifactId } : {}),
          ...(item.artifactName ? { artifactName: item.artifactName } : {}),
          ...(item.expectedLatestVersionId ? { expectedLatestVersionId: item.expectedLatestVersionId } : {}),
          ...(item.taskId ? { taskId: item.taskId } : {}), ...(item.messageId ? { messageId: item.messageId } : {}),
          ...(item.note ? { note: item.note } : {}),
          ...(item.artifactPath ? { artifactPath: item.artifactPath } : request.body.artifactPathPrefix ? { artifactPath: request.body.artifactPathPrefix } : {}),
        });
        results.push({ resourceId, ok: true, result });
      } catch (error) {
        const domain = error instanceof DomainError ? error : new DomainError('PUBLISH_FAILED', 'Artifact publication failed.', 400);
        results.push({ resourceId, ok: false, error: { code: domain.code, message: domain.message } });
      }
    }
    return { publishBatchId: request.body.publishBatchId ?? null, results };
  });
  app.get('/v1/projects/:projectId/artifact-held-drafts', { schema: { tags: ['artifact-v2'], security: HumanSecurity, params: ProjectParams } }, async (request) => ({ items: service.artifactV2.listHeldDrafts(authenticate(request, service), request.params.projectId) }));
  app.post('/v1/artifact-held-drafts/:draftId/discard', { schema: { tags: ['artifact-v2'], security: HumanSecurity, params: Type.Object({ draftId: Id }) } }, async (request, reply) => { service.artifactV2.discardHeldDraft(requireHuman(authenticate(request, service)), request.params.draftId); return reply.status(204).send(); });

  // ID-only aliases are retained for version links embedded in existing
  // messages. They resolve through the Project-scoped v2 service and never
  // expose the removed Workspace Artifact model.
  app.get('/v1/artifact-v2/:artifactId', { schema: { tags: ['artifact-v2'], security: HumanSecurity, params: ArtifactParams, response: { 200: ArtifactV2Response } } }, async (request) => service.artifactV2.getArtifact(requireHuman(authenticate(request, service)), request.params.artifactId));
  app.get('/v1/artifact-v2/:artifactId/versions', { schema: { tags: ['artifact-v2'], security: HumanSecurity, params: ArtifactParams, response: { 200: Type.Object({ items: Type.Array(ArtifactVersionV2Response) }) } } }, async (request) => ({ items: service.artifactV2.listVersions(requireHuman(authenticate(request, service)), request.params.artifactId) }));
  app.get('/v1/artifact-v2/:artifactId/versions/:versionId', { schema: { tags: ['artifact-v2'], security: HumanSecurity, params: ArtifactVersionV2Params, response: { 200: ArtifactVersionV2Response } } }, async (request) => service.artifactV2.getVersion(requireHuman(authenticate(request, service)), request.params.versionId));
  app.patch('/v1/artifact-v2/:artifactId', { schema: { tags: ['artifact-v2'], security: HumanSecurity, params: ArtifactParams, body: Type.Object({ name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })), projectPath: Type.Optional(Type.String({ maxLength: 2000 })) }), response: { 200: ArtifactV2Response } } }, async (request) => service.artifactV2.updateArtifact(requireHuman(authenticate(request, service)), request.params.artifactId, request.body));
  app.delete('/v1/artifact-v2/:artifactId', { schema: { tags: ['artifact-v2'], security: HumanSecurity, params: ArtifactParams, response: { 200: ArtifactV2Response } } }, async (request) => service.artifactV2.deleteArtifact(requireHuman(authenticate(request, service)), request.params.artifactId));
  app.post('/v1/artifact-v2/:artifactId/restore', { schema: { tags: ['artifact-v2'], security: HumanSecurity, params: ArtifactParams, response: { 200: ArtifactV2Response } } }, async (request) => service.artifactV2.restoreArtifact(requireHuman(authenticate(request, service)), request.params.artifactId));
  app.get('/v1/artifact-versions/:versionId', { schema: { tags: ['artifact-v2'], security: HumanSecurity, params: ArtifactVersionOnlyParams, response: { 200: ArtifactVersionV2Response } } }, async (request) => service.artifactV2.getVersion(requireHuman(authenticate(request, service)), request.params.versionId));
  app.get('/v1/artifact-versions/:versionId/download', { schema: { tags: ['artifact-v2'], security: HumanSecurity, params: ArtifactVersionOnlyParams } }, async (request, reply) => { const result = service.artifactV2.readVersion(requireHuman(authenticate(request, service)), request.params.versionId); reply.header('Content-Type', result.version.mediaType); reply.header('Content-Length', String(result.version.byteLength)); reply.header('Content-Disposition', artifactAttachmentDisposition(result.version.fileName, result.version.mediaType, result.version.versionId)); return reply.send(service.artifactV2.blobs.read(result.storagePath)); });
  app.get('/v1/artifact-versions/:versionId/preview', { schema: { tags: ['artifact-v2'], security: HumanSecurity, params: ArtifactVersionOnlyParams } }, async (request, reply) => { const result = service.artifactV2.readVersion(requireHuman(authenticate(request, service)), request.params.versionId); reply.header('Content-Type', result.version.mediaType); reply.header('Content-Length', String(result.version.byteLength)); reply.header('Content-Disposition', 'inline'); return reply.send(service.artifactV2.blobs.read(result.storagePath)); });
  app.get('/v1/artifact-versions/:versionId/context', { schema: { tags: ['artifact-v2'], security: HumanSecurity, params: ArtifactVersionOnlyParams } }, async (request) => service.artifactV2.getVersionContext(requireHuman(authenticate(request, service)), request.params.versionId));
  app.delete('/v1/artifact-versions/:versionId', { schema: { tags: ['artifact-v2'], security: HumanSecurity, params: ArtifactVersionOnlyParams, response: { 200: ArtifactVersionV2Response } } }, async (request) => service.artifactV2.deleteVersion(requireHuman(authenticate(request, service)), request.params.versionId));
  app.post('/v1/artifact-versions/:versionId/restore', { schema: { tags: ['artifact-v2'], security: HumanSecurity, params: ArtifactVersionOnlyParams, response: { 200: ArtifactVersionV2Response } } }, async (request) => service.artifactV2.restoreVersion(requireHuman(authenticate(request, service)), request.params.versionId));

  // Project-scoped aliases keep the resource boundary explicit for API clients.
  app.get('/v1/projects/:projectId/artifacts/:artifactId', { schema: { tags: ['artifact-v2'], security: HumanSecurity, params: ProjectArtifactV2Params, response: { 200: ArtifactV2Response } } }, async (request) => service.artifactV2.getArtifactInProject(authenticate(request, service), request.params.projectId, request.params.artifactId));
  app.get('/v1/projects/:projectId/artifacts/:artifactId/versions', { schema: { tags: ['artifact-v2'], security: HumanSecurity, params: ProjectArtifactV2Params, response: { 200: Type.Object({ items: Type.Array(ArtifactVersionV2Response) }) } } }, async (request) => { const principal = authenticate(request, service); service.artifactV2.getArtifactInProject(principal, request.params.projectId, request.params.artifactId); return { items: service.artifactV2.listVersions(principal, request.params.artifactId) }; });
  app.get('/v1/projects/:projectId/artifacts/:artifactId/versions/:versionId', { schema: { tags: ['artifact-v2'], security: HumanSecurity, params: ProjectArtifactVersionV2Params, response: { 200: ArtifactVersionV2Response } } }, async (request) => { const principal = authenticate(request, service); service.artifactV2.getArtifactInProject(principal, request.params.projectId, request.params.artifactId); return service.artifactV2.getVersion(principal, request.params.versionId); });
  app.get('/v1/projects/:projectId/artifacts/:artifactId/versions/:versionId/download', { schema: { tags: ['artifact-v2'], security: HumanSecurity, params: ProjectArtifactVersionV2Params } }, async (request, reply) => {
    const principal = authenticate(request, service); service.artifactV2.getArtifactInProject(principal, request.params.projectId, request.params.artifactId);
    const result = service.artifactV2.readVersion(principal, request.params.versionId);
    reply.header('Content-Type', result.version.mediaType);
    reply.header('Content-Length', String(result.version.byteLength));
    reply.header('Content-Disposition', artifactAttachmentDisposition(result.version.fileName, result.version.mediaType, result.version.versionId));
    return reply.send(service.artifactV2.blobs.read(result.storagePath));
  });
  app.get('/v1/projects/:projectId/artifacts/:artifactId/versions/:versionId/preview', { schema: { tags: ['artifact-v2'], security: HumanSecurity, params: ProjectArtifactVersionV2Params } }, async (request, reply) => {
    const principal = authenticate(request, service); service.artifactV2.getArtifactInProject(principal, request.params.projectId, request.params.artifactId);
    const result = service.artifactV2.readVersion(principal, request.params.versionId);
    reply.header('Content-Type', result.version.mediaType);
    reply.header('Content-Length', String(result.version.byteLength));
    reply.header('Content-Disposition', 'inline');
    return reply.send(service.artifactV2.blobs.read(result.storagePath));
  });
  app.get('/v1/projects/:projectId/artifacts/:artifactId/versions/:versionId/context', { schema: { tags: ['artifact-v2'], security: HumanSecurity, params: ProjectArtifactVersionV2Params } }, async (request) => { const principal = authenticate(request, service); service.artifactV2.getArtifactInProject(principal, request.params.projectId, request.params.artifactId); return service.artifactV2.getVersionContext(principal, request.params.versionId); });
  app.delete('/v1/projects/:projectId/artifacts/:artifactId/versions/:versionId', { schema: { tags: ['artifact-v2'], security: HumanSecurity, params: ProjectArtifactVersionV2Params, response: { 200: ArtifactVersionV2Response } } }, async (request) => { const principal = requireHuman(authenticate(request, service)); service.artifactV2.getArtifactInProject(principal, request.params.projectId, request.params.artifactId, true); return service.artifactV2.deleteVersion(principal, request.params.versionId); });
  app.post('/v1/projects/:projectId/artifacts/:artifactId/versions/:versionId/restore', { schema: { tags: ['artifact-v2'], security: HumanSecurity, params: ProjectArtifactVersionV2Params, response: { 200: ArtifactVersionV2Response } } }, async (request) => { const principal = requireHuman(authenticate(request, service)); service.artifactV2.getArtifactInProject(principal, request.params.projectId, request.params.artifactId, true); return service.artifactV2.restoreVersion(principal, request.params.versionId); });
  app.patch('/v1/projects/:projectId/artifacts/:artifactId', { schema: { tags: ['artifact-v2'], security: HumanSecurity, params: ProjectArtifactV2Params, body: Type.Object({ name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })), projectPath: Type.Optional(Type.String({ maxLength: 2000 })) }), response: { 200: ArtifactV2Response } } }, async (request) => { const principal = requireHuman(authenticate(request, service)); service.artifactV2.getArtifactInProject(principal, request.params.projectId, request.params.artifactId); return service.artifactV2.updateArtifact(principal, request.params.artifactId, request.body); });
  app.post('/v1/projects/:projectId/artifacts/:artifactId/restore', { schema: { tags: ['artifact-v2'], security: HumanSecurity, params: ProjectArtifactV2Params, response: { 200: ArtifactV2Response } } }, async (request) => { const principal = requireHuman(authenticate(request, service)); service.artifactV2.getArtifactInProject(principal, request.params.projectId, request.params.artifactId, true); return service.artifactV2.restoreArtifact(principal, request.params.artifactId); });

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
      body: Type.Object({ workspaceMembershipId: Id, role: ProjectAssignableRoleSchema }),
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

  app.post('/v1/projects/:projectId/work-items', {
    schema: {
      tags: ['work-item'], security: HumanSecurity, headers: IdempotencyHeaders, params: ProjectParams,
      body: Type.Object({
        description: Type.String({ minLength: 1, maxLength: 10000 }),
        assigneeProjectMembershipId: Type.Optional(Type.Union([Id, Type.Null()])),
        assigneeProjectMembershipIds: Type.Optional(Type.Array(Id, { uniqueItems: true, maxItems: 50 })),
      }, { additionalProperties: false }),
      response: { 201: WorkItemResponse },
    },
  }, async (request, reply) => reply.status(201).send(service.createWorkItem(
    requireHuman(authenticate(request, service)),
    request.params.projectId,
    request.body,
    idempotencyKey(request),
  )));

  app.post('/v1/messages/:messageId/work-item', {
    schema: {
      tags: ['work-item'], security: HumanSecurity, headers: IdempotencyHeaders, params: MessageParams,
      body: Type.Object({
        description: Type.Optional(Type.String({ minLength: 1, maxLength: 10000 })),
        assigneeProjectMembershipId: Type.Optional(Type.Union([Id, Type.Null()])),
        assigneeProjectMembershipIds: Type.Optional(Type.Array(Id, { uniqueItems: true, maxItems: 50 })),
      }, { additionalProperties: false }),
      response: { 201: WorkItemResponse },
    },
  }, async (request, reply) => reply.status(201).send(service.createWorkItemFromMessage(
    requireHuman(authenticate(request, service)),
    request.params.messageId,
    request.body,
    idempotencyKey(request),
  )));

  app.get('/v1/projects/:projectId/work-items', {
    schema: {
      tags: ['work-item'], security: HumanSecurity, params: ProjectParams,
      response: { 200: Type.Object({ items: Type.Array(WorkItemResponse) }) },
    },
  }, async (request) => ({
    items: service.listProjectWorkItems(
      requireHuman(authenticate(request, service)),
      request.params.projectId,
    ),
  }));

  app.get('/v1/work-items/:workItemId', {
    schema: { tags: ['work-item'], security: HumanSecurity, params: WorkItemParams, response: { 200: WorkItemResponse } },
  }, async (request) => service.getWorkItem(
    requireHuman(authenticate(request, service)),
    request.params.workItemId,
  ));

  app.patch('/v1/work-items/:workItemId', {
    schema: {
      tags: ['work-item'], security: HumanSecurity, headers: IdempotencyHeaders, params: WorkItemParams,
      body: Type.Object({
        description: Type.String({ minLength: 1, maxLength: 10000 }),
        expectedRevision: Type.Integer({ minimum: 1 }),
      }, { additionalProperties: false }),
      response: { 200: WorkItemResponse },
    },
  }, async (request) => service.updateWorkItemDetails(
    requireHuman(authenticate(request, service)),
    request.params.workItemId,
    request.body,
    idempotencyKey(request),
  ));

  app.get('/v1/work-items/:workItemId/comments', {
    schema: {
      tags: ['work-item'], security: HumanSecurity, params: WorkItemParams,
      response: { 200: Type.Object({ items: Type.Array(WorkItemCommentResponse) }) },
    },
  }, async (request) => ({
    items: service.listWorkItemComments(
      requireHuman(authenticate(request, service)),
      request.params.workItemId,
    ),
  }));

  app.post('/v1/work-items/:workItemId/comments', {
    schema: {
      tags: ['work-item'], security: HumanSecurity, headers: IdempotencyHeaders, params: WorkItemParams,
      body: Type.Object({
        body: Type.String({ minLength: 1, maxLength: 10_000 }),
        mentionedActorIds: Type.Optional(Type.Array(Id, { uniqueItems: true, maxItems: 100 })),
        workItemIds: Type.Optional(Type.Array(Id, { uniqueItems: true, maxItems: 50 })),
        artifactSelections: Type.Optional(Type.Array(Type.Object({ artifactId: Id, artifactVersionId: Id }), { maxItems: 100 })),
      }, { additionalProperties: false }),
      response: { 201: WorkItemCommentResponse },
    },
  }, async (request, reply) => reply.status(201).send(service.postWorkItemComment(
    requireHuman(authenticate(request, service)),
    request.params.workItemId,
    request.body,
    idempotencyKey(request),
  )));

  app.post('/v1/work-items/:workItemId/submissions', {
    schema: {
      tags: ['work-item'], security: HumanSecurity, headers: IdempotencyHeaders, params: WorkItemParams,
      body: Type.Object({
        artifactVersionIds: Type.Array(Id, { minItems: 1, uniqueItems: true, maxItems: 100 }),
        expectedRevision: Type.Integer({ minimum: 1 }),
      }, { additionalProperties: false }),
      response: { 201: WorkItemResponse },
    },
  }, async (request, reply) => reply.status(201).send(service.submitHumanWorkItemResult(
    requireHuman(authenticate(request, service)),
    request.params.workItemId,
    request.body,
    idempotencyKey(request),
  )));

  app.post('/v1/work-items/:workItemId/assignment', {
    schema: {
      tags: ['work-item'], security: HumanSecurity, headers: IdempotencyHeaders, params: WorkItemParams,
      body: Type.Object({
        assigneeProjectMembershipId: Type.Union([Id, Type.Null()]),
        assigneeProjectMembershipIds: Type.Optional(Type.Array(Id, { uniqueItems: true, maxItems: 50 })),
        expectedRevision: Type.Integer({ minimum: 1 }),
        expectedAssignmentRevision: Type.Integer({ minimum: 0 }),
      }, { additionalProperties: false }),
      response: { 200: WorkItemResponse },
    },
  }, async (request) => service.assignWorkItem(
    requireHuman(authenticate(request, service)), request.params.workItemId, request.body, idempotencyKey(request),
  ));

  app.post('/v1/work-items/:workItemId/block', {
    schema: {
      tags: ['work-item'], security: HumanSecurity, headers: IdempotencyHeaders, params: WorkItemParams,
      body: Type.Object({
        reason: Type.String({ minLength: 1, maxLength: 2000 }),
        expectedRevision: Type.Integer({ minimum: 1 }),
      }, { additionalProperties: false }),
      response: { 200: WorkItemResponse },
    },
  }, async (request) => service.blockWorkItem(
    requireHuman(authenticate(request, service)), request.params.workItemId, request.body, idempotencyKey(request),
  ));

  app.post('/v1/work-items/:workItemId/unblock', {
    schema: {
      tags: ['work-item'], security: HumanSecurity, headers: IdempotencyHeaders, params: WorkItemParams,
      body: RevisionBody, response: { 200: WorkItemResponse },
    },
  }, async (request) => service.unblockWorkItem(
    requireHuman(authenticate(request, service)), request.params.workItemId,
    request.body.expectedRevision, idempotencyKey(request),
  ));

  app.post('/v1/work-items/:workItemId/complete', {
    schema: {
      tags: ['work-item'], security: HumanSecurity, headers: IdempotencyHeaders, params: WorkItemParams,
      body: RevisionBody, response: { 200: WorkItemResponse },
    },
  }, async (request) => service.completeWorkItem(
    requireHuman(authenticate(request, service)), request.params.workItemId,
    request.body.expectedRevision, idempotencyKey(request),
  ));

  app.post('/v1/work-items/:workItemId/cancel', {
    schema: {
      tags: ['work-item'], security: HumanSecurity, headers: IdempotencyHeaders, params: WorkItemParams,
      body: Type.Object({
        reason: Type.Optional(Type.String({ maxLength: 2000 })),
        expectedRevision: Type.Integer({ minimum: 1 }),
      }, { additionalProperties: false }),
      response: { 200: WorkItemResponse },
    },
  }, async (request) => service.cancelWorkItem(
    requireHuman(authenticate(request, service)), request.params.workItemId, request.body, idempotencyKey(request),
  ));

  app.get('/v1/workspaces/:workspaceId/join-links', {
    schema: {
      tags: ['membership'], security: HumanSecurity, params: WorkspaceParams, querystring: CursorQuery,
      response: { 200: Type.Object({ items: Type.Array(WorkspaceJoinLinkResponse), nextCursor: Type.Union([Type.String(), Type.Null()]) }) },
    },
  }, async (request) => {
    const principal = requireHuman(authenticate(request, service));
    return service.listWorkspaceJoinLinks(principal, request.params.workspaceId, request.query.cursor, request.query.limit ?? 100);
  });

  app.post('/v1/workspaces/:workspaceId/join-links', {
    schema: {
      tags: ['membership'], security: HumanSecurity, params: WorkspaceParams,
      response: { 201: WorkspaceJoinLinkCreatedResponse },
    },
  }, async (request, reply) => {
    const principal = requireHuman(authenticate(request, service));
    return reply.status(201).send(
      service.createWorkspaceJoinLink(principal, request.params.workspaceId),
    );
  });

  app.get('/v1/workspace-join-links/:token', {
    schema: {
      tags: ['membership'], security: HumanSecurity, params: WorkspaceJoinTokenParams,
      response: { 200: WorkspaceJoinLinkPreviewResponse },
    },
  }, async (request) => service.previewWorkspaceJoinLink(
    requireHuman(authenticate(request, service)),
    request.params.token,
  ));

  app.post('/v1/workspace-join-links/:token/accept', {
    schema: {
      tags: ['membership'], security: HumanSecurity, headers: IdempotencyHeaders, params: WorkspaceJoinTokenParams,
      response: { 200: WorkspaceMemberResponse },
    },
  }, async (request) => {
    const principal = requireHuman(authenticate(request, service));
    return service.acceptWorkspaceJoinLink(
      principal,
      request.params.token,
      idempotencyKey(request),
    );
  });

  app.post('/v1/workspace-join-links/:joinLinkId/revoke', {
    schema: {
      tags: ['membership'], security: HumanSecurity, headers: IdempotencyHeaders, params: WorkspaceJoinLinkParams,
      body: RevisionBody, response: { 200: WorkspaceJoinLinkResponse },
    },
  }, async (request) => {
    const principal = requireHuman(authenticate(request, service));
    return service.revokeWorkspaceJoinLink(
      principal,
      request.params.joinLinkId,
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

  app.get('/v1/workspaces/:workspaceId/agent-activity', {
    schema: {
      tags: ['agent', 'runtime'], security: HumanSecurity, params: WorkspaceParams,
      querystring: Type.Object({
        agentId: Type.Optional(Id),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 100 })),
      }),
      response: { 200: Type.Object({ items: Type.Array(AgentActivityEventResponse) }) },
    },
  }, async (request) => ({
    items: service.listAgentActivity(
      requireHuman(authenticate(request, service)),
      request.params.workspaceId,
      request.query.agentId,
      request.query.limit ?? 100,
    ),
  }));

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
        kind: Type.Literal('dm'),
        title: Type.Optional(Type.String({ maxLength: 200 })),
        visibility: Type.Optional(Type.Literal('private')),
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
        participantProjectMembershipIds: Type.Array(Id, { uniqueItems: true, maxItems: 200 }),
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
          artifactVersionId: Id,
        }, { additionalProperties: false }), { maxItems: 100 })),
        workItemIds: Type.Optional(Type.Array(Id, { uniqueItems: true, maxItems: 50 })),
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
          artifactVersionId: Id,
        }, { additionalProperties: false }), { maxItems: 100 })),
        workItemIds: Type.Optional(Type.Array(Id, { uniqueItems: true, maxItems: 50 })),
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

  const ConversationParticipantParams = Type.Object({
    conversationId: Id,
    scopeMembershipId: Id,
  });
  const ConversationParticipantRemovalResponse = Type.Object({
    scopeMembershipId: Id,
    revision: Type.Integer({ minimum: 1 }),
    contextVersion: Type.Integer({ minimum: 1 }),
    removedAt: Type.Integer(),
    cancelledAgentRequestIds: Type.Array(Id),
    cancelledRunIds: Type.Array(Id),
  });

  app.put('/v1/conversations/:conversationId/participants/:scopeMembershipId', {
    schema: {
      tags: ['conversation'], security: HumanSecurity, headers: IdempotencyHeaders,
      params: ConversationParticipantParams, body: RevisionBody,
      response: { 200: ConversationParticipantResponse },
    },
  }, async (request) => service.addConversationParticipant(
    requireHuman(authenticate(request, service)),
    request.params.conversationId,
    request.params.scopeMembershipId,
    request.body.expectedRevision,
    idempotencyKey(request),
  ));

  app.delete('/v1/conversations/:conversationId/participants/:scopeMembershipId', {
    schema: {
      tags: ['conversation'], security: HumanSecurity, headers: IdempotencyHeaders,
      params: ConversationParticipantParams, body: RevisionBody,
      response: { 200: ConversationParticipantRemovalResponse },
    },
  }, async (request) => service.removeConversationParticipant(
    requireHuman(authenticate(request, service)),
    request.params.conversationId,
    request.params.scopeMembershipId,
    request.body.expectedRevision,
    idempotencyKey(request),
  ));

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
    return service.getAttemptExecutionInput(principal.computerId, request.params.attemptId) as any;
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

  app.get('/v1/computers/self/agents/:agentId/session-input', {
    schema: {
      tags: ['agent-inbox', 'runtime'], security: BearerSecurity, params: ComputerAgentParams,
      querystring: Type.Object({
        kind: Type.Union([Type.Literal('mention'), Type.Literal('work_item')]),
        key: Id,
      }),
      response: { 200: AgentSessionInputResponse },
    },
  }, async (request) => {
    const principal = requireComputer(authenticate(request, service));
    return service.getComputerAgentSessionInput(principal.computerId, request.params.agentId, request.query);
  });

  app.post('/v1/computers/self/agents/:agentId/activity', {
    schema: {
      tags: ['agent-inbox', 'runtime'], security: BearerSecurity, headers: IdempotencyHeaders,
      params: ComputerAgentParams, body: AgentActivityEventInput,
      response: { 200: AgentActivityEventResponse },
    },
  }, async (request) => service.recordComputerAgentActivity(
    requireComputer(authenticate(request, service)).computerId,
    request.params.agentId,
    request.body,
  ));

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

  app.get('/v1/computers/self/agent-inbox-wakes', {
    schema: {
      tags: ['agent-inbox'], security: BearerSecurity,
      response: { 200: AgentInboxWakeBatchResponse },
    },
  }, async (request) => {
    const principal = requireComputer(authenticate(request, service));
    return service.getComputerAgentInboxWakes(principal.computerId, {});
  });

  app.get('/v1/computers/self/agents/:agentId/work-items', {
    schema: {
      tags: ['work-item', 'agent-inbox'], security: BearerSecurity, params: ComputerAgentParams,
      querystring: Type.Object({ projectId: Type.Optional(Id) }),
      response: { 200: Type.Object({ items: Type.Array(WorkItemResponse) }) },
    },
  }, async (request) => {
    const principal = requireComputer(authenticate(request, service));
    return {
      items: service.listComputerAgentWorkItems(
        principal.computerId,
        request.params.agentId,
        request.query.projectId,
      ),
    };
  });

  app.get('/v1/computers/self/agents/:agentId/work-items/:workItemId', {
    schema: {
      tags: ['work-item', 'agent-inbox'], security: BearerSecurity,
      params: ComputerAgentWorkItemParams,
      response: { 200: WorkItemResponse },
    },
  }, async (request) => {
    const principal = requireComputer(authenticate(request, service));
    return service.getComputerAgentWorkItem(
      principal.computerId,
      request.params.agentId,
      request.params.workItemId,
    );
  });

  app.get('/v1/computers/self/agents/:agentId/work-items/:workItemId/comments', {
    schema: {
      tags: ['work-item', 'agent-inbox'], security: BearerSecurity,
      params: ComputerAgentWorkItemParams,
      response: { 200: Type.Object({ items: Type.Array(WorkItemCommentResponse) }) },
    },
  }, async (request) => {
    const principal = requireComputer(authenticate(request, service));
    return {
      items: service.listComputerAgentWorkItemComments(
        principal.computerId,
        request.params.agentId,
        request.params.workItemId,
      ),
    };
  });

  app.post('/v1/computers/self/agents/:agentId/work-items/:workItemId/comments', {
    schema: {
      tags: ['work-item', 'agent-inbox'], security: BearerSecurity, headers: IdempotencyHeaders,
      params: ComputerAgentWorkItemParams,
      body: Type.Object({
        body: Type.String({ minLength: 1, maxLength: 10_000 }),
        mentionedActorIds: Type.Optional(Type.Array(Id, { uniqueItems: true, maxItems: 100 })),
        workItemIds: Type.Optional(Type.Array(Id, { uniqueItems: true, maxItems: 50 })),
        artifactSelections: Type.Optional(Type.Array(Type.Object({ artifactId: Id, artifactVersionId: Id }), { maxItems: 100 })),
      }, { additionalProperties: false }),
      response: { 201: WorkItemCommentResponse },
    },
  }, async (request, reply) => {
    const principal = requireComputer(authenticate(request, service));
    return reply.status(201).send(service.postComputerAgentWorkItemComment(
      principal.computerId,
      request.params.agentId,
      request.params.workItemId,
      request.body,
      idempotencyKey(request),
    ));
  });

  app.post('/v1/computers/self/agents/:agentId/work-items/:workItemId/block', {
    schema: {
      tags: ['work-item', 'agent-inbox'], security: BearerSecurity, headers: IdempotencyHeaders,
      params: ComputerAgentWorkItemParams,
      body: Type.Object({
        reason: Type.String({ minLength: 1, maxLength: 2000 }),
        expectedRevision: Type.Integer({ minimum: 1 }),
        expectedAssignmentRevision: Type.Integer({ minimum: 1 }),
      }, { additionalProperties: false }),
      response: { 200: WorkItemResponse },
    },
  }, async (request) => {
    const principal = requireComputer(authenticate(request, service));
    return service.blockComputerAgentWorkItem(
      principal.computerId,
      request.params.agentId,
      request.params.workItemId,
      request.body,
      idempotencyKey(request),
    );
  });

  app.post('/v1/computers/self/agents/:agentId/work-items/:workItemId/submissions', {
    schema: {
      tags: ['work-item', 'agent-inbox'], security: BearerSecurity, headers: IdempotencyHeaders,
      params: ComputerAgentWorkItemParams,
      body: Type.Object({
        commentId: Type.Optional(Type.Union([Id, Type.Null()])),
        artifactVersionIds: Type.Optional(Type.Array(Id, { uniqueItems: true, maxItems: 100 })),
        expectedRevision: Type.Integer({ minimum: 1 }),
        expectedAssignmentRevision: Type.Integer({ minimum: 0 }),
      }, { additionalProperties: false }),
      response: { 201: WorkItemResponse },
    },
  }, async (request, reply) => {
    const principal = requireComputer(authenticate(request, service));
    return reply.status(201).send(service.submitComputerAgentWorkItemResult(
      principal.computerId,
      request.params.agentId,
      request.params.workItemId,
      request.body,
      idempotencyKey(request),
    ));
  });

  app.post('/v1/computers/self/agents/:agentId/inbox/claim', {
    schema: {
      tags: ['agent-inbox'], security: BearerSecurity, headers: IdempotencyHeaders, params: ComputerAgentParams,
      body: Type.Object({
        target: Type.String({ minLength: 1, maxLength: 500 }),
        receipt: Type.String({ minLength: 1, maxLength: 500 }),
        agentRequestId: Id,
        initialDiscussionFrontier: Type.Optional(Type.Integer({ minimum: 0 })),
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
      querystring: Type.Object({ conversationId: Id, threadId: Type.Optional(Id) }),
      response: { 200: MessageResponse },
    },
  }, async (request) => {
    const principal = requireComputer(authenticate(request, service));
    return service.resolveComputerAgentMessage(principal.computerId, request.params.agentId, {
      conversationId: request.query.conversationId,
      threadId: request.query.threadId ?? null,
      messageId: request.params.messageId,
    });
  });

  app.post('/v1/computers/self/agents/:agentId/messages', {
    schema: {
      tags: ['agent-inbox'], security: BearerSecurity, headers: IdempotencyHeaders, params: ComputerAgentParams,
      body: Type.Object({
        conversationId: Id,
        threadId: Type.Union([Id, Type.Null()]),
        receipt: Type.String({ minLength: 1, maxLength: 500 }),
        draftId: Id,
        expectedDiscussionFrontier: Type.Integer({ minimum: 0 }),
        body: Type.String({ minLength: 1, maxLength: 100000 }),
        artifactVersionIds: Type.Optional(Type.Array(Id, { uniqueItems: true, maxItems: 100 })),
        mentionedActorIds: Type.Optional(Type.Array(Id, { uniqueItems: true, maxItems: 50 })),
        workItemIds: Type.Optional(Type.Array(Id, { uniqueItems: true, maxItems: 50 })),
        mode: Type.Union([Type.Literal('check'), Type.Literal('override')]),
      }, { additionalProperties: false }),
      response: { 200: AgentMessagePublicationResponse },
    },
  }, async (request) => {
    const principal = requireComputer(authenticate(request, service));
    return service.sendComputerAgentMessage(
      principal.computerId,
      request.params.agentId,
      request.body,
      idempotencyKey(request),
    );
  });

  app.post('/v1/computers/self/agents/:agentId/inbox/complete', {
    schema: {
      tags: ['agent-inbox'], security: BearerSecurity, headers: IdempotencyHeaders, params: ComputerAgentParams,
      body: Type.Object({
        receipt: Type.String({ minLength: 1, maxLength: 500 }),
        target: Type.String({ minLength: 1, maxLength: 500 }),
        expectedDiscussionFrontier: Type.Optional(Type.Integer({ minimum: 0 })),
        draftId: Type.Optional(Id),
      }, { additionalProperties: false }),
      response: { 200: AgentInboxCompletionResponse },
    },
  }, async (request) => {
    const principal = requireComputer(authenticate(request, service));
    return service.completeComputerAgentInbox(
      principal.computerId,
      request.params.agentId,
      request.body,
      idempotencyKey(request),
    );
  });

  // Agent-scoped v2 runtime surface.  The URL binds both the Agent and
  // Project, so the Computer token cannot silently publish under its owner's
  // unrelated Project membership.  Only read operations exist for resources;
  // Artifact publication is the sole Agent write operation.
  app.get('/v1/computers/self/agents/:agentId/projects/:projectId/resources', {
    schema: { tags: ['agent-runtime', 'project-resource'], security: BearerSecurity, params: ComputerAgentProjectParams, response: { 200: Type.Object({ items: Type.Array(ProjectResourceResponse) }) } },
  }, async (request) => {
    const principal = requireComputer(authenticate(request, service));
    return { items: service.projectResources.list({ ...principal, agentId: request.params.agentId }, request.params.projectId) };
  });
  app.get('/v1/computers/self/agents/:agentId/projects/:projectId/resources/:resourceId', {
    schema: { tags: ['agent-runtime', 'project-resource'], security: BearerSecurity, params: ComputerAgentProjectResourceParams, response: { 200: Type.Object({ resource: ProjectResourceResponse, contentBase64: Type.Optional(Type.String()) }) } },
  }, async (request) => {
    const principal = requireComputer(authenticate(request, service));
    const scoped = { ...principal, agentId: request.params.agentId };
    const resource = service.projectResources.get(scoped, request.params.resourceId);
    invariant(resource.projectId === request.params.projectId, 'PROJECT_SCOPE_VIOLATION', 'Resource does not belong to this Project.', 404);
    if (resource.kind === 'directory') return { resource };
    const content = service.projectResources.read(scoped, request.params.resourceId);
    return { resource, contentBase64: readFileSync(content.storagePath).toString('base64') };
  });
  app.get('/v1/computers/self/agents/:agentId/projects/:projectId/links', {
    schema: { tags: ['agent-runtime', 'project-link'], security: BearerSecurity, params: ComputerAgentProjectParams, response: { 200: Type.Object({ items: Type.Array(ProjectLinkResponse) }) } },
  }, async (request) => {
    const principal = requireComputer(authenticate(request, service));
    return { items: service.projectResources.listLinks({ ...principal, agentId: request.params.agentId }, request.params.projectId) };
  });
  app.get('/v1/computers/self/agents/:agentId/projects/:projectId/artifacts/:artifactId', {
    schema: { tags: ['agent-runtime', 'artifact-v2'], security: BearerSecurity, params: ComputerAgentProjectArtifactParams, response: { 200: ArtifactV2Response } },
  }, async (request) => {
    const principal = { ...requireComputer(authenticate(request, service)), agentId: request.params.agentId };
    const artifact = service.artifactV2.getArtifactInProject(principal, request.params.projectId, request.params.artifactId);
    if (!artifact.latestVersion || artifact.latestVersion.status !== 'active') return artifact;
    const content = service.artifactV2.readVersion(principal, artifact.latestVersion.versionId);
    return { ...artifact, contentBase64: readFileSync(content.storagePath).toString('base64'), mediaType: content.version.mediaType };
  });
  app.post('/v1/computers/self/agents/:agentId/projects/:projectId/artifacts', {
    schema: { tags: ['agent-runtime', 'artifact-v2'], security: BearerSecurity, headers: IdempotencyHeaders, params: ComputerAgentProjectParams, consumes: ['multipart/form-data'], response: { 200: ArtifactV2PublishResponse, 201: ArtifactV2PublishResponse } },
  }, async (request, reply) => {
    const principal = { ...requireComputer(authenticate(request, service)), agentId: request.params.agentId };
    const upload = await request.file({ limits: { fileSize: MAX_ARTIFACT_BYTES, files: 1 } });
    invariant(upload, 'ARTIFACT_FILE_REQUIRED', 'An Artifact file upload is required.');
    const stored = await service.artifactV2.blobs.write(upload.file, upload.mimetype);
    const jsonField = (name: string): unknown => {
      const value = multipartString(upload.fields, name); if (!value) return undefined;
      try { return JSON.parse(value); } catch { throw new DomainError('INVALID_MULTIPART_FIELD', `${name} must be valid JSON.`, 400); }
    };
    const artifactId = multipartString(upload.fields, 'artifactId');
    const draftId = multipartString(upload.fields, 'draftId');
    const expectedLatestVersionId = multipartString(upload.fields, 'expectedLatestVersionId');
    const parentVersionIds = jsonField('parentVersionIds') as string[] | undefined;
    const sourceResourceRefs = jsonField('sourceResourceRefs') as Array<{ resourceId: string; revision?: number; digest?: string }> | undefined;
    const result = await service.artifactV2.publish(principal, request.params.projectId, {
      ...(draftId ? { draftId } : {}),
      fileName: upload.filename,
      ...(artifactId ? { artifactId } : {}),
      ...(multipartString(upload.fields, 'artifactName') ? { artifactName: multipartString(upload.fields, 'artifactName')! } : {}),
      ...(multipartString(upload.fields, 'artifactPath') ? { artifactPath: multipartString(upload.fields, 'artifactPath')! } : {}),
      ...(expectedLatestVersionId ? { expectedLatestVersionId } : {}),
      ...(parentVersionIds ? { parentVersionIds } : {}), ...(sourceResourceRefs ? { sourceResourceRefs } : {}),
      ...(multipartString(upload.fields, 'taskId') ? { taskId: multipartString(upload.fields, 'taskId')! } : {}),
      ...(multipartString(upload.fields, 'messageId') ? { messageId: multipartString(upload.fields, 'messageId')! } : {}),
      ...(multipartString(upload.fields, 'publishBatchId') ? { publishBatchId: multipartString(upload.fields, 'publishBatchId')! } : {}),
      ...(multipartString(upload.fields, 'note') ? { note: multipartString(upload.fields, 'note')! } : {}),
    }, stored, optionalIdempotencyKey(request));
    return reply.status(result.created ? 201 : 200).send(result);
  });
  app.post('/v1/computers/self/agents/:agentId/projects/:projectId/artifact-held-drafts/:draftId/retry', {
    schema: { tags: ['agent-runtime', 'artifact-v2'], security: BearerSecurity, headers: IdempotencyHeaders, params: Type.Object({ agentId: Id, projectId: Id, draftId: Id }), body: Type.Object({ mode: Type.Optional(Type.Union([Type.Literal('retry'), Type.Literal('force')])) }, { additionalProperties: false }), response: { 200: ArtifactV2PublishResponse, 201: ArtifactV2PublishResponse } },
  }, async (request, reply) => {
    const principal = { ...requireComputer(authenticate(request, service)), agentId: request.params.agentId };
    const result = await service.artifactV2.retryHeldDraft(principal, request.params.draftId, request.body.mode ?? 'retry', request.params.projectId);
    return reply.status(result.created ? 201 : 200).send(result);
  });
  app.post('/v1/computers/self/agents/:agentId/projects/:projectId/artifact-held-drafts/:draftId/discard', {
    schema: { tags: ['agent-runtime', 'artifact-v2'], security: BearerSecurity, headers: IdempotencyHeaders, params: Type.Object({ agentId: Id, projectId: Id, draftId: Id }), response: { 204: Type.Null() } },
  }, async (request, reply) => {
    const principal = { ...requireComputer(authenticate(request, service)), agentId: request.params.agentId };
    service.artifactV2.discardHeldDraft(principal, request.params.draftId, request.params.projectId);
    return reply.status(204).send(null);
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
    mentionedActorIds: Type.Optional(Type.Array(Id, { uniqueItems: true, maxItems: 50 })),
    workItemIds: Type.Optional(Type.Array(Id, { uniqueItems: true, maxItems: 50 })),
    privateGrantIds: Type.Optional(Type.Array(Id, { uniqueItems: true })),
  }, { additionalProperties: false });
  const ArtifactPublicationIntent = Type.Object({
    stagedBlobId: Id,
    artifactId: Type.Optional(Id),
    fileName: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    artifactName: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    artifactPath: Type.Optional(Type.String({ maxLength: 2000 })),
    expectedLatestVersionId: Type.Optional(Id),
    parentVersionIds: Type.Optional(Type.Array(Id, { uniqueItems: true, maxItems: 100 })),
    sourceResourceRefs: Type.Optional(Type.Array(Type.Object({ resourceId: Id, revision: Type.Optional(Type.Integer({ minimum: 1 })), digest: Type.Optional(Type.String({ minLength: 64, maxLength: 64 })) }), { uniqueItems: true, maxItems: 100 })),
    taskId: Type.Optional(Id), messageId: Type.Optional(Id), publishBatchId: Type.Optional(Id),
    note: Type.Optional(Type.String({ maxLength: 3000 })),
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
    const stored = await service.artifactV2.blobs.write(upload.file, upload.mimetype);
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
        publishedArtifacts: Type.Array(ArtifactV2Response),
      }) },
    },
  }, async (request) => {
    const principal = requireComputer(authenticate(request, service));
    return service.returnAttempt(principal.computerId, request.params.attemptId, request.body, idempotencyKey(request)) as any;
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

function setSessionCookie(reply: FastifyReply, token: string, expiresAt: number, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
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

function optionalIdempotencyKey(request: FastifyRequest): string | undefined {
  const value = request.headers['idempotency-key'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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

function artifactAttachmentDisposition(name: string, mediaType: string, fallback: string): string {
  const safeName = name.trim().replaceAll(/[\\/\r\n]/gu, '_') || fallback;
  const inferredExtension = mediaTypeExtension(mediaType.split(';', 1)[0]!.trim());
  const fileName = extname(safeName) || !inferredExtension ? safeName : `${safeName}.${inferredExtension}`;
  return `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
