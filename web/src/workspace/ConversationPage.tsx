import {
  CheckCircleOutlined,
  CheckSquareOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  FileOutlined,
  GlobalOutlined,
  InboxOutlined,
  ImportOutlined,
  MessageOutlined,
  LockOutlined,
  PauseCircleOutlined,
  PlusOutlined,
  RollbackOutlined,
  TeamOutlined,
  UploadOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Bubble, Sender } from '@ant-design/x';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Avatar,
  Button,
  Card,
  Dropdown,
  Empty,
  List,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import {
  api,
  errorMessage,
  type ArtifactV2,
  type Conversation,
  type Participant,
  type WorkItem,
  type WorkspaceMessage,
} from '../api/client';
import { sessionQueryKey } from '../app';
import { useWorkspace, workspaceKeys } from './workspace-context';
import { WorkItemCommentDrawer } from './WorkItemCommentDrawer';

const { Text, Title } = Typography;
type ComposerParticipant = Pick<Participant, 'actorId' | 'actorType' | 'displayName'>;

function conversationKindLabel(kind: Conversation['kind']): string {
  return kind === 'dm' ? '私聊' : '频道';
}

function formatConversationTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(timestamp);
}

function workItemLifecycleLabel(status: WorkItem['lifecycleStatus'], assigned: boolean): string {
  if (status === 'open') return assigned ? '进行中' : '待处理';
  if (status === 'blocked') return '已阻塞';
  if (status === 'completed') return '已完成';
  return '已取消';
}

function workItemLifecycleIcon(status: WorkItem['lifecycleStatus']): React.ReactNode {
  if (status === 'open') return <ClockCircleOutlined />;
  if (status === 'blocked') return <PauseCircleOutlined />;
  if (status === 'completed') return <CheckCircleOutlined />;
  return <CloseCircleOutlined />;
}

async function loadAllMessages(conversationId: string): Promise<WorkspaceMessage[]> {
  const messages: WorkspaceMessage[] = [];
  let afterVersion = 0;
  while (true) {
    const page = await api.listMessages(conversationId, afterVersion);
    messages.push(...page.items);
    if (page.items.length < 200) break;
    afterVersion = page.items.at(-1)!.conversationVersion;
  }
  return messages;
}

export function filterMentionableParticipants(
  participants: Participant[],
  currentActorId: string,
): Participant[] {
  return participants.filter((participant) => participant.actorId !== currentActorId);
}

export function activeMentionQuery(value: string): string | null {
  const match = value.match(/(?:^|\s)@([^\s@]*)$/u);
  return match ? match[1] ?? '' : null;
}

export function removeActiveMention(value: string): string {
  return value.replace(/(?:^|\s)@[^\s@]*$/u, '').trimEnd();
}

