import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { sessionQueryKey } from '../app';
import type { WorkspaceContextValue } from './workspace-context';
import { WorkspaceContext } from './workspace-context';
import {
  activeMentionQuery,
  ConversationPage,
  filterMentionableParticipants,
  removeActiveMention,
} from './ConversationPage';

afterEach(() => vi.unstubAllGlobals());

const workspaceId = '6c07fe76-1237-4998-8250-d20c61e90024';
const conversationId = 'ce601f89-f5d1-42de-a705-82c354354e31';
const humanId = 'f37845d6-44ac-4e0a-a00b-85e56a8a7849';
const humanMembershipId = '5f9195bf-903d-480d-90eb-5404dc4eefb4';
const agentId = '8101135d-2a4a-480e-b14e-5d3f58d217b4';
const agentMembershipId = '25854b59-7b4a-456a-b6ab-c5ea189fbd2a';

function json(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('Conversation message stream', () => {
  it('keeps @ editable until a mention target is selected', () => {
    expect(activeMentionQuery('@')).toBe('');
    expect(activeMentionQuery('请看 @Res')).toBe('Res');
    expect(activeMentionQuery('请看 ')).toBeNull();
    expect(activeMentionQuery('alice@example.com')).toBeNull();
    expect(removeActiveMention('请看 @Researcher')).toBe('请看');
  });

  it('excludes the current Human from mention candidates while retaining Agents', () => {
    const candidates = filterMentionableParticipants([
      {
        workspaceMembershipId: humanMembershipId,
        projectMembershipId: null,
        actorId: humanId,
        actorType: 'human',
        displayName: 'Alice',
        joinedAt: 1,
      },
      {
        workspaceMembershipId: agentMembershipId,
        projectMembershipId: null,
        actorId: agentId,
        actorType: 'agent',
        displayName: 'Researcher',
        joinedAt: 1,
      },
    ], humanId);

    expect(candidates.map((participant) => participant.actorId)).toEqual([agentId]);
  });

  it('shows Agent DM messages as ordinary messages without redundant @ guidance', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      const path = new URL(request.url).pathname;
      if (path === `/v1/conversations/${conversationId}`) return json({
        id: conversationId,
        workspaceId,
        kind: 'dm',
        title: null,
        projectId: null,
        lifecycleStatus: 'active',
        revision: 1,
        archivedAt: null,
        archivedByMembershipId: null,
        contextVersion: 3,
        timelineFrontier: 2,
        createdByMembershipId: humanMembershipId,
        createdAt: 1,
        updatedAt: 3,
      });
      if (path === `/v1/conversations/${conversationId}/participants`) return json({ items: [
        {
          workspaceMembershipId: humanMembershipId,
          projectMembershipId: null,
          actorId: humanId,
          actorType: 'human',
          displayName: 'Alice',
          addedAt: 1,
        },
        {
          workspaceMembershipId: agentMembershipId,
          projectMembershipId: null,
          actorId: agentId,
          actorType: 'agent',
          displayName: 'Researcher',
          addedAt: 1,
        },
      ] });
      if (path === `/v1/conversations/${conversationId}/messages`) return json({ items: [
        {
          id: 'ef873138-489a-46eb-b69c-f63784f9f9b5', workspaceId, conversationId,
          threadId: null, threadRootMessageId: null, authorActorId: humanId,
          authorMembershipId: humanMembershipId, authorActorType: 'human', authorDisplayName: 'Alice', authorDeleted: false,
          body: '@Researcher 你好', conversationVersion: 1, scopePosition: 1,
          producingRunId: null, producingAttemptId: null,
          mentionOutcomes: [{
            id: 'dc0ab6f2-a95b-4185-bdf8-f2a31fca55ad', targetReference: agentId,
            targetAgentId: agentId, outcome: 'requested', agentRequestId: '063439d7-5c06-4b3b-8815-5abae55c937d', reason: null,
          }],
          createdAt: 2,
        },
        {
          id: '1b9a728e-1bd3-4037-97c9-783ee98c8e88', workspaceId, conversationId,
          threadId: null, threadRootMessageId: null, authorActorId: agentId,
          authorMembershipId: agentMembershipId, authorActorType: 'agent', authorDisplayName: 'Researcher', authorDeleted: true,
          body: '你好，我已经收到。', conversationVersion: 2, scopePosition: 2,
          producingRunId: '654cf224-17d0-4f05-b6ad-c98551edcb0d',
          producingAttemptId: '33be16f3-0e66-40c6-bd70-fd5616059ba5',
          mentionOutcomes: [], createdAt: 3,
        },
      ], nextCursor: null });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(sessionQueryKey, { id: humanId, displayName: 'Alice', verifiedEmail: 'alice@example.com' });
    const context: WorkspaceContextValue = {
      workspace: {
        id: workspaceId, name: 'Product', revision: 1, contextVersion: 3,
        membershipId: humanMembershipId, membershipRole: 'owner', createdAt: 1, updatedAt: 1,
      },
      members: [],
      agents: [{
        id: agentId, workspaceId, createdByHumanId: humanId,
        ownerMembershipId: humanMembershipId, ownerHumanId: humanId, ownerDisplayName: 'Alice',
        name: 'Researcher', description: null,
        lifecycleStatus: 'active', revision: 1, membershipId: agentMembershipId, membershipStatus: 'active',
        executionPolicyVersion: 1, runtimeBinding: null, createdAt: 1, updatedAt: 1,
      }],
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

    render(
      <ConfigProvider>
        <AntApp>
          <QueryClientProvider client={queryClient}>
            <WorkspaceContext.Provider value={context}>
              <MemoryRouter initialEntries={[`/w/${workspaceId}/c/${conversationId}`]}>
                <Routes><Route path="/w/:workspaceId/c/:conversationId" element={<ConversationPage />} /></Routes>
              </MemoryRouter>
            </WorkspaceContext.Provider>
          </QueryClientProvider>
        </AntApp>
      </ConfigProvider>,
    );

    expect(await screen.findByText('@Researcher 你好')).toBeVisible();
    expect(await screen.findByText('你好，我已经收到。')).toBeVisible();
    expect(screen.getByText('已删除')).toBeVisible();
    expect(screen.queryByText('requested')).not.toBeInTheDocument();
    expect(screen.queryByText('pending')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '取消请求' })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some((call) => new URL((call[0] as Request).url).pathname.endsWith('/agent-requests'))).toBe(false);
    expect(screen.getByPlaceholderText('发送消息；点击 + 添加内容')).toBeVisible();
    expect(screen.queryByText('无需 @')).not.toBeInTheDocument();
  });

  it('archives and restores from the header while keeping archived history read-only', async () => {
    let lifecycleStatus: 'active' | 'archived' = 'active';
    let revision = 1;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      const path = new URL(request.url).pathname;
      const conversation = {
        id: conversationId,
        workspaceId,
        projectId: null,
        kind: 'channel',
        title: 'Lifecycle',
        lifecycleStatus,
        revision,
        archivedAt: lifecycleStatus === 'archived' ? 4 : null,
        archivedByMembershipId: lifecycleStatus === 'archived' ? humanMembershipId : null,
        contextVersion: revision,
        timelineFrontier: 0,
        createdByMembershipId: humanMembershipId,
        createdByProjectMembershipId: null,
        createdAt: 1,
        updatedAt: revision,
      };
      if (path === `/v1/conversations/${conversationId}` && request.method === 'GET') return json(conversation);
      if (path === `/v1/conversations/${conversationId}/archive` && request.method === 'POST') {
        lifecycleStatus = 'archived';
        revision = 2;
        return json({ ...conversation, lifecycleStatus, revision, archivedAt: 4, archivedByMembershipId: humanMembershipId });
      }
      if (path === `/v1/conversations/${conversationId}/restore` && request.method === 'POST') {
        lifecycleStatus = 'active';
        revision = 3;
        return json({ ...conversation, lifecycleStatus, revision, archivedAt: null, archivedByMembershipId: null });
      }
      if (path === `/v1/conversations/${conversationId}/participants`) return json({ items: [
        {
          workspaceMembershipId: humanMembershipId,
          projectMembershipId: null,
          actorId: humanId,
          actorType: 'human',
          displayName: 'Alice',
          addedAt: 1,
        },
      ] });
      if (path === `/v1/conversations/${conversationId}/messages`) return json({ items: [], nextCursor: null });
      if (path === `/v1/workspaces/${workspaceId}/artifacts`) return json({ items: [] });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(sessionQueryKey, { id: humanId, displayName: 'Alice', verifiedEmail: 'alice@example.com' });
    const context: WorkspaceContextValue = {
      workspace: {
        id: workspaceId, name: 'Product', revision: 1, contextVersion: 3,
        membershipId: humanMembershipId, membershipRole: 'owner', createdAt: 1, updatedAt: 1,
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
    };

    render(
      <ConfigProvider>
        <AntApp>
          <QueryClientProvider client={queryClient}>
            <WorkspaceContext.Provider value={context}>
              <MemoryRouter initialEntries={[`/w/${workspaceId}/c/${conversationId}`]}>
                <Routes><Route path="/w/:workspaceId/c/:conversationId" element={<ConversationPage />} /></Routes>
              </MemoryRouter>
            </WorkspaceContext.Provider>
          </QueryClientProvider>
        </AntApp>
      </ConfigProvider>,
    );

    await userEvent.click(await screen.findByRole('button', { name: /归档/u }));
    const popconfirm = (await screen.findByText('归档这个 Conversation？')).closest('.ant-popover');
    expect(popconfirm).not.toBeNull();
    await userEvent.click(within(popconfirm as HTMLElement).getAllByRole('button').at(-1)!);
    expect(await screen.findByText('该 Conversation 已归档')).toBeVisible();
    expect(screen.queryByPlaceholderText('发送消息；输入 @ 选择成员，点击 + 添加内容')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some((call) => {
      const request = call[0] as Request;
      return request.method === 'POST' && new URL(request.url).pathname.endsWith('/archive');
    })).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: /恢复/u }));
    expect(await screen.findByPlaceholderText('发送消息；输入 @ 选择成员，点击 + 添加内容')).toBeVisible();
    expect(screen.queryByText('该 Conversation 已归档')).not.toBeInTheDocument();
  });
});
