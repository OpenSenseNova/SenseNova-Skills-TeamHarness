import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { sessionQueryKey } from '../app';
import { WorkspaceHome, WorkspaceShell } from './WorkspaceShell';
import { ProjectHome, ProjectsPage } from './ProjectPages';

afterEach(() => vi.unstubAllGlobals());

const workspaceId = '6c07fe76-1237-4998-8250-d20c61e90024';
const membershipId = '5f9195bf-903d-480d-90eb-5404dc4eefb4';
const humanId = 'f37845d6-44ac-4e0a-a00b-85e56a8a7849';
const workspace = {
  id: workspaceId,
  name: 'test',
  revision: 1,
  contextVersion: 1,
  membershipId,
  membershipRole: 'owner',
  createdAt: 1,
  updatedAt: 1,
};
const secondWorkspaceId = '2a538b11-f621-4191-8405-c5d677fde995';
const secondWorkspace = { ...workspace, id: secondWorkspaceId, name: 'second', membershipId: 'e5ebf144-92fe-431c-b063-bf1543bcb015' };

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

describe('WorkspaceShell', () => {
  it('keeps governance-only Projects separate and requires an explicit recovery Membership', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('min-width: 992px'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    const projectId = '04fdc61c-6405-4c30-a28a-ad2f36bdc115';
    const project = {
      id: projectId,
      workspaceId,
      name: 'Restricted',
      revision: 1,
      contextVersion: 1,
      membershipId: null,
      role: null,
      governanceOnly: true,
      activeMemberCount: 3,
      conversationCount: 2,
      description: null,
      repository: null,
      connectedComputerCount: 0,
      readyComputerCount: 0,
      workingCopySummary: 'not_connected',
      createdByMembershipId: '339038c9-bb5c-45e9-a175-c0642a5db20d',
      createdAt: 1,
      updatedAt: 1,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      const url = new URL(request.url);
      if (url.pathname === '/v1/workspaces') return json({ items: [workspace], nextCursor: null });
      if (url.pathname.endsWith('/bootstrap')) return json({ workspace, changeCursor: 0 });
      if (url.pathname === `/v1/workspaces/${workspaceId}/members`) return json({ items: [{
        membershipId,
        actorId: humanId,
        actorType: 'human',
        displayName: 'Alice',
        membershipRole: 'owner',
        revision: 1,
        joinedAt: 1,
      }], nextCursor: null });
      if (url.pathname === `/v1/workspaces/${workspaceId}/agents`) return json({ items: [], nextCursor: null });
      if (url.pathname === `/v1/workspaces/${workspaceId}/conversations`) return json({ items: [], nextCursor: null });
      if (url.pathname === `/v1/workspaces/${workspaceId}/projects`) return json({ items: [project], nextCursor: null });
      if (url.pathname === `/v1/projects/${projectId}`) return json(project);
      if (url.pathname === `/v1/projects/${projectId}/members` && request.method === 'POST') return json({
        projectMembershipId: '3a8805cc-b359-4418-85e4-f1355fac71e6',
        workspaceMembershipId: membershipId,
        actorId: humanId,
        actorType: 'human',
        displayName: 'Alice',
        role: 'manager',
        revision: 1,
        joinedAt: 2,
      }, 201);
      if (url.pathname.endsWith('/changes')) return json({ items: [], nextCursor: 0 });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(sessionQueryKey, { id: humanId, displayName: 'Alice', verifiedEmail: 'alice@example.com' });

    render(
      <ConfigProvider>
        <AntApp>
          <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={[`/w/${workspaceId}`]}>
              <Routes>
                <Route path="/w/:workspaceId" element={<WorkspaceShell />}>
                  <Route index element={<WorkspaceHome />} />
                  <Route path="projects" element={<ProjectsPage />} />
                  <Route path="p/:projectId" element={<ProjectHome />} />
                </Route>
              </Routes>
            </MemoryRouter>
          </QueryClientProvider>
        </AntApp>
      </ConfigProvider>,
    );

    await userEvent.click(await screen.findByRole('button', { name: /项目/u }));
    await userEvent.click(await screen.findByRole('button', { name: /Restricted · 仅元数据/ }));
    expect(await screen.findByText(/3 位成员，2 个 Conversation/)).toBeVisible();
    expect(screen.queryByText('项目成员')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '以 Manager 身份加入并恢复治理' }));
    await vi.waitFor(() => expect(fetchMock.mock.calls.map((call) => call[0] as Request).find((request) => (
      request.method === 'POST' && new URL(request.url).pathname === `/v1/projects/${projectId}/members`
    ))).toBeDefined());
    const recoveryRequest = fetchMock.mock.calls.map((call) => call[0] as Request).find((request) => (
      request.method === 'POST' && new URL(request.url).pathname === `/v1/projects/${projectId}/members`
    ));
    expect(await recoveryRequest!.clone().json()).toEqual({ workspaceMembershipId: membershipId, role: 'manager' });
  });

  it('moves from loading to a usable empty-workspace action without changing Hook order', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const request = input as Request;
      const url = new URL(request.url);
      if (url.pathname === '/v1/workspaces') return json({ items: [workspace], nextCursor: null });
      if (url.pathname === `/v1/workspaces/${workspaceId}/bootstrap`) return json({ workspace, changeCursor: 0 });
      if (url.pathname === `/v1/workspaces/${workspaceId}/members`) return json({ items: [{
        membershipId,
        actorId: humanId,
        actorType: 'human',
        displayName: 'Alice',
        membershipRole: 'owner',
        revision: 1,
        joinedAt: 1,
      }], nextCursor: null });
      if (url.pathname === `/v1/workspaces/${workspaceId}/agents`) return json({ items: [], nextCursor: null });
      if (url.pathname === `/v1/workspaces/${workspaceId}/projects`) return json({ items: [], nextCursor: null });
      if (url.pathname === `/v1/workspaces/${workspaceId}/conversations` && request.method === 'POST') return json({
        id: 'ae04186a-42e5-4077-9888-b10ba98271f5',
        workspaceId,
        kind: 'channel',
        title: 'general',
        contextVersion: 0,
        createdByMembershipId: membershipId,
        createdAt: 2,
        updatedAt: 2,
      }, 201);
      if (url.pathname === `/v1/workspaces/${workspaceId}/conversations`) return json({ items: [], nextCursor: null });
      if (url.pathname === `/v1/workspaces/${workspaceId}/changes`) return json({ items: [], nextCursor: 0 });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(sessionQueryKey, { id: humanId, displayName: 'Alice', verifiedEmail: 'alice@example.com' });

    render(
      <ConfigProvider>
        <AntApp>
          <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={[`/w/${workspaceId}`]}>
              <Routes>
                <Route path="/w/:workspaceId" element={<WorkspaceShell />}>
                  <Route index element={<WorkspaceHome />} />
                  <Route path="c/:conversationId" element={<div>Conversation 已进入</div>} />
                </Route>
              </Routes>
            </MemoryRouter>
          </QueryClientProvider>
        </AntApp>
      </ConfigProvider>,
    );

    expect(await screen.findByText('test 已准备好')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: /新建 Conversation/ }));
    const dialog = await screen.findByRole('dialog', { name: '新建工作区会话' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: '标题' }), { target: { value: 'general' } });
    await userEvent.click(within(dialog).getByRole('button', { name: /创\s*建/ }));
    expect(await screen.findByText('Conversation 已进入')).toBeVisible();
    const createRequest = fetchMock.mock.calls.map((call) => call[0] as Request)
      .find((request) => request.method === 'POST' && new URL(request.url).pathname.endsWith('/conversations'));
    expect(createRequest).toBeDefined();
    expect(await createRequest!.clone().json()).toMatchObject({ kind: 'channel', title: 'general' });
  });

  it('switches Workspace from the persistent navigation rail', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('min-width: 992px'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const request = input as Request;
      const url = new URL(request.url);
      if (url.pathname === '/v1/workspaces') return json({ items: [workspace, secondWorkspace], nextCursor: null });
      const target = url.pathname.includes(secondWorkspaceId) ? secondWorkspace : workspace;
      if (url.pathname.endsWith('/bootstrap')) return json({ workspace: target, changeCursor: 0 });
      if (url.pathname.endsWith('/members')) return json({ items: [{
        membershipId: target.membershipId,
        actorId: humanId,
        actorType: 'human',
        displayName: 'Alice',
        membershipRole: 'owner',
        revision: 1,
        joinedAt: 1,
      }], nextCursor: null });
      if (url.pathname.endsWith('/agents') || url.pathname.endsWith('/conversations') || url.pathname.endsWith('/projects')) return json({ items: [], nextCursor: null });
      if (url.pathname.endsWith('/changes')) return json({ items: [], nextCursor: 0 });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(sessionQueryKey, { id: humanId, displayName: 'Alice', verifiedEmail: 'alice@example.com' });

    render(
      <ConfigProvider>
        <AntApp>
          <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={[`/w/${workspaceId}`]}>
              <Routes>
                <Route path="/w/:workspaceId" element={<WorkspaceShell />}>
                  <Route index element={<WorkspaceHome />} />
                  <Route path="agents" element={<div>Agent 管理页</div>} />
                  <Route path="members" element={<div>Human 管理页</div>} />
                </Route>
              </Routes>
            </MemoryRouter>
          </QueryClientProvider>
        </AntApp>
      </ConfigProvider>,
    );

    expect(await screen.findByText('test 已准备好')).toBeVisible();
    expect(screen.getByRole('button', { name: '新建会话' })).toBeInTheDocument();
    expect(screen.getByText(/私聊/)).toBeInTheDocument();
    const switchers = await screen.findAllByRole('button', { name: '切换 Workspace' });
    const railSwitcher = switchers.find((button) => button.classList.contains('workspace-rail-switcher'));
    expect(railSwitcher).toBeDefined();
    await userEvent.click(railSwitcher!);
    await userEvent.click(await screen.findByRole('menuitem', { name: /second/ }));
    expect(await screen.findByText('second 已准备好')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '团队' }));
    expect(await screen.findByText(/Human 成员/)).toBeInTheDocument();
    expect(await screen.findByText('Agent 管理页')).toBeVisible();
    expect(screen.queryByRole('button', { name: '新建私聊' })).not.toBeInTheDocument();
  });

  it('starts a private message from an Agent identity', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('min-width: 992px'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    const agentMembershipId = '25854b59-7b4a-456a-b6ab-c5ea189fbd2a';
    const agentId = '8101135d-2a4a-480e-b14e-5d3f58d217b4';
    const directConversationId = 'ce601f89-f5d1-42de-a705-82c354354e31';
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      const url = new URL(request.url);
      if (url.pathname === '/v1/workspaces') return json({ items: [workspace], nextCursor: null });
      if (url.pathname.endsWith('/bootstrap')) return json({ workspace, changeCursor: 0 });
      if (url.pathname.endsWith('/members')) return json({ items: [
        {
          membershipId,
          actorId: humanId,
          actorType: 'human',
          displayName: 'Alice',
          membershipRole: 'owner',
          revision: 1,
          joinedAt: 1,
        },
        {
          membershipId: agentMembershipId,
          actorId: agentId,
          actorType: 'agent',
          displayName: 'Researcher',
          membershipRole: 'member',
          revision: 1,
          joinedAt: 2,
        },
      ], nextCursor: null });
      if (url.pathname.endsWith('/agents')) return json({ items: [{
        id: agentId,
        workspaceId,
        createdByHumanId: humanId,
        name: 'Researcher',
        description: 'Research Agent',
        lifecycleStatus: 'active',
        revision: 1,
        membershipId: agentMembershipId,
        executionPolicyVersion: 1,
        createdAt: 2,
        updatedAt: 2,
      }], nextCursor: null });
      if (url.pathname.endsWith('/projects')) return json({ items: [], nextCursor: null });
      if (url.pathname.endsWith('/conversations') && request.method === 'POST') return json({
        id: directConversationId,
        workspaceId,
        kind: 'dm',
        title: null,
        contextVersion: 1,
        timelineFrontier: 0,
        createdByMembershipId: membershipId,
        createdAt: 3,
        updatedAt: 3,
      }, 201);
      if (url.pathname.endsWith('/conversations')) return json({ items: [], nextCursor: null });
      if (url.pathname.endsWith('/changes')) return json({ items: [], nextCursor: 0 });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(sessionQueryKey, { id: humanId, displayName: 'Alice', verifiedEmail: 'alice@example.com' });

    render(
      <ConfigProvider>
        <AntApp>
          <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={[`/w/${workspaceId}/agents`]}>
              <Routes>
                <Route path="/w/:workspaceId" element={<WorkspaceShell />}>
                  <Route path="agents" element={<div>Agent 管理页</div>} />
                  <Route path="c/:conversationId" element={<div>私信已进入</div>} />
                </Route>
              </Routes>
            </MemoryRouter>
          </QueryClientProvider>
        </AntApp>
      </ConfigProvider>,
    );

    await userEvent.click(await screen.findByRole('button', { name: '与 Researcher 私聊' }));
    expect(await screen.findByText('私信已进入')).toBeVisible();
    const createRequest = fetchMock.mock.calls.map((call) => call[0] as Request)
      .find((request) => request.method === 'POST' && new URL(request.url).pathname.endsWith('/conversations'));
    expect(createRequest).toBeDefined();
    expect(await createRequest!.clone().json()).toEqual({
      kind: 'dm',
      directWorkspaceMembershipIds: [agentMembershipId],
    });
  });

  it('reuses the existing two-person private message for the selected member', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('min-width: 992px'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    const bobMembershipId = '25854b59-7b4a-456a-b6ab-c5ea189fbd2a';
    const directConversationId = 'ce601f89-f5d1-42de-a705-82c354354e31';
    const conversation = {
      id: directConversationId,
      workspaceId,
      kind: 'dm',
      title: null,
      contextVersion: 1,
      timelineFrontier: 0,
      createdByMembershipId: membershipId,
      createdAt: 3,
      updatedAt: 3,
    };
    const alice = {
      membershipId,
      actorId: humanId,
      actorType: 'human',
      displayName: 'Alice',
      membershipRole: 'owner',
      revision: 1,
      joinedAt: 1,
    };
    const bob = {
      membershipId: bobMembershipId,
      actorId: '8101135d-2a4a-480e-b14e-5d3f58d217b4',
      actorType: 'human',
      displayName: 'Bob',
      membershipRole: 'member',
      revision: 1,
      joinedAt: 2,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      const url = new URL(request.url);
      if (url.pathname === '/v1/workspaces') return json({ items: [workspace], nextCursor: null });
      if (url.pathname.endsWith('/bootstrap')) return json({ workspace, changeCursor: 0 });
      if (url.pathname.endsWith('/members')) return json({ items: [alice, bob], nextCursor: null });
      if (url.pathname.endsWith('/agents')) return json({ items: [], nextCursor: null });
      if (url.pathname.endsWith('/projects')) return json({ items: [], nextCursor: null });
      if (url.pathname.endsWith('/conversations')) return json({ items: [conversation], nextCursor: null });
      if (url.pathname === `/v1/conversations/${directConversationId}/participants`) return json({
        items: [
          { workspaceMembershipId: membershipId, projectMembershipId: null, actorId: humanId, actorType: 'human', displayName: 'Alice', addedAt: 1 },
          { workspaceMembershipId: bobMembershipId, projectMembershipId: null, actorId: bob.actorId, actorType: 'human', displayName: 'Bob', addedAt: 2 },
        ],
        nextCursor: null,
      });
      if (url.pathname.endsWith('/changes')) return json({ items: [], nextCursor: 0 });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(sessionQueryKey, { id: humanId, displayName: 'Alice', verifiedEmail: 'alice@example.com' });

    render(
      <ConfigProvider>
        <AntApp>
          <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={[`/w/${workspaceId}/agents`]}>
              <Routes>
                <Route path="/w/:workspaceId" element={<WorkspaceShell />}>
                  <Route path="agents" element={<div>Agent 管理页</div>} />
                  <Route path="c/:conversationId" element={<div>已有私信已进入</div>} />
                </Route>
              </Routes>
            </MemoryRouter>
          </QueryClientProvider>
        </AntApp>
      </ConfigProvider>,
    );

    await userEvent.click(await screen.findByRole('button', { name: '与 Bob 私聊' }));
    expect(await screen.findByText('已有私信已进入')).toBeVisible();
    expect(fetchMock.mock.calls.map((call) => call[0] as Request)
      .filter((request) => request.method === 'POST' && new URL(request.url).pathname.endsWith('/conversations'))).toHaveLength(0);
  });

  it('shows pending Agent execution only in the bottom-left activity area', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('min-width: 992px'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    const conversationId = 'ce601f89-f5d1-42de-a705-82c354354e31';
    const agentId = '8101135d-2a4a-480e-b14e-5d3f58d217b4';
    const agentMembershipId = '25854b59-7b4a-456a-b6ab-c5ea189fbd2a';
    const conversation = {
      id: conversationId, workspaceId, kind: 'channel', title: 'all', contextVersion: 1,
      timelineFrontier: 1, createdByMembershipId: membershipId, createdAt: 2, updatedAt: 2,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      const url = new URL(request.url);
      if (url.pathname === '/v1/workspaces') return json({ items: [workspace], nextCursor: null });
      if (url.pathname.endsWith('/bootstrap')) return json({ workspace, changeCursor: 0 });
      if (url.pathname.endsWith('/members')) return json({ items: [{
        membershipId, actorId: humanId, actorType: 'human', displayName: 'Alice',
        membershipRole: 'owner', revision: 1, joinedAt: 1,
      }], nextCursor: null });
      if (url.pathname.endsWith('/agents')) return json({ items: [{
        id: agentId, workspaceId, createdByHumanId: humanId, name: 'Researcher', description: null,
        lifecycleStatus: 'active', revision: 1, membershipId: agentMembershipId,
        executionPolicyVersion: 1, runtimeBinding: null, createdAt: 1, updatedAt: 1,
      }], nextCursor: null });
      if (url.pathname === '/v1/computers') return json({ items: [] });
      if (url.pathname.endsWith('/projects')) return json({ items: [], nextCursor: null });
      if (url.pathname.endsWith('/conversations')) return json({ items: [conversation], nextCursor: null });
      if (url.pathname === `/v1/conversations/${conversationId}/agent-requests`) return json({ items: [{
        id: '063439d7-5c06-4b3b-8815-5abae55c937d', workspaceId,
        sourceMessageId: 'ef873138-489a-46eb-b69c-f63784f9f9b5', targetAgentId: agentId,
        resultConversationId: conversationId, resultThreadId: null, status: 'pending', version: 1,
        intake: { disposition: 'ready', reasons: [] }, terminalReason: null, run: null, createdAt: 3, updatedAt: 3, terminalAt: null,
      }] });
      if (url.pathname.endsWith('/changes')) return json({ items: [], nextCursor: 0 });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(sessionQueryKey, { id: humanId, displayName: 'Alice', verifiedEmail: 'alice@example.com' });

    render(
      <ConfigProvider>
        <AntApp>
          <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={[`/w/${workspaceId}/c/${conversationId}`]}>
              <Routes>
                <Route path="/w/:workspaceId" element={<WorkspaceShell />}>
                  <Route path="c/:conversationId" element={<div>Conversation 已进入</div>} />
                </Route>
              </Routes>
            </MemoryRouter>
          </QueryClientProvider>
        </AntApp>
      </ConfigProvider>,
    );

    expect(await screen.findByText('等待执行…')).toBeVisible();
    const activity = screen.getByText('等待执行…').closest('.sidebar-agent-activity');
    expect(activity).not.toBeNull();
    expect(within(activity as HTMLElement).getByText('Researcher')).toBeVisible();
    expect(screen.queryByRole('button', { name: '取消请求' })).not.toBeInTheDocument();
  });

  it('opens a Project as a separate management and Conversation scope', async () => {
    const projectId = '8f53fd7e-7a79-4d8d-aa27-d73cc8f81581';
    const projectMembershipId = '5ebac46c-4023-4385-991c-6ded840d7dbd';
    const project = {
      id: projectId,
      workspaceId,
      name: 'Launch',
      revision: 1,
      contextVersion: 1,
      membershipId: projectMembershipId,
      role: 'manager',
      governanceOnly: false,
      activeMemberCount: 1,
      conversationCount: 0,
      description: 'Launch repository',
      repository: {
        id: 'd1c71ddf-7345-4755-a403-da2fe2a38b97',
        cloneUrl: 'git@github.com:example/launch.git',
        repositoryIdentity: 'github.com/example/launch',
        defaultBranch: 'main',
        revision: 1,
      },
      connectedComputerCount: 0,
      readyComputerCount: 0,
      workingCopySummary: 'not_connected',
      createdByMembershipId: membershipId,
      createdAt: 1,
      updatedAt: 1,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      const url = new URL(request.url);
      if (url.pathname === '/v1/workspaces') return json({ items: [workspace], nextCursor: null });
      if (url.pathname.endsWith('/bootstrap')) return json({ workspace, changeCursor: 0 });
      if (url.pathname === `/v1/workspaces/${workspaceId}/members`) return json({ items: [{
        membershipId,
        actorId: humanId,
        actorType: 'human',
        displayName: 'Alice',
        membershipRole: 'owner',
        revision: 1,
        joinedAt: 1,
      }], nextCursor: null });
      if (url.pathname === `/v1/workspaces/${workspaceId}/agents`) return json({ items: [], nextCursor: null });
      if (url.pathname === `/v1/workspaces/${workspaceId}/conversations`) return json({ items: [], nextCursor: null });
      if (url.pathname === `/v1/workspaces/${workspaceId}/projects`) return json({ items: [project], nextCursor: null });
      if (url.pathname === `/v1/projects/${projectId}`) return json(project);
      if (url.pathname === `/v1/projects/${projectId}/members`) return json({ items: [{
        projectMembershipId,
        workspaceMembershipId: membershipId,
        actorId: humanId,
        actorType: 'human',
        displayName: 'Alice',
        role: 'manager',
        revision: 1,
        joinedAt: 1,
      }], nextCursor: null });
      if (url.pathname === `/v1/projects/${projectId}/working-copies`) return json({ items: [] });
      if (url.pathname === `/v1/projects/${projectId}/resource-links`) return json({ items: [] });
      if (url.pathname === `/v1/workspaces/${workspaceId}/artifacts`) return json({ items: [] });
      if (url.pathname === `/v1/projects/${projectId}/conversations` && request.method === 'POST') return json({
        id: '38dd5b19-9867-4646-8150-dcb7afac30bd',
        workspaceId,
        projectId,
        kind: 'channel',
        title: 'Roadmap',
        contextVersion: 1,
        timelineFrontier: 0,
        createdByMembershipId: membershipId,
        createdByProjectMembershipId: projectMembershipId,
        createdAt: 2,
        updatedAt: 2,
      }, 201);
      if (url.pathname === `/v1/projects/${projectId}/conversations`) return json({ items: [], nextCursor: null });
      if (url.pathname.endsWith('/changes')) return json({ items: [], nextCursor: 0 });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(sessionQueryKey, { id: humanId, displayName: 'Alice', verifiedEmail: 'alice@example.com' });

    render(
      <ConfigProvider>
        <AntApp>
          <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={[`/w/${workspaceId}`]}>
              <Routes>
                <Route path="/w/:workspaceId" element={<WorkspaceShell />}>
                  <Route index element={<WorkspaceHome />} />
                  <Route path="projects" element={<ProjectsPage />} />
                  <Route path="p/:projectId" element={<ProjectHome />} />
                  <Route path="p/:projectId/c/:conversationId" element={<div>Project Conversation 已进入</div>} />
                </Route>
              </Routes>
            </MemoryRouter>
          </QueryClientProvider>
        </AntApp>
      </ConfigProvider>,
    );

    await userEvent.click(await screen.findByRole('button', { name: 'menu-unfold' }));
    await userEvent.click(await screen.findByRole('button', { name: /项目/u }));
    await userEvent.click(await screen.findByRole('button', { name: /Launch/ }));
    expect(await screen.findByText('1 位成员 · 0 个当前可见 Conversation')).toBeVisible();
    expect(screen.queryByText('还没有项目私聊')).not.toBeInTheDocument();
    expect(screen.queryByText(/^私聊/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '管理项目成员' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '打开 Artifacts' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '新建项目会话' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('在 Launch 中新建会话')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByRole('textbox', { name: '标题' }), { target: { value: 'Roadmap' } });
    await userEvent.click(within(dialog).getByRole('button', { name: /创\s*建/ }));
    expect(await screen.findByText('Project Conversation 已进入')).toBeVisible();
    expect(screen.getByRole('button', { name: '打开 Artifacts' })).toBeVisible();
    const createRequest = fetchMock.mock.calls.map((call) => call[0] as Request).find((request) => (
      request.method === 'POST' && new URL(request.url).pathname === `/v1/projects/${projectId}/conversations`
    ));
    expect(await createRequest!.clone().json()).toEqual({
      kind: 'channel',
      title: 'Roadmap',
    });
  });

  it('lists archived Conversations separately and restores them', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('min-width: 992px'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    const archivedConversationId = 'ce601f89-f5d1-42de-a705-82c354354e31';
    let restored = false;
    const archivedConversation = {
      id: archivedConversationId,
      workspaceId,
      projectId: null,
      kind: 'channel',
      title: 'Archived planning',
      lifecycleStatus: 'archived',
      revision: 2,
      archivedAt: 4,
      archivedByMembershipId: membershipId,
      contextVersion: 2,
      timelineFrontier: 1,
      createdByMembershipId: membershipId,
      createdByProjectMembershipId: null,
      createdAt: 1,
      updatedAt: 4,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      const url = new URL(request.url);
      if (url.pathname === '/v1/workspaces') return json({ items: [workspace], nextCursor: null });
      if (url.pathname.endsWith('/bootstrap')) return json({ workspace, changeCursor: 0 });
      if (url.pathname === `/v1/workspaces/${workspaceId}/members`) return json({ items: [{
        membershipId,
        actorId: humanId,
        actorType: 'human',
        displayName: 'Alice',
        membershipRole: 'owner',
        revision: 1,
        joinedAt: 1,
      }], nextCursor: null });
      if (url.pathname === `/v1/workspaces/${workspaceId}/agents`) return json({ items: [], nextCursor: null });
      if (url.pathname === '/v1/computers') return json({ items: [] });
      if (url.pathname === `/v1/workspaces/${workspaceId}/projects`) return json({ items: [], nextCursor: null });
      if (url.pathname === `/v1/workspaces/${workspaceId}/conversations`) {
        if (url.searchParams.get('lifecycleStatus') === 'archived') {
          return json({ items: restored ? [] : [archivedConversation], nextCursor: null });
        }
        return json({ items: restored ? [{
          ...archivedConversation,
          lifecycleStatus: 'active',
          revision: 3,
          archivedAt: null,
          archivedByMembershipId: null,
        }] : [], nextCursor: null });
      }
      if (url.pathname === `/v1/conversations/${archivedConversationId}/restore` && request.method === 'POST') {
        restored = true;
        return json({
          ...archivedConversation,
          lifecycleStatus: 'active',
          revision: 3,
          archivedAt: null,
          archivedByMembershipId: null,
        });
      }
      if (url.pathname.endsWith('/changes')) return json({ items: [], nextCursor: 0 });
      if (url.pathname === `/v1/workspaces/${workspaceId}/artifacts`) return json({ items: [] });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(sessionQueryKey, { id: humanId, displayName: 'Alice', verifiedEmail: 'alice@example.com' });

    render(
      <ConfigProvider>
        <AntApp>
          <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={[`/w/${workspaceId}`]}>
              <Routes>
                <Route path="/w/:workspaceId" element={<WorkspaceShell />}>
                  <Route index element={<WorkspaceHome />} />
                  <Route path="c/:conversationId" element={<div>Archived Conversation 已打开</div>} />
                </Route>
              </Routes>
            </MemoryRouter>
          </QueryClientProvider>
        </AntApp>
      </ConfigProvider>,
    );

    await userEvent.click(await screen.findByRole('button', { name: /已归档 Conversation/u }));
    const archivedTitle = await screen.findByText('Archived planning');
    const dialog = archivedTitle.closest('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(within(dialog as HTMLElement).getByText('Archived planning')).toBeInTheDocument();
    fireEvent.click(within(dialog as HTMLElement).getByRole('button', { name: /恢复/u }));
    expect(await within(dialog as HTMLElement).findByText('没有已归档的 Conversation')).toBeInTheDocument();
    const restoreRequest = fetchMock.mock.calls.map((call) => call[0] as Request).find((request) => (
      request.method === 'POST' && new URL(request.url).pathname.endsWith('/restore')
    ));
    expect(await restoreRequest!.clone().json()).toEqual({ expectedRevision: 2 });
  });

  it('logs out from the account menu when the API returns 204 No Content', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('min-width: 992px'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      const url = new URL(request.url);
      if (url.pathname === '/v1/auth/logout' && request.method === 'POST') {
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/v1/workspaces') return json({ items: [workspace], nextCursor: null });
      if (url.pathname.endsWith('/bootstrap')) return json({ workspace, changeCursor: 0 });
      if (url.pathname === `/v1/workspaces/${workspaceId}/members`) return json({ items: [{
        membershipId,
        actorId: humanId,
        actorType: 'human',
        displayName: 'Alice',
        membershipRole: 'owner',
        revision: 1,
        joinedAt: 1,
      }], nextCursor: null });
      if (url.pathname === `/v1/workspaces/${workspaceId}/agents`) return json({ items: [], nextCursor: null });
      if (url.pathname === '/v1/computers') return json({ items: [] });
      if (url.pathname === `/v1/workspaces/${workspaceId}/projects`) return json({ items: [], nextCursor: null });
      if (url.pathname === `/v1/workspaces/${workspaceId}/conversations`) return json({ items: [], nextCursor: null });
      if (url.pathname.endsWith('/changes')) return json({ items: [], nextCursor: 0 });
      if (url.pathname === `/v1/workspaces/${workspaceId}/artifacts`) return json({ items: [] });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(sessionQueryKey, { id: humanId, displayName: 'Alice', verifiedEmail: 'alice@example.com' });

    render(
      <ConfigProvider>
        <AntApp>
          <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={[`/w/${workspaceId}`]}>
              <Routes>
                <Route path="/login" element={<div>登录页</div>} />
                <Route path="/w/:workspaceId" element={<WorkspaceShell />}>
                  <Route index element={<WorkspaceHome />} />
                </Route>
              </Routes>
            </MemoryRouter>
          </QueryClientProvider>
        </AntApp>
      </ConfigProvider>,
    );

    await userEvent.click(await screen.findByRole('button', { name: '账户菜单' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /退出登录/u }));
    expect(await screen.findByText('登录页')).toBeVisible();
    expect(fetchMock.mock.calls.some((call) => {
      const request = call[0] as Request;
      return request.method === 'POST' && new URL(request.url).pathname === '/v1/auth/logout';
    })).toBe(true);
  });
});
