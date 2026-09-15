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
import { useLanguage } from '../language';
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

function relativeTime(timestamp: number, isEnglish: boolean): string {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return isEnglish ? 'just now' : '刚刚';
  if (minutes < 60) return isEnglish ? `${minutes} min ago` : `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return isEnglish ? `${hours} hr ago` : `${hours} 小时前`;
  return new Intl.DateTimeFormat(isEnglish ? 'en-US' : 'zh-CN', { month: 'short', day: 'numeric' }).format(timestamp);
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
  const { isEnglish } = useLanguage();
  const tx = (zh: string, en: string) => isEnglish ? en : zh;
  if (!submission?.artifactReferences.length) return null;
  return (
    <div className="work-item-submission-artifacts" aria-label={tx('交付结果', 'Submission')}>
      <Text type="secondary">{tx('交付结果：', 'Submission:')}</Text>
      {submission.artifactReferences.map((reference) => reference.contentAvailable ? (
        <a
          key={reference.artifactVersionId}
          href={artifactHref(workspaceId, projectId, reference.artifactId, reference.artifactVersionId)}
        >
          {reference.artifactName} · v{reference.version} · {reference.fileName}
        </a>
      ) : (
        <Text type="secondary" key={reference.artifactVersionId}>
          {reference.artifactName} · v{reference.version} · {tx('该版本已不可访问', 'This version is no longer accessible')}
        </Text>
      ))}
    </div>
  );
}

export function WorkItemBoardPage() {
  const { workspace, project, projectMembers, members } = useWorkspace();
  const { isEnglish } = useLanguage();
  const tx = (zh: string, en: string) => isEnglish ? en : zh;
  const localizedColumns = columns.map((column) => ({
    ...column,
    title: tx(column.title, ({ 待处理: 'Backlog', 进行中: 'In progress', 已阻塞: 'Blocked', 已完成: 'Completed', 已取消: 'Cancelled' } as Record<string, string>)[column.title] ?? column.title),
    empty: tx(column.empty, ({ '暂无待处理任务': 'No backlog tasks', '暂无进行中的任务': 'No tasks in progress', '暂无阻塞任务': 'No blocked tasks', '暂无已完成任务': 'No completed tasks', '暂无已取消任务': 'No cancelled tasks' } as Record<string, string>)[column.empty] ?? column.empty),
  }));
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
        ? tx(`任务已创建，并已通知 ${workItem.assignees.filter((assignee) => assignee.actorType === 'agent').map((assignee) => assignee.displayName).join('、')}。`, `Task created and notified ${workItem.assignees.filter((assignee) => assignee.actorType === 'agent').map((assignee) => assignee.displayName).join(', ')}.`)
        : tx('任务已创建。', 'Task created.'));
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
      void message.success(variables.action.kind === 'block' ? tx('任务已标记为阻塞。', 'Task marked as blocked.') : tx('任务已取消。', 'Task cancelled.'));
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
        ? tx(`已分配给 ${workItem.assignees.map((assignee) => assignee.displayName).join('、')}${workItem.assignees.some((assignee) => assignee.actorType === 'agent') ? '，并通知相关 Agent' : ''}。`, `Assigned to ${workItem.assignees.map((assignee) => assignee.displayName).join(', ')}${workItem.assignees.some((assignee) => assignee.actorType === 'agent') ? ', and notified the relevant Agent' : ''}.`)
        : tx('已解除分配。', 'Assignment cleared.'));
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
      void message.success(tx('任务详情已更新。', 'Task details updated.'));
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const transition = useMutation({
    mutationFn: ({ workItem, kind }: { workItem: WorkItem; kind: 'unblock' | 'complete' }) => kind === 'unblock'
      ? api.unblockWorkItem(workItem.id, workItem.revision)
      : api.completeWorkItem(workItem.id, workItem.revision),
    onSuccess: async (_, variables) => {
      await refresh();
      void message.success(variables.kind === 'unblock' ? tx('任务已解除阻塞。', 'Task unblocked.') : tx('任务已完成。', 'Task completed.'));
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
      void message.success(tx('交付结果已提交，等待验收。', 'Result submitted, awaiting review.'));
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
      title: tx('确认完成这个任务？', 'Complete this task?'),
      content: workItem.currentSubmission
        ? tx(`将验收 ${workItem.currentSubmission.submittedByDisplayName} 提交的结果；完成后不可重新打开。`, `Accept the result submitted by ${workItem.currentSubmission.submittedByDisplayName}; it cannot be reopened once completed.`)
        : tx('当前没有结构化结果提交；仍可按人工完成策略直接完成。完成后不可重新打开。', 'No structured result has been submitted; you can still complete it manually. It cannot be reopened once completed.'),
      okText: tx('确认完成', 'Confirm completion'),
      cancelText: tx('返回', 'Back'),
      onOk: () => transition.mutateAsync({ workItem, kind: 'complete' }),
    });
  };

  return (
    <main className="work-item-board-page">
      <header className="work-item-board-header">
        <div>
          <Text className="work-item-board-eyebrow">{project.name}</Text>
          <Title level={2}>{tx('任务看板', 'Task board')}</Title>
          <Text type="secondary">{tx('把协作拆成可跟踪的任务，明确负责人和交付结果。', 'Break collaboration into trackable tasks with clear owners and outcomes.')}</Text>
        </div>
        <Button type="primary" size="large" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          {tx('创建任务', 'Create task')}
        </Button>
      </header>

      <div className="work-item-board-toolbar">
        <Input
          allowClear
          prefix={<SearchOutlined />}
          aria-label={tx('搜索任务', 'Search tasks')}
              placeholder={tx('搜索任务描述或负责人', 'Search task descriptions or assignees')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Select
          aria-label={tx('按负责人筛选', 'Filter by assignee')}
          value={assigneeFilter}
          onChange={setAssigneeFilter}
          options={[
            { value: 'all', label: tx('全部负责人', 'All assignees') },
            { value: 'unassigned', label: tx('未分配', 'Unassigned') },
            ...projectMembers.map((member) => ({
              value: member.projectMembershipId,
              label: `${member.actorType === 'agent' ? 'Agent' : tx('成员', 'Member')} · ${member.displayName}`,
            })),
          ]}
        />
        <Text type="secondary">{tx('显示', 'Showing')} {filteredItems.length} / {workItems.data?.length ?? 0} {tx('个任务', 'tasks')}</Text>
      </div>

      {workItems.isPending ? (
        <div className="work-item-board-loading"><Spin size="large" /></div>
      ) : workItems.isError ? (
        <Alert type="error" showIcon title={tx('任务看板加载失败', 'Failed to load the task board')} description={errorMessage(workItems.error)} />
      ) : (
        <section className="work-item-board" aria-label={tx(`${project.name} 任务看板`, `${project.name} task board`)}>
          {localizedColumns.map((column) => {
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
                        ? [{ key: 'upload-result', label: tx('上传交付结果', 'Upload result'), icon: <UploadOutlined /> }] : []),
                      ...(workItem.sourceConversationId && workItem.sourceMessageId
                        ? [{ key: 'view-source', label: tx('查看来源', 'View source'), icon: <LinkOutlined /> }] : []),
                      ...(canManage && workItem.lifecycleStatus === 'open' && workItem.assignees.length === 0
                        ? [{ key: 'edit', label: tx('编辑任务', 'Edit task'), icon: <EditOutlined /> }] : []),
                      ...(canManage && (workItem.lifecycleStatus === 'open' || workItem.lifecycleStatus === 'blocked')
                        ? [{ key: 'assign', label: workItem.assignees.length ? tx('更换负责人', 'Change assignee') : tx('分配负责人', 'Assign'), icon: <SwapOutlined /> }] : []),
                      ...(canBlock ? [{ key: 'block', label: tx('报告阻塞', 'Report blocker'), icon: <PauseCircleOutlined /> }] : []),
                      ...(canManage && workItem.lifecycleStatus === 'blocked'
                        ? [{ key: 'unblock', label: tx('解除阻塞', 'Unblock'), icon: <CheckCircleOutlined /> }] : []),
                      ...(canManage && workItem.lifecycleStatus === 'open'
                        ? [{ key: 'complete', label: tx('确认完成', 'Confirm completion'), icon: <CheckCircleOutlined /> }] : []),
                      ...(canManage && (workItem.lifecycleStatus === 'open' || workItem.lifecycleStatus === 'blocked')
                        ? [{ key: 'cancel', label: tx('取消任务', 'Cancel task'), icon: <CloseCircleOutlined />, danger: true }] : []),
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
                              <Button type="text" size="small" aria-label={tx('任务操作', 'Task actions')} icon={<MoreOutlined />} />
                            </Dropdown>
                          )}
                        </div>
                        {isWorkItemSubmissionPending(workItem) && (
                          <Tag className="work-item-submission-tag" color="processing">{tx('结果待验收', 'Result pending review')}</Tag>
                        )}
                        <SubmissionArtifacts
                          submission={workItem.currentSubmission}
                          workspaceId={workspace.id}
                          projectId={workItem.projectId}
                        />
                        {workItem.blockerReason && <p className="work-item-reason blocked">{tx('阻塞：', 'Blocked: ')}{workItem.blockerReason}</p>}
                        {workItem.cancellationReason && <p className="work-item-reason cancelled">{tx('取消：', 'Cancelled: ')}{workItem.cancellationReason}</p>}
                        {relatedWorkItemReferences.length > 0 && (
                          <div className="work-item-related" aria-label={tx('关联任务', 'Related tasks')}>
                            <span className="work-item-related-label">{tx('关联任务：', 'Related tasks: ')}</span>
                            {relatedWorkItemReferences.map((reference) => (
                              <a
                                key={reference.workItemId}
                                href={`/w/${workspace.id}/p/${workItem.projectId}/work-items?workItemId=${reference.workItemId}`}
                                className="work-item-related-link"
                                aria-label={tx(`打开关联任务 #${reference.taskNumber}`, `Open related task #${reference.taskNumber}`)}
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
                              <span className="work-item-card-person-label">{tx('发起人：', 'Created by: ')}</span>{workItem.createdByDisplayName}
                            </span>
                          </span>
                          {workItem.assignees.length ? (
                            <span className="work-item-card-person">
                              <Avatar size={22} icon={workItem.assignees[0]?.actorType === 'agent' ? <RobotOutlined /> : <UserOutlined />} />
                              <span className="work-item-card-person-copy">
                                <span className="work-item-card-person-label">{tx('负责人：', 'Assignee: ')}</span>
                                {workItem.assignees.map((assignee) => assignee.displayName).join(isEnglish ? ', ' : '、')}
                              </span>
                            </span>
                          ) : (
                            <span className="work-item-card-person work-item-unassigned">
                              <Avatar size={22} icon={<UserOutlined />} />
                              <span className="work-item-card-person-copy">
                                <span className="work-item-card-person-label">{tx('负责人：', 'Assignee: ')}</span>{tx('未分配', 'Unassigned')}
                              </span>
                            </span>
                          )}
                        </div>
                        <footer className="work-item-card-footer">
                          <Text type="secondary"><ClockCircleOutlined /> {relativeTime(workItem.updatedAt, isEnglish)}</Text>
                          <Button type="link" size="small" icon={<MessageOutlined />} onClick={() => setCommentAction(workItem)}>
                            {tx('评论', 'Comments')}{workItem.commentFrontier ? ` ${workItem.commentFrontier}` : ''}
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
        aria-label={tx('上传交付结果', 'Upload result')}
        onChange={(event) => {
          const file = event.target.files?.[0];
          const workItem = resultUploadWorkItem.current;
          if (file && workItem) submitResult.mutate({ workItem, file });
          event.target.value = '';
        }}
      />

      <Modal
        title={tx('创建任务', 'Create task')}
        open={createOpen}
        okText={tx('创建', 'Create')}
        cancelText={tx('取消', 'Cancel')}
        confirmLoading={create.isPending}
        onCancel={() => setCreateOpen(false)}
        onOk={() => void createForm.validateFields().then((value) => create.mutate(value))}
      >
        <Form form={createForm} layout="vertical">
          <Form.Item name="description" label={tx('具体描述', 'Description')} rules={[{ required: true, max: 10000, whitespace: true }]}>
            <Input.TextArea autoFocus rows={5} placeholder={tx('描述要交付的内容、范围和验收标准', 'Describe what to deliver, the scope, and acceptance criteria')} />
          </Form.Item>
          <Form.Item name="assigneeProjectMembershipIds" label={tx('负责人（可多选）', 'Assignees (multiple)')}>
            <Select
              mode="multiple"
              maxTagCount="responsive"
              allowClear
              placeholder={tx('暂不分配', 'Leave unassigned')}
              options={projectMembers.map((member) => ({
                value: member.projectMembershipId,
                label: `${member.actorType === 'agent' ? 'Agent' : 'Human'} · ${member.displayName}`,
              }))}
            />
          </Form.Item>
          <Alert
            type="info"
            showIcon
            title={tx('任务使用独立评论区；分配或 @Agent 时才会定向唤醒。', 'Tasks have their own comment thread; an Agent is only woken when assigned or @-mentioned.')}
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
        title={tx('编辑任务', 'Edit task')}
        open={Boolean(editAction)}
        okText={tx('保存', 'Save')}
        cancelText={tx('取消', 'Cancel')}
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
          <Form.Item name="description" label={tx('具体描述', 'Description')} rules={[{ required: true, max: 10000, whitespace: true }]}>
            <Input.TextArea autoFocus rows={5} placeholder={tx('描述要交付的内容、范围和验收标准', 'Describe what to deliver, the scope, and acceptance criteria')} />
          </Form.Item>
          <Alert type="info" showIcon title={tx('只有未分配且仍在待处理的任务可以编辑。', 'Only unassigned tasks still in the backlog can be edited.')} />
        </Form>
      </Modal>

      <Modal
        title={assignmentAction?.assignees.length ? tx('更换负责人', 'Change assignee') : tx('分配负责人', 'Assign')}
        open={Boolean(assignmentAction)}
        okText={tx('确认', 'Confirm')}
        cancelText={tx('取消', 'Cancel')}
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
            label={tx('负责人（可多选）', 'Assignees (multiple)')}
            rules={[{
              validator: (_, value?: string[]) => (
                (value ?? []).slice().sort().join(',') === (assignmentAction?.assignees ?? []).map((assignee) => assignee.projectMembershipId).slice().sort().join(',')
                  ? Promise.reject(new Error(tx('请选择不同的负责人，或清空以解除分配。', 'Choose a different assignee, or clear to remove the assignment.')))
                  : Promise.resolve()
              ),
            }]}
          >
            <Select
              mode="multiple"
              maxTagCount="responsive"
              allowClear
              placeholder={tx('清空后解除分配', 'Clear to remove the assignment')}
              options={projectMembers.map((member) => ({
                value: member.projectMembershipId,
                label: `${member.actorType === 'agent' ? 'Agent' : tx('成员', 'Member')} · ${member.displayName}`,
              }))}
            />
          </Form.Item>
          <Alert
            type="info"
            showIcon
            title={tx('重新分配会更新任务版本，并让旧的待验收提交失效；分配给 Agent 时会再次通知它。', 'Reassigning bumps the task version and invalidates the previous pending submission; the Agent is notified again when assigned.')}
          />
        </Form>
      </Modal>

      <Modal
        title={reasonAction?.kind === 'block' ? tx('报告阻塞', 'Report blocker') : tx('取消任务', 'Cancel task')}
        open={Boolean(reasonAction)}
        okText={reasonAction?.kind === 'block' ? tx('确认阻塞', 'Confirm block') : tx('确认取消', 'Confirm cancel')}
        okButtonProps={{ danger: reasonAction?.kind === 'cancel' }}
        cancelText={tx('返回', 'Back')}
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
            label={reasonAction?.kind === 'block' ? tx('阻塞原因', 'Blocker reason') : tx('取消原因', 'Cancellation reason')}
            rules={reasonAction?.kind === 'block' ? [{ required: true, max: 2000 }] : [{ max: 2000 }]}
          >
            <Input.TextArea rows={4} placeholder={reasonAction?.kind === 'block' ? tx('记录一个可追溯的具体原因', 'Record a specific, traceable reason') : tx('可选填取消原因', 'Cancellation reason (optional)')} />
          </Form.Item>
        </Form>
      </Modal>
    </main>
  );
}
