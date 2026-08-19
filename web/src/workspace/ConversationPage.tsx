import {
  FileMarkdownOutlined,
  FileOutlined,
  InboxOutlined,
  ImportOutlined,
  MessageOutlined,
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
  Dropdown,
  Empty,
  List,
  Modal,
  Popconfirm,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import { useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  api,
  errorMessage,
  type Artifact,
  type ArtifactSnapshot,
  type Participant,
  type WorkspaceMessage,
} from '../api/client';
import { sessionQueryKey } from '../app';
import { useWorkspace, workspaceKeys } from './workspace-context';

const { Text, Title } = Typography;

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

function Composer({
  participants,
  artifacts,
  loading,
  compact = false,
  agentRequestIsImplicit = false,
  onSubmit,
}: {
  participants: Participant[];
  artifacts: Artifact[];
  loading: boolean;
  compact?: boolean;
  agentRequestIsImplicit?: boolean;
  onSubmit: (
    body: string,
    mentionedActorIds: string[],
    artifactSelections: Array<{ artifactId: string; snapshotId: string | null }>,
  ) => Promise<void>;
}) {
  const { workspace, project, members } = useWorkspace();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const [value, setValue] = useState('');
  const [selected, setSelected] = useState<Participant[]>([]);
  const [selectedArtifacts, setSelectedArtifacts] = useState<Array<{
    artifact: Artifact;
    snapshotId: string | null;
    displayName: string;
  }>>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [artifactSnapshots, setArtifactSnapshots] = useState<Record<string, {
    status: 'loading' | 'loaded' | 'error';
    items: ArtifactSnapshot[];
  }>>({});
  const uploadInput = useRef<HTMLInputElement>(null);
  const loadingSnapshotIds = useRef(new Set<string>());
  const mentionQuery = mentionOpen ? activeMentionQuery(value)?.toLocaleLowerCase() ?? '' : '';
  const selectable = participants.filter((participant) => (
    !selected.some((item) => item.actorId === participant.actorId)
    && participant.displayName.toLocaleLowerCase().includes(mentionQuery)
  ));
  const availableArtifacts = artifacts.filter((artifact) => !selectedArtifacts.some((item) => item.artifact.id === artifact.id));
  const memberNames = useMemo(
    () => new Map(members.map((member) => [member.membershipId, member.displayName])),
    [members],
  );
  const memberName = (membershipId: string) => memberNames.get(membershipId) ?? `成员 ${membershipId.slice(0, 8)}`;
  const uploadFile = useMutation({
    mutationFn: (file: File) => api.createFileArtifact(
      workspace.id,
      file,
      file.name,
      project ? [project.id] : [],
    ),
    onSuccess: async (artifact) => {
      setSelectedArtifacts((items) => [...items, {
        artifact,
        snapshotId: null,
        displayName: `当前状态 · r${artifact.currentState.currentRevision}`,
      }]);
      await queryClient.invalidateQueries({ queryKey: ['workspace', workspace.id, 'artifacts'] });
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const loadArtifactSnapshots = (artifactId: string) => {
    if (artifactSnapshots[artifactId] || loadingSnapshotIds.current.has(artifactId)) return;
    loadingSnapshotIds.current.add(artifactId);
    setArtifactSnapshots((current) => ({
      ...current,
      [artifactId]: { status: 'loading', items: [] },
    }));
    void api.listArtifactSnapshots(artifactId).then((page) => {
      setArtifactSnapshots((current) => ({
        ...current,
        [artifactId]: { status: 'loaded', items: page.items },
      }));
    }).catch((error) => {
      setArtifactSnapshots((current) => ({
        ...current,
        [artifactId]: { status: 'error', items: [] },
      }));
      void message.error(errorMessage(error));
    }).finally(() => {
      loadingSnapshotIds.current.delete(artifactId);
    });
  };
  const artifactMenuItems = availableArtifacts.map((artifact) => {
    const snapshotState = artifactSnapshots[artifact.id];
    return {
      key: `artifact:${artifact.id}`,
      icon: artifact.artifactType === 'markdown' ? <FileMarkdownOutlined /> : <FileOutlined />,
      label: (
        <span className="composer-attachment-menu-copy">
          <strong>{artifact.name}</strong>
          <small>
            {artifact.artifactType === 'markdown' ? 'Markdown' : artifact.currentState.mediaType}
            {' · '}创建者 {memberName(artifact.createdByMembershipId)}
          </small>
        </span>
      ),
      children: [
        {
          key: `selection:${artifact.id}:current`,
          label: (
            <span className="composer-attachment-menu-copy">
              <strong>r{artifact.currentState.currentRevision} · 当前状态</strong>
              <small>
                更新者 {memberName(artifact.currentState.updatedByMembershipId)}
                {' · '}{formatAttachmentTime(artifact.currentState.updatedAt)}
              </small>
            </span>
          ),
        },
        ...(snapshotState?.status === 'loaded'
          ? snapshotState.items.map((snapshot) => ({
              key: `selection:${artifact.id}:${snapshot.snapshotId}`,
              label: (
                <span className="composer-attachment-menu-copy">
                  <strong>r{snapshot.revision} · {snapshot.label || '历史版本'}</strong>
                  <small>作者 {snapshot.createdByDisplayName} · {formatAttachmentTime(snapshot.createdAt)}</small>
                </span>
              ),
            }))
          : [{
              key: `snapshot-state:${artifact.id}`,
              disabled: true,
              label: snapshotState?.status === 'error' ? '历史版本加载失败' : '正在加载历史版本…',
            }]),
      ],
    };
  });
  const attachmentMenu = {
    items: [{
      type: 'group' as const,
      label: '添加',
      children: [
        { key: 'upload', icon: <UploadOutlined />, label: '上传本地文件' },
        {
          key: 'existing-artifacts',
          icon: <ImportOutlined />,
          label: '添加已有 Artifact',
          children: artifactMenuItems.length
            ? artifactMenuItems
            : [{ key: 'no-artifacts', disabled: true, label: '没有可添加的 Artifact' }],
        },
      ],
    }],
    onClick: ({ key }: { key: string }) => {
      setMentionOpen(false);
      if (key === 'upload') uploadInput.current?.click();
      const selection = key.match(/^selection:([^:]+):([^:]+)$/u);
      if (!selection) return;
      const artifact = artifacts.find((item) => item.id === selection[1]);
      if (!artifact) return;
      if (selection[2] === 'current') {
        setSelectedArtifacts((items) => [...items, {
          artifact,
          snapshotId: null,
          displayName: `r${artifact.currentState.currentRevision} · 当前状态`,
        }]);
        return;
      }
      const snapshot = artifactSnapshots[artifact.id]?.items.find((item) => item.snapshotId === selection[2]);
      if (!snapshot) return;
      setSelectedArtifacts((items) => [...items, {
        artifact,
        snapshotId: snapshot.snapshotId,
        displayName: `r${snapshot.revision} · ${snapshot.label || '历史版本'}`,
      }]);
    },
    onOpenChange: (openKeys: string[]) => {
      for (const key of openKeys) {
        if (key.startsWith('artifact:')) loadArtifactSnapshots(key.slice('artifact:'.length));
      }
    },
  };
  const submit = async () => {
    const body = `${selected.map((participant) => `@${participant.displayName}`).join(' ')}${selected.length && value.trim() ? ' ' : ''}${value.trim()}`;
    if (!body) return;
    try {
      await onSubmit(
        body,
        selected.map((participant) => participant.actorId),
        selectedArtifacts.map((item) => ({ artifactId: item.artifact.id, snapshotId: item.snapshotId })),
      );
      setValue('');
      setSelected([]);
      setSelectedArtifacts([]);
      setMentionOpen(false);
    } catch {
      // The mutation owns error presentation. Keep the draft so the Human can retry.
    }
  };
  return (
    <div className={compact ? 'thread-composer' : 'sender-shell'}>
      {selected.length > 0 && (
        <div className="mention-strip">
          <Text type="secondary">提及：</Text>
          {selected.map((participant) => (
            <Tag
              key={participant.actorId}
              color={participant.actorType === 'agent' ? 'blue' : 'default'}
              closable
              onClose={() => setSelected((items) => items.filter((item) => item.actorId !== participant.actorId))}
            >
              @{participant.displayName}
            </Tag>
          ))}
        </div>
      )}
      {selectedArtifacts.length > 0 && (
        <div className="mention-strip">
          <Text type="secondary">附件：</Text>
          {selectedArtifacts.map((selection) => (
            <Tag
              key={selection.artifact.id}
              color="geekblue"
              closable
              onClose={() => setSelectedArtifacts((items) => items.filter((item) => item.artifact.id !== selection.artifact.id))}
            >
              {selection.artifact.name} · {selection.displayName}
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
                  @{participant.displayName} <Text type="secondary">{participant.actorType === 'agent' ? 'Agent' : 'Human'}</Text>
                </Button>
              ))}
            </Space>
          ) : <Text type="secondary">当前 Conversation 没有其他可提及成员。</Text>}
        </div>
      )}
      <input
        ref={uploadInput}
        className="composer-file-input"
        type="file"
        aria-label="选择要上传的文件"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) uploadFile.mutate(file);
          event.target.value = '';
        }}
      />
      <Sender
        value={value}
        loading={loading}
        placeholder={compact
          ? '回复 Thread…'
          : agentRequestIsImplicit
            ? '发送消息；点击 + 添加内容'
            : '发送消息；输入 @ 选择成员，点击 + 添加内容'}
        autoSize={{ minRows: compact ? 1 : 2, maxRows: compact ? 4 : 8 }}
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
              loading={uploadFile.isPending}
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
    </div>
  );
}

