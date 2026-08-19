import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { sessionQueryKey } from '../app';
import type { Agent, Computer } from '../api/client';
import { AgentCreateModal } from './AgentCreateModal';
import { AgentDetailPage } from './AgentDetailPage';
import { WorkspaceContext, type WorkspaceContextValue } from './workspace-context';

afterEach(() => vi.unstubAllGlobals());

const workspaceId = '6c07fe76-1237-4998-8250-d20c61e90024';
const agentId = '8101135d-2a4a-480e-b14e-5d3f58d217b4';
const humanId = 'f37845d6-44ac-4e0a-a00b-85e56a8a7849';
const computerId = '2a538b11-f621-4191-8405-c5d677fde995';
const conversationId = 'f5b02113-e4b2-4be3-b0a4-174107a25a7f';
const agentRequestId = 'ce8bdedc-e03f-40ae-9528-555bc03d9a92';
const runId = 'ccf2f3ad-ae26-4e71-970a-c596b1d101f8';
const attemptId = 'ce5471f8-2035-441c-9c46-7bfcb0e8351b';
const projectId = '8b9eb173-8812-4cc3-99fd-76bf483c0f7e';
const runtimeConfiguration: NonNullable<Computer['runtimes'][number]['configuration']> = {
  models: [
    { id: 'gpt-5.6-codex', label: 'GPT-5.6 Codex', description: null, supportedReasoningEfforts: ['medium', 'high'] },
  ],
  defaultModelId: 'gpt-5.6-codex',
  reasoningEfforts: [
    { id: 'medium', label: 'Medium', description: null },
    { id: 'high', label: 'High', description: null },
  ],
  defaultReasoningEffort: 'medium',
  modes: [
    { id: 'default', label: 'Default', description: null },
    { id: 'autonomous', label: 'Autonomous', description: null },
  ],
  defaultModeId: 'default',
};
const emptySkills: Computer['runtimes'][number]['skills'] = { global: [], workspace: [] };
const runtimeBinding = {
  id: '7e76edcf-f131-40ca-933c-08a00cfefd6d',
  workspaceId,
  agentId,
  computerId,
  computerName: 'Alice Mac',
  computerConnectionStatus: 'online' as const,
  runtimeId: 'codex' as const,
  runtimeAvailability: 'ready' as const,
  detectedVersion: '0.40.0',
  runtimeCatalogRevision: 2,
  validatedRuntimeCatalogRevision: 2,
  configuration: {
    requested: { model: null, reasoningEffort: null, mode: null },
    effective: {
      model: { value: 'gpt-5.6-codex', source: 'runtime_default' as const },
      reasoningEffort: { value: 'medium' as const, source: 'runtime_default' as const },
      mode: { value: 'default', source: 'runtime_default' as const },
    },
    status: 'valid' as const,
    invalidReason: null,
  },
  bindingRevision: 1,
  createdAt: 100,
};
const agent: Agent = {
  id: agentId,
  workspaceId,
  createdByHumanId: humanId,
  ownerMembershipId: '5f9195bf-903d-480d-90eb-5404dc4eefb4',
  ownerHumanId: humanId,
  ownerDisplayName: 'Alice',
  name: 'Researcher',
  description: '负责检索和核对资料',
  lifecycleStatus: 'active',
  revision: 1,
  membershipId: '25854b59-7b4a-456a-b6ab-c5ea189fbd2a',
  membershipStatus: 'active',
  executionPolicyVersion: 1,
  runtimeBinding,
  createdAt: 100,
  updatedAt: 100,
};
const computer: Computer = {
  id: computerId,
  name: 'Alice Mac',
  status: 'active',
  connectionStatus: 'online',
  lastSeenAt: Date.now(),
  runtimeCatalogRevision: 2,
  runtimes: [
    { runtimeId: 'codex', label: 'Codex CLI', availability: 'ready', detectedVersion: '0.40.0', configuration: runtimeConfiguration, skills: emptySkills, unavailableReason: null, checkedAt: Date.now() },
    { runtimeId: 'claude', label: 'Claude Code', availability: 'unauthenticated', detectedVersion: '1.0.0', configuration: null, skills: emptySkills, unavailableReason: { code: 'unauthenticated', message: 'Claude Code 尚未登录。' }, checkedAt: Date.now() },
    { runtimeId: 'gemini', label: 'Gemini CLI', availability: 'not_installed', detectedVersion: null, configuration: null, skills: emptySkills, unavailableReason: { code: 'not_installed', message: 'Gemini CLI 未安装。' }, checkedAt: Date.now() },
    { runtimeId: 'goose', label: 'Goose', availability: 'not_installed', detectedVersion: null, configuration: null, skills: emptySkills, unavailableReason: { code: 'not_installed', message: 'Goose 未安装。' }, checkedAt: Date.now() },
    { runtimeId: 'generic-acp', label: 'Generic ACP', availability: 'adapter_missing', detectedVersion: null, configuration: null, skills: emptySkills, unavailableReason: { code: 'adapter_missing', message: 'ACP Adapter 缺失。' }, checkedAt: Date.now() },
    { runtimeId: 'hermes', label: 'Hermes Agent', availability: 'ready', detectedVersion: '0.19.0', configuration: runtimeConfiguration, skills: emptySkills, unavailableReason: null, checkedAt: Date.now() },
  ],
  createdAt: 1,
};

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function renderApp(children: React.ReactNode, queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(
    <ConfigProvider>
      <AntApp>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </AntApp>
    </ConfigProvider>,
  );
}

