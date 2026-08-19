import { createContext, useContext } from 'react';
import type { Agent, Conversation, Member, Project, ProjectMember, Workspace } from '../api/client';

export const workspaceKeys = {
  list: ['workspaces'] as const,
  computers: ['computers'] as const,
  bootstrap: (id: string) => ['workspace', id, 'bootstrap'] as const,
  members: (id: string) => ['workspace', id, 'members'] as const,
  agents: (id: string) => ['workspace', id, 'agents'] as const,
  agent: (workspaceId: string, agentId: string) => ['workspace', workspaceId, 'agent', agentId] as const,
  conversations: (id: string) => ['workspace', id, 'conversations'] as const,
  archivedConversations: (id: string) => ['workspace', id, 'conversations', 'archived'] as const,
  projects: (id: string) => ['workspace', id, 'projects'] as const,
  project: (id: string) => ['project', id] as const,
  projectMembers: (id: string) => ['project', id, 'members'] as const,
  projectWorkingCopies: (id: string) => ['project', id, 'working-copies'] as const,
  projectConversations: (id: string) => ['project', id, 'conversations'] as const,
  projectArchivedConversations: (id: string) => ['project', id, 'conversations', 'archived'] as const,
  projectResourceLinks: (id: string) => ['project', id, 'resource-links'] as const,
  artifacts: (workspaceId: string, projectId?: string) => ['workspace', workspaceId, 'artifacts', projectId ?? 'all'] as const,
  artifact: (id: string) => ['artifact', id] as const,
  artifactSnapshots: (id: string) => ['artifact', id, 'snapshots'] as const,
  artifactTrash: (workspaceId: string) => ['workspace', workspaceId, 'artifact-trash'] as const,
  artifactCleanup: (workspaceId: string) => ['workspace', workspaceId, 'artifact-cleanup'] as const,
  invitations: (id: string) => ['workspace', id, 'invitations'] as const,
};

export interface WorkspaceContextValue {
  workspace: Workspace;
  members: Member[];
  agents: Agent[];
  conversations: Conversation[];
  projects: Project[];
  project: Project | null;
  projectMembers: ProjectMember[];
  openNewProject: () => void;
  openNewConversation: () => void;
  openDirectMessage: (membershipId: string) => Promise<void>;
  openingDirectMessageMembershipId: string | null;
  refresh: () => Promise<void>;
}

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('Workspace context is unavailable.');
  return value;
}
