import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  EditOutlined,
  LinkOutlined,
  MessageOutlined,
  MoreOutlined,
  PauseCircleOutlined,
  PlusOutlined,
  RobotOutlined,
  SearchOutlined,
  StopOutlined,
  SwapOutlined,
  UploadOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Avatar,
  Button,
  Dropdown,
  Empty,
  Form,
  Input,
  List,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { api, errorMessage, type CreateWorkItemInput, type ProjectMember, type WorkItem } from '../api/client';
import { useWorkspace, workspaceKeys } from './workspace-context';
import { isWorkItemSubmissionPending } from './work-item-presentation';
import { Composer } from './ConversationPage';
import { WorkItemCommentDrawer } from './WorkItemCommentDrawer';

const { Text, Title } = Typography;

type BoardColumnKey = 'backlog' | 'in_progress' | 'blocked' | 'completed' | 'cancelled';
type ReasonAction = { kind: 'block' | 'cancel'; workItem: WorkItem };

const columns: Array<{
  key: BoardColumnKey;
  title: string;
  icon: React.ReactNode;
  empty: string;
}> = [
  { key: 'backlog', title: '待处理', icon: <ClockCircleOutlined />, empty: '暂无待处理任务' },
  { key: 'in_progress', title: '进行中', icon: <RobotOutlined />, empty: '暂无进行中的任务' },
  { key: 'blocked', title: '已阻塞', icon: <PauseCircleOutlined />, empty: '暂无阻塞任务' },
  { key: 'completed', title: '已完成', icon: <CheckCircleOutlined />, empty: '暂无已完成任务' },
  { key: 'cancelled', title: '已取消', icon: <StopOutlined />, empty: '暂无已取消任务' },
];

function boardColumn(workItem: WorkItem): BoardColumnKey {
  if (workItem.lifecycleStatus === 'blocked') return 'blocked';
  if (workItem.lifecycleStatus === 'completed') return 'completed';
  if (workItem.lifecycleStatus === 'cancelled') return 'cancelled';
  return (workItem.assignees?.length ?? (workItem.assignee ? 1 : 0)) > 0 ? 'in_progress' : 'backlog';
}

function relativeTime(timestamp: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(timestamp);
}

function artifactHref(workspaceId: string, projectId: string, artifactId: string, versionId: string): string {
  return `/w/${workspaceId}/p/${projectId}/artifacts/${artifactId}?versionId=${encodeURIComponent(versionId)}`;
}

function SubmissionArtifacts({
  submission,
  workspaceId,
  projectId,
}: {
  submission: NonNullable<WorkItem['currentSubmission']> | null | undefined;
  workspaceId: string;
  projectId: string;
}) {
  if (!submission?.artifactReferences.length) return null;
  return (
    <div className="work-item-submission-artifacts" aria-label="交付结果">
      <Text type="secondary">交付结果：</Text>
      {submission.artifactReferences.map((reference) => reference.contentAvailable ? (
        <a
          key={reference.artifactVersionId}
          href={artifactHref(workspaceId, projectId, reference.artifactId, reference.artifactVersionId)}
        >
          {reference.artifactName} · v{reference.version} · {reference.fileName}
        </a>
      ) : (
        <Text type="secondary" key={reference.artifactVersionId}>
          {reference.artifactName} · v{reference.version} · 该版本已不可访问
        </Text>
      ))}
    </div>
  );
}

