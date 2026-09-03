import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { sessionQueryKey } from '../app';
import type { WorkItem } from '../api/client';
import type { WorkspaceContextValue } from './workspace-context';
import { WorkspaceContext } from './workspace-context';
import { isWorkItemSubmissionPending } from './work-item-presentation';
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
const projectId = '04fdc61c-6405-4c30-a28a-ad2f36bdc115';
const projectMembershipId = '3a8805cc-b359-4418-85e4-f1355fac71e6';
const agentProjectMembershipId = '6c55d2e6-5c3f-4eb1-b8f2-e0b8d8cb4b27';

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

describe('Conversation message stream', () => {
  it('marks a submission as pending only while its WorkItem is open', () => {
    const currentSubmission = {} as NonNullable<WorkItem['currentSubmission']>;
    expect(isWorkItemSubmissionPending({ lifecycleStatus: 'open', currentSubmission })).toBe(true);
    expect(isWorkItemSubmissionPending({ lifecycleStatus: 'completed', currentSubmission })).toBe(false);
  });

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
        scopeMembershipId: humanMembershipId,
        workspaceMembershipId: humanMembershipId,
        projectMembershipId: null,
        actorId: humanId,
        actorType: 'human',
        displayName: 'Alice',
        joinedAt: 1,
      },
      {
        scopeMembershipId: agentMembershipId,
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
    const agentMessageId = '1b9a728e-1bd3-4037-97c9-783ee98c8e88';
    let replyPayload: unknown;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      const path = new URL(request.url).pathname;
      if (path === `/v1/conversations/${conversationId}`) return json({
        id: conversationId,
        workspaceId,
        kind: 'dm',
        visibility: 'private',
        scope: { type: 'direct_message' },
        accessMode: 'content',
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
          scopeMembershipId: humanMembershipId,
          workspaceMembershipId: humanMembershipId,
          projectMembershipId: null,
          actorId: humanId,
          actorType: 'human',
          displayName: 'Alice',
          addedAt: 1,
        },
        {
          scopeMembershipId: agentMembershipId,
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
          threadId: null, threadRootMessageId: null, replyToMessageId: null, authorActorId: humanId,
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
          id: agentMessageId, workspaceId, conversationId,
          threadId: null, threadRootMessageId: null, replyToMessageId: null, authorActorId: agentId,
          authorMembershipId: agentMembershipId, authorActorType: 'agent', authorDisplayName: 'Researcher', authorDeleted: true,
          body: '你好，我已经收到。', conversationVersion: 2, scopePosition: 2,
          producingRunId: '654cf224-17d0-4f05-b6ad-c98551edcb0d',
          producingAttemptId: '33be16f3-0e66-40c6-bd70-fd5616059ba5',
          mentionOutcomes: [], createdAt: 3,
        },
        {
          id: '3f80fa22-628c-4c6c-b3b5-6f9bf0cc1dc8', workspaceId, conversationId,
          threadId: 'fe93204e-2d67-4d05-b8a2-d91b2f2f2681', threadRootMessageId: agentMessageId,
          replyToMessageId: agentMessageId,
          authorActorId: humanId, authorMembershipId: humanMembershipId,
          authorActorType: 'human', authorDisplayName: 'Alice', authorDeleted: false,
          body: '@Researcher 补充背景', conversationVersion: 3, scopePosition: 1,
          producingRunId: null, producingAttemptId: null,
          mentions: [{ actorId: agentId, actorType: 'agent', displayName: 'Researcher' }],
          mentionOutcomes: [], artifactReferences: [], createdAt: 4,
        },
      ], nextCursor: null });
      if (path === `/v1/messages/${agentMessageId}/replies` && request.method === 'POST') {
        replyPayload = await request.clone().json();
        return json({
          id: 'd46c6a4d-4f62-4b58-ae69-8dd65a3d518e', workspaceId, conversationId,
          threadId: 'fe93204e-2d67-4d05-b8a2-d91b2f2f2681', threadRootMessageId: agentMessageId,
          replyToMessageId: agentMessageId,
          authorActorId: humanId, authorMembershipId: humanMembershipId,
          authorActorType: 'human', authorDisplayName: 'Alice', authorDeleted: false,
          body: '@Researcher 请继续', conversationVersion: 4, scopePosition: 2,
          producingRunId: null, producingAttemptId: null,
          mentions: [{ actorId: agentId, actorType: 'agent', displayName: 'Researcher' }],
          mentionOutcomes: [], artifactReferences: [], createdAt: 5,
        });
      }
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
    const replyReference = await screen.findByLabelText('引用 Researcher 的消息');
    expect(within(replyReference).getByText('@Researcher')).toBeVisible();
    expect(within(replyReference).getByText('你好，我已经收到。')).toBeVisible();
    expect(screen.getAllByText('你好，我已经收到。')).toHaveLength(2);
    expect(await screen.findByText('@Researcher 补充背景')).toBeVisible();
    expect(screen.queryByText('1 条回复')).not.toBeInTheDocument();
    expect(screen.getByText('已删除')).toBeVisible();
    expect(screen.queryByText('requested')).not.toBeInTheDocument();
    expect(screen.queryByText('pending')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '取消请求' })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some((call) => new URL((call[0] as Request).url).pathname.endsWith('/agent-requests'))).toBe(false);
    expect(screen.getByPlaceholderText('写下消息，点击 + 添加内容')).toBeVisible();
    expect(screen.queryByText('无需 @')).not.toBeInTheDocument();

    await userEvent.click(within(document.querySelector(`#message-${agentMessageId}`) as HTMLElement).getByRole('button', { name: '回复' }));
    const replyInput = screen.getByPlaceholderText('回复 @Researcher…');
    await userEvent.type(replyInput, '请继续{enter}');
    await waitFor(() => expect(replyPayload).toEqual({
      body: '@Researcher 请继续',
      mentionedActorIds: [agentId],
    }));
  });

  it('prompts project admins to join a private Channel without loading its content', async () => {
    const participantMembershipId = 'c4d7919e-e98d-42d2-b003-c72fa60eb2cf';
    const participantHumanId = '62a33b10-d221-4dd4-91bb-d15e84cf92a9';
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      const path = new URL(request.url).pathname;
      if (path === `/v1/conversations/${conversationId}`) return json({
        id: conversationId,
        workspaceId,
        projectId,
        kind: 'channel',
        visibility: 'private',
        scope: { type: 'project_group', projectId, membershipMode: 'explicit' },
        accessMode: 'governance',
        title: 'Leadership',
        lifecycleStatus: 'active',
        revision: 2,
        archivedAt: null,
        archivedByMembershipId: null,
        contextVersion: 4,
        timelineFrontier: 3,
        createdByMembershipId: humanMembershipId,
        createdByProjectMembershipId: projectMembershipId,
        createdAt: 1,
        updatedAt: 4,
      });
      if (path === `/v1/conversations/${conversationId}/participants`) return json({ items: [{
        scopeMembershipId: participantMembershipId,
        workspaceMembershipId: participantMembershipId,
        projectMembershipId: participantMembershipId,
        actorId: participantHumanId,
        actorType: 'human',
        displayName: 'Bob',
        joinedAt: 2,
      }] });
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
      members: [
        {
          membershipId: humanMembershipId, actorId: humanId, actorType: 'human', displayName: 'Alice',
          membershipRole: 'owner', revision: 1, joinedAt: 1,
        },
        {
          membershipId: participantMembershipId, actorId: participantHumanId, actorType: 'human', displayName: 'Bob',
          membershipRole: 'member', revision: 1, joinedAt: 2,
        },
      ],
      agents: [],
      conversations: [],
      projects: [],
      project: {
        id: projectId, workspaceId, name: 'Leadership', description: null,
        revision: 1, contextVersion: 1, membershipId: projectMembershipId,
        role: 'owner', governanceOnly: false, activeMemberCount: 2, conversationCount: 1,
        createdByMembershipId: humanMembershipId,
        createdAt: 1, updatedAt: 1,
      },
      projectMembers: [{
        projectMembershipId: participantMembershipId,
        workspaceMembershipId: participantMembershipId,
        actorId: participantHumanId,
        actorType: 'human',
        displayName: 'Bob',
        role: 'member',
        sponsoredByProjectMembershipId: null,
        revision: 1,
        joinedAt: 2,
      }],
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

    expect(await screen.findByText('请先加入这个会话')).toBeVisible();
    expect(screen.getByText('把自己加入成员后即可访问完整历史。')).toBeVisible();
    expect(screen.queryByText(/治理权限|不能读取消息、搜索内容、接收频道变更或运行 Agent/)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/发送消息/)).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some((call) => new URL((call[0] as Request).url).pathname.endsWith('/messages'))).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: /加入会话/ }));
    const participantDialog = await screen.findByRole('dialog', { name: '会话成员' });
    expect(within(participantDialog).getByRole('combobox', { name: '添加参与者' })).toBeInTheDocument();
    expect(within(participantDialog).getByText('Bob')).toBeInTheDocument();
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
        kind: 'dm', visibility: 'private', accessMode: 'content',
        scope: { type: 'direct_message' },
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
          scopeMembershipId: humanMembershipId,
          workspaceMembershipId: humanMembershipId,
          projectMembershipId: null,
          actorId: humanId,
          actorType: 'human',
          displayName: 'Alice',
          addedAt: 1,
        },
        {
          scopeMembershipId: '88bd7409-4b97-4abc-bcec-bca46c7d635c',
          workspaceMembershipId: '88bd7409-4b97-4abc-bcec-bca46c7d635c',
          projectMembershipId: null,
          actorId: '66eb52a8-9902-46d8-bfc5-63b6a11ce658',
          actorType: 'human',
          displayName: 'Bob',
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
    const popconfirm = (await screen.findByText('归档这个会话？')).closest('.ant-popover');
    expect(popconfirm).not.toBeNull();
    await userEvent.click(within(popconfirm as HTMLElement).getAllByRole('button').at(-1)!);
    expect(await screen.findByText('该会话已归档')).toBeVisible();
    expect(screen.queryByPlaceholderText('写下消息，输入 @ 提及成员，点击 + 添加内容')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some((call) => {
      const request = call[0] as Request;
      return request.method === 'POST' && new URL(request.url).pathname.endsWith('/archive');
    })).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: /恢复/u }));
    expect(await screen.findByPlaceholderText('写下消息，输入 @ 提及成员，点击 + 添加内容')).toBeVisible();
    expect(screen.queryByText('该会话已归档')).not.toBeInTheDocument();
  });

  it('creates a task from the composer and assigns selected Agents automatically', async () => {
    const sourceMessageId = '0a12c9e6-5893-4f05-85bf-ec17b89bc20a';
    const messagePayloads: unknown[] = [];
    const createPayloads: unknown[] = [];
    const taskMessages: Array<{ id: string; body: string; workItemReferences: Array<Record<string, unknown>> }> = [];
    const taskWorkItems: Array<Record<string, unknown>> = [];
    const taskComments = new Map<string, Array<Record<string, unknown>>>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      const path = new URL(request.url).pathname;
      if (path === `/v1/conversations/${conversationId}`) return json({
        id: conversationId,
        workspaceId,
        projectId,
        kind: 'channel',
        visibility: 'public',
        scope: { type: 'project_group', projectId, membershipMode: 'project_all' },
        accessMode: 'content',
        title: 'Launch',
        lifecycleStatus: 'active',
        revision: 1,
        archivedAt: null,
        archivedByMembershipId: null,
        contextVersion: 1,
        timelineFrontier: 1,
        createdByMembershipId: humanMembershipId,
        createdByProjectMembershipId: projectMembershipId,
        createdAt: 1,
        updatedAt: 2,
      });
      if (path === `/v1/conversations/${conversationId}/participants`) return json({ items: [
        {
          scopeMembershipId: projectMembershipId,
          workspaceMembershipId: humanMembershipId,
          projectMembershipId,
          actorId: humanId,
          actorType: 'human',
          displayName: 'Alice',
          joinedAt: 1,
        },
        {
          scopeMembershipId: agentProjectMembershipId,
          workspaceMembershipId: agentMembershipId,
          projectMembershipId: agentProjectMembershipId,
          actorId: agentId,
          actorType: 'agent',
          displayName: 'Builder',
          joinedAt: 1,
        },
      ] });
      if (path === `/v1/conversations/${conversationId}/messages` && request.method === 'POST') {
        const payload = await request.clone().json() as { body: string };
        messagePayloads.push(payload);
        const id = `task-message-${taskMessages.length + 1}`;
        taskMessages.push({ id, body: payload.body, workItemReferences: [] });
        return json({ id });
      }
      if (path === `/v1/conversations/${conversationId}/messages` && request.method === 'GET') return json({ items: [
        {
          id: sourceMessageId,
          workspaceId,
          conversationId,
          projectId,
          threadId: null,
          threadRootMessageId: null,
          replyToMessageId: null,
          authorActorId: humanId,
          authorMembershipId: humanMembershipId,
          authorProjectMembershipId: projectMembershipId,
          authorActorType: 'human',
          authorDisplayName: 'Alice',
          authorDeleted: false,
          body: '@Builder 完成发布前检查',
          conversationVersion: 1,
          scopePosition: 1,
          producingRunId: null,
          producingAttemptId: null,
          mentions: [{ actorId: agentId, actorType: 'agent', displayName: 'Builder' }],
          mentionOutcomes: [],
          artifactReferences: [],
          workItemReferences: [],
          createdAt: 2,
        },
        ...taskMessages.map((taskMessage, index) => ({
          id: taskMessage.id,
          workspaceId,
          conversationId,
          projectId,
          threadId: null,
          threadRootMessageId: null,
          replyToMessageId: null,
          authorActorId: humanId,
          authorMembershipId: humanMembershipId,
          authorProjectMembershipId: projectMembershipId,
          authorActorType: 'human',
          authorDisplayName: 'Alice',
          authorDeleted: false,
          body: taskMessage.body,
          conversationVersion: index + 2,
          scopePosition: index + 2,
          producingRunId: null,
          producingAttemptId: null,
          mentions: [],
          mentionOutcomes: [],
          artifactReferences: [],
          workItemReferences: taskMessage.workItemReferences,
          createdAt: index + 3,
        })),
      ], nextCursor: null });
      if (path === `/v1/workspaces/${workspaceId}/artifacts`) return json({ items: [] });
      if (path.startsWith('/v1/messages/') && path.endsWith('/work-item') && request.method === 'POST') {
        const payload = await request.clone().json();
        createPayloads.push(payload);
        const assigned = createPayloads.length === 1;
        const workItemId = `work-item-${createPayloads.length}`;
        const sourceMessage = taskMessages.find((taskMessage) => path === `/v1/messages/${taskMessage.id}/work-item`);
        const taskReference = {
          workItemId,
          taskNumber: createPayloads.length,
          description: assigned ? '完成发布前检查' : '纯待办任务',
        };
        taskComments.set(workItemId, []);
        const workItem = {
          id: workItemId,
          workspaceId,
          projectId,
          taskNumber: createPayloads.length,
          description: assigned ? '完成发布前检查' : '纯待办任务',
          relatedWorkItemReferences: [],
          sourceConversationId: null,
          sourceMessageId: sourceMessage?.id ?? null,
          sourceThreadId: null,
          lifecycleStatus: 'open',
          blockerReason: null,
          cancellationReason: null,
          assignee: assigned ? {
              projectMembershipId: agentProjectMembershipId,
              workspaceMembershipId: agentMembershipId,
              actorId: agentId,
              actorType: 'agent',
              displayName: 'Builder',
            } : null,
          assignees: assigned ? [{
              projectMembershipId: agentProjectMembershipId,
              workspaceMembershipId: agentMembershipId,
              actorId: agentId,
              actorType: 'agent',
              displayName: 'Builder',
            }] : [],
          currentSubmission: null,
          assignmentRevision: 1,
          commentFrontier: 0,
          revision: 1,
          createdByMembershipId: humanMembershipId,
          createdByProjectMembershipId: projectMembershipId,
          createdByDisplayName: 'Alice',
          createdAt: 1,
          updatedAt: 2,
          completedAt: null,
          cancelledAt: null,
        };
        taskWorkItems.push(workItem);
        return json(workItem, 201);
      }
      const taskCommentMatch = path.match(new RegExp(`^/v1/work-items/([^/]+)/comments$`, 'u'));
      if (taskCommentMatch && request.method === 'GET') return json({ items: taskComments.get(taskCommentMatch[1]!) ?? [] });
      if (taskCommentMatch && request.method === 'POST') {
        const payload = await request.clone().json() as { body: string; mentionedActorIds?: string[] };
        const items = taskComments.get(taskCommentMatch[1]!) ?? [];
        const comment = {
          id: `task-comment-${items.length + 1}`,
          workspaceId,
          projectId,
          workItemId: taskCommentMatch[1]!,
          authorActorId: humanId,
          authorMembershipId: humanMembershipId,
          authorProjectMembershipId: projectMembershipId,
          authorActorType: 'human',
          authorDisplayName: 'Alice',
          body: payload.body,
          mentionedActorIds: payload.mentionedActorIds ?? [],
          position: items.length + 1,
          createdAt: 4,
        };
        items.push(comment);
        taskComments.set(taskCommentMatch[1]!, items);
        return json(comment, 201);
      }
      if (path === `/v1/projects/${projectId}/work-items`) return json({ items: taskWorkItems });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(sessionQueryKey, { id: humanId, displayName: 'Alice', verifiedEmail: 'alice@example.com' });
    const context: WorkspaceContextValue = {
      workspace: {
        id: workspaceId, name: 'Product', revision: 1, contextVersion: 1,
        membershipId: humanMembershipId, membershipRole: 'owner', createdAt: 1, updatedAt: 1,
      },
      members: [],
      agents: [],
      conversations: [],
      projects: [],
      project: {
        id: projectId, workspaceId, name: 'Launch', description: null,
        revision: 1, contextVersion: 1, membershipId: projectMembershipId,
        role: 'owner', governanceOnly: false, activeMemberCount: 2, conversationCount: 1,
        createdByMembershipId: humanMembershipId,
        createdAt: 1, updatedAt: 1,
      },
      projectMembers: [{
        projectMembershipId: agentProjectMembershipId,
        workspaceMembershipId: agentMembershipId,
        actorId: agentId,
        actorType: 'agent',
        displayName: 'Builder',
        role: 'member',
        sponsoredByProjectMembershipId: projectMembershipId,
        revision: 1,
        joinedAt: 1,
      }],
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
              <MemoryRouter initialEntries={[`/w/${workspaceId}/p/${projectId}/c/${conversationId}?messageId=${sourceMessageId}`]}>
                <Routes><Route path="/w/:workspaceId/p/:projectId/c/:conversationId" element={<ConversationPage />} /></Routes>
              </MemoryRouter>
            </WorkspaceContext.Provider>
          </QueryClientProvider>
        </AntApp>
      </ConfigProvider>,
    );

    const source = await screen.findByText('@Builder 完成发布前检查');
    expect(source.closest(`#message-${sourceMessageId}`)).toHaveClass('message-source-highlight');
    const input = screen.getByPlaceholderText('写下消息，输入 @ 提及成员，点击 + 添加内容');
    await userEvent.type(input, '@Builder');
    const mentionOption = (await screen.findAllByText('@Builder'))[0]!;
    await userEvent.click(mentionOption.closest('button')!);
    await userEvent.type(input, '完成发布前检查');
    expect(screen.queryByRole('button', { name: '创建任务' })).not.toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: '添加内容' })[0]!);
    await userEvent.click(await screen.findByText('创建任务', { selector: '.ant-dropdown-menu-title-content' }));
    expect(screen.getByRole('status')).toHaveTextContent('提交后会创建任务；@Agent 会自动成为负责人，否则进入待处理。');
    expect(createPayloads).toHaveLength(0);
    await userEvent.type(input, '{enter}');
    await waitFor(() => expect(createPayloads[0]).toEqual({
      description: '完成发布前检查',
      assigneeProjectMembershipIds: [agentProjectMembershipId],
    }));
    expect(messagePayloads[0]).toEqual({ body: '@Builder 完成发布前检查', mentionedActorIds: [agentId] });
    const taskMentionLink = await screen.findByRole('link', { name: /打开任务 #1/u });
    expect(taskMentionLink).toHaveAttribute(
      'href',
      `/w/${workspaceId}/p/${projectId}/work-items?workItemId=work-item-1`,
    );
    const taskMessage = document.querySelector('#message-task-message-1');
    const taskCard = taskMessage?.querySelector('.message-task-card');
    expect(taskCard).toBeInTheDocument();
    expect(taskMessage?.querySelector('.message-content')?.textContent).toContain('@task#1');
    expect(taskMessage?.querySelector('.message-task-comment-button')).not.toBeInTheDocument();
    const taskCommentButton = within(taskCard as HTMLElement).getByRole('button', { name: '打开任务 #1 评论' });
    expect(taskCommentButton).toBeVisible();
    await userEvent.click(taskCommentButton);
    expect(await screen.findByText('还没有评论')).toBeVisible();
    const taskCommentInput = screen.getByPlaceholderText('写下评论，输入 @ 提及成员');
    await userEvent.type(taskCommentInput, '补充验收标准{enter}');
    expect(await screen.findByText('补充验收标准')).toBeVisible();

    await userEvent.type(input, '纯待办任务');
    await userEvent.click(screen.getAllByRole('button', { name: '添加内容' })[0]!);
    await userEvent.click(await screen.findByText('创建任务', { selector: '.ant-dropdown-menu-title-content' }));
    await userEvent.type(input, '{enter}');
    await waitFor(() => expect(createPayloads[1]).toEqual({
      description: '纯待办任务',
      assigneeProjectMembershipIds: [],
    }));
  });
});
