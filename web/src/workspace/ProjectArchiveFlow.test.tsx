import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Project } from '../api/client';
import { ProjectSettingsPage, ProjectsPage } from './ProjectPages';
import { WorkspaceContext, type WorkspaceContextValue } from './workspace-context';

const workspaceId = '6c07fe76-1237-4998-8250-d20c61e90024';

function project(id: string, name: string): Project {
  return {
    id,
    workspaceId,
    name,
    description: null,
    revision: 1,
    contextVersion: 1,
    membershipId: 'project-membership',
    role: 'owner',
    governanceOnly: false,
    activeMemberCount: 1,
    conversationCount: 0,
    createdByMembershipId: 'workspace-membership',
    createdAt: 1,
    updatedAt: 1,
  };
}

function baseContext(overrides: Partial<WorkspaceContextValue> = {}): WorkspaceContextValue {
  return {
    workspace: {
      id: workspaceId,
      name: 'Product',
      revision: 1,
      contextVersion: 1,
      membershipId: 'workspace-membership',
      membershipRole: 'owner',
      createdAt: 1,
      updatedAt: 1,
    },
    members: [],
    agents: [],
    conversations: [],
    projects: [],
    project: null,
    projectMembers: [],
    openNewProject: () => undefined,
    openNewConversation: () => undefined,
    openDirectMessage: async () => undefined,
    openingDirectMessageMembershipId: null,
    refresh: async () => undefined,
    ...overrides,
  };
}

function renderWithContext(element: React.ReactNode, context: WorkspaceContextValue, initialEntries = [`/w/${workspaceId}/projects`]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <ConfigProvider>
      <AntApp>
        <QueryClientProvider client={queryClient}>
          <WorkspaceContext.Provider value={context}>
            <MemoryRouter initialEntries={initialEntries}>
              {element}
            </MemoryRouter>
          </WorkspaceContext.Provider>
        </QueryClientProvider>
      </AntApp>
    </ConfigProvider>,
  );
}

describe('Project archive flow', () => {
  it('keeps archived projects out of the default list and offers restore', async () => {
    const restoreProject = vi.fn();
    const archived = project('archived-project', 'Archived project');
    renderWithContext(
      <ProjectsPage />,
      baseContext({ projects: [project('active-project', 'Active project')], archivedProjects: [archived], restoreProject }),
    );

    expect(screen.getByText('Active project')).toBeVisible();
    expect(screen.queryByText('Archived project')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /已归档 \(1\)/u }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Archived project')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /恢复/u }));
    expect(restoreProject).toHaveBeenCalledWith('archived-project');
  });

  it('archives from project settings after confirmation and returns to the directory', async () => {
    const archiveProject = vi.fn();
    const current = project('active-project', 'Active project');
    renderWithContext(
      <Routes>
        <Route path="/w/:workspaceId/p/:projectId" element={<ProjectSettingsPage />} />
        <Route path="/w/:workspaceId/projects" element={<span>Projects directory</span>} />
      </Routes>,
      baseContext({ project: current, archiveProject, restoreProject: vi.fn(), isProjectArchived: () => false }),
      [`/w/${workspaceId}/p/${current.id}`],
    );

    await userEvent.click(screen.getByRole('button', { name: /归档项目/u }));
    const popconfirm = (await screen.findByText('归档这个项目？')).closest('.ant-popover');
    expect(popconfirm).not.toBeNull();
    await userEvent.click(within(popconfirm as HTMLElement).getAllByRole('button').at(-1)!);
    expect(archiveProject).toHaveBeenCalledWith(current.id);
    expect(await screen.findByText('Projects directory')).toBeVisible();
  });
});