export function WorkItemBoardPage() {
  const { workspace, project, projectMembers, members } = useWorkspace();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { message, modal } = App.useApp();
  const [createOpen, setCreateOpen] = useState(false);
  const [reasonAction, setReasonAction] = useState<ReasonAction>();
  const [assignmentAction, setAssignmentAction] = useState<WorkItem>();
  const [commentAction, setCommentAction] = useState<WorkItem>();
  const [editAction, setEditAction] = useState<WorkItem>();
  const [search, setSearch] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState('all');
  const [createForm] = Form.useForm<CreateWorkItemInput>();
  const [reasonForm] = Form.useForm<{ reason: string }>();
  const [assignmentForm] = Form.useForm<{ assigneeProjectMembershipIds?: string[] }>();
  const [editForm] = Form.useForm<{ description: string }>();
  const resultUploadInput = useRef<HTMLInputElement>(null);
  const resultUploadWorkItem = useRef<WorkItem | null>(null);
  const openedFromQuery = useRef(false);
  const requestedWorkItemId = searchParams.get('workItemId');

  const workItems = useQuery({
    queryKey: workspaceKeys.projectWorkItems(project?.id ?? ''),
    queryFn: () => api.listProjectWorkItems(project!.id).then((page) => page.items),
    enabled: Boolean(project),
  });
  const artifacts = useQuery({
    queryKey: workspaceKeys.projectArtifacts(project?.id ?? ''),
    queryFn: () => api.listProjectArtifactsV2(project!.id).then((page) => page.items),
    enabled: Boolean(project),
  });
  const comments = useQuery({
    queryKey: ['work-item', commentAction?.id, 'comments'],
    queryFn: () => api.listWorkItemComments(commentAction!.id).then((page) => page.items),
    enabled: Boolean(commentAction),
  });

  useEffect(() => {
    if (openedFromQuery.current || !requestedWorkItemId || !workItems.data) return;
    openedFromQuery.current = true;
    const target = workItems.data.find((workItem) => workItem.id === requestedWorkItemId);
    if (target) setCommentAction(target);
  }, [requestedWorkItemId, workItems.data]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: workspaceKeys.projectWorkItems(project!.id) });
  const create = useMutation({
    mutationFn: (value: CreateWorkItemInput) => api.createWorkItem(project!.id, {
      description: value.description.trim(),
      assigneeProjectMembershipIds: value.assigneeProjectMembershipIds ?? [],
    }),
    onSuccess: async (workItem) => {
      createForm.resetFields();
      setCreateOpen(false);
      await Promise.all([
        refresh(),
        queryClient.invalidateQueries({ queryKey: workspaceKeys.projectConversations(project!.id) }),
        queryClient.invalidateQueries({ queryKey: workspaceKeys.projects(workspace.id) }),
      ]);
      void message.success(workItem.assignees.some((assignee) => assignee.actorType === 'agent')
        ? `任务已创建，并已通知 ${workItem.assignees.filter((assignee) => assignee.actorType === 'agent').map((assignee) => assignee.displayName).join('、')}。`
        : '任务已创建。');
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const reasonMutation = useMutation({
    mutationFn: ({ action, reason }: { action: ReasonAction; reason: string }) => action.kind === 'block'
      ? api.blockWorkItem(action.workItem.id, reason.trim(), action.workItem.revision)
      : api.cancelWorkItem(action.workItem.id, reason.trim() || undefined, action.workItem.revision),
    onSuccess: async (_, variables) => {
      setReasonAction(undefined);
      reasonForm.resetFields();
      await refresh();
      void message.success(variables.action.kind === 'block' ? '任务已标记为阻塞。' : '任务已取消。');
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const assignmentMutation = useMutation({
    mutationFn: ({ workItem, assigneeProjectMembershipIds }: {
      workItem: WorkItem;
      assigneeProjectMembershipIds: string[];
    }) => api.assignWorkItem(
      workItem.id,
      assigneeProjectMembershipIds,
      workItem.revision,
      workItem.assignmentRevision,
    ),
    onSuccess: async (workItem) => {
      setAssignmentAction(undefined);
      assignmentForm.resetFields();
      await refresh();
      void message.success(workItem.assignees.length
        ? `已分配给 ${workItem.assignees.map((assignee) => assignee.displayName).join('、')}${workItem.assignees.some((assignee) => assignee.actorType === 'agent') ? '，并通知相关 Agent' : ''}。`
        : '已解除分配。');
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const editMutation = useMutation({
    mutationFn: ({ workItem, description }: { workItem: WorkItem; description: string }) => api.updateWorkItemDetails(
      workItem.id,
      description.trim(),
      workItem.revision,
    ),
    onSuccess: async () => {
      setEditAction(undefined);
      editForm.resetFields();
      await refresh();
      void message.success('任务详情已更新。');
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const transition = useMutation({
    mutationFn: ({ workItem, kind }: { workItem: WorkItem; kind: 'unblock' | 'complete' }) => kind === 'unblock'
      ? api.unblockWorkItem(workItem.id, workItem.revision)
      : api.completeWorkItem(workItem.id, workItem.revision),
    onSuccess: async (_, variables) => {
      await refresh();
      void message.success(variables.kind === 'unblock' ? '任务已解除阻塞。' : '任务已完成。');
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const postComment = useMutation({
    mutationFn: ({ workItemId, body, mentionedActorIds, workItemIds, artifactSelections }: {
      workItemId: string;
      body: string;
      mentionedActorIds: string[];
      workItemIds: string[];
      artifactSelections: Array<{ artifactId: string; artifactVersionId: string }>;
    }) => api.postWorkItemComment(workItemId, body.trim(), mentionedActorIds, workItemIds, artifactSelections),
    onSuccess: async (comment) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['work-item', comment.workItemId, 'comments'] }),
        refresh(),
      ]);
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const submitResult = useMutation({
    mutationFn: async ({ workItem, file }: { workItem: WorkItem; file: File }) => {
      const published = await api.publishArtifactV2(workItem.projectId, file, { taskId: workItem.id });
      return api.submitWorkItemResult(workItem.id, [published.version.versionId], workItem.revision);
    },
    onSuccess: async () => {
      await refresh();
      void message.success('交付结果已提交，等待验收。');
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const commentParticipants = useMemo<Array<Pick<ProjectMember, 'actorId' | 'actorType' | 'displayName'>>>(() => {
    const currentActorId = members.find((member) => member.membershipId === workspace.membershipId)?.actorId;
    return projectMembers
      .filter((member) => member.actorId !== currentActorId)
      .map((member) => ({ actorId: member.actorId, actorType: member.actorType, displayName: member.displayName }));
  }, [members, projectMembers, workspace.membershipId]);

  const filteredItems = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase();
    return (workItems.data ?? []).filter((workItem) => {
      const matchesSearch = !keyword
        || workItem.description.toLocaleLowerCase().includes(keyword)
        || workItem.createdByDisplayName.toLocaleLowerCase().includes(keyword)
        || workItem.assignees.some((assignee) => assignee.displayName.toLocaleLowerCase().includes(keyword));
      const matchesAssignee = assigneeFilter === 'all'
        || (assigneeFilter === 'unassigned' && workItem.assignees.length === 0)
        || workItem.assignees.some((assignee) => assignee.projectMembershipId === assigneeFilter);
      return matchesSearch && matchesAssignee;
    });
  }, [assigneeFilter, search, workItems.data]);

  if (!project) return <Navigate to={`/w/${workspace.id}/projects`} replace />;

  const canManage = project.role === 'owner' || project.role === 'manager';
  const confirmComplete = (workItem: WorkItem) => {
    modal.confirm({
      title: '确认完成这个任务？',
      content: workItem.currentSubmission
        ? `将验收 ${workItem.currentSubmission.submittedByDisplayName} 提交的结果；完成后不可重新打开。`
        : '当前没有结构化结果提交；仍可按人工完成策略直接完成。完成后不可重新打开。',
      okText: '确认完成',
      cancelText: '返回',
      onOk: () => transition.mutateAsync({ workItem, kind: 'complete' }),
    });
  };

  return (
    <main className="work-item-board-page">
      <header className="work-item-board-header">
        <div>
          <Text className="work-item-board-eyebrow">{project.name}</Text>
          <Title level={2}>任务看板</Title>
          <Text type="secondary">把协作拆成可跟踪的任务，明确负责人和交付结果。</Text>
        </div>
        <Button type="primary" size="large" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          创建任务
        </Button>
      </header>

      <div className="work-item-board-toolbar">
        <Input
          allowClear
          prefix={<SearchOutlined />}
          aria-label="搜索任务"
          placeholder="搜索任务描述或负责人"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Select
          aria-label="按负责人筛选"
          value={assigneeFilter}
          onChange={setAssigneeFilter}
          options={[
            { value: 'all', label: '全部负责人' },
            { value: 'unassigned', label: '未分配' },
            ...projectMembers.map((member) => ({
              value: member.projectMembershipId,
              label: `${member.actorType === 'agent' ? 'Agent' : '成员'} · ${member.displayName}`,
            })),
          ]}
        />
        <Text type="secondary">显示 {filteredItems.length} / {workItems.data?.length ?? 0} 个任务</Text>
      </div>

      {workItems.isPending ? (
        <div className="work-item-board-loading"><Spin size="large" /></div>
      ) : workItems.isError ? (
        <Alert type="error" showIcon title="任务看板加载失败" description={errorMessage(workItems.error)} />
      ) : (
        <section className="work-item-board" aria-label={`${project.name} 任务看板`}>
          {columns.map((column) => {
            const items = filteredItems.filter((workItem) => boardColumn(workItem) === column.key);
            return (
              <section className={`work-item-column ${column.key}`} key={column.key} aria-labelledby={`column-${column.key}`}>
                <header className="work-item-column-header">
                  <span className="work-item-column-title" id={`column-${column.key}`}>{column.icon} {column.title}</span>
                  <span className="work-item-column-count">{items.length}</span>
                </header>
                <div className="work-item-column-body">
                  {items.length ? items.map((workItem) => {
                    const relatedWorkItemReferences = workItem.relatedWorkItemReferences ?? [];
                    const canBlock = workItem.lifecycleStatus === 'open'
                      && (canManage || workItem.assignees.some((assignee) => assignee.workspaceMembershipId === workspace.membershipId));
                    const menuItems = [
                      ...((canManage || workItem.assignees.some((assignee) => assignee.workspaceMembershipId === workspace.membershipId))
                        && workItem.lifecycleStatus === 'open'
                        ? [{ key: 'upload-result', label: '上传交付结果', icon: <UploadOutlined /> }] : []),
                      ...(workItem.sourceConversationId && workItem.sourceMessageId
                        ? [{ key: 'view-source', label: '查看来源', icon: <LinkOutlined /> }] : []),
                      ...(canManage && workItem.lifecycleStatus === 'open' && workItem.assignees.length === 0
                        ? [{ key: 'edit', label: '编辑任务', icon: <EditOutlined /> }] : []),
                      ...(canManage && (workItem.lifecycleStatus === 'open' || workItem.lifecycleStatus === 'blocked')
                        ? [{ key: 'assign', label: workItem.assignees.length ? '更换负责人' : '分配负责人', icon: <SwapOutlined /> }] : []),
                      ...(canBlock ? [{ key: 'block', label: '报告阻塞', icon: <PauseCircleOutlined /> }] : []),
                      ...(canManage && workItem.lifecycleStatus === 'blocked'
                        ? [{ key: 'unblock', label: '解除阻塞', icon: <CheckCircleOutlined /> }] : []),
                      ...(canManage && workItem.lifecycleStatus === 'open'
                        ? [{ key: 'complete', label: '确认完成', icon: <CheckCircleOutlined /> }] : []),
                      ...(canManage && (workItem.lifecycleStatus === 'open' || workItem.lifecycleStatus === 'blocked')
                        ? [{ key: 'cancel', label: '取消任务', icon: <CloseCircleOutlined />, danger: true }] : []),
                    ];
                    return (
                      <article className="work-item-card" key={workItem.id}>
                        <div className="work-item-card-heading">
                          <div className="work-item-card-title">
                            <strong>@task#{workItem.taskNumber}</strong>
                            <p className="work-item-description">{workItem.description}</p>
                          </div>
                          {menuItems.length > 0 && (
                            <Dropdown
                              trigger={['click']}
                              menu={{
                                items: menuItems,
                                onClick: ({ key }) => {
                                  if (key === 'assign') {
                                    setAssignmentAction(workItem);
                                    assignmentForm.resetFields();
                                    assignmentForm.setFieldsValue({
                                      assigneeProjectMembershipIds: workItem.assignees.map((assignee) => assignee.projectMembershipId),
                                    });
                                    return;
                                  }
                                  if (key === 'edit') {
                                    setEditAction(workItem);
                                    editForm.setFieldsValue({ description: workItem.description });
                                    return;
                                  }
                                  if (key === 'upload-result') {
                                    resultUploadWorkItem.current = workItem;
                                    resultUploadInput.current?.click();
                                    return;
                                  }
                                  if (key === 'view-source') {
                                    navigate(
                                      `/w/${workspace.id}/p/${workItem.projectId}/c/${workItem.sourceConversationId}?messageId=${workItem.sourceMessageId}`,
                                    );
                                    return;
                                  }
                                  if (key === 'block' || key === 'cancel') {
                                    setReasonAction({ kind: key, workItem });
                                    return;
                                  }
                                  if (key === 'unblock') transition.mutate({ workItem, kind: 'unblock' });
                                  if (key === 'complete') confirmComplete(workItem);
                                },
                              }}
                            >
                              <Button type="text" size="small" aria-label="任务操作" icon={<MoreOutlined />} />
                            </Dropdown>
                          )}
                        </div>
                        {isWorkItemSubmissionPending(workItem) && (
                          <Tag className="work-item-submission-tag" color="processing">结果待验收</Tag>
                        )}
                        <SubmissionArtifacts
                          submission={workItem.currentSubmission}
                          workspaceId={workspace.id}
                          projectId={workItem.projectId}
                        />
                        {workItem.blockerReason && <p className="work-item-reason blocked">阻塞：{workItem.blockerReason}</p>}
                        {workItem.cancellationReason && <p className="work-item-reason cancelled">取消：{workItem.cancellationReason}</p>}
                        {relatedWorkItemReferences.length > 0 && (
                          <div className="work-item-related" aria-label="关联任务">
                            <span className="work-item-related-label">关联任务：</span>
                            {relatedWorkItemReferences.map((reference) => (
                              <a
                                key={reference.workItemId}
                                href={`/w/${workspace.id}/p/${workItem.projectId}/work-items?workItemId=${reference.workItemId}`}
                                className="work-item-related-link"
                                aria-label={`打开关联任务 #${reference.taskNumber}`}
                              >
                                @task#{reference.taskNumber}
                              </a>
                            ))}
                          </div>
                        )}
                        <div className="work-item-card-meta">
                          <span className="work-item-card-person">
                            <Avatar size={22} icon={<UserOutlined />} />
                            <span className="work-item-card-person-copy">
                              <span className="work-item-card-person-label">发起人：</span>{workItem.createdByDisplayName}
                            </span>
                          </span>
                          {workItem.assignees.length ? (
                            <span className="work-item-card-person">
                              <Avatar size={22} icon={workItem.assignees[0]?.actorType === 'agent' ? <RobotOutlined /> : <UserOutlined />} />
                              <span className="work-item-card-person-copy">
                                <span className="work-item-card-person-label">负责人：</span>
                                {workItem.assignees.map((assignee) => assignee.displayName).join('、')}
                              </span>
                            </span>
                          ) : (
                            <span className="work-item-card-person work-item-unassigned">
                              <Avatar size={22} icon={<UserOutlined />} />
                              <span className="work-item-card-person-copy">
                                <span className="work-item-card-person-label">负责人：</span>未分配
                              </span>
                            </span>
                          )}
                        </div>
                        <footer className="work-item-card-footer">
                          <Text type="secondary"><ClockCircleOutlined /> {relativeTime(workItem.updatedAt)}</Text>
                          <Button type="link" size="small" icon={<MessageOutlined />} onClick={() => setCommentAction(workItem)}>
                            评论{workItem.commentFrontier ? ` ${workItem.commentFrontier}` : ''}
                          </Button>
                        </footer>
                      </article>
                    );
                  }) : (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={column.empty} />
                  )}
                </div>
              </section>
            );
          })}
        </section>
      )}

      <input
        ref={resultUploadInput}
        className="composer-file-input"
        type="file"
        hidden
        aria-label="上传交付结果"
        onChange={(event) => {
          const file = event.target.files?.[0];
          const workItem = resultUploadWorkItem.current;
          if (file && workItem) submitResult.mutate({ workItem, file });
          event.target.value = '';
        }}
      />

      <Modal
        title="创建任务"
        open={createOpen}
        okText="创建"
        cancelText="取消"
        confirmLoading={create.isPending}
        onCancel={() => setCreateOpen(false)}
        onOk={() => void createForm.validateFields().then((value) => create.mutate(value))}
      >
        <Form form={createForm} layout="vertical">
          <Form.Item name="description" label="具体描述" rules={[{ required: true, max: 10000, whitespace: true }]}>
            <Input.TextArea autoFocus rows={5} placeholder="描述要交付的内容、范围和验收标准" />
          </Form.Item>
          <Form.Item name="assigneeProjectMembershipIds" label="负责人（可多选）">
            <Select
              mode="multiple"
              maxTagCount="responsive"
              allowClear
              placeholder="暂不分配"
              options={projectMembers.map((member) => ({
                value: member.projectMembershipId,
                label: `${member.actorType === 'agent' ? 'Agent' : 'Human'} · ${member.displayName}`,
              }))}
            />
          </Form.Item>
          <Alert
            type="info"
            showIcon
            title="任务使用独立评论区；分配或 @Agent 时才会定向唤醒。"
          />
        </Form>
      </Modal>

      <WorkItemCommentDrawer
        open={Boolean(commentAction)}
        workItem={commentAction}
        comments={comments.data}
        commentsPending={comments.isPending}
        commentsError={comments.error}
        workspaceId={workspace.id}
        projectId={project?.id ?? ''}
        submissionContent={(
          <SubmissionArtifacts
            submission={commentAction?.currentSubmission}
            workspaceId={workspace.id}
            projectId={project?.id ?? ''}
          />
        )}
        onClose={() => setCommentAction(undefined)}
        onOpenTaskComments={(workItemId) => {
          const target = workItems.data?.find((item) => item.id === workItemId);
          if (target) setCommentAction(target);
        }}
        composer={commentAction ? (
          <Composer
            participants={commentParticipants}
            artifacts={artifacts.data ?? []}
            workItems={workItems.data ?? []}
            loading={postComment.isPending}
            workItemReplyId={commentAction.id}
            onCancelReply={() => setCommentAction(undefined)}
            onSubmitWorkItemComment={async (workItemId, body, mentionedActorIds, artifactSelections, workItemIds) => {
              await postComment.mutateAsync({ workItemId, body, mentionedActorIds, artifactSelections, workItemIds });
            }}
            onSubmit={async () => undefined}
          />
        ) : null}
      />

      <Modal
        title="编辑任务"
        open={Boolean(editAction)}
        okText="保存"
        cancelText="取消"
        confirmLoading={editMutation.isPending}
        onCancel={() => {
          setEditAction(undefined);
          editForm.resetFields();
        }}
        onOk={() => void editForm.validateFields().then(({ description }) => {
          if (editAction) editMutation.mutate({ workItem: editAction, description });
        })}
      >
        <Form form={editForm} layout="vertical">
          <Form.Item name="description" label="具体描述" rules={[{ required: true, max: 10000, whitespace: true }]}>
            <Input.TextArea autoFocus rows={5} placeholder="描述要交付的内容、范围和验收标准" />
          </Form.Item>
          <Alert type="info" showIcon title="只有未分配且仍在待处理的任务可以编辑。" />
        </Form>
      </Modal>

      <Modal
        title={assignmentAction?.assignees.length ? '更换负责人' : '分配负责人'}
        open={Boolean(assignmentAction)}
        okText="确认"
        cancelText="取消"
        confirmLoading={assignmentMutation.isPending}
        onCancel={() => {
          setAssignmentAction(undefined);
          assignmentForm.resetFields();
        }}
        onOk={() => void assignmentForm.validateFields().then(({ assigneeProjectMembershipIds }) => {
          if (assignmentAction) assignmentMutation.mutate({
            workItem: assignmentAction,
            assigneeProjectMembershipIds: assigneeProjectMembershipIds ?? [],
          });
        })}
      >
        <Form form={assignmentForm} layout="vertical">
          <Form.Item
            name="assigneeProjectMembershipIds"
            label="负责人（可多选）"
            rules={[{
              validator: (_, value?: string[]) => (
                (value ?? []).slice().sort().join(',') === (assignmentAction?.assignees ?? []).map((assignee) => assignee.projectMembershipId).slice().sort().join(',')
                  ? Promise.reject(new Error('请选择不同的负责人，或清空以解除分配。'))
                  : Promise.resolve()
              ),
            }]}
          >
            <Select
              mode="multiple"
              maxTagCount="responsive"
              allowClear
              placeholder="清空后解除分配"
              options={projectMembers.map((member) => ({
                value: member.projectMembershipId,
                label: `${member.actorType === 'agent' ? 'Agent' : '成员'} · ${member.displayName}`,
              }))}
            />
          </Form.Item>
          <Alert
            type="info"
            showIcon
            title="重新分配会更新任务版本，并让旧的待验收提交失效；分配给 Agent 时会再次通知它。"
          />
        </Form>
      </Modal>

      <Modal
        title={reasonAction?.kind === 'block' ? '报告阻塞' : '取消任务'}
        open={Boolean(reasonAction)}
        okText={reasonAction?.kind === 'block' ? '确认阻塞' : '确认取消'}
        okButtonProps={{ danger: reasonAction?.kind === 'cancel' }}
        cancelText="返回"
        confirmLoading={reasonMutation.isPending}
        onCancel={() => {
          setReasonAction(undefined);
          reasonForm.resetFields();
        }}
        onOk={() => void reasonForm.validateFields().then(({ reason }) => {
          if (reasonAction) reasonMutation.mutate({ action: reasonAction, reason });
        })}
      >
        <Form form={reasonForm} layout="vertical">
          <Form.Item
            name="reason"
            label={reasonAction?.kind === 'block' ? '阻塞原因' : '取消原因'}
            rules={reasonAction?.kind === 'block' ? [{ required: true, max: 2000 }] : [{ max: 2000 }]}
          >
            <Input.TextArea rows={4} placeholder={reasonAction?.kind === 'block' ? '记录一个可追溯的具体原因' : '可选填取消原因'} />
          </Form.Item>
        </Form>
      </Modal>
    </main>
  );
}