export function Composer({
  participants,
  artifacts,
  workItems,
  loading,
  creatingWorkItem = false,
  agentRequestIsImplicit = false,
  replyTarget = null,
  workItemReplyId = null,
  onCancelReply,
  onCreateWorkItem,
  onSubmitWorkItemComment,
  onSubmit,
}: {
  participants: ComposerParticipant[];
  artifacts: ArtifactV2[];
  workItems: WorkItem[];
  loading: boolean;
  creatingWorkItem?: boolean;
  agentRequestIsImplicit?: boolean;
  replyTarget?: WorkspaceMessage | null;
  workItemReplyId?: string | null;
  onCancelReply?: () => void;
  onCreateWorkItem?: (
    messageBody: string,
    taskBody: string,
    mentionedActorIds: string[],
    workItemIds: string[],
    artifactSelections: Array<{ artifactId: string; artifactVersionId: string }>,
  ) => Promise<void>;
  onSubmitWorkItemComment?: (
    workItemId: string,
    body: string,
    mentionedActorIds: string[],
    artifactSelections: Array<{ artifactId: string; artifactVersionId: string }>,
    workItemIds: string[],
  ) => Promise<void>;
  onSubmit: (
    body: string,
    mentionedActorIds: string[],
    artifactSelections: Array<{ artifactId: string; artifactVersionId: string }>,
    workItemIds: string[],
  ) => Promise<void>;
}) {
  const { workspace, project } = useWorkspace();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const [value, setValue] = useState('');
  const [selected, setSelected] = useState<ComposerParticipant[]>([]);
  const [selectedArtifacts, setSelectedArtifacts] = useState<Array<{
    artifact: ArtifactV2;
    artifactVersionId: string;
    displayName: string;
  }>>([]);
  const [selectedWorkItems, setSelectedWorkItems] = useState<WorkItem[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [taskMode, setTaskMode] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null);
  const replyAuthor = replyTarget
    ? participants.find((participant) => participant.actorId === replyTarget.authorActorId)
    : undefined;
  const effectiveSelected = !workItemReplyId && replyAuthor
    ? [replyAuthor, ...selected.filter((participant) => participant.actorId !== replyAuthor.actorId)]
    : selected;
  const mentionQuery = mentionOpen ? activeMentionQuery(value)?.toLocaleLowerCase() ?? '' : '';
  const selectable = participants.filter((participant) => (
    !effectiveSelected.some((item) => item.actorId === participant.actorId)
    && participant.displayName.toLocaleLowerCase().includes(mentionQuery)
  ));
  const availableArtifacts = artifacts.filter((artifact) => (
    !selectedArtifacts.some((item) => item.artifact.artifactId === artifact.artifactId)
    && artifact.latestVersion !== null
  ));
  const availableWorkItems = workItems.filter((item) => !selectedWorkItems.some((selectedItem) => selectedItem.id === item.id));
  const uploadArtifact = useMutation({
    mutationFn: (file: File) => {
      if (!project) throw new Error('只有项目会话可以上传 Artifact。');
      return api.publishArtifactV2(project.id, file);
    },
    onSuccess: async (result) => {
      setSelectedArtifacts((items) => [...items, {
        artifact: result.artifact,
        artifactVersionId: result.version.versionId,
        displayName: `v${result.version.version}`,
      }]);
      if (project) await queryClient.invalidateQueries({ queryKey: workspaceKeys.projectArtifacts(project.id) });
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const artifactMenuItems = availableArtifacts.map((artifact) => ({
    key: `artifact:${artifact.artifactId}:${artifact.latestVersion!.versionId}`,
    icon: <FileOutlined />,
    label: (
      <span className="composer-attachment-menu-copy">
        <strong>{artifact.name}</strong>
        <small>v{artifact.latestVersion!.version} · {artifact.latestVersion!.fileName}</small>
      </span>
    ),
  }));
  const workItemMenuItems = availableWorkItems.map((item) => ({
    key: `work-item:${item.id}`,
    icon: <CheckSquareOutlined />,
    label: (
      <span className="composer-attachment-menu-copy">
        <strong>@task#{item.taskNumber}</strong>
        <small>{item.description.slice(0, 80)}</small>
      </span>
    ),
  }));
  const attachmentMenu = {
    items: [{
      type: 'group' as const,
      label: '添加内容',
      children: [
        { key: 'upload', icon: <UploadOutlined />, label: '上传 Artifact', disabled: !project },
        {
          key: 'existing-artifacts',
          icon: <ImportOutlined />,
          label: '添加已有交付物',
          children: artifactMenuItems.length
            ? artifactMenuItems
            : [{ key: 'no-artifacts', disabled: true, label: '当前没有可添加的交付物' }],
        },
        {
          key: 'work-items',
          icon: <CheckSquareOutlined />,
          label: '引用 WorkItem',
          children: workItemMenuItems.length
            ? workItemMenuItems
            : [{ key: 'no-work-items', disabled: true, label: '当前项目没有可引用的任务' }],
        },
        ...(onCreateWorkItem ? [{
          key: 'create-work-item',
          icon: <CheckSquareOutlined />,
          label: '创建任务',
          disabled: creatingWorkItem,
        }] : []),
      ],
    }],
    onClick: ({ key }: { key: string }) => {
      setMentionOpen(false);
      if (key === 'upload') uploadInput.current?.click();
      if (key === 'create-work-item') {
        setTaskMode(true);
        return;
      }
      if (key.startsWith('work-item:')) {
        const item = workItems.find((candidate) => candidate.id === key.slice('work-item:'.length));
        if (item) setSelectedWorkItems((items) => [...items, item]);
        return;
      }
      const selection = key.match(/^artifact:([^:]+):([^:]+)$/u);
      if (!selection) return;
      const artifact = artifacts.find((item) => item.artifactId === selection[1]);
      if (!artifact) return;
      setSelectedArtifacts((items) => [...items, {
        artifact,
        artifactVersionId: selection[2]!,
        displayName: `v${artifact.latestVersion?.version ?? '?'}`,
      }]);
    },
  };
  const submit = async () => {
    if (taskMode) {
      await createTask();
      return;
    }
    const body = `${effectiveSelected.map((participant) => `@${participant.displayName}`).join(' ')}${effectiveSelected.length && value.trim() ? ' ' : ''}${value.trim()}`;
    if (!body) return;
    if (workItemReplyId && onSubmitWorkItemComment) {
      try {
      await onSubmitWorkItemComment(
        workItemReplyId,
        body,
        effectiveSelected.map((participant) => participant.actorId),
        selectedArtifacts.map((item) => ({ artifactId: item.artifact.artifactId, artifactVersionId: item.artifactVersionId })),
        selectedWorkItems.map((item) => item.id),
      );
        setValue('');
        setSelected([]);
        setSelectedArtifacts([]);
        setSelectedWorkItems([]);
        setMentionOpen(false);
      } catch {
        // The mutation owns error presentation. Keep the draft so the Human can retry.
      }
      return;
    }
    try {
      await onSubmit(
        body,
        effectiveSelected.map((participant) => participant.actorId),
        selectedArtifacts.map((item) => ({
          artifactId: item.artifact.artifactId,
          artifactVersionId: item.artifactVersionId,
        })),
        selectedWorkItems.map((item) => item.id),
      );
      setValue('');
      setSelected([]);
      setSelectedArtifacts([]);
      setSelectedWorkItems([]);
      setMentionOpen(false);
    } catch {
      // The mutation owns error presentation. Keep the draft so the Human can retry.
    }
  };
  const createTask = async () => {
    const body = `${effectiveSelected.map((participant) => `@${participant.displayName}`).join(' ')}${effectiveSelected.length && value.trim() ? ' ' : ''}${value.trim()}`;
    if (!onCreateWorkItem) return;
    const taskDescription = value.trim();
    if (!taskDescription) {
      void message.warning('请输入任务内容。');
      return;
    }
    if (taskDescription.length > 10_000) {
      void message.error('任务描述最多 10000 字。');
      return;
    }
    try {
      await onCreateWorkItem(
        body,
        taskDescription,
        effectiveSelected.map((participant) => participant.actorId),
        selectedWorkItems.map((item) => item.id),
        selectedArtifacts.map((item) => ({ artifactId: item.artifact.artifactId, artifactVersionId: item.artifactVersionId })),
      );
      setValue('');
      setSelected([]);
      setSelectedArtifacts([]);
      setSelectedWorkItems([]);
      setMentionOpen(false);
      setTaskMode(false);
    } catch {
      // Keep the draft available when the server rejects the task.
    }
  };
  return (
    <div className="sender-shell">
      {replyTarget && (
        <div className="reply-context">
          <div className="reply-context-copy">
            <Text strong>{workItemReplyId ? '任务讨论' : `回复 @${replyTarget.authorDisplayName}`}</Text>
            <Text type="secondary" ellipsis>{replyTarget.body}</Text>
          </div>
          <Button type="text" size="small" onClick={onCancelReply}>取消</Button>
        </div>
      )}
      {effectiveSelected.length > 0 && (
        <div className="mention-strip">
          <Text type="secondary">提及：</Text>
          {effectiveSelected.map((participant) => (
            <Tag
              key={participant.actorId}
              color={participant.actorType === 'agent' ? 'blue' : 'default'}
              closable={participant.actorId !== replyAuthor?.actorId}
              onClose={() => setSelected((items) => items.filter((item) => item.actorId !== participant.actorId))}
            >
              @{participant.displayName}
            </Tag>
          ))}
        </div>
      )}
      {selectedArtifacts.length > 0 && (
        <div className="mention-strip">
          <Text type="secondary">已添加：</Text>
          {selectedArtifacts.map((selection) => (
            <Tag
              key={selection.artifact.artifactId}
              color="geekblue"
              closable
              onClose={() => setSelectedArtifacts((items) => items.filter((item) => item.artifact.artifactId !== selection.artifact.artifactId))}
            >
              {selection.artifact.name} · {selection.displayName}
            </Tag>
          ))}
        </div>
      )}
      {selectedWorkItems.length > 0 && (
        <div className="mention-strip">
          <Text type="secondary">任务：</Text>
          {selectedWorkItems.map((item) => (
            <Tag
              key={item.id}
              color="purple"
              closable
              onClose={() => setSelectedWorkItems((items) => items.filter((candidate) => candidate.id !== item.id))}
            >
              @task#{item.taskNumber}
            </Tag>
          ))}
        </div>
      )}
      {mentionOpen && (
        <div className="mention-picker">
          {selectable.length ? (
            <Space orientation="vertical" size={2} style={{ width: '100%' }}>
              {selectable.map((participant) => (
                <Button
                  key={participant.actorId}
                  type="text"
                  block
                  onClick={() => {
                    setSelected((items) => [...items, participant]);
                    setValue((current) => removeActiveMention(current));
                    setMentionOpen(false);
                  }}
                >
                  @{participant.displayName} <Text type="secondary">{participant.actorType === 'agent' ? 'Agent' : '成员'}</Text>
                </Button>
              ))}
            </Space>
          ) : <Text type="secondary">当前会话没有其他可提及成员。</Text>}
        </div>
      )}
      <input
        ref={uploadInput}
        className="composer-file-input"
        type="file"
        aria-label="选择要上传的交付物"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) uploadArtifact.mutate(file);
          event.target.value = '';
        }}
      />
      <Sender
        value={value}
        loading={loading}
        placeholder={workItemReplyId
          ? '写下评论，输入 @ 提及成员'
          : replyTarget
            ? `回复 @${replyTarget.authorDisplayName}…`
            : taskMode
              ? '描述任务目标，输入 @ 选择负责人'
              : agentRequestIsImplicit
                ? '写下消息，点击 + 添加内容'
                : '写下消息，输入 @ 提及成员，点击 + 添加内容'}
        autoSize={{ minRows: 1, maxRows: 8 }}
        prefix={(
          <Dropdown
            menu={attachmentMenu}
            trigger={['click']}
            placement="topLeft"
            rootClassName="composer-attachment-dropdown"
          >
            <Button
              type="text"
              aria-label="添加内容"
              loading={uploadArtifact.isPending}
              icon={<PlusOutlined />}
              onClick={() => setMentionOpen(false)}
            />
          </Dropdown>
        )}
        onChange={(next) => {
          setValue(next);
          setMentionOpen(activeMentionQuery(next) !== null);
        }}
        onSubmit={() => void submit()}
      />
      {taskMode && (
        <div className="composer-task-hint" role="status">
          <CheckSquareOutlined />
          <span className="composer-task-hint-title">创建任务</span>
          <Text type="secondary">提交后会创建任务；@Agent 会自动成为负责人，否则进入待处理。</Text>
          <Button type="text" size="small" aria-label="取消创建任务" onClick={() => setTaskMode(false)}>取消</Button>
        </div>
      )}
    </div>
  );
}

