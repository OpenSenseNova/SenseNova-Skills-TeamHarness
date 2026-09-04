import createClient from 'openapi-fetch';
import type { paths } from './generated';
import {
  commandKey,
  requestBlob,
  requestJson,
  unwrap,
} from './transport';

export { ApiError, errorMessage } from './transport';

const client = createClient<paths>({
  baseUrl: typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
  credentials: 'include',
  fetch: (request) => globalThis.fetch(request),
});

type JsonResponse<
  Path extends keyof paths,
  Method extends keyof paths[Path],
  Status extends number,
> = paths[Path][Method] extends { responses: infer Responses }
  ? Status extends keyof Responses
    ? Responses[Status] extends { content: { 'application/json': infer Json } }
      ? Json
      : never
    : never
  : never;

type JsonRequestBody<
  Path extends keyof paths,
  Method extends keyof paths[Path],
> = paths[Path][Method] extends { requestBody: { content: { 'application/json': infer Json } } }
  ? Json
  : never;

export type Human = JsonResponse<'/v1/auth/session', 'get', 200>;
export type Registration = JsonResponse<'/v1/auth/register', 'post', 202>;
export type WorkspacePage = JsonResponse<'/v1/workspaces', 'get', 200>;
export type Workspace = WorkspacePage['items'][number];
export type WorkspaceBootstrap = JsonResponse<'/v1/workspaces/{workspaceId}/bootstrap', 'get', 200>;
export type MemberPage = JsonResponse<'/v1/workspaces/{workspaceId}/members', 'get', 200>;
export type Member = MemberPage['items'][number];
export type ProjectPage = JsonResponse<'/v1/workspaces/{workspaceId}/projects', 'get', 200>;
export type Project = ProjectPage['items'][number];
export type ProjectMemberPage = JsonResponse<'/v1/projects/{projectId}/members', 'get', 200>;
export type ProjectMember = ProjectMemberPage['items'][number];
export type CreateProjectInput = JsonRequestBody<'/v1/workspaces/{workspaceId}/projects', 'post'>;
export type UpdateProjectInput = JsonRequestBody<'/v1/projects/{projectId}', 'patch'>;
export type WorkItemPage = JsonResponse<'/v1/projects/{projectId}/work-items', 'get', 200>;
export type WorkItem = WorkItemPage['items'][number];
export type WorkItemCommentPage = JsonResponse<'/v1/work-items/{workItemId}/comments', 'get', 200>;
export type WorkItemComment = WorkItemCommentPage['items'][number];
export type CreateWorkItemInput = JsonRequestBody<'/v1/projects/{projectId}/work-items', 'post'>;
export type CreateWorkItemFromMessageInput = JsonRequestBody<'/v1/messages/{messageId}/work-item', 'post'>;
export type ProjectResourcePage = JsonResponse<'/v1/projects/{projectId}/resources', 'get', 200>;
export type ProjectResource = ProjectResourcePage['items'][number];
export type ProjectLinkPage = JsonResponse<'/v1/projects/{projectId}/links', 'get', 200>;
export type ProjectLink = ProjectLinkPage['items'][number];
export type ArtifactV2Page = JsonResponse<'/v1/projects/{projectId}/artifacts', 'get', 200>;
export type ArtifactV2 = ArtifactV2Page['items'][number];
export type ArtifactVersionV2 = NonNullable<ArtifactV2['latestVersion']>;
export type ArtifactV2PublishResult = JsonResponse<'/v1/projects/{projectId}/artifacts', 'post', 201>;
export type ArtifactVersionContextV2 = JsonResponse<'/v1/artifact-versions/{versionId}/context', 'get', 200>;
export type WorkspaceJoinLinkPage = JsonResponse<'/v1/workspaces/{workspaceId}/join-links', 'get', 200>;
export type WorkspaceJoinLink = WorkspaceJoinLinkPage['items'][number];
export type AgentPage = JsonResponse<'/v1/workspaces/{workspaceId}/agents', 'get', 200>;
export type Agent = AgentPage['items'][number];
export type RuntimeBinding = NonNullable<Agent['runtimeBinding']>;
export type RuntimeId = RuntimeBinding['runtimeId'];
export type RuntimeReasoningEffort = RuntimeBinding['configuration']['requested']['reasoningEffort'];
export type ComputerPage = JsonResponse<'/v1/computers', 'get', 200>;
export type Computer = ComputerPage['items'][number];
export type ComputerRegistration = JsonResponse<'/v1/computers', 'post', 201>;
export type ExecutionPolicy = JsonResponse<'/v1/workspaces/{workspaceId}/agents/{agentId}/execution-policy', 'get', 200>;
export type ConversationPage = JsonResponse<'/v1/workspaces/{workspaceId}/conversations', 'get', 200>;
export type Conversation = ConversationPage['items'][number];
export type MessagePage = JsonResponse<'/v1/conversations/{conversationId}/messages', 'get', 200>;
export type WorkspaceMessage = MessagePage['items'][number];
export type ParticipantPage = JsonResponse<'/v1/conversations/{conversationId}/participants', 'get', 200>;
export type Participant = ParticipantPage['items'][number];
export type AgentRequestPage = JsonResponse<'/v1/conversations/{conversationId}/agent-requests', 'get', 200>;
export type AgentRequest = AgentRequestPage['items'][number];
export type AgentActivityPage = JsonResponse<'/v1/workspaces/{workspaceId}/agent-activity', 'get', 200>;
export type AgentActivityEvent = AgentActivityPage['items'][number];
export type PrivateGrantPage = JsonResponse<'/v1/runs/{runId}/private-context-grants', 'get', 200>;
export type PrivateGrant = PrivateGrantPage['items'][number];
export type ChangePage = JsonResponse<'/v1/workspaces/{workspaceId}/changes', 'get', 200>;