export function ConversationPage() {
  const { conversationId = '' } = useParams();
  const { workspace, project } = useWorkspace();
  const queryClient = useQueryClient();
  const session = queryClient.getQueryData<{ id: string }>(sessionQueryKey)!;
  const { message } = App.useApp();
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set());
  const [participantsOpen, setParticipantsOpen] = useState(false);

  const conversation = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => api.getConversation(conversationId),
  });
  const messages = useQuery({
    queryKey: ['conversation', conversationId, 'messages'],
    queryFn: () => loadAllMessages(conversationId),
  });
  const participants = useQuery({
    queryKey: ['conversation', conversationId, 'participants'],
    queryFn: () => api.listParticipants(conversationId).then((page) => page.items),
  });
  const artifacts = useQuery({
    queryKey: workspaceKeys.artifacts(workspace.id, project?.id),
    queryFn: () => api.listArtifacts(workspace.id, project?.id).then((page) => page.items),
  });
  const send = useMutation({
    mutationFn: ({ body, mentionedActorIds, artifactSelections }: {
      body: string;
      mentionedActorIds: string[];
      artifactSelections: Array<{ artifactId: string; snapshotId: string | null }>;
    }) => api.postMessage(conversationId, {
      body,
      ...(mentionedActorIds.length ? { mentionedActorIds } : {}),
      ...(artifactSelections.length ? { artifactSelections } : {}),
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
    mutationFn: ({ messageId, body, mentionedActorIds, artifactSelections }: {
      messageId: string;
      body: string;
      mentionedActorIds: string[];
      artifactSelections: Array<{ artifactId: string; snapshotId: string | null }>;
    }) => api.replyToMessage(messageId, {
      body,
      ...(mentionedActorIds.length ? { mentionedActorIds } : {}),
      ...(artifactSelections.length ? { artifactSelections } : {}),
    }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'messages'] }),
        queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'requests'] }),
      ]);
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
      void message.success(variables.action === 'archive' ? 'Conversation 已归档' : 'Conversation 已恢复');
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const grouped = useMemo(() => {
    const topLevel = (messages.data ?? []).filter((item) => item.threadRootMessageId === null);
    const replies = new Map<string, WorkspaceMessage[]>();
    for (const item of messages.data ?? []) {
      if (!item.threadRootMessageId) continue;
      replies.set(item.threadRootMessageId, [...(replies.get(item.threadRootMessageId) ?? []), item]);
    }
    return { topLevel, replies };
  }, [messages.data]);
  if (conversation.isPending || messages.isPending || participants.isPending) {
    return <div className="full-page-center"><Spin /></div>;
  }
  if (conversation.isError || messages.isError || participants.isError) {
    return <div className="full-page-center"><Empty description={errorMessage(conversation.error || messages.error || participants.error)} /></div>;
  }
  const archived = conversation.data.lifecycleStatus === 'archived';
  const directMessageClosed = conversation.data.kind === 'dm' && participants.data.length !== 2;
  const readOnly = archived || directMessageClosed;
  const mentionableParticipants = filterMentionableParticipants(participants.data, session.id);
  const directAgentParticipant = conversation.data.kind === 'dm'
    ? participants.data.find((participant) => participant.actorType === 'agent')
    : undefined;
  const canManageLifecycle = conversation.data.kind === 'dm'
    || conversation.data.createdByMembershipId === workspace.membershipId
    || workspace.membershipRole === 'owner'
    || project?.role === 'manager';

  const renderMessage = (item: WorkspaceMessage, nested = false) => {
    const own = item.authorActorId === session.id;
    const threadReplies = grouped.replies.get(item.id) ?? [];
    return (
      <div key={item.id}>
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
              <div>{item.body}</div>
              {(item.artifactReferences ?? []).map((reference) => (
                <div className="message-artifact-reference" key={reference.artifactSnapshotId}>
                  {reference.contentAvailable ? (
                    <a href={api.artifactSnapshotDownloadUrl(reference.artifactId, reference.artifactSnapshotId)}>
                      {reference.artifactName} · {reference.snapshotLabel || formatAttachmentTime(reference.snapshotCreatedAt)}
                    </a>
                  ) : (
                    <Text type="secondary">
                      {reference.artifactName} · {reference.snapshotLabel || formatAttachmentTime(reference.snapshotCreatedAt)} · 该历史内容已删除
                    </Text>
                  )}
                </div>
              ))}
            </div>
          )}
          footer={!nested ? (
            <Button type="link" size="small" onClick={() => setExpandedThreads((current) => {
              const next = new Set(current);
              if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
              return next;
            })}>
              {threadReplies.length ? `${threadReplies.length} 条回复` : '回复'}
            </Button>
          ) : undefined}
        />
        {!nested && expandedThreads.has(item.id) && (
          <div className="thread-block">
            {threadReplies.map((threadMessage) => renderMessage(threadMessage, true))}
            {!readOnly && (
              <Composer
                compact
                participants={mentionableParticipants}
                artifacts={artifacts.data ?? []}
                loading={reply.isPending}
                agentRequestIsImplicit={Boolean(directAgentParticipant)}
                onSubmit={async (body, mentionedActorIds, artifactSelections) => {
                  await reply.mutateAsync({ messageId: item.id, body, mentionedActorIds, artifactSelections });
                }}
              />
            )}
          </div>
        )}
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
            {archived && <Tag icon={<InboxOutlined />}>已归档</Tag>}
            {!archived && directMessageClosed && <Tag>只读</Tag>}
          </Space>
          <Text type="secondary">{conversation.data.kind === 'dm' ? 'DM' : 'Channel'} · {participants.data.length} 位参与者</Text>
        </div>
        <Space>
          <Button icon={<TeamOutlined />} onClick={() => setParticipantsOpen(true)}>参与者</Button>
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
              title="归档这个 Conversation？"
              description="消息和执行历史会保留，但归档后不能继续发送消息或请求 Agent。"
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
        {grouped.topLevel.length ? <div className="message-stack">{grouped.topLevel.map((item) => renderMessage(item))}</div> : <Empty description="还没有消息，开始协作吧。" />}
      </div>
      <div className="conversation-composer">
        {archived ? (
          <Alert
            type="info"
            showIcon
            title="该 Conversation 已归档"
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
            loading={send.isPending}
            agentRequestIsImplicit={Boolean(directAgentParticipant)}
            onSubmit={async (body, mentionedActorIds, artifactSelections) => {
              await send.mutateAsync({ body, mentionedActorIds, artifactSelections });
            }}
          />
        )}
      </div>
      <Modal title="Conversation 参与者" open={participantsOpen} footer={null} onCancel={() => setParticipantsOpen(false)}>
        {conversation.data.kind === 'channel' && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            title={project ? '成员与当前 Project 自动同步。' : '成员与当前 Workspace 自动同步。'}
          />
        )}
        <List
          dataSource={participants.data}
          renderItem={(participant: Participant) => (
            <List.Item>
              <List.Item.Meta
                avatar={<Avatar icon={participant.actorType === 'agent' ? <MessageOutlined /> : <UserOutlined />} />}
                title={participant.displayName}
                description={participant.actorType === 'agent' ? 'Agent' : 'Human'}
              />
            </List.Item>
          )}
        />
      </Modal>
    </section>
  );
}

function formatAttachmentTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(timestamp);
}
