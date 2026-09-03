import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { WorkItem } from '../api/client';
import type { WorkspaceContextValue } from './workspace-context';
import { WorkspaceContext } from './workspace-context';
import { WorkItemBoardPage } from './WorkItemBoardPage';

const workspaceId = '6c07fe76-1237-4998-8250-d20c61e90024';
const projectId = '04fdc61c-6405-4c30-a28a-ad2f36bdc115';

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function createWorkItem(
  lifecycleStatus: WorkItem['lifecycleStatus'],
  relatedWorkItemReferences: WorkItem['relatedWorkItemReferences'] = [],
): WorkItem {
  return {
    id: 'work-item-1',
    workspaceId,
    projectId,
    taskNumber: 1,
    description: '验证完成任务的交付结果展示',
    relatedWorkItemReferences,
    sourceConversationId: null,
    sourceMessageId: null,
    sourceThreadId: null,
    lifecycleStatus,
    blockerReason: null,
    cancellationReason: null,
    assignee: null,
    assignees: [],
    currentSubmission: {
      id: 'submission-1',
      commentId: null,
      submittedByMembershipId: 'human-membership',
      submittedByProjectMembershipId: 'project-membership',
      submittedByActorId: 'human-1',
      submittedByDisplayName: 'Alice',
      assignmentRevision: 1,
      artifactReferences: [{
        artifactId: 'artifact-1',
        artifactVersionId: 'version-1',
        artifactName: '交付文档',
        version: 1,
        fileName: 'result.md',
        mediaType: 'text/markdown',
        contentDigest: 'digest',
        byteLength: 12,
        contentAvailable: true,
        artifactStatus: 'active',
      }],
      createdAt: 2,
    },
    assignmentRevision: 1,
    commentFrontier: 0,
    revision: 2,
    createdByMembershipId: 'human-membership',
    createdByProjectMembershipId: 'project-membership',
    createdByDisplayName: 'Alice',
    createdAt: 1,
    updatedAt: 2,
    completedAt: lifecycleStatus === 'completed' ? 3 : null,
    cancelledAt: null,
  };
}

