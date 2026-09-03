import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp, ConfigProvider } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MembersPage } from './MembersPage';
import { WorkspaceContext, type WorkspaceContextValue } from './workspace-context';

const originalClipboard = navigator.clipboard;

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: originalClipboard,
  });
});

const workspaceId = '6c07fe76-1237-4998-8250-d20c61e90024';
const membershipId = '5f9195bf-903d-480d-90eb-5404dc4eefb4';
const joinLinkId = 'a95ccf75-0805-4b3c-95cb-206c7d90db17';
const revokedLinkId = '4e5de535-5ec4-4cc5-aeb4-cb9fdaf52108';
const token = `anc_${'a'.repeat(43)}`;
const createdToken = `anc_${'b'.repeat(43)}`;

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function toRequest(input: RequestInfo | URL, init?: RequestInit): Request {
  return input instanceof Request ? input : new Request(input, init);
}

function context(role: 'owner' | 'member', withOtherMember = false): WorkspaceContextValue {
  const currentMember = {
    membershipId,
    actorId: 'f37845d6-44ac-4e0a-a00b-85e56a8a7849',
    actorType: 'human' as const,
    displayName: role === 'owner' ? 'Alice Owner' : 'Bob Member',
    membershipRole: role,
    revision: 1,
    joinedAt: 1,
  };
  return {
    workspace: {
      id: workspaceId,
      name: 'Product',
      revision: 1,
      contextVersion: 1,
      membershipId,
      membershipRole: role,
      createdAt: 1,
      updatedAt: 1,
    },
    members: [
      currentMember,
      ...(withOtherMember ? [{
        membershipId: 'e5ebf144-92fe-431c-b063-bf1543bcb015',
        actorId: 'a2b4d6f8-11d3-4a90-8b22-c7d0e1f23456',
        actorType: 'human' as const,
        displayName: 'Charlie Member',
        membershipRole: 'member' as const,
        revision: 1,
        joinedAt: 2,
      }] : []),
    ],
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
  };
}

function joinLinks() {
  return {
    items: [
      {
        id: joinLinkId,
        workspaceId,
        token,
        status: 'active',
        revision: 1,
        createdByMembershipId: membershipId,
        useCount: 2,
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: 1,
        revokedAt: null,
      },
      {
        id: revokedLinkId,
        workspaceId,
        token: null,
        status: 'revoked',
        revision: 2,
        createdByMembershipId: membershipId,
        useCount: 1,
        createdAt: 2,
        updatedAt: 3,
        lastUsedAt: 2,
        revokedAt: 3,
      },
    ],
    nextCursor: null,
  };
}

function renderPage(role: 'owner' | 'member', fetchMock: ReturnType<typeof vi.fn>, withOtherMember = false) {
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(['workspace', workspaceId, 'join-links'], joinLinks().items);
  render(
    <ConfigProvider>
      <AntApp>
        <QueryClientProvider client={queryClient}>
          <WorkspaceContext.Provider value={context(role, withOtherMember)}>
            <MembersPage />
          </WorkspaceContext.Provider>
        </QueryClientProvider>
      </AntApp>
    </ConfigProvider>,
  );
}

describe('MembersPage Workspace join links', () => {
  it('lets a member view and copy active links without create or revoke controls', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = toRequest(input, init);
      if (new URL(request.url).pathname === `/v1/workspaces/${workspaceId}/join-links` && request.method === 'GET') {
        return json(joinLinks());
      }
      return json({ error: { code: 'NOT_FOUND', message: 'Not found.', details: null } }, 404);
    });

    renderPage('member', fetchMock);
    fireEvent.click(screen.getByText('邀请链接'));

    expect(await screen.findByText('有效邀请链接对所有 Workspace 成员可见')).toBeVisible();
    expect(screen.getByText(/只有 Workspace Owner 可以创建或停用链接/)).toBeVisible();
    expect(screen.queryByText('创建并复制邀请链接')).not.toBeInTheDocument();
    expect(screen.queryByText('停用')).not.toBeInTheDocument();
    const copyButtons = await screen.findAllByText('复制链接');
    expect(copyButtons).toHaveLength(1);
    fireEvent.click(copyButtons[0]!.closest('button')!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/join/${token}`));
    expect(fetchMock.mock.calls.map((call) => call[0] as Request).some((request) => request.method !== 'GET')).toBe(false);
  });

  it('keeps create and revoke controls available to an owner', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = toRequest(input, init);
      const path = new URL(request.url).pathname;
      if (path === `/v1/workspaces/${workspaceId}/join-links` && request.method === 'GET') return json(joinLinks());
      if (path === `/v1/workspaces/${workspaceId}/join-links` && request.method === 'POST') {
        return json({ ...joinLinks().items[0], id: '4be36987-76e4-472e-8423-7f1c9f6a12da', token: createdToken }, 201);
      }
      return json({ error: { code: 'NOT_FOUND', message: 'Not found.', details: null } }, 404);
    });

    renderPage('owner', fetchMock);

    const createButton = await screen.findByText('创建并复制邀请链接');
    fireEvent.click(screen.getByText('邀请链接'));
    expect(await screen.findByText('停用')).toBeVisible();
    expect(await screen.findAllByText('复制链接')).toHaveLength(1);
    fireEvent.click(createButton.closest('button')!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/join/${createdToken}`));
    expect(document.querySelector('textarea[aria-label="邀请链接"]:not([aria-hidden="true"])'))
      .toHaveValue(`${window.location.origin}/join/${createdToken}`);
  }, 15_000);
});

describe('MembersPage Workspace membership controls', () => {
  it('does not expose Workspace role editing', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = toRequest(input, init);
      if (new URL(request.url).pathname === `/v1/workspaces/${workspaceId}/join-links` && request.method === 'GET') {
        return json(joinLinks());
      }
      return json({ error: { code: 'NOT_FOUND', message: 'Not found.', details: null } }, 404);
    });

    renderPage('owner', fetchMock, true);

    expect(await screen.findByText('Charlie Member')).toBeVisible();
    expect(screen.queryByRole('button', { name: '修改' })).not.toBeInTheDocument();
    expect(screen.queryByText('责任角色')).not.toBeInTheDocument();
  });
});
