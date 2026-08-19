import createClient from 'openapi-fetch';
import type { paths } from './generated';

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
export type ProjectWorkingCopyPage = JsonResponse<'/v1/projects/{projectId}/working-copies', 'get', 200>;
export type ProjectWorkingCopy = ProjectWorkingCopyPage['items'][number];
export type ProjectResourceLinkPage = JsonResponse<'/v1/projects/{projectId}/resource-links', 'get', 200>;
export type ProjectResourceLink = ProjectResourceLinkPage['items'][number];
export type ArtifactPage = JsonResponse<'/v1/workspaces/{workspaceId}/artifacts', 'get', 200>;
export type Artifact = ArtifactPage['items'][number];
export type ArtifactSnapshotPage = JsonResponse<'/v1/artifacts/{artifactId}/snapshots', 'get', 200>;
export type ArtifactSnapshot = ArtifactSnapshotPage['items'][number];
export type ArtifactSnapshotSave = JsonResponse<'/v1/artifacts/{artifactId}/snapshots', 'post', 200>;
export type ArtifactCleanupStatus = JsonResponse<'/v1/workspaces/{workspaceId}/artifacts/cleanup-status', 'get', 200>;
export type InvitationPage = JsonResponse<'/v1/workspaces/{workspaceId}/invitations', 'get', 200>;
export type Invitation = InvitationPage['items'][number];
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
export type PrivateGrantPage = JsonResponse<'/v1/runs/{runId}/private-context-grants', 'get', 200>;
export type PrivateGrant = PrivateGrantPage['items'][number];
export type ChangePage = JsonResponse<'/v1/workspaces/{workspaceId}/changes', 'get', 200>;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: unknown = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function commandKey(): string {
  return crypto.randomUUID();
}

async function unwrap<T>(request: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  const result = await request;
  if (result.data !== undefined || result.response.ok) return result.data as T;
  const error = result.error as { error?: { code?: string; message?: string; details?: unknown } } | undefined;
  throw new ApiError(
    result.response.status,
    error?.error?.code ?? 'REQUEST_FAILED',
    error?.error?.message ?? `请求失败（${result.response.status}）`,
    error?.error?.details,
  );
}

