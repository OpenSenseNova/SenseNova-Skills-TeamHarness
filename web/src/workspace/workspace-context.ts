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
  projectWorkItems: (id: string) => ['project', id, 'work-items'] as const,
  projectConversations: (id: string) => ['project', id, 'conversations'] as const,
  projectArchivedConversations: (id: string) => ['project', id, 'conversations', 'archived'] as const,
  projectArtifacts: (projectId: string) => ['project-v2', projectId, 'artifacts'] as const,
  joinLinks: (id: string) => ['workspace', id, 'join-links'] as const,
};

export interface WorkspaceContextValue {
  workspace: Workspace;
  members: Member[];
  agents: Agent[];
  conversations: Conversation[];
  projects: Project[];
  /** Projects archived in this browser; omitted from the default project surfaces. */
  archivedProjects?: Project[];
  project: Project | null;
  projectMembers: ProjectMember[];
  archiveProject?: (projectId: string) => void;
  restoreProject?: (projectId: string) => void;
  isProjectArchived?: (projectId: string) => boolean;
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