describe('Agent runtime flow', () => {
  it('creates an Agent with the selected Computer and ready Runtime', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      const url = new URL(request.url);
      if (url.pathname === '/v1/computers') return json({ items: [computer] });
      if (url.pathname === `/v1/workspaces/${workspaceId}/agents` && request.method === 'POST') return json(agent, 201);
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
    renderApp(
      <MemoryRouter initialEntries={[`/w/${workspaceId}/agents`]}>
        <Routes>
          <Route path="/w/:workspaceId/agents" element={<AgentCreateModal workspaceId={workspaceId} open onClose={() => undefined} />} />
          <Route path="/w/:workspaceId/agents/:agentId" element={<div>Agent 资料已打开</div>} />
        </Routes>
      </MemoryRouter>,
      queryClient,
    );

    const dialog = await screen.findByRole('dialog', { name: '创建 AGENT' });
    await waitFor(() => expect(screen.getByRole('combobox', { name: '计算机' })).toBeEnabled());
    await waitFor(() => expect(screen.getByRole('combobox', { name: /模型/ })).toBeEnabled());
    expect(screen.getByRole('combobox', { name: /推理强度/ })).toBeEnabled();
    expect(screen.getByRole('combobox', { name: /运行模式/ })).toBeEnabled();
    await userEvent.type(screen.getByRole('textbox', { name: '名称' }), 'Researcher');
    await userEvent.type(screen.getByRole('textbox', { name: /描述/ }), '负责检索和核对资料');
    const submit = screen.getByRole('button', { name: /创建 Agent/i });
    await waitFor(() => expect(submit).toBeEnabled());
    await userEvent.click(submit);

    expect(await screen.findByText('Agent 资料已打开')).toBeVisible();
    const createRequest = fetchMock.mock.calls.map((call) => call[0] as Request)
      .find((request) => request.method === 'POST' && new URL(request.url).pathname.endsWith('/agents'));
    expect(createRequest).toBeDefined();
    expect(await createRequest!.clone().json()).toEqual({
      name: 'Researcher',
      description: '负责检索和核对资料',
      runtimeBinding: { computerId, runtimeId: 'codex', model: null, reasoningEffort: null, mode: null },
    });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['workspace', workspaceId, 'agents'] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['workspace', workspaceId, 'members'] });
    expect(dialog).not.toBeInTheDocument();
  });

  it('still offers adding another Computer when every existing Computer is offline', async () => {
    const offlineComputer: Computer = { ...computer, connectionStatus: 'offline' };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      return new URL(request.url).pathname === '/v1/computers'
        ? json({ items: [offlineComputer] })
        : new Response(null, { status: 404 });
    }));

    renderApp(
      <MemoryRouter>
        <AgentCreateModal workspaceId={workspaceId} open onClose={() => undefined} />
      </MemoryRouter>,
    );

    expect(await screen.findByText('没有可用于运行 Agent 的计算机')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加计算机' })).toBeEnabled();
  });

  it('explains how to reconnect a bound Computer from the offline status', async () => {
    const offlineComputer: Computer = { ...computer, connectionStatus: 'offline' };
    const offlineAgent: Agent = {
      ...agent,
      runtimeBinding: {
        ...runtimeBinding,
        computerConnectionStatus: 'offline',
        configuration: {
          ...runtimeBinding.configuration,
          status: 'computer_offline',
          invalidReason: { code: 'computer_offline', message: 'The bound Computer is currently offline.' },
        },
      },
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      const url = new URL(request.url);
      if (url.pathname === '/v1/computers') return json({ items: [offlineComputer] });
      if (url.pathname === `/v1/workspaces/${workspaceId}/agents/${agentId}`) return json(offlineAgent);
      return new Response(null, { status: 404 });
    }));

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    queryClient.setQueryData(sessionQueryKey, { id: humanId, displayName: 'Alice', verifiedEmail: 'alice@example.com' });
    const context: WorkspaceContextValue = {
      workspace: {
        id: workspaceId,
        name: 'Product',
        revision: 1,
        contextVersion: 1,
        membershipId: '5f9195bf-903d-480d-90eb-5404dc4eefb4',
        membershipRole: 'owner',
        createdAt: 1,
        updatedAt: 1,
      },
      members: [{
        membershipId: '5f9195bf-903d-480d-90eb-5404dc4eefb4',
        actorId: humanId,
        actorType: 'human',
        displayName: 'Alice',
        membershipRole: 'owner',
        revision: 1,
        joinedAt: 1,
      }],
      agents: [offlineAgent],
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

    renderApp(
      <QueryClientProvider client={queryClient}>
        <WorkspaceContext.Provider value={context}>
          <MemoryRouter initialEntries={[`/w/${workspaceId}/agents/${agentId}`]}>
            <Routes>
              <Route path="/w/:workspaceId/agents/:agentId" element={<AgentDetailPage />} />
            </Routes>
          </MemoryRouter>
        </WorkspaceContext.Provider>
      </QueryClientProvider>,
      queryClient,
    );

    const helpButton = await screen.findByRole('button', { name: '如何让 Alice Mac 上线' });
    await userEvent.click(helpButton);

    expect(await screen.findByText('让计算机重新上线')).toBeInTheDocument();
    expect(screen.getByText('anc-computer run')).toBeInTheDocument();
    expect(screen.getByText(/保持客户端运行/)).toBeInTheDocument();
    expect(screen.getByText(/ANC_SERVER_URL and ANC_COMPUTER_TOKEN are required/)).toBeInTheDocument();
    expect(screen.getByText(/downloads\/anc-local-computer\.tgz/)).toBeInTheDocument();
  });

  it('keeps all Agent information on the profile and shows ACP returns in Activity', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      const url = new URL(request.url);
      if (url.pathname === '/v1/computers') return json({ items: [computer] });
      if (url.pathname === `/v1/workspaces/${workspaceId}/agents/${agentId}/membership` && request.method === 'DELETE') {
        return json({ agentId, membershipId: agent.membershipId, terminatedAt: Date.now() });
      }
      if (url.pathname === `/v1/workspaces/${workspaceId}/agents/${agentId}` && request.method === 'DELETE') {
        return json({ agentId, deletedAt: Date.now() });
      }
      if (url.pathname === `/v1/workspaces/${workspaceId}/agents/${agentId}`) return json(agent);
      if (url.pathname === `/v1/projects/${projectId}/conversations`) return json({ items: [{
        id: conversationId,
        workspaceId,
        projectId,
        kind: 'channel',
        title: 'all',
        contextVersion: 2,
        timelineFrontier: 2,
        createdByMembershipId: '5f9195bf-903d-480d-90eb-5404dc4eefb4',
        createdByProjectMembershipId: '3c9de04a-8ddb-4c82-924c-0c6e8a2e584e',
        createdAt: 1,
        updatedAt: 2,
      }], nextCursor: null });
      if (url.pathname === `/v1/conversations/${conversationId}/agent-requests`) return json({ items: [{
        id: agentRequestId,
        workspaceId,
        sourceMessageId: '4ac5eaaa-1036-4705-9164-c77822e767fd',
        targetAgentId: agentId,
        resultConversationId: conversationId,
        resultThreadId: null,
        status: 'accepted',
        version: 2,
        intake: null,
        terminalReason: null,
        run: {
          id: runId,
          status: 'terminal',
          outcome: 'publish',
          deadlineAt: 5_000,
          contextSnapshotId: '024f90cb-6146-4bc1-92b0-cf67c608bf25',
          policyVersion: 1,
          workspaceContextVersion: 1,
          conversationContextVersion: 1,
          triggerFrontier: { kind: 'timeline', conversationId, threadId: null, rootMessageId: null, position: 1 },
          sourceCount: 2,
          attempt: { id: attemptId, status: 'finished', failureReason: null },
        },
        createdAt: 1_000,
        updatedAt: 2_000,
        terminalAt: 2_000,
      }, {
        id: '1fd3ca0e-e128-486a-aaad-daaf1ca2a121',
        workspaceId,
        sourceMessageId: '041b729f-4865-450b-a90f-5d30802c5a03',
        targetAgentId: agentId,
        resultConversationId: conversationId,
        resultThreadId: null,
        status: 'accepted',
        version: 2,
        intake: null,
        terminalReason: null,
        run: {
          id: 'a02c61ea-48b7-4fa9-9903-f9bd4796d390',
          status: 'terminal',
          outcome: 'failed',
          deadlineAt: 6_000,
          contextSnapshotId: '2a9dbfa0-f0ba-4e43-b30c-1dc4ef9dd5d4',
          policyVersion: 1,
          workspaceContextVersion: 2,
          conversationContextVersion: 2,
          triggerFrontier: { kind: 'timeline', conversationId, threadId: null, rootMessageId: null, position: 2 },
          sourceCount: 3,
          attempt: {
            id: 'e72b8484-cbdb-4b72-a8c3-3341f79d4101',
            status: 'failed',
            failureReason: { code: 'runtime_failure', message: 'Artifact current version changed during return.' },
          },
        },
        createdAt: 2_500,
        updatedAt: 3_000,
        terminalAt: 3_000,
      }] });
      if (url.pathname === `/v1/conversations/${conversationId}/messages`) return json({ items: [{
        id: '4a30761e-e4c0-4f26-a4c3-78ba53cc259f',
        workspaceId,
        conversationId,
        threadId: null,
        threadRootMessageId: null,
        authorActorId: agentId,
        authorMembershipId: agent.membershipId,
        authorActorType: 'agent',
        authorDisplayName: 'Researcher',
        authorDeleted: false,
        body: '资料已经核对完成，结果已发送到 Conversation。',
        conversationVersion: 2,
        scopePosition: 2,
        producingRunId: runId,
        producingAttemptId: attemptId,
        mentionOutcomes: [],
        createdAt: 2_000,
      }] });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    queryClient.setQueryData(sessionQueryKey, { id: humanId, displayName: 'Alice', verifiedEmail: 'alice@example.com' });
    const openDirectMessage = vi.fn(async () => undefined);
    const context: WorkspaceContextValue = {
      workspace: {
        id: workspaceId,
        name: 'Product',
        revision: 1,
        contextVersion: 1,
        membershipId: '5f9195bf-903d-480d-90eb-5404dc4eefb4',
        membershipRole: 'owner',
        createdAt: 1,
        updatedAt: 1,
      },
      members: [{
        membershipId: '5f9195bf-903d-480d-90eb-5404dc4eefb4',
        actorId: humanId,
        actorType: 'human',
        displayName: 'Alice',
        membershipRole: 'owner',
        revision: 1,
        joinedAt: 1,
      }],
      agents: [agent],
      conversations: [],
      projects: [{
        id: projectId,
        workspaceId,
        name: 'Artifact Project',
        description: null,
        revision: 1,
        contextVersion: 1,
        membershipId: '3c9de04a-8ddb-4c82-924c-0c6e8a2e584e',
        role: 'manager',
        governanceOnly: false,
        activeMemberCount: 2,
        conversationCount: 1,
        repository: null,
        connectedComputerCount: 0,
        readyComputerCount: 0,
        workingCopySummary: 'not_connected',
        createdByMembershipId: '5f9195bf-903d-480d-90eb-5404dc4eefb4',
        createdAt: 1,
        updatedAt: 1,
      }],
      project: null,
      projectMembers: [],
      openNewProject: () => undefined,
      openNewConversation: () => undefined,
      openDirectMessage,
      openingDirectMessageMembershipId: null,
      refresh: async () => undefined,
    };

    renderApp(
      <QueryClientProvider client={queryClient}>
        <WorkspaceContext.Provider value={context}>
          <MemoryRouter initialEntries={[`/w/${workspaceId}/agents/${agentId}`]}>
            <Routes>
              <Route path="/w/:workspaceId/agents" element={<div>Agent 列表</div>} />
              <Route path="/w/:workspaceId/agents/:agentId" element={<AgentDetailPage />} />
              <Route path="/w/:workspaceId/p/:projectId/c/:conversationId" element={<div>Project Conversation 已打开</div>} />
            </Routes>
          </MemoryRouter>
        </WorkspaceContext.Provider>
      </QueryClientProvider>,
      queryClient,
    );

    expect(await screen.findAllByText('负责检索和核对资料')).toHaveLength(2);
    expect(screen.getAllByText('Alice')).toHaveLength(2);
    expect(screen.getByRole('tab', { name: '资料' })).toBeVisible();
    expect(screen.getByRole('tab', { name: '动态' })).toBeVisible();
    expect(screen.queryByRole('tab', { name: /聊天/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Skills/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: '运行环境' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: '角色与规则' })).not.toBeInTheDocument();
    expect(screen.getByText('Codex CLI')).toBeVisible();
    expect(screen.getByText(/Alice Mac · 0\.40\.0/)).toBeVisible();
    expect(screen.getByText('模型')).toBeVisible();
    expect(screen.getByText('推理强度')).toBeVisible();
    expect(screen.getByText('模式')).toBeVisible();
    expect(screen.getByText('gpt-5.6-codex（Runtime 默认）')).toBeVisible();
    expect(screen.getByText('medium（Runtime 默认）')).toBeVisible();
    expect(screen.getByText('default（Runtime 默认）')).toBeVisible();
    expect(screen.queryByRole('button', { name: '如何让 Alice Mac 上线' })).not.toBeInTheDocument();
    expect(openDirectMessage).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '停用' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /删除 Agent/ })).toBeVisible();

    await userEvent.click(screen.getByRole('tab', { name: '动态' }));
    expect(await screen.findByText('Artifact current version changed during return.')).toBeVisible();
    expect(await screen.findByText('已向 Conversation 返回 1 条消息')).toBeVisible();
    expect(screen.getByText('资料已经核对完成，结果已发送到 Conversation。')).toBeVisible();
    expect(screen.getAllByText(/#all/)).toHaveLength(2);
    await userEvent.click(screen.getAllByRole('button', { name: '查看 Conversation' })[0]!);
    expect(await screen.findByText('Project Conversation 已打开')).toBeVisible();
  });

  it('terminates active Membership and permanently deletes an Agent from one confirmation', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      const url = new URL(request.url);
      if (url.pathname === '/v1/computers') return json({ items: [] });
      if (url.pathname === `/v1/workspaces/${workspaceId}/agents/${agentId}/membership` && request.method === 'DELETE') {
        return json({ agentId, membershipId: agent.membershipId, terminatedAt: Date.now() });
      }
      if (url.pathname === `/v1/workspaces/${workspaceId}/agents/${agentId}` && request.method === 'DELETE') {
        return json({ agentId, deletedAt: Date.now() });
      }
      if (url.pathname === `/v1/workspaces/${workspaceId}/agents/${agentId}`) return json(agent);
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    queryClient.setQueryData(sessionQueryKey, { id: humanId, displayName: 'Alice', verifiedEmail: 'alice@example.com' });
    const context: WorkspaceContextValue = {
      workspace: {
        id: workspaceId, name: 'Product', revision: 1, contextVersion: 1,
        membershipId: '5f9195bf-903d-480d-90eb-5404dc4eefb4', membershipRole: 'owner', createdAt: 1, updatedAt: 1,
      },
      members: [], agents: [agent], conversations: [], projects: [], project: null, projectMembers: [],
      openNewProject: () => undefined,
      openNewConversation: () => undefined,
      openDirectMessage: async () => undefined,
      openingDirectMessageMembershipId: null,
      refresh: async () => undefined,
    };

    renderApp(
      <QueryClientProvider client={queryClient}>
        <WorkspaceContext.Provider value={context}>
          <MemoryRouter initialEntries={[`/w/${workspaceId}/agents/${agentId}`]}>
            <Routes>
              <Route path="/w/:workspaceId/agents" element={<div>Agent 列表</div>} />
              <Route path="/w/:workspaceId/agents/:agentId" element={<AgentDetailPage />} />
            </Routes>
          </MemoryRouter>
        </WorkspaceContext.Provider>
      </QueryClientProvider>,
      queryClient,
    );

    await userEvent.click(await screen.findByRole('button', { name: /删除 Agent/ }));
    const confirmation = await screen.findByRole('tooltip');
    expect(within(confirmation).getByText(/历史消息仍保留/)).toBeInTheDocument();
    await userEvent.click(within(confirmation).getByRole('button', { name: '删除 Agent' }));
    await waitFor(() => {
      const deleteCalls = fetchMock.mock.calls.map(([input]) => input as Request).filter((request) => request.method === 'DELETE');
      expect(deleteCalls.map((request) => new URL(request.url).pathname)).toEqual([
        `/v1/workspaces/${workspaceId}/agents/${agentId}/membership`,
        `/v1/workspaces/${workspaceId}/agents/${agentId}`,
      ]);
    });
    expect(await screen.findByText('Agent 列表')).toBeVisible();
  });
});