async function unwrapResponse<T>(response: Response): Promise<T> {
  const payload = await response.json() as T | { error?: { code?: string; message?: string; details?: unknown } };
  if (response.ok) return payload as T;
  const error = (payload as { error?: { code?: string; message?: string; details?: unknown } }).error;
  throw new ApiError(response.status, error?.code ?? 'REQUEST_FAILED', error?.message ?? `请求失败（${response.status}）`, error?.details);
}

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
  listInvitations: (workspaceId: string, cursor?: string) => unwrap(client.GET('/v1/workspaces/{workspaceId}/invitations', {
    params: { path: { workspaceId }, query: { limit: 100, ...(cursor ? { cursor } : {}) } },
  })),
  createInvitation: (workspaceId: string, body: {
    verifiedEmail: string;
    membershipRole: 'owner' | 'member';
  }) => unwrap(client.POST('/v1/workspaces/{workspaceId}/invitations', {
    params: { path: { workspaceId }, header: { 'idempotency-key': commandKey() } }, body,
  })),
  revokeInvitation: (invitationId: string, expectedRevision: number) =>
    unwrap(client.POST('/v1/invitations/{invitationId}/revoke', {
      params: { path: { invitationId }, header: { 'idempotency-key': commandKey() } }, body: { expectedRevision },
    })),
  acceptInvitation: (invitationId: string, expectedRevision: number) =>
    unwrap(client.POST('/v1/invitations/{invitationId}/accept', {
      params: { path: { invitationId }, header: { 'idempotency-key': commandKey() } }, body: { expectedRevision },
    })),
  updateMember: (workspaceId: string, membershipId: string, body: {
    membershipRole: 'owner' | 'member';
    expectedRevision: number;
  }) => unwrap(client.PATCH('/v1/workspaces/{workspaceId}/members/{membershipId}', {
    params: { path: { workspaceId, membershipId }, header: { 'idempotency-key': commandKey() } }, body,
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
  putProjectRepository: (projectId: string, body: JsonRequestBody<'/v1/projects/{projectId}/repository', 'put'>) =>
    unwrap(client.PUT('/v1/projects/{projectId}/repository', {
      params: { path: { projectId }, header: { 'idempotency-key': commandKey() } }, body,
    })),
  deleteProjectRepository: (projectId: string, body: JsonRequestBody<'/v1/projects/{projectId}/repository', 'delete'>) =>
    unwrap(client.DELETE('/v1/projects/{projectId}/repository', {
      params: { path: { projectId }, header: { 'idempotency-key': commandKey() } }, body,
    })),
  listProjectResourceLinks: (projectId: string) => unwrap(client.GET('/v1/projects/{projectId}/resource-links', {
    params: { path: { projectId } },
  })),
  createProjectResourceLink: (projectId: string, body: JsonRequestBody<'/v1/projects/{projectId}/resource-links', 'post'>) =>
    unwrap(client.POST('/v1/projects/{projectId}/resource-links', {
      params: { path: { projectId }, header: { 'idempotency-key': commandKey() } }, body,
    })),
  updateProjectResourceLink: (projectId: string, linkId: string, body: JsonRequestBody<'/v1/projects/{projectId}/resource-links/{linkId}', 'patch'>) =>
    unwrap(client.PATCH('/v1/projects/{projectId}/resource-links/{linkId}', {
      params: { path: { projectId, linkId }, header: { 'idempotency-key': commandKey() } }, body,
    })),
  deleteProjectResourceLink: (projectId: string, linkId: string, expectedRevision: number) =>
    unwrap(client.DELETE('/v1/projects/{projectId}/resource-links/{linkId}', {
      params: { path: { projectId, linkId }, header: { 'idempotency-key': commandKey() } }, body: { expectedRevision },
    })),
  listProjectMembers: (projectId: string, cursor?: string) => unwrap(client.GET('/v1/projects/{projectId}/members', {
    params: { path: { projectId }, query: { limit: 100, ...(cursor ? { cursor } : {}) } },
  })),
  listProjectWorkingCopies: (projectId: string) => unwrap(client.GET('/v1/projects/{projectId}/working-copies', {
    params: { path: { projectId } },
  })),
  addProjectMember: (projectId: string, body: { workspaceMembershipId: string; role: 'manager' | 'member' }) =>
    unwrap(client.POST('/v1/projects/{projectId}/members', {
      params: { path: { projectId }, header: { 'idempotency-key': commandKey() } }, body,
    })),
  updateProjectMember: (
    projectId: string,
    projectMembershipId: string,
    body: { role: 'manager' | 'member'; expectedRevision: number },
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

  listArtifacts: (workspaceId: string, projectId?: string) => unwrap(client.GET('/v1/workspaces/{workspaceId}/artifacts', {
    params: { path: { workspaceId }, query: projectId ? { projectId } : {} },
  })),
  listArtifactTrash: (workspaceId: string) => unwrap(client.GET('/v1/workspaces/{workspaceId}/artifacts/trash', {
    params: { path: { workspaceId } },
  })),
  getArtifactCleanupStatus: (workspaceId: string) => unwrap(client.GET('/v1/workspaces/{workspaceId}/artifacts/cleanup-status', {
    params: { path: { workspaceId } },
  })),
  createMarkdownArtifact: (workspaceId: string, body: JsonRequestBody<'/v1/workspaces/{workspaceId}/artifacts/markdown', 'post'>) =>
    unwrap(client.POST('/v1/workspaces/{workspaceId}/artifacts/markdown', {
      params: { path: { workspaceId }, header: { 'idempotency-key': commandKey() } }, body,
    })),
  createFileArtifact: async (workspaceId: string, file: File, name: string, projectIds: string[] = []) => {
    const body = new FormData();
    body.append('name', name);
    body.append('projectIds', JSON.stringify(projectIds));
    body.append('file', file);
    return unwrapResponse<Artifact>(await fetch(`/v1/workspaces/${workspaceId}/artifacts/files`, {
      method: 'POST', credentials: 'include', headers: { 'idempotency-key': commandKey() }, body,
    }));
  },
  getArtifact: (artifactId: string) => unwrap(client.GET('/v1/artifacts/{artifactId}', {
    params: { path: { artifactId } },
  })),
  flushArtifactDraft: (artifactId: string) => unwrap(client.POST('/v1/artifacts/{artifactId}/draft/flush', {
    params: { path: { artifactId } },
  })),
  renameArtifact: (artifactId: string, body: JsonRequestBody<'/v1/artifacts/{artifactId}', 'patch'>) =>
    unwrap(client.PATCH('/v1/artifacts/{artifactId}', {
      params: { path: { artifactId }, header: { 'idempotency-key': commandKey() } }, body,
    })),
  deleteArtifact: (artifactId: string, expectedRevision: number) => unwrap(client.DELETE('/v1/artifacts/{artifactId}', {
    params: { path: { artifactId }, header: { 'idempotency-key': commandKey() } }, body: { expectedRevision },
  })),
  restoreArtifact: (artifactId: string, expectedRevision: number) => unwrap(client.POST('/v1/artifacts/{artifactId}/restore', {
    params: { path: { artifactId }, header: { 'idempotency-key': commandKey() } }, body: { expectedRevision },
  })),
  saveArtifactSnapshot: (artifactId: string, body: JsonRequestBody<'/v1/artifacts/{artifactId}/snapshots', 'post'>) =>
    unwrap(client.POST('/v1/artifacts/{artifactId}/snapshots', {
      params: { path: { artifactId }, header: { 'idempotency-key': commandKey() } }, body,
    })),
  replaceFileArtifactCurrent: async (
    artifactId: string,
    file: File,
    expectedCurrentRevision: number,
  ) => {
    const body = new FormData();
    body.append('expectedCurrentRevision', String(expectedCurrentRevision));
    body.append('file', file);
    return unwrapResponse<Artifact>(await fetch(`/v1/artifacts/${artifactId}/current/file`, {
      method: 'PUT', credentials: 'include', headers: { 'idempotency-key': commandKey() }, body,
    }));
  },
  listArtifactSnapshots: (artifactId: string) => unwrap(client.GET('/v1/artifacts/{artifactId}/snapshots', {
    params: { path: { artifactId } },
  })),
  renameArtifactSnapshot: (
    artifactId: string,
    snapshotId: string,
    body: JsonRequestBody<'/v1/artifacts/{artifactId}/snapshots/{snapshotId}', 'patch'>,
  ) => unwrap(client.PATCH('/v1/artifacts/{artifactId}/snapshots/{snapshotId}', {
    params: { path: { artifactId, snapshotId }, header: { 'idempotency-key': commandKey() } }, body,
  })),
  deleteArtifactSnapshot: (artifactId: string, snapshotId: string, expectedRevision: number) =>
    unwrap(client.DELETE('/v1/artifacts/{artifactId}/snapshots/{snapshotId}', {
      params: { path: { artifactId, snapshotId }, header: { 'idempotency-key': commandKey() } },
      body: { expectedRevision },
    })),
  restoreArtifactSnapshot: (artifactId: string, snapshotId: string, expectedCurrentRevision: number) =>
    unwrap(client.POST('/v1/artifacts/{artifactId}/snapshots/{snapshotId}/restore', {
      params: { path: { artifactId, snapshotId }, header: { 'idempotency-key': commandKey() } },
      body: { expectedCurrentRevision },
    })),
  getArtifactSnapshotContent: async (artifactId: string, snapshotId: string) => {
    const response = await fetch(`/v1/artifacts/${artifactId}/snapshots/${snapshotId}/download`, {
      credentials: 'include',
    });
    if (!response.ok) throw new ApiError(response.status, 'ARTIFACT_SNAPSHOT_READ_FAILED', `读取历史快照失败（${response.status}）`);
    return response.blob();
  },
  associateArtifact: (projectId: string, artifactId: string) => unwrap(client.PUT('/v1/projects/{projectId}/artifacts/{artifactId}', {
    params: { path: { projectId, artifactId }, header: { 'idempotency-key': commandKey() } },
  })),
  dissociateArtifact: (projectId: string, artifactId: string) => unwrap(client.DELETE('/v1/projects/{projectId}/artifacts/{artifactId}', {
    params: { path: { projectId, artifactId }, header: { 'idempotency-key': commandKey() } },
  })),
  artifactSnapshotDownloadUrl: (artifactId: string, snapshotId: string) => `/v1/artifacts/${artifactId}/snapshots/${snapshotId}/download`,
  artifactCurrentDownloadUrl: (artifactId: string) => `/v1/artifacts/${artifactId}/current/download`,

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
  createConversation: (workspaceId: string, body:
    | { kind: 'channel'; title?: string }
    | { kind: 'dm'; title?: string; directWorkspaceMembershipIds: string[] }
  ) => unwrap(client.POST('/v1/workspaces/{workspaceId}/conversations', {
    params: { path: { workspaceId }, header: { 'idempotency-key': commandKey() } }, body,
  })),
  listProjectConversations: (projectId: string, cursor?: string, lifecycleStatus: 'active' | 'archived' = 'active') => unwrap(client.GET('/v1/projects/{projectId}/conversations', {
    params: { path: { projectId }, query: { limit: 100, lifecycleStatus, ...(cursor ? { cursor } : {}) } },
  })),
  createProjectConversation: (projectId: string, body: {
    kind: 'channel';
    title?: string;
  }) => unwrap(client.POST('/v1/projects/{projectId}/conversations', {
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
  listAgentRequests: (conversationId: string) => unwrap(client.GET('/v1/conversations/{conversationId}/agent-requests', {
    params: { path: { conversationId }, query: { limit: 200 } },
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

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const known: Record<string, string> = {
      INVALID_LOGIN: '邮箱或密码错误。',
      EMAIL_NOT_VERIFIED: '请先完成邮箱验证。',
      EMAIL_ALREADY_REGISTERED: '该邮箱已经注册，请直接登录。',
      INVALID_VERIFICATION_CODE: '验证码不正确。',
      VERIFICATION_CODE_EXPIRED: '验证码已过期，请重新发送。',
      STALE_REVISION: '内容已经发生变化，请刷新后重试。',
      CONVERSATION_VERSION_CONFLICT: '会话参与者已经变化，请刷新后重试。',
      WORKSPACE_MEMBERSHIP_REQUIRED: '你已经不再是这个 Workspace 的成员。',
      COMPUTER_OFFLINE: '这台计算机当前离线，请重新连接后再创建 Agent。',
      RUNTIME_UNAVAILABLE_ON_COMPUTER: '所选运行时在这台计算机上尚未就绪，请检查安装或登录状态后重试。',
      COMPUTER_NOT_FOUND: '这台计算机不存在、已停用或不属于当前账号。',
      CONVERSATION_CLOSED: '对方已不再是成员，这个私聊只能查看历史消息。',
    };
    return known[error.code] ?? `${error.message}（${error.code}）`;
  }
  return error instanceof Error ? error.message : '发生未知错误。';
}