export function ConversationPage() {
  const { conversationId = '' } = useParams();
  const location = useLocation();
  const { workspace, project, members, projectMembers } = useWorkspace();
  const queryClient = useQueryClient();
  const session = queryClient.getQueryData<{ id: string }>(sessionQueryKey)!;
  const { message } = App.useApp();
  const [replyTarget, setReplyTarget] = useState<WorkspaceMessage | null>(null);
  const [replyWorkItemId, setReplyWorkItemId] = useState<string | null>(null);
  const [taskThreadMessageId, setTaskThreadMessageId] = useState<string | null>(null);
  const [taskThreadWorkItemId, setTaskThreadWorkItemId] = useState<string | null>(null);
  const [participantsOpen, setParticipantsOpen] = useState(false);

  useEffect(() => {
    setReplyTarget(null);
    setReplyWorkItemId(null);
    setTaskThreadMessageId(null);
    setTaskThreadWorkItemId(null);
  }, [conversationId]);

  const conversation = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => api.getConversation(conversationId),
  });
  const messages = useQuery({
    queryKey: ['conversation', conversationId, 'messages'],
    queryFn: () => loadAllMessages(conversationId),
    enabled: conversation.data?.accessMode === 'content',
  });
  const participants = useQuery({
    queryKey: ['conversation', conversationId, 'participants'],
    queryFn: () => api.listParticipants(conversationId).then((page) => page.items),
    enabled: conversation.isSuccess,
  });
  const artifacts = useQuery({
    queryKey: workspaceKeys.projectArtifacts(project?.id ?? ''),
    queryFn: () => api.listProjectArtifactsV2(project!.id).then((page) => page.items),
    enabled: conversation.data?.accessMode === 'content'
      && Boolean(project?.id)
      && conversation.data?.projectId === project?.id,
  });
  const workItems = useQuery({
    queryKey: project ? workspaceKeys.projectWorkItems(project.id) : ['project-work-items', 'none'],
    queryFn: () => api.listProjectWorkItems(project!.id).then((page) => page.items),
    enabled: conversation.data?.accessMode === 'content' && Boolean(project?.id)
      && conversation.data?.projectId === project?.id,
  });
  const send = useMutation({
    mutationFn: ({ body, mentionedActorIds, artifactSelections, workItemIds }: {
      body: string;
      mentionedActorIds: string[];
      artifactSelections: Array<{ artifactId: string; artifactVersionId: string }>;
      workItemIds: string[];
    }) => api.postMessage(conversationId, {
      body,
      ...(mentionedActorIds.length ? { mentionedActorIds } : {}),
      ...(artifactSelections.length ? { artifactSelections } : {}),
      ...(workItemIds.length ? { workItemIds } : {}),
    }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'messages'] }),
        queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'requests'] }),
        queryClient.invalidateQueries({ queryKey: workspaceKeys.conversations(workspace.id) }),
      ]);
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const reply = useMutation({
    mutationFn: ({ messageId, body, mentionedActorIds, artifactSelections, workItemIds }: {
      messageId: string;
      body: string;
      mentionedActorIds: string[];
      artifactSelections: Array<{ artifactId: string; artifactVersionId: string }>;
      workItemIds: string[];
    }) => api.replyToMessage(messageId, {
      body,
      ...(mentionedActorIds.length ? { mentionedActorIds } : {}),
      ...(artifactSelections.length ? { artifactSelections } : {}),
      ...(workItemIds.length ? { workItemIds } : {}),
    }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'messages'] }),
        queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'requests'] }),
      ]);
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const createWorkItem = useMutation({
    mutationFn: async ({ messageBody, taskBody, mentionedActorIds, workItemIds, artifactSelections }: {
      messageBody: string;
      taskBody: string;
      mentionedActorIds: string[];
      workItemIds: string[];
      artifactSelections: Array<{ artifactId: string; artifactVersionId: string }>;
    }) => {
      if (!project) throw new Error('当前会话不属于项目。');
      const assigneeProjectMembershipIds = projectMembers
        .filter((member) => member.actorType === 'agent' && mentionedActorIds.includes(member.actorId))
        .map((member) => member.projectMembershipId);
      const sourceMessage = await api.postMessage(conversationId, {
        body: messageBody,
        ...(mentionedActorIds.length ? { mentionedActorIds } : {}),
        ...(artifactSelections.length ? { artifactSelections } : {}),
        ...(workItemIds.length ? { workItemIds } : {}),
      });
      return api.createWorkItemFromMessage(sourceMessage.id, {
        description: taskBody,
        assigneeProjectMembershipIds,
      });
    },
    onSuccess: async (workItem) => {
      if (project) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: workspaceKeys.projectWorkItems(project.id) }),
          queryClient.invalidateQueries({ queryKey: workspaceKeys.projects(workspace.id) }),
          queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'messages'] }),
          queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'requests'] }),
        ]);
      }
      void message.success(workItem.assignees.some((assignee) => assignee.actorType === 'agent')
        ? `任务已创建，并已分配给 ${workItem.assignees.filter((assignee) => assignee.actorType === 'agent').map((assignee) => assignee.displayName).join('、')}。`
        : '任务已放入待处理。');
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const postWorkItemComment = useMutation({
    mutationFn: ({ workItemId, body, mentionedActorIds, workItemIds, artifactSelections }: {
      workItemId: string;
      body: string;
      mentionedActorIds: string[];
      workItemIds: string[];
      artifactSelections: Array<{ artifactId: string; artifactVersionId: string }>;
    }) => api.postWorkItemComment(workItemId, body, mentionedActorIds, workItemIds, artifactSelections),
    onSuccess: async (_, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['work-item', variables.workItemId, 'comments'] }),
        queryClient.invalidateQueries({ queryKey: workspaceKeys.projectWorkItems(project?.id ?? '') }),
      ]);
      setReplyTarget(null);
      setReplyWorkItemId(null);
      void message.success('任务评论已发布。');
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const lifecycle = useMutation({
    mutationFn: ({ action, revision }: { action: 'archive' | 'restore'; revision: number }) => (
      action === 'archive'
        ? api.archiveConversation(conversationId, revision)
        : api.restoreConversation(conversationId, revision)
    ),
    onSuccess: async (updated, variables) => {
      queryClient.setQueryData(['conversation', conversationId], updated);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workspaceKeys.conversations(workspace.id) }),
        queryClient.invalidateQueries({ queryKey: workspaceKeys.archivedConversations(workspace.id) }),
        ...(updated.projectId ? [
          queryClient.invalidateQueries({ queryKey: workspaceKeys.projectConversations(updated.projectId) }),
          queryClient.invalidateQueries({ queryKey: workspaceKeys.projectArchivedConversations(updated.projectId) }),
        ] : []),
      ]);
      void message.success(variables.action === 'archive' ? '会话已归档' : '会话已恢复');
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const addParticipant = useMutation({
    mutationFn: (scopeMembershipId: string) => api.addConversationParticipant(
      conversationId,
      scopeMembershipId,
      conversation.data!.revision,
    ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] }),
        queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'participants'] }),
      ]);
      void message.success('成员已添加');
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const removeParticipant = useMutation({
    mutationFn: (scopeMembershipId: string) => api.removeConversationParticipant(
      conversationId,
      scopeMembershipId,
      conversation.data!.revision,
    ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] }),
        queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'participants'] }),
        queryClient.invalidateQueries({ queryKey: workspaceKeys.conversations(workspace.id) }),
        ...(project ? [queryClient.invalidateQueries({ queryKey: workspaceKeys.projectConversations(project.id) })] : []),
      ]);
      void message.success('成员已移除');
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const messagesById = useMemo(
    () => new Map((messages.data ?? []).map((item) => [item.id, item])),
    [messages.data],
  );
  const taskComments = useQuery({
    queryKey: ['work-item', taskThreadWorkItemId, 'comments'],
    queryFn: () => api.listWorkItemComments(taskThreadWorkItemId!).then((page) => page.items),
    enabled: Boolean(taskThreadWorkItemId),
  });
  const focusedMessageId = new URLSearchParams(location.search).get('messageId');
  useEffect(() => {
    if (!focusedMessageId || !messages.data) return undefined;
    const target = document.getElementById(`message-${focusedMessageId}`);
    if (!target) return undefined;
    if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center' });
    target.classList.add('message-source-highlight');
    const timeout = window.setTimeout(() => target.classList.remove('message-source-highlight'), 2200);
    return () => window.clearTimeout(timeout);
  }, [focusedMessageId, messages.data]);
  if (conversation.isPending || participants.isPending
    || (conversation.data?.accessMode === 'content' && messages.isPending)) {
    return <div className="full-page-center"><Spin /></div>;
  }
  if (conversation.isError || participants.isError
    || (conversation.data?.accessMode === 'content' && messages.isError)) {
    return <div className="full-page-center"><Empty description={errorMessage(conversation.error || messages.error || participants.error)} /></div>;
  }
  const archived = conversation.data.lifecycleStatus === 'archived';
  const directMessageClosed = conversation.data.kind === 'dm' && participants.data.length !== 2;
  const readOnly = archived || directMessageClosed;
  const canCreateWorkItem = !readOnly
    && conversation.data.accessMode === 'content'
    && conversation.data.projectId !== null
    && project?.id === conversation.data.projectId;
  const mentionableParticipants = filterMentionableParticipants(participants.data, session.id);
  const directAgentParticipant = conversation.data.kind === 'dm'
    ? participants.data.find((participant) => participant.actorType === 'agent')
    : undefined;
  const projectGroupIsExplicit = conversation.data.scope.type === 'project_group'
    && conversation.data.scope.membershipMode === 'explicit';
  const projectAdmin = project?.role === 'owner' || project?.role === 'manager';
  const isConversationCreator = conversation.data.createdByMembershipId === workspace.membershipId;
  const canManageLifecycle = conversation.data.kind === 'dm'
    || (projectGroupIsExplicit && (projectAdmin || isConversationCreator));
  const canManageHumanAudience = projectGroupIsExplicit && (projectAdmin || isConversationCreator);
  const canManageAudience = conversation.data.kind === 'channel';
  const audienceIds = new Set(participants.data.map((participant) => participant.scopeMembershipId));
  const availableParticipants = (project
    ? projectMembers.map((member) => ({
        value: member.projectMembershipId,
        label: `${member.displayName} · ${member.actorType === 'agent' ? 'Agent' : '成员'}`,
        actorType: member.actorType,
      }))
    : members.map((member) => ({
        value: member.membershipId,
        label: `${member.displayName} · ${member.actorType === 'agent' ? 'Agent' : '成员'}`,
        actorType: member.actorType,
      })))
    .filter((option) => !audienceIds.has(option.value))
    .filter((option) => canManageHumanAudience || option.actorType === 'agent');

  const renderMessage = (item: WorkspaceMessage) => {
    const own = item.authorActorId === session.id;
    const replySource = item.replyToMessageId ? messagesById.get(item.replyToMessageId) : undefined;
    const missingMentionText = (item.mentions ?? [])
      .filter((mention) => !item.body.includes(`@${mention.displayName}`))
      .map((mention) => `@${mention.displayName}`)
      .join(' ');
    const renderedBody = missingMentionText ? `${missingMentionText} ${item.body}` : item.body;
    const taskReferences = item.workItemReferences ?? [];
    const createdTaskReferences = (workItems.data ?? [])
      .filter((task) => task.sourceMessageId === item.id)
      .map((task) => ({ workItemId: task.id, taskNumber: task.taskNumber }));
    const createdTaskIds = new Set(createdTaskReferences.map((reference) => reference.workItemId));
    const mentionedTaskReferences = taskReferences.filter((reference) => (
      !createdTaskIds.has(reference.workItemId)
    ));
    return (
      <div key={item.id} id={`message-${item.id}`}>
        <Bubble
          placement={own ? 'end' : 'start'}
          variant={item.authorActorType === 'agent' ? 'outlined' : 'filled'}
          avatar={<Avatar icon={item.authorActorType === 'agent' ? <MessageOutlined /> : <UserOutlined />} style={{ background: item.authorActorType === 'agent' ? '#eef2ff' : '#e9f8f3', color: item.authorActorType === 'agent' ? '#4f6ef7' : '#208c70' }} />}
          header={(
            <div className="message-meta">
              {item.authorDisplayName} {item.authorDeleted && <Tag bordered={false}>已删除</Tag>} ·{' '}
              {new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(item.createdAt)}
            </div>
          )}
          content={(
            <div className="message-content">
              {replySource && (
                <div
                  className="message-reply-reference"
                  aria-label={`引用 ${replySource.authorDisplayName} 的消息`}
                >
                  <Text strong>@{replySource.authorDisplayName}</Text>
                  <Text type="secondary" ellipsis>{replySource.body}</Text>
                </div>
              )}
              <div className="message-body-line">
                {renderedBody}
                {mentionedTaskReferences.length > 0 && (
                  <span className="message-task-mentions" aria-label="引用的任务">
                    {mentionedTaskReferences.map((reference) => (
                      <a
                        key={reference.workItemId}
                        className="message-task-mention"
                        href={`/w/${workspace.id}/p/${project?.id ?? item.projectId}/work-items?workItemId=${reference.workItemId}`}
                        aria-label={`打开任务 #${reference.taskNumber}`}
                      >
                        @task#{reference.taskNumber}
                      </a>
                    ))}
                  </span>
                )}
              </div>
              {createdTaskReferences.length > 0 && (
                <div className="message-task-card-list" aria-label="消息中的任务">
                  {createdTaskReferences.map((reference) => {
                    const task = workItems.data?.find((candidate) => candidate.id === reference.workItemId);
                    const taskNumber = task?.taskNumber ?? reference.taskNumber;
                    const taskHref = `/w/${workspace.id}/p/${project?.id ?? item.projectId}/work-items?workItemId=${reference.workItemId}`;
                    const relatedTaskReferences = task?.relatedWorkItemReferences ?? mentionedTaskReferences;
                    return (
                      <div className="message-task-card-row" key={`card-${reference.workItemId}`}>
                        <article className={`message-task-card ${task?.lifecycleStatus ?? 'open'}`}>
                          <a
                            className="message-task-card-link"
                            href={taskHref}
                            aria-label={`打开任务 #${taskNumber}`}
                          >
                            <div className="message-task-card-header">
                              <span className="message-task-card-label"><CheckSquareOutlined /> @task#{taskNumber}</span>
                              {task && (
                                <span className="message-task-card-status">
                                  {workItemLifecycleIcon(task.lifecycleStatus)} {workItemLifecycleLabel(task.lifecycleStatus, task.assignees.length > 0)}
                                </span>
                              )}
                            </div>
                            <strong>{task?.description ?? '任务详情加载中…'}</strong>
                            {relatedTaskReferences.length > 0 && (
                              <div className="message-task-card-related" aria-label="关联任务">
                                <span className="message-task-card-related-label">关联任务：</span>
                                {relatedTaskReferences.map((related) => (
                                  <a
                                    key={related.workItemId}
                                    className="message-task-mention"
                                    href={`/w/${workspace.id}/p/${project?.id ?? item.projectId}/work-items?workItemId=${related.workItemId}`}
                                    aria-label={`打开关联任务 #${related.taskNumber}`}
                                  >
                                    @task#{related.taskNumber}
                                  </a>
                                ))}
                              </div>
                            )}
                            {task?.blockerReason && <p className="message-task-card-reason blocked">阻塞：{task.blockerReason}</p>}
                            {task?.cancellationReason && <p className="message-task-card-reason cancelled">取消：{task.cancellationReason}</p>}
                            {task && (
                              <div className="message-task-card-meta">
                                <span className="message-task-card-person">
                                  <Avatar size={20} icon={<UserOutlined />} />
                                  <span><span className="message-task-card-person-label">发起人：</span>{task.createdByDisplayName}</span>
                                </span>
                                <span className={`message-task-card-person${task.assignees.length ? '' : ' message-task-card-unassigned'}`}>
                                  <Avatar size={20} icon={task.assignees[0]?.actorType === 'agent' ? <MessageOutlined /> : <UserOutlined />} />
                                  <span>
                                    <span className="message-task-card-person-label">负责人：</span>
                                    {task.assignees.length ? task.assignees.map((assignee) => assignee.displayName).join('、') : '未分配'}
                                  </span>
                                </span>
                              </div>
                            )}
                          </a>
                          {!readOnly && (
                            <footer className="work-item-card-footer message-task-card-footer">
                              <Button
                                type="link"
                                size="small"
                                icon={<MessageOutlined />}
                                aria-label={`打开任务 #${taskNumber} 评论`}
                                onClick={() => {
                                  setTaskThreadMessageId(item.id);
                                  setTaskThreadWorkItemId(reference.workItemId);
                                  setReplyWorkItemId(null);
                                  setReplyTarget(null);
                                }}
                              >
                                评论{task?.commentFrontier ? ` ${task.commentFrontier}` : ''}
                              </Button>
                            </footer>
                          )}
                        </article>
                      </div>
                    );
                  })}
                </div>
              )}
              {(item.artifactReferences ?? []).map((reference) => (
                <div className="message-artifact-reference" key={reference.artifactVersionId}>
                  {reference.contentAvailable ? (
                    <a href={`/v1/artifact-versions/${reference.artifactVersionId}/download`}>
                      {reference.artifactName} · v{reference.version} · {reference.fileName}
                    </a>
                  ) : (
                    <Text type="secondary">
                      {reference.artifactName} · v{reference.version} · 该版本内容已删除
                    </Text>
                  )}
                  {reference.artifactStatus !== 'active' && (
                    <Text type="secondary"> · 交付物{reference.artifactStatus === 'deleted' ? '已删除' : '已清理'}</Text>
                  )}
                </div>
              ))}
            </div>
          )}
          footer={!readOnly
            ? (
              <Button
                type="link"
                size="small"
                onClick={() => {
                  setTaskThreadMessageId(null);
                  setTaskThreadWorkItemId(null);
                  setReplyWorkItemId(null);
                  setReplyTarget(item);
                }}
              >
                回复
              </Button>
            )
            : undefined}
        />
      </div>
    );
  };

  const otherDirectParticipant = conversation.data.kind === 'dm'
    ? participants.data.find((participant) => participant.workspaceMembershipId !== workspace.membershipId)
    : undefined;
  const conversationTitle = conversation.data.title
    || (conversation.data.kind === 'dm' ? otherDirectParticipant?.displayName ?? '私聊' : '未命名会话');
  return (
    <section className="conversation-page">
      <header className="conversation-header">
        <div className="conversation-title">
          <Space size={8}>
            <Title level={3}>{conversationTitle}</Title>
            {conversation.data.kind === 'channel' && (
              <Tag icon={conversation.data.visibility === 'private' ? <LockOutlined /> : <GlobalOutlined />}>
                {conversation.data.visibility === 'private' ? '私密' : '公开'}
              </Tag>
            )}
            {archived && <Tag icon={<InboxOutlined />}>已归档</Tag>}
            {!archived && directMessageClosed && <Tag>只读</Tag>}
          </Space>
          <Text type="secondary">
            {conversationKindLabel(conversation.data.kind)} · {participants.data.length} 位成员
          </Text>
        </div>
        <Space>
          <Button icon={<TeamOutlined />} onClick={() => setParticipantsOpen(true)}>成员</Button>
          {canManageLifecycle && (archived ? (
            <Button
              icon={<RollbackOutlined />}
              loading={lifecycle.isPending}
              onClick={() => lifecycle.mutate({ action: 'restore', revision: conversation.data.revision })}
            >
              恢复
            </Button>
          ) : (
            <Popconfirm
              title="归档这个会话？"
              description="消息和执行历史会保留；归档后不能继续发送消息或请求 Agent。"
              okText="归档"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => lifecycle.mutate({ action: 'archive', revision: conversation.data.revision })}
            >
              <Button danger icon={<InboxOutlined />} loading={lifecycle.isPending}>归档</Button>
            </Popconfirm>
          ))}
        </Space>
      </header>
      <div className="conversation-messages">
        {conversation.data.accessMode === 'governance' ? (
          <div className="full-page-center">
            <Card style={{ width: 520, maxWidth: 'calc(100vw - 32px)' }}>
              <Alert
                type="info"
                showIcon
                title="请先加入这个会话"
                description="把自己加入成员后即可访问完整历史。"
              />
              <Button style={{ marginTop: 16 }} type="primary" icon={<TeamOutlined />} onClick={() => setParticipantsOpen(true)}>
                加入会话
              </Button>
            </Card>
          </div>
        ) : (messages.data ?? []).length ? (
          <div className="message-stack">{(messages.data ?? []).map((item) => renderMessage(item))}</div>
        ) : <Empty description="还没有消息，开始协作吧。" />}
      </div>
      {conversation.data.accessMode === 'content' && <div className="conversation-composer">
        {archived ? (
          <Alert
            type="info"
            showIcon
            title="该会话已归档"
            description="消息和执行历史仍可查看；恢复后才能继续发送消息或请求 Agent。"
          />
        ) : directMessageClosed ? (
          <Alert
            type="info"
            showIcon
            title="该私聊已结束"
            description="对方成员已被删除，历史消息仅供查看。"
          />
        ) : (
          <Composer
            participants={mentionableParticipants}
            artifacts={artifacts.data ?? []}
            workItems={workItems.data ?? []}
            loading={send.isPending || reply.isPending || createWorkItem.isPending || postWorkItemComment.isPending}
            creatingWorkItem={createWorkItem.isPending}
            agentRequestIsImplicit={Boolean(directAgentParticipant)}
            replyTarget={replyTarget}
            onCancelReply={() => {
              setReplyTarget(null);
              setReplyWorkItemId(null);
              setTaskThreadMessageId(null);
              setTaskThreadWorkItemId(null);
            }}
            onSubmitWorkItemComment={async (workItemId, body, mentionedActorIds, artifactSelections, workItemIds) => {
              await postWorkItemComment.mutateAsync({ workItemId, body, mentionedActorIds, artifactSelections, workItemIds });
            }}
            {...(canCreateWorkItem ? {
              onCreateWorkItem: async (
                messageBody: string,
                taskBody: string,
                mentionedActorIds: string[],
                workItemIds: string[],
                artifactSelections: Array<{ artifactId: string; artifactVersionId: string }>,
              ) => {
                await createWorkItem.mutateAsync({ messageBody, taskBody, mentionedActorIds, workItemIds, artifactSelections });
              },
            } : {})}
            onSubmit={async (body, mentionedActorIds, artifactSelections, workItemIds) => {
              if (replyTarget) {
                await reply.mutateAsync({ messageId: replyTarget.id, body, mentionedActorIds, artifactSelections, workItemIds });
                setReplyTarget(null);
                setReplyWorkItemId(null);
                return;
              }
              await send.mutateAsync({ body, mentionedActorIds, artifactSelections, workItemIds });
            }}
          />
        )}
      </div>}
      <WorkItemCommentDrawer
        open={Boolean(taskThreadWorkItemId)}
        workItem={workItems.data?.find((item) => item.id === taskThreadWorkItemId)}
        comments={taskComments.data}
        commentsPending={taskComments.isPending}
        commentsError={taskComments.error}
        workspaceId={workspace.id}
        projectId={project?.id ?? conversation.data.projectId ?? ''}
        readOnly={readOnly}
        onClose={() => {
          setTaskThreadMessageId(null);
          setTaskThreadWorkItemId(null);
          setReplyWorkItemId(null);
        }}
        onOpenTaskComments={(workItemId) => {
          setTaskThreadWorkItemId(workItemId);
          setReplyWorkItemId(null);
          setReplyTarget(null);
        }}
        composer={!readOnly && taskThreadWorkItemId ? (
          <Composer
            participants={mentionableParticipants}
            artifacts={artifacts.data ?? []}
            workItems={workItems.data ?? []}
            loading={postWorkItemComment.isPending}
            workItemReplyId={taskThreadWorkItemId}
            onCancelReply={() => {
              setTaskThreadMessageId(null);
              setTaskThreadWorkItemId(null);
              setReplyWorkItemId(null);
            }}
            onSubmitWorkItemComment={async (workItemId, body, mentionedActorIds, artifactSelections, workItemIds) => {
              await postWorkItemComment.mutateAsync({ workItemId, body, mentionedActorIds, artifactSelections, workItemIds });
            }}
            onSubmit={async () => undefined}
          />
        ) : null}
      />
      <Modal title="会话成员" open={participantsOpen} footer={null} onCancel={() => setParticipantsOpen(false)}>
        {conversation.data.kind === 'channel' && conversation.data.scope.type !== 'direct_message'
          && !projectGroupIsExplicit && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            title={project
              ? '项目成员会自动进入主群；Agent 需要由 Owner 单独加入。'
              : 'Workspace 成员会自动进入团队会话；Agent 需要由 Owner 单独加入。'}
          />
        )}
        {conversation.data.kind === 'channel' && canManageAudience && (
          <Select
            aria-label="添加参与者"
            placeholder="添加成员或 Agent"
            options={availableParticipants}
            loading={addParticipant.isPending}
            disabled={availableParticipants.length === 0}
            style={{ width: '100%', marginBottom: 16 }}
            onSelect={(scopeMembershipId: string) => addParticipant.mutate(scopeMembershipId)}
          />
        )}
        <List
          dataSource={participants.data}
          renderItem={(participant: Participant) => (
            <List.Item {...((participant.actorType === 'agent' || canManageHumanAudience) ? { actions: [
              <Popconfirm
                key="remove"
                title={`移除 ${participant.displayName}？`}
                description="移出后会立即失去完整历史、消息、变更流和 Agent 执行权限。"
                okText="移除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => removeParticipant.mutate(participant.scopeMembershipId)}
              >
                <Button
                  type="link"
                  danger
                  loading={removeParticipant.isPending && removeParticipant.variables === participant.scopeMembershipId}
                >
                  移除
                </Button>
              </Popconfirm>,
            ] } : {})}>
              <List.Item.Meta
                avatar={<Avatar icon={participant.actorType === 'agent' ? <MessageOutlined /> : <UserOutlined />} />}
                title={participant.displayName}
                description={participant.actorType === 'agent' ? 'Agent' : '成员'}
              />
            </List.Item>
          )}
        />
      </Modal>
    </section>
  );
}