function createContext(): WorkspaceContextValue {
  return {
    workspace: {
      id: workspaceId,
      name: 'Workspace',
      revision: 1,
      contextVersion: 1,
      membershipId: 'human-membership',
      membershipRole: 'owner',
      createdAt: 1,
      updatedAt: 1,
    },
    members: [],
    agents: [],
    conversations: [],
    projects: [],
    project: {
      id: projectId,
      workspaceId,
      name: 'Launch',
      description: null,
      revision: 1,
      contextVersion: 1,
      membershipId: 'project-membership',
      role: 'owner',
      governanceOnly: false,
      activeMemberCount: 1,
      conversationCount: 0,
      createdByMembershipId: 'human-membership',
      createdAt: 1,
      updatedAt: 1,
    },
    projectMembers: [],
    openNewProject: () => undefined,
    openNewConversation: () => undefined,
    openDirectMessage: async () => undefined,
    openingDirectMessageMembershipId: null,
    refresh: async () => undefined,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('WorkItem board submission status', () => {
  it.each([
    { lifecycleStatus: 'open' as const, pendingVisible: true },
    { lifecycleStatus: 'completed' as const, pendingVisible: false },
  ])('shows pending only while the task is open ($lifecycleStatus)', async ({ lifecycleStatus, pendingVisible }) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL((input as Request).url).pathname;
      if (path === `/v1/projects/${projectId}/work-items`) {
        return json({ items: [createWorkItem(lifecycleStatus)] });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <ConfigProvider>
        <AntApp>
          <QueryClientProvider client={queryClient}>
            <WorkspaceContext.Provider value={createContext()}>
              <MemoryRouter initialEntries={[`/w/${workspaceId}/p/${projectId}/work-items`]}>
                <Routes><Route path="/w/:workspaceId/p/:projectId/work-items" element={<WorkItemBoardPage />} /></Routes>
              </MemoryRouter>
            </WorkspaceContext.Provider>
          </QueryClientProvider>
        </AntApp>
      </ConfigProvider>,
    );

    const description = await screen.findByText('验证完成任务的交付结果展示');
    const card = description.closest('article');
    expect(card).not.toBeNull();
    if (pendingVisible) {
      expect(within(card as HTMLElement).getByText('结果待验收')).toBeVisible();
    } else {
      expect(within(card as HTMLElement).queryByText('结果待验收')).not.toBeInTheDocument();
    }
    expect(within(card as HTMLElement).getByRole('link', { name: /交付文档/u })).toHaveAttribute(
      'href',
      `/w/${workspaceId}/p/${projectId}/artifacts/artifact-1?versionId=version-1`,
    );
  });

  it('shows source WorkItem references as related tasks on the card', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL((input as Request).url).pathname;
      if (path === `/v1/projects/${projectId}/work-items`) {
        return json({ items: [createWorkItem('open', [{ workItemId: 'work-item-source', taskNumber: 1 }])] });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <ConfigProvider>
        <AntApp>
          <QueryClientProvider client={queryClient}>
            <WorkspaceContext.Provider value={createContext()}>
              <MemoryRouter initialEntries={[`/w/${workspaceId}/p/${projectId}/work-items`]}>
                <Routes><Route path="/w/:workspaceId/p/:projectId/work-items" element={<WorkItemBoardPage />} /></Routes>
              </MemoryRouter>
            </WorkspaceContext.Provider>
          </QueryClientProvider>
        </AntApp>
      </ConfigProvider>,
    );

    const description = await screen.findByText('验证完成任务的交付结果展示');
    const card = description.closest('article');
    expect(card).not.toBeNull();
    const related = within(card as HTMLElement).getByLabelText('关联任务');
    expect(related).toHaveTextContent('关联任务：');
    expect(within(related).getByRole('link', { name: '打开关联任务 #1' })).toHaveAttribute(
      'href',
      `/w/${workspaceId}/p/${projectId}/work-items?workItemId=work-item-source`,
    );
  });

  it('keeps result and source actions in the card menu', async () => {
    const workItem = createWorkItem('open');
    workItem.sourceConversationId = 'conversation-source';
    workItem.sourceMessageId = 'message-source';
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL((input as Request).url).pathname;
      if (path === `/v1/projects/${projectId}/work-items`) return json({ items: [workItem] });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <ConfigProvider>
        <AntApp>
          <QueryClientProvider client={queryClient}>
            <WorkspaceContext.Provider value={createContext()}>
              <MemoryRouter initialEntries={[`/w/${workspaceId}/p/${projectId}/work-items`]}>
                <Routes><Route path="/w/:workspaceId/p/:projectId/work-items" element={<WorkItemBoardPage />} /></Routes>
              </MemoryRouter>
            </WorkspaceContext.Provider>
          </QueryClientProvider>
        </AntApp>
      </ConfigProvider>,
    );

    const description = await screen.findByText('验证完成任务的交付结果展示');
    const card = description.closest('article');
    expect(card).not.toBeNull();
    const footer = card?.querySelector('footer');
    expect(footer).not.toBeNull();
    expect(within(footer as HTMLElement).getByRole('button', { name: /评论/u })).toBeVisible();
    expect(within(footer as HTMLElement).queryByText('上传交付结果')).not.toBeInTheDocument();
    expect(within(footer as HTMLElement).queryByText('查看来源')).not.toBeInTheDocument();

    await userEvent.click(within(card as HTMLElement).getByRole('button', { name: '任务操作' }));
    const menu = document.querySelector('.ant-dropdown-menu');
    expect(menu).not.toBeNull();
    expect(menu).toHaveTextContent('上传交付结果');
    expect(menu).toHaveTextContent('查看来源');
  });
});