export const api = {
  register: (body: { displayName: string; email: string; password: string }) =>
    unwrap(client.POST('/v1/auth/register', { body })),
  verifyEmail: (body: { registrationId: string; code: string }) =>
    unwrap(client.POST('/v1/auth/verify-email', { body })),
  resendVerification: (registrationId: string) =>
    unwrap(client.POST('/v1/auth/resend-verification', { body: { registrationId } })),
  login: (body: { email: string; password: string }) => unwrap(client.POST('/v1/auth/login', { body })),
  session: () => unwrap(client.GET('/v1/auth/session')),
  logout: () => unwrap(client.POST('/v1/auth/logout')),

  listWorkspaces: (cursor?: string) => unwrap(client.GET('/v1/workspaces', {
    params: { query: { limit: 100, ...(cursor ? { cursor } : {}) } },
  })),
  createWorkspace: (name: string) => unwrap(client.POST('/v1/workspaces', {
    params: { header: { 'idempotency-key': commandKey() } }, body: { name },
  })),
  bootstrapWorkspace: (workspaceId: string) => unwrap(client.GET('/v1/workspaces/{workspaceId}/bootstrap', {
    params: { path: { workspaceId } },
  })),
  updateWorkspace: (workspaceId: string, body: { name: string; expectedRevision: number }) =>
    unwrap(client.PATCH('/v1/workspaces/{workspaceId}', {
      params: { path: { workspaceId }, header: { 'idempotency-key': commandKey() } }, body,
    })),
  listMembers: (workspaceId: string, cursor?: string) => unwrap(client.GET('/v1/workspaces/{workspaceId}/members', {
    params: { path: { workspaceId }, query: { limit: 100, ...(cursor ? { cursor } : {}) } },
  })),
  listWorkspaceJoinLinks: (workspaceId: string, cursor?: string) => unwrap(client.GET('/v1/workspaces/{workspaceId}/join-links', {
    params: { path: { workspaceId }, query: { limit: 100, ...(cursor ? { cursor } : {}) } },
  })),
  createWorkspaceJoinLink: (workspaceId: string) => unwrap(client.POST('/v1/workspaces/{workspaceId}/join-links', {
    params: { path: { workspaceId } },
  })),
  previewWorkspaceJoinLink: (token: string) => unwrap(client.GET('/v1/workspace-join-links/{token}', {
    params: { path: { token } },
  })),
  revokeWorkspaceJoinLink: (joinLinkId: string, expectedRevision: number) =>
    unwrap(client.POST('/v1/workspace-join-links/{joinLinkId}/revoke', {
      params: { path: { joinLinkId }, header: { 'idempotency-key': commandKey() } }, body: { expectedRevision },
    })),
  acceptWorkspaceJoinLink: (token: string) =>
    unwrap(client.POST('/v1/workspace-join-links/{token}/accept', {
      params: { path: { token }, header: { 'idempotency-key': commandKey() } },
    })),
  removeMember: (workspaceId: string, membershipId: string, expectedRevision: number) =>
    unwrap(client.DELETE('/v1/workspaces/{workspaceId}/members/{membershipId}', {
      params: { path: { workspaceId, membershipId }, header: { 'idempotency-key': commandKey() } }, body: { expectedRevision },
    })),
  leaveWorkspace: (workspaceId: string, expectedRevision: number) =>
    unwrap(client.POST('/v1/workspaces/{workspaceId}/leave', {
      params: { path: { workspaceId }, header: { 'idempotency-key': commandKey() } }, body: { expectedRevision },
    })),

  listProjects: (workspaceId: string, cursor?: string) => unwrap(client.GET('/v1/workspaces/{workspaceId}/projects', {
    params: { path: { workspaceId }, query: { limit: 100, ...(cursor ? { cursor } : {}) } },
  })),
  createProject: (workspaceId: string, body: CreateProjectInput) => unwrap(client.POST('/v1/workspaces/{workspaceId}/projects', {
    params: { path: { workspaceId }, header: { 'idempotency-key': commandKey() } }, body,
  })),
  getProject: (projectId: string) => unwrap(client.GET('/v1/projects/{projectId}', {
    params: { path: { projectId } },
  })),
  updateProject: (projectId: string, body: UpdateProjectInput) =>
    unwrap(client.PATCH('/v1/projects/{projectId}', {
      params: { path: { projectId }, header: { 'idempotency-key': commandKey() } }, body,
    })),
  listProjectMembers: (projectId: string, cursor?: string) => unwrap(client.GET('/v1/projects/{projectId}/members', {
    params: { path: { projectId }, query: { limit: 100, ...(cursor ? { cursor } : {}) } },
  })),
  addProjectMember: (projectId: string, body: { workspaceMembershipId: string; role: 'manager' | 'member' }) =>
    unwrap(client.POST('/v1/projects/{projectId}/members', {
      params: { path: { projectId }, header: { 'idempotency-key': commandKey() } }, body,
    })),
  updateProjectMember: (
    projectId: string,
    projectMembershipId: string,
    body: { role: 'owner' | 'manager' | 'member'; expectedRevision: number },
  ) => unwrap(client.PATCH('/v1/projects/{projectId}/members/{projectMembershipId}', {
    params: {
      path: { projectId, projectMembershipId },
      header: { 'idempotency-key': commandKey() },
    },
    body,
  })),
  removeProjectMember: (projectId: string, projectMembershipId: string, expectedRevision: number) =>
    unwrap(client.DELETE('/v1/projects/{projectId}/members/{projectMembershipId}', {
      params: {
        path: { projectId, projectMembershipId },
        header: { 'idempotency-key': commandKey() },
      },
      body: { expectedRevision },
    })),
  leaveProject: (projectId: string, expectedRevision: number) => unwrap(client.POST('/v1/projects/{projectId}/leave', {
    params: { path: { projectId }, header: { 'idempotency-key': commandKey() } }, body: { expectedRevision },
  })),
  listProjectWorkItems: (projectId: string) => unwrap(client.GET('/v1/projects/{projectId}/work-items', {
    params: { path: { projectId } },
  })),
  createWorkItem: (projectId: string, body: CreateWorkItemInput) =>
    unwrap(client.POST('/v1/projects/{projectId}/work-items', {
      params: { path: { projectId }, header: { 'idempotency-key': commandKey() } }, body,
    })),
  createWorkItemFromMessage: (messageId: string, body: CreateWorkItemFromMessageInput) =>
    unwrap(client.POST('/v1/messages/{messageId}/work-item', {
      params: { path: { messageId }, header: { 'idempotency-key': commandKey() } }, body,
    })),
  getWorkItem: (workItemId: string) => unwrap(client.GET('/v1/work-items/{workItemId}', {
    params: { path: { workItemId } },
  })),
  updateWorkItemDetails: (workItemId: string, description: string, expectedRevision: number) => unwrap(client.PATCH('/v1/work-items/{workItemId}', {
    params: { path: { workItemId }, header: { 'idempotency-key': commandKey() } },
    body: { description, expectedRevision },
  })),
  listWorkItemComments: (workItemId: string) => unwrap(client.GET('/v1/work-items/{workItemId}/comments', {
    params: { path: { workItemId } },
  })),
  postWorkItemComment: (
    workItemId: string,
    body: string,
    mentionedActorIds: string[] = [],
    workItemIds: string[] = [],
    artifactSelections: Array<{ artifactId: string; artifactVersionId: string }> = [],
  ) =>
    unwrap(client.POST('/v1/work-items/{workItemId}/comments', {
      params: { path: { workItemId }, header: { 'idempotency-key': commandKey() } },
      body: { body, mentionedActorIds, workItemIds, artifactSelections },
    })),
  submitWorkItemResult: (workItemId: string, artifactVersionIds: string[], expectedRevision: number) =>
    unwrap(client.POST('/v1/work-items/{workItemId}/submissions', {
      params: { path: { workItemId }, header: { 'idempotency-key': commandKey() } },
      body: { artifactVersionIds, expectedRevision },
    })),
  assignWorkItem: (
    workItemId: string,
    assigneeProjectMembershipIds: string[] | string | null,
    expectedRevision: number,
    expectedAssignmentRevision: number,
  ) => {
    const ids = Array.isArray(assigneeProjectMembershipIds)
      ? assigneeProjectMembershipIds
      : (assigneeProjectMembershipIds ? [assigneeProjectMembershipIds] : []);
    return unwrap(client.POST('/v1/work-items/{workItemId}/assignment', {
      params: { path: { workItemId }, header: { 'idempotency-key': commandKey() } },
      body: {
        assigneeProjectMembershipId: ids[0] ?? null,
        assigneeProjectMembershipIds: ids,
        expectedRevision,
        expectedAssignmentRevision,
      },
    }));
  },
  blockWorkItem: (workItemId: string, reason: string, expectedRevision: number) =>
    unwrap(client.POST('/v1/work-items/{workItemId}/block', {
      params: { path: { workItemId }, header: { 'idempotency-key': commandKey() } },
      body: { reason, expectedRevision },
    })),
  unblockWorkItem: (workItemId: string, expectedRevision: number) =>
    unwrap(client.POST('/v1/work-items/{workItemId}/unblock', {
      params: { path: { workItemId }, header: { 'idempotency-key': commandKey() } },
      body: { expectedRevision },
    })),
  completeWorkItem: (workItemId: string, expectedRevision: number) =>
    unwrap(client.POST('/v1/work-items/{workItemId}/complete', {
      params: { path: { workItemId }, header: { 'idempotency-key': commandKey() } },
      body: { expectedRevision },
    })),
  cancelWorkItem: (workItemId: string, reason: string | undefined, expectedRevision: number) =>
    unwrap(client.POST('/v1/work-items/{workItemId}/cancel', {
      params: { path: { workItemId }, header: { 'idempotency-key': commandKey() } },
      body: { ...(reason ? { reason } : {}), expectedRevision },
    })),

  listProjectResources: (projectId: string) => requestJson<{ items: ProjectResource[] }>(`/v1/projects/${projectId}/resources`),
  listProjectResourceTrash: (projectId: string) => requestJson<{ items: ProjectResource[] }>(`/v1/projects/${projectId}/resources/trash`),
  uploadProjectResource: async (projectId: string, file: File, options: { parentResourceId?: string | null; path?: string } = {}) => {
    const body = new FormData(); body.append('file', file);
    if (options.parentResourceId) body.append('parentResourceId', options.parentResourceId);
    if (options.path) body.append('path', options.path);
    return requestJson<ProjectResource>(`/v1/projects/${projectId}/resources`, { method: 'POST', body });
  },
  createProjectResourceFolder: async (projectId: string, body: { name: string; parentResourceId?: string | null }) =>
    requestJson<ProjectResource>(`/v1/projects/${projectId}/resources/folders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  updateProjectResource: async (resourceId: string, body: { name?: string; parentResourceId?: string | null }) =>
    requestJson<ProjectResource>(`/v1/project-resources/${resourceId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  getProjectResource: (projectId: string, resourceId: string) => requestJson<ProjectResource>(`/v1/projects/${projectId}/resources/${resourceId}`),
  updateProjectResourceInProject: async (projectId: string, resourceId: string, body: { name?: string; parentResourceId?: string | null }) =>
    requestJson<ProjectResource>(`/v1/projects/${projectId}/resources/${resourceId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  replaceProjectResource: async (resourceId: string, file: File, expectedRevision: number) => {
    const body = new FormData(); body.append('file', file); body.append('expectedRevision', String(expectedRevision));
    return requestJson<ProjectResource>(`/v1/project-resources/${resourceId}/content`, { method: 'PUT', body });
  },
  deleteProjectResource: (resourceId: string) => requestJson<ProjectResource>(`/v1/project-resources/${resourceId}`, { method: 'DELETE' }),
  restoreProjectResource: (resourceId: string) => requestJson<ProjectResource>(`/v1/project-resources/${resourceId}/restore`, { method: 'POST' }),
  downloadProjectResource: async (resourceId: string) => {
    return requestBlob(`/v1/project-resources/${resourceId}/download`);
  },
  listProjectLinks: (projectId: string) => requestJson<{ items: ProjectLink[] }>(`/v1/projects/${projectId}/links`),
  listProjectLinkTrash: (projectId: string) => requestJson<{ items: ProjectLink[] }>(`/v1/projects/${projectId}/links/trash`),
  createProjectLink: async (projectId: string, body: { locator: string; name: string; description?: string | null }) =>
    requestJson<ProjectLink>(`/v1/projects/${projectId}/links`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  updateProjectLink: async (linkId: string, body: { name?: string; description?: string | null }) =>
    requestJson<ProjectLink>(`/v1/project-links/${linkId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  updateProjectLinkInProject: async (projectId: string, linkId: string, body: { name?: string; description?: string | null }) =>
    requestJson<ProjectLink>(`/v1/projects/${projectId}/links/${linkId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  deleteProjectLink: (linkId: string) => requestJson<ProjectLink>(`/v1/project-links/${linkId}`, { method: 'DELETE' }),
  restoreProjectLink: (linkId: string) => requestJson<ProjectLink>(`/v1/project-links/${linkId}/restore`, { method: 'POST' }),
  listProjectArtifactsV2: (projectId: string) => requestJson<{ items: ArtifactV2[] }>(`/v1/projects/${projectId}/artifacts`),
  listProjectArtifactTrashV2: (projectId: string) => requestJson<{ items: ArtifactV2[] }>(`/v1/projects/${projectId}/artifacts/trash`),
  getArtifactV2: (artifactId: string) => requestJson<ArtifactV2>(`/v1/artifact-v2/${artifactId}`),
  listArtifactVersionsV2: (artifactId: string) => requestJson<{ items: ArtifactVersionV2[] }>(`/v1/artifact-v2/${artifactId}/versions`),
  publishArtifactV2: async (projectId: string, file: File, fields: Record<string, string | string[] | object | undefined> = {}) => {
    const body = new FormData(); body.append('file', file);
    for (const [key, value] of Object.entries(fields)) if (value !== undefined) body.append(key, typeof value === 'string' ? value : JSON.stringify(value));
    return requestJson<ArtifactV2PublishResult>(`/v1/projects/${projectId}/artifacts`, {
      method: 'POST', credentials: 'include', headers: { 'idempotency-key': commandKey() }, body,
    });
  },
  downloadArtifactVersionV2: async (versionId: string) => {
    return requestBlob(`/v1/artifact-versions/${versionId}/download`);
  },
  getArtifactVersionContextV2: (versionId: string) => requestJson<ArtifactVersionContextV2>(`/v1/artifact-versions/${versionId}/context`),
  updateArtifactV2: async (artifactId: string, body: { name?: string; projectPath?: string }) =>
    requestJson<ArtifactV2>(`/v1/artifact-v2/${artifactId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  deleteArtifactV2: (artifactId: string) => requestJson<ArtifactV2>(`/v1/artifact-v2/${artifactId}`, { method: 'DELETE' }),
  deleteArtifactVersionV2: (versionId: string) => requestJson<ArtifactVersionV2>(`/v1/artifact-versions/${versionId}`, { method: 'DELETE' }),
  listAgents: (workspaceId: string, cursor?: string) => unwrap(client.GET('/v1/workspaces/{workspaceId}/agents', {
    params: { path: { workspaceId }, query: { limit: 100, ...(cursor ? { cursor } : {}) } },
  })),
  getAgent: (workspaceId: string, agentId: string) =>
    unwrap(client.GET('/v1/workspaces/{workspaceId}/agents/{agentId}', {
      params: { path: { workspaceId, agentId } },
    })),
  listComputers: () => unwrap(client.GET('/v1/computers')),
  createComputer: (name: string) => unwrap(client.POST('/v1/computers', {
    params: { header: { 'idempotency-key': commandKey() } },
    body: { name },
  })),
  createAgent: (workspaceId: string, body: {
    name: string;
    description?: string;
    runtimeBinding?: {
      computerId: string;
      runtimeId: RuntimeId;
      model?: string | null;
      reasoningEffort?: RuntimeReasoningEffort;
      mode?: string | null;
    };
  }) =>
    unwrap(client.POST('/v1/workspaces/{workspaceId}/agents', {
      params: { path: { workspaceId }, header: { 'idempotency-key': commandKey() } }, body,
    })),
  bindAgentRuntime: (workspaceId: string, agentId: string, body: {
    computerId: string;
    runtimeId: RuntimeId;
    model?: string | null;
    reasoningEffort?: RuntimeReasoningEffort;
    mode?: string | null;
    expectedRevision: number;
  }) => unwrap(client.POST('/v1/workspaces/{workspaceId}/agents/{agentId}/runtime-bindings', {
    params: { path: { workspaceId, agentId }, header: { 'idempotency-key': commandKey() } }, body,
  })),
  updateAgent: (workspaceId: string, agentId: string, body: {
    name?: string;
    description?: string | null;
    expectedRevision: number;
  }) => unwrap(client.PATCH('/v1/workspaces/{workspaceId}/agents/{agentId}', {
    params: { path: { workspaceId, agentId }, header: { 'idempotency-key': commandKey() } }, body,
  })),
  deleteAgent: (workspaceId: string, agentId: string, expectedRevision: number) =>
    unwrap(client.DELETE('/v1/workspaces/{workspaceId}/agents/{agentId}', {
      params: { path: { workspaceId, agentId }, header: { 'idempotency-key': commandKey() } },
      body: { expectedRevision },
    })),
  setAgentAvailability: (workspaceId: string, agentId: string, action: 'suspend' | 'resume', expectedRevision: number) => {
    const options = {
      params: { path: { workspaceId, agentId }, header: { 'idempotency-key': commandKey() } },
      body: { expectedRevision },
    };
    if (action === 'suspend') return unwrap(client.POST('/v1/workspaces/{workspaceId}/agents/{agentId}/suspend', options));
    return unwrap(client.POST('/v1/workspaces/{workspaceId}/agents/{agentId}/resume', options));
  },
  restartAgent: (workspaceId: string, agentId: string, expectedRevision: number) =>
    unwrap(client.POST('/v1/workspaces/{workspaceId}/agents/{agentId}/restart', {
      params: { path: { workspaceId, agentId }, header: { 'idempotency-key': commandKey() } },
      body: { expectedRevision },
    })),
  transferAgentOwnership: (workspaceId: string, agentId: string, newOwnerMembershipId: string, expectedRevision: number) =>
    unwrap(client.POST('/v1/workspaces/{workspaceId}/agents/{agentId}/ownership', {
      params: { path: { workspaceId, agentId }, header: { 'idempotency-key': commandKey() } },
      body: { newOwnerMembershipId, expectedRevision },
    })),
  terminateAgentMembership: (workspaceId: string, agentId: string, expectedRevision: number) =>
    unwrap(client.DELETE('/v1/workspaces/{workspaceId}/agents/{agentId}/membership', {
      params: { path: { workspaceId, agentId }, header: { 'idempotency-key': commandKey() } },
      body: { expectedRevision },
    })),
  readmitAgentMembership: (workspaceId: string, agentId: string, expectedRevision: number) =>
    unwrap(client.POST('/v1/workspaces/{workspaceId}/agents/{agentId}/membership/readmit', {
      params: { path: { workspaceId, agentId }, header: { 'idempotency-key': commandKey() } },
      body: { expectedRevision },
    })),
  getExecutionPolicy: (workspaceId: string, agentId: string) =>
    unwrap(client.GET('/v1/workspaces/{workspaceId}/agents/{agentId}/execution-policy', {
      params: { path: { workspaceId, agentId } },
    })),
  updateExecutionPolicy: (workspaceId: string, agentId: string, body: Omit<ExecutionPolicy, 'id' | 'workspaceId' | 'agentId' | 'version' | 'createdByMembershipId' | 'createdAt'> & { expectedVersion: number }) =>
    unwrap(client.PUT('/v1/workspaces/{workspaceId}/agents/{agentId}/execution-policy', {
      params: { path: { workspaceId, agentId }, header: { 'idempotency-key': commandKey() } }, body,
    })),

  listConversations: (workspaceId: string, cursor?: string, lifecycleStatus: 'active' | 'archived' = 'active') => unwrap(client.GET('/v1/workspaces/{workspaceId}/conversations', {
    params: { path: { workspaceId }, query: { limit: 100, lifecycleStatus, ...(cursor ? { cursor } : {}) } },
  })),
  createConversation: (
    workspaceId: string,
    body: JsonRequestBody<'/v1/workspaces/{workspaceId}/conversations', 'post'>,
  ) => unwrap(client.POST('/v1/workspaces/{workspaceId}/conversations', {
    params: { path: { workspaceId }, header: { 'idempotency-key': commandKey() } }, body,
  })),
  listProjectConversations: (projectId: string, cursor?: string, lifecycleStatus: 'active' | 'archived' = 'active') => unwrap(client.GET('/v1/projects/{projectId}/conversations', {
    params: { path: { projectId }, query: { limit: 100, lifecycleStatus, ...(cursor ? { cursor } : {}) } },
  })),
  createProjectConversation: (
    projectId: string,
    body: JsonRequestBody<'/v1/projects/{projectId}/conversations', 'post'>,
  ) => unwrap(client.POST('/v1/projects/{projectId}/conversations', {
    params: { path: { projectId }, header: { 'idempotency-key': commandKey() } }, body,
  })),
  getConversation: (conversationId: string) => unwrap(client.GET('/v1/conversations/{conversationId}', {
    params: { path: { conversationId } },
  })),
  archiveConversation: (conversationId: string, expectedRevision: number) =>
    unwrap(client.POST('/v1/conversations/{conversationId}/archive', {
      params: { path: { conversationId }, header: { 'idempotency-key': commandKey() } },
      body: { expectedRevision },
    })),
  restoreConversation: (conversationId: string, expectedRevision: number) =>
    unwrap(client.POST('/v1/conversations/{conversationId}/restore', {
      params: { path: { conversationId }, header: { 'idempotency-key': commandKey() } },
      body: { expectedRevision },
    })),
  listMessages: (conversationId: string, afterVersion = 0) => unwrap(client.GET('/v1/conversations/{conversationId}/messages', {
    params: { path: { conversationId }, query: { afterVersion, limit: 200 } },
  })),
  postMessage: (
    conversationId: string,
    body: JsonRequestBody<'/v1/conversations/{conversationId}/messages', 'post'>,
  ) =>
    unwrap(client.POST('/v1/conversations/{conversationId}/messages', {
      params: { path: { conversationId }, header: { 'idempotency-key': commandKey() } }, body,
    })),
  replyToMessage: (
    messageId: string,
    body: JsonRequestBody<'/v1/messages/{messageId}/replies', 'post'>,
  ) =>
    unwrap(client.POST('/v1/messages/{messageId}/replies', {
      params: { path: { messageId }, header: { 'idempotency-key': commandKey() } }, body,
    })),
  listParticipants: (conversationId: string) => unwrap(client.GET('/v1/conversations/{conversationId}/participants', {
    params: { path: { conversationId } },
  })),
  addConversationParticipant: (conversationId: string, scopeMembershipId: string, expectedRevision: number) =>
    unwrap(client.PUT('/v1/conversations/{conversationId}/participants/{scopeMembershipId}', {
      params: {
        path: { conversationId, scopeMembershipId },
        header: { 'idempotency-key': commandKey() },
      },
      body: { expectedRevision },
    })),
  removeConversationParticipant: (conversationId: string, scopeMembershipId: string, expectedRevision: number) =>
    unwrap(client.DELETE('/v1/conversations/{conversationId}/participants/{scopeMembershipId}', {
      params: {
        path: { conversationId, scopeMembershipId },
        header: { 'idempotency-key': commandKey() },
      },
      body: { expectedRevision },
    })),
  listAgentRequests: (conversationId: string) => unwrap(client.GET('/v1/conversations/{conversationId}/agent-requests', {
    params: { path: { conversationId }, query: { limit: 200 } },
  })),
  listAgentActivity: (workspaceId: string, agentId?: string) => unwrap(client.GET('/v1/workspaces/{workspaceId}/agent-activity', {
    params: { path: { workspaceId }, query: { ...(agentId ? { agentId } : {}), limit: 200 } },
  })),
  cancelAgentRequest: (agentRequestId: string, expectedVersion: number) =>
    unwrap(client.POST('/v1/agent-requests/{agentRequestId}/cancel', {
      params: { path: { agentRequestId }, header: { 'idempotency-key': commandKey() } }, body: { expectedVersion },
    })),
  listPrivateContextGrants: (runId: string) => unwrap(client.GET('/v1/runs/{runId}/private-context-grants', {
    params: { path: { runId } },
  })),
  createPrivateContextGrant: (runId: string, body: {
    sourceCategory: 'local_file' | 'local_memory' | 'local_tool';
    readAllowed: boolean;
    disclosureAllowed: boolean;
    expiresAt: number;
  }) => unwrap(client.POST('/v1/runs/{runId}/private-context-grants', {
    params: { path: { runId }, header: { 'idempotency-key': commandKey() } }, body,
  })),
  revokePrivateContextGrant: (grantId: string) => unwrap(client.POST('/v1/private-context-grants/{grantId}/revoke', {
    params: { path: { grantId }, header: { 'idempotency-key': commandKey() } },
  })),
  changes: (workspaceId: string, after: number) => unwrap(client.GET('/v1/workspaces/{workspaceId}/changes', {
    params: { path: { workspaceId }, query: { after, limit: 200 } },
  })),
};
