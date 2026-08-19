import {
  CheckOutlined,
  DownOutlined,
  FileOutlined,
  FolderOutlined,
  InboxOutlined,
  LoadingOutlined,
  LogoutOutlined,
  MenuUnfoldOutlined,
  MessageOutlined,
  PlusOutlined,
  RobotOutlined,
  RollbackOutlined,
  SettingOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Alert,
  Avatar,
  Button,
  Card,
  Drawer,
  Dropdown,
  Empty,
  Form,
  Grid,
  Input,
  Layout,
  Modal,
  Select,
  Space,
  Spin,
  Tabs,
  Tooltip,
  Typography,
} from 'antd';
import { useEffect, useRef, useState } from 'react';
import { Navigate, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  ApiError,
  errorMessage,
  type AgentRequest,
  type Conversation,
  type CreateProjectInput,
  type Human,
} from '../api/client';
import { sessionQueryKey } from '../app';
import { WorkspaceContext, type WorkspaceContextValue, useWorkspace, workspaceKeys } from './workspace-context';
import { ArtifactsPanel } from './ArtifactsPanel';

const { Sider, Content } = Layout;
const { Text, Title } = Typography;

async function loadAll<T>(loader: (cursor?: string) => Promise<{ items: T[]; nextCursor: string | null }>): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await loader(cursor);
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
}

function agentActivityLabel(request: AgentRequest): string {
  if (request.run?.status === 'active') return '正在执行…';
  if (request.intake?.reasons.includes('runtime_unavailable')) return '等待运行时上线…';
  if (request.intake?.reasons.includes('project_working_copy_unavailable')) return '等待连接仓库…';
  if (request.intake?.reasons.includes('agent_suspended')) return 'Agent 已暂停';
  if (request.intake?.reasons.includes('authority_revoked')) return '当前会话不可用';
  return '等待执行…';
}

function useWorkspaceChanges(workspaceId: string, initialCursor: number | undefined) {
  const queryClient = useQueryClient();
  const cursor = useRef(initialCursor);
  useEffect(() => { cursor.current = initialCursor; }, [initialCursor, workspaceId]);

  useEffect(() => {
    if (initialCursor === undefined) return;
    let stopped = false;
    let running = false;
    const invalidate = async (sourceType: string, conversationId: string | null, projectId: string | null) => {
      if (sourceType === 'message' && conversationId) {
        await queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'messages'] });
      }
      if (sourceType === 'agent_request' && conversationId) {
        await queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'requests'] });
      }
      if (sourceType === 'conversation') {
        await queryClient.invalidateQueries({ queryKey: workspaceKeys.conversations(workspaceId) });
        await queryClient.invalidateQueries({ queryKey: workspaceKeys.archivedConversations(workspaceId) });
        if (projectId) {
          await queryClient.invalidateQueries({ queryKey: workspaceKeys.projectConversations(projectId) });
          await queryClient.invalidateQueries({ queryKey: workspaceKeys.projectArchivedConversations(projectId) });
        }
        if (conversationId) {
          await queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] });
          await queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'participants'] });
        }
      }
      if (sourceType === 'agent') await queryClient.invalidateQueries({ queryKey: workspaceKeys.agents(workspaceId) });
      if (sourceType === 'artifact') {
        await queryClient.invalidateQueries({ queryKey: ['workspace', workspaceId, 'artifacts'] });
        await queryClient.invalidateQueries({ queryKey: ['artifact'] });
      }
      if (sourceType === 'workspace_membership') {
        await queryClient.invalidateQueries({ queryKey: workspaceKeys.members(workspaceId) });
        await queryClient.invalidateQueries({ queryKey: ['conversation'] });
      }
      if (sourceType === 'project' || sourceType === 'project_membership' || sourceType === 'project_working_copy') {
        await queryClient.invalidateQueries({ queryKey: workspaceKeys.projects(workspaceId) });
        if (sourceType === 'project_membership') {
          await queryClient.invalidateQueries({ queryKey: ['conversation'] });
        }
        if (projectId) {
          await queryClient.invalidateQueries({ queryKey: workspaceKeys.project(projectId) });
          await queryClient.invalidateQueries({ queryKey: workspaceKeys.projectMembers(projectId) });
          await queryClient.invalidateQueries({ queryKey: workspaceKeys.projectWorkingCopies(projectId) });
        }
      }
      if (sourceType === 'workspace_invitation') await queryClient.invalidateQueries({ queryKey: workspaceKeys.invitations(workspaceId) });
      if (sourceType === 'workspace') {
        await queryClient.invalidateQueries({ queryKey: workspaceKeys.bootstrap(workspaceId) });
        await queryClient.invalidateQueries({ queryKey: workspaceKeys.list });
      }
    };
    const poll = async () => {
      if (stopped || running || document.visibilityState === 'hidden' || cursor.current === undefined) return;
      running = true;
      try {
        const page = await api.changes(workspaceId, cursor.current);
        cursor.current = page.nextCursor;
        for (const change of page.items) await invalidate(change.sourceType, change.conversationId, change.projectId);
      } catch {
        // Resource queries surface authorization or connectivity errors on their own.
      } finally {
        running = false;
      }
    };
    const interval = window.setInterval(() => void poll(), 2_000);
    const onVisible = () => { if (document.visibilityState === 'visible') void poll(); };
    window.addEventListener('online', poll);
    document.addEventListener('visibilitychange', onVisible);
    void poll();
    return () => {
      stopped = true;
      window.clearInterval(interval);
      window.removeEventListener('online', poll);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [initialCursor, queryClient, workspaceId]);
}

export function WorkspaceEntry() {
  const navigate = useNavigate();
  const [form] = Form.useForm<{ name: string }>();
  const queryClient = useQueryClient();
  const workspaces = useQuery({
    queryKey: workspaceKeys.list,
    queryFn: () => loadAll(api.listWorkspaces),
  });
  const create = useMutation({
    mutationFn: (name: string) => api.createWorkspace(name),
    onSuccess: async (workspace) => {
      localStorage.setItem('anc:last-workspace', workspace.id);
      await queryClient.invalidateQueries({ queryKey: workspaceKeys.list });
      navigate(`/w/${workspace.id}`);
    },
  });

  if (workspaces.isPending) return <div className="full-page-center"><Spin size="large" /></div>;
  if (workspaces.data?.length) {
    const remembered = localStorage.getItem('anc:last-workspace');
    const target = workspaces.data.find((workspace) => workspace.id === remembered) ?? workspaces.data[0]!;
    return <Navigate to={`/w/${target.id}`} replace />;
  }
  return (
    <main className="full-page-center page-background">
      <Card className="empty-workspace" variant="borderless">
        <RobotOutlined style={{ fontSize: 42, color: '#4f6ef7' }} />
        <Title level={2}>创建第一个 Workspace</Title>
        <Text type="secondary">Workspace 用来组织成员、Agent 和共享 Conversation。</Text>
        <Form form={form} layout="vertical" style={{ marginTop: 28 }} onFinish={({ name }) => create.mutate(name)}>
          <Form.Item name="name" label="Workspace 名称" rules={[{ required: true, max: 120 }]}>
            <Input size="large" placeholder="例如：产品团队" />
          </Form.Item>
          <Button type="primary" htmlType="submit" size="large" block loading={create.isPending}>创建 Workspace</Button>
        </Form>
        {create.error && <Text type="danger">{errorMessage(create.error)}</Text>}
      </Card>
    </main>
  );
}

export function WorkspaceHome() {
  const { workspace, conversations, agents, openNewConversation } = useWorkspace();
  const navigate = useNavigate();
  if (conversations.length > 0) {
    return <Navigate to={`/w/${workspace.id}/c/${conversations[0]!.id}`} replace />;
  }
  const activeAgents = agents.filter((agent) => agent.lifecycleStatus === 'active').length;
  return (
    <main className="full-page-center page-background workspace-home">
      <Card className="empty-workspace" variant="borderless">
        <MessageOutlined style={{ fontSize: 42, color: '#4f6ef7' }} />
        <Title level={2}>{workspace.name} 已准备好</Title>
        <Text type="secondary">
          这个 Workspace 还没有 Conversation。创建第一个 Conversation 后，就可以邀请成员或请求 Agent 协作。
        </Text>
        <Space orientation="vertical" size="middle" style={{ width: '100%', marginTop: 28 }}>
          <Button type="primary" size="large" icon={<PlusOutlined />} block onClick={openNewConversation}>
            新建 Conversation
          </Button>
          {activeAgents === 0 && (
            <Button size="large" icon={<RobotOutlined />} block onClick={() => navigate(`/w/${workspace.id}/agents`)}>
              先创建 Agent
            </Button>
          )}
        </Space>
      </Card>
    </main>
  );
}

export function WorkspaceShell() {
  const { workspaceId = '', projectId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const screens = Grid.useBreakpoint();
  const desktop = screens.lg ?? false;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [conversationModal, setConversationModal] = useState(false);
  const [archivedModal, setArchivedModal] = useState(false);
  const [projectModal, setProjectModal] = useState(false);
  const [projectCreateMode, setProjectCreateMode] = useState<'remote' | 'local'>('remote');
  const localProjectBaseline = useRef<Set<string>>(new Set());
  const [workspaceModal, setWorkspaceModal] = useState(false);
  const [conversationForm] = Form.useForm<{ title: string }>();
  const [projectForm] = Form.useForm<CreateProjectInput>();
  const [workspaceForm] = Form.useForm<{ name: string }>();
  const selectedConversationId = location.pathname.match(/\/c\/([^/]+)/)?.[1] ?? null;

  const session = queryClient.getQueryData<Human>(sessionQueryKey)!;
  const workspaceList = useQuery({ queryKey: workspaceKeys.list, queryFn: () => loadAll(api.listWorkspaces) });
  const bootstrap = useQuery({
    queryKey: workspaceKeys.bootstrap(workspaceId),
    queryFn: () => api.bootstrapWorkspace(workspaceId),
  });
  const members = useQuery({
    queryKey: workspaceKeys.members(workspaceId),
    queryFn: () => loadAll((cursor) => api.listMembers(workspaceId, cursor)),
    enabled: bootstrap.isSuccess,
  });
  const agents = useQuery({
    queryKey: workspaceKeys.agents(workspaceId),
    queryFn: () => loadAll((cursor) => api.listAgents(workspaceId, cursor)),
    enabled: bootstrap.isSuccess,
  });
  const computers = useQuery({
    queryKey: workspaceKeys.computers,
    queryFn: () => api.listComputers().then((page) => page.items),
    enabled: bootstrap.isSuccess,
    refetchInterval: 10_000,
  });
  const conversations = useQuery({
    queryKey: workspaceKeys.conversations(workspaceId),
    queryFn: () => loadAll((cursor) => api.listConversations(workspaceId, cursor)),
    enabled: bootstrap.isSuccess,
  });
  const projects = useQuery({
    queryKey: workspaceKeys.projects(workspaceId),
    queryFn: () => loadAll((cursor) => api.listProjects(workspaceId, cursor)),
    enabled: bootstrap.isSuccess,
  });
  const project = useQuery({
    queryKey: workspaceKeys.project(projectId ?? ''),
    queryFn: () => api.getProject(projectId!),
    enabled: bootstrap.isSuccess && Boolean(projectId),
  });
  const projectMembers = useQuery({
    queryKey: workspaceKeys.projectMembers(projectId ?? ''),
    queryFn: () => loadAll((cursor) => api.listProjectMembers(projectId!, cursor)),
    enabled: project.isSuccess && !project.data.governanceOnly,
  });
  const projectConversations = useQuery({
    queryKey: workspaceKeys.projectConversations(projectId ?? ''),
    queryFn: () => loadAll((cursor) => api.listProjectConversations(projectId!, cursor)),
    enabled: project.isSuccess && !project.data.governanceOnly,
  });
  const archivedConversations = useQuery({
    queryKey: projectId
      ? workspaceKeys.projectArchivedConversations(projectId)
      : workspaceKeys.archivedConversations(workspaceId),
    queryFn: () => loadAll((cursor) => projectId
      ? api.listProjectConversations(projectId, cursor, 'archived')
      : api.listConversations(workspaceId, cursor, 'archived')),
    enabled: archivedModal && bootstrap.isSuccess && (!projectId || (project.isSuccess && !project.data.governanceOnly)),
  });
  const agentRequests = useQuery({
    queryKey: ['conversation', selectedConversationId, 'requests'],
    queryFn: () => api.listAgentRequests(selectedConversationId!).then((page) => page.items),
    enabled: bootstrap.isSuccess && selectedConversationId !== null,
    refetchInterval: 2_000,
  });
  const currentConversations = projectId ? (projectConversations.data ?? []) : (conversations.data ?? []);
  const workspaceDirectConversations = (conversations.data ?? []).filter((conversation) => conversation.kind === 'dm');
  const directConversationIds = workspaceDirectConversations.map((conversation) => conversation.id);
  const directMessageParticipants = useQuery({
    queryKey: ['workspace', workspaceId, 'direct-message-participants', directConversationIds],
    queryFn: async () => Object.fromEntries(await Promise.all(directConversationIds.map(async (conversationId) => {
      const page = await api.listParticipants(conversationId);
      return [conversationId, page.items] as const;
    }))),
    enabled: directConversationIds.length > 0,
  });
  useWorkspaceChanges(workspaceId, bootstrap.data?.changeCursor);
  useEffect(() => {
    if (!projectModal || projectCreateMode !== 'local') return;
    const created = (projects.data ?? []).find((item) => (
      !item.governanceOnly && !localProjectBaseline.current.has(item.id)
    ));
    if (!created) return;
    setProjectModal(false);
    navigate(`/w/${workspaceId}/p/${created.id}`);
  }, [projectCreateMode, projectModal, projects.data, navigate, workspaceId]);

  const createConversation = useMutation({
    mutationFn: (value: { title: string }) => projectId
      ? api.createProjectConversation(projectId, {
          kind: 'channel',
          title: value.title.trim(),
        })
      : api.createConversation(workspaceId, {
          kind: 'channel',
          title: value.title.trim(),
        }),
    onSuccess: async (conversation) => {
      setConversationModal(false);
      conversationForm.resetFields();
      await queryClient.invalidateQueries({ queryKey: workspaceKeys.conversations(workspaceId) });
      if (projectId) await queryClient.invalidateQueries({ queryKey: workspaceKeys.projectConversations(projectId) });
      navigate(projectId
        ? `/w/${workspaceId}/p/${projectId}/c/${conversation.id}`
        : `/w/${workspaceId}/c/${conversation.id}`);
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const restoreArchivedConversation = useMutation({
    mutationFn: (conversation: Conversation) => api.restoreConversation(conversation.id, conversation.revision),
    onSuccess: async (restored) => {
      queryClient.setQueryData(['conversation', restored.id], restored);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workspaceKeys.conversations(workspaceId) }),
        queryClient.invalidateQueries({ queryKey: workspaceKeys.archivedConversations(workspaceId) }),
        ...(restored.projectId ? [
          queryClient.invalidateQueries({ queryKey: workspaceKeys.projectConversations(restored.projectId) }),
          queryClient.invalidateQueries({ queryKey: workspaceKeys.projectArchivedConversations(restored.projectId) }),
        ] : []),
      ]);
      void message.success('Conversation 已恢复');
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const openDirectMessage = useMutation({
    mutationFn: async (targetMembershipId: string) => {
      const ownMembershipId = bootstrap.data?.workspace.membershipId;
      if (!ownMembershipId || targetMembershipId === ownMembershipId) {
        throw new Error('不能与自己发起私信。');
      }
      const participantsByConversation = directMessageParticipants.data ?? Object.fromEntries(
        await Promise.all(workspaceDirectConversations.map(async (conversation) => {
          const page = await api.listParticipants(conversation.id);
          return [conversation.id, page.items] as const;
        })),
      );
      const existing = workspaceDirectConversations.find((conversation) => {
        const participantIds = (participantsByConversation[conversation.id] ?? [])
          .map((participant) => participant.workspaceMembershipId);
        return participantIds.length === 2
          && participantIds.includes(ownMembershipId)
          && participantIds.includes(targetMembershipId);
      });
      if (existing) return existing;
      return api.createConversation(workspaceId, {
        kind: 'dm',
        directWorkspaceMembershipIds: [targetMembershipId],
      });
    },
    onSuccess: async (conversation) => {
      await queryClient.invalidateQueries({ queryKey: workspaceKeys.conversations(workspaceId) });
      setSidebarOpen(false);
      navigate(`/w/${workspaceId}/c/${conversation.id}`);
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const createProject = useMutation({
    mutationFn: (value: CreateProjectInput) => {
      const cloneUrl = value.repository?.cloneUrl?.trim();
      return api.createProject(workspaceId, {
        name: value.name.trim(),
        description: value.description?.trim() || null,
        ...(cloneUrl ? { repository: {
          cloneUrl,
          defaultBranch: value.repository?.defaultBranch?.trim() || 'main',
        } } : {}),
      });
    },
    onSuccess: async (created) => {
      projectForm.resetFields();
      setProjectModal(false);
      await queryClient.invalidateQueries({ queryKey: workspaceKeys.projects(workspaceId) });
      navigate(`/w/${workspaceId}/p/${created.id}`);
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const recoverProjectGovernance = useMutation({
    mutationFn: () => api.addProjectMember(projectId!, {
      workspaceMembershipId: bootstrap.data!.workspace.membershipId,
      role: 'manager',
    }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workspaceKeys.project(projectId!) }),
        queryClient.invalidateQueries({ queryKey: workspaceKeys.projectMembers(projectId!) }),
        queryClient.invalidateQueries({ queryKey: workspaceKeys.projects(workspaceId) }),
      ]);
      void message.success('已加入 Project；现在可以访问全部 Project Channel 并执行恢复治理。');
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const createWorkspace = useMutation({
    mutationFn: ({ name }: { name: string }) => api.createWorkspace(name.trim()),
    onSuccess: async (created) => {
      workspaceForm.resetFields();
      setWorkspaceModal(false);
      await queryClient.invalidateQueries({ queryKey: workspaceKeys.list });
      setSidebarOpen(false);
      navigate(`/w/${created.id}`);
    },
  });
  const finishLogout = () => {
    queryClient.clear();
    navigate('/login', { replace: true });
  };
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: finishLogout,
    onError: (error) => {
      if (error instanceof ApiError && error.status === 401) {
        finishLogout();
        return;
      }
      void message.error(errorMessage(error));
    },
  });

  useEffect(() => {
    localStorage.setItem('anc:last-workspace', workspaceId);
  }, [workspaceId]);

  if (bootstrap.isPending || members.isPending || agents.isPending || conversations.isPending || projects.isPending
    || (projectId && project.isPending)
    || (project.isSuccess && !project.data.governanceOnly && (projectMembers.isPending || projectConversations.isPending))) {
    return <div className="full-page-center"><Spin size="large" /></div>;
  }
  if (bootstrap.isError || members.isError || agents.isError || conversations.isError || projects.isError
    || project.isError || projectMembers.isError || projectConversations.isError) {
    return (
      <div className="full-page-center">
        <Empty description={errorMessage(
          bootstrap.error || members.error || agents.error || conversations.error || projects.error
          || project.error || projectMembers.error || projectConversations.error,
        )}>
          <Button onClick={() => navigate('/')}>返回 Workspace 列表</Button>
        </Empty>
      </div>
    );
  }
  const selectedProject = project.data;
  if (projectId && selectedProject?.governanceOnly) {
    return (
      <div className="full-page-center">
        <Card title={selectedProject.name} style={{ width: 520, maxWidth: 'calc(100vw - 32px)' }}>
          <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
            <Text type="secondary">
              你当前只有 Workspace 治理元数据权限：{selectedProject.activeMemberCount} 位成员，{selectedProject.conversationCount} 个 Conversation。成员和内容尚不可见。
            </Text>
            <Button
              type="primary"
              loading={recoverProjectGovernance.isPending}
              onClick={() => recoverProjectGovernance.mutate()}
            >
              以 Manager 身份加入并恢复治理
            </Button>
            <Button onClick={() => navigate(`/w/${workspaceId}/projects`)}>返回项目列表</Button>
          </Space>
        </Card>
      </div>
    );
  }

  const workspace = bootstrap.data.workspace;
  const selectedKey = projectId && location.pathname.endsWith('/members') ? 'project-members'
    : projectId && location.pathname.endsWith(`/p/${projectId}`) ? 'project-profile'
    : location.pathname.endsWith('/projects') ? 'projects'
    : location.pathname.includes('/agents') ? 'agents'
    : location.pathname.includes('/members') ? 'members'
      : location.pathname.includes('/settings') ? 'settings'
        : selectedConversationId ?? '';
  const primarySection = projectId || selectedKey === 'projects' ? 'projects' : selectedKey === 'agents' || selectedKey === 'members'
    ? 'members'
    : selectedKey === 'settings' ? 'settings' : 'chat';
  const showArtifactsPanel = selectedKey !== 'project-profile';
  const selectedAgentId = location.pathname.match(/\/agents\/([^/]+)/)?.[1] ?? null;

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: workspaceKeys.bootstrap(workspaceId) }),
      queryClient.invalidateQueries({ queryKey: workspaceKeys.members(workspaceId) }),
      queryClient.invalidateQueries({ queryKey: workspaceKeys.agents(workspaceId) }),
      queryClient.invalidateQueries({ queryKey: workspaceKeys.conversations(workspaceId) }),
      queryClient.invalidateQueries({ queryKey: workspaceKeys.archivedConversations(workspaceId) }),
      queryClient.invalidateQueries({ queryKey: workspaceKeys.projects(workspaceId) }),
      ...(projectId ? [
        queryClient.invalidateQueries({ queryKey: workspaceKeys.project(projectId) }),
        queryClient.invalidateQueries({ queryKey: workspaceKeys.projectMembers(projectId) }),
        queryClient.invalidateQueries({ queryKey: workspaceKeys.projectConversations(projectId) }),
        queryClient.invalidateQueries({ queryKey: workspaceKeys.projectArchivedConversations(projectId) }),
      ] : []),
    ]);
  };

  const availableWorkspaces = workspaceList.data?.length ? workspaceList.data : [workspace];
  const workspaceMenu = {
    items: [
      ...availableWorkspaces.map((item) => ({
        key: item.id,
        label: (
          <div className="workspace-menu-item">
            <span className="workspace-menu-avatar">{item.name.slice(0, 1).toUpperCase()}</span>
            <span>{item.name}</span>
            {item.id === workspaceId && <CheckOutlined />}
          </div>
        ),
      })),
      { type: 'divider' as const },
      { key: 'create-workspace', icon: <PlusOutlined />, label: '创建 Workspace' },
    ],
    onClick: ({ key }: { key: string }) => {
      if (key === 'create-workspace') setWorkspaceModal(true);
      else if (key !== workspaceId) {
        setSidebarOpen(false);
        navigate(`/w/${key}`);
      }
    },
  };
  const workspaceButton = (expanded = false) => (
    <Dropdown menu={workspaceMenu} trigger={['click']} placement="bottomLeft">
      <Button className={expanded ? 'mobile-workspace-switcher' : 'workspace-rail-switcher'} aria-label="切换 Workspace">
        <span className="workspace-rail-avatar">{workspace.name.slice(0, 1).toUpperCase()}</span>
        {expanded && <><span className="mobile-workspace-name">{workspace.name}</span><DownOutlined /></>}
      </Button>
    </Dropdown>
  );
  const go = (path: string) => {
    setSidebarOpen(false);
    navigate(`/w/${workspaceId}${path}`);
  };
  const openArchivedConversation = (conversation: Conversation) => {
    setArchivedModal(false);
    go(conversation.projectId
      ? `/p/${conversation.projectId}/c/${conversation.id}`
      : `/c/${conversation.id}`);
  };
  const canManageConversation = (conversation: Conversation) => conversation.kind === 'dm'
    || conversation.createdByMembershipId === workspace.membershipId
    || workspace.membershipRole === 'owner'
    || (conversation.projectId !== null && project.data?.role === 'manager');
  const rail = (
    <nav className="workspace-rail" aria-label="Workspace 主导航">
      {workspaceButton()}
      <div className="rail-nav">
        <Tooltip title="协作" placement="right"><Button aria-label="协作" className={primarySection === 'chat' ? 'rail-button active' : 'rail-button'} icon={<MessageOutlined />} onClick={() => go('')} /></Tooltip>
        <Tooltip title="项目" placement="right"><Button aria-label="项目" className={primarySection === 'projects' ? 'rail-button active' : 'rail-button'} icon={<FolderOutlined />} onClick={() => go('/projects')} /></Tooltip>
        <Tooltip title="团队" placement="right"><Button aria-label="团队" className={primarySection === 'members' ? 'rail-button active' : 'rail-button'} icon={<TeamOutlined />} onClick={() => go('/agents')} /></Tooltip>
      </div>
      <div className="rail-bottom">
        <Tooltip title="Workspace 设置" placement="right"><Button aria-label="Workspace 设置" className={primarySection === 'settings' ? 'rail-button active' : 'rail-button'} icon={<SettingOutlined />} onClick={() => go('/settings')} /></Tooltip>
        <Dropdown
          trigger={['click']}
          placement="topLeft"
          menu={{ items: [{ key: 'logout', icon: <LogoutOutlined />, label: '退出登录', danger: true }], onClick: () => logout.mutate() }}
        >
          <Tooltip title={session.displayName} placement="right"><Button aria-label="账户菜单" className="rail-account"><Avatar size={28} icon={<UserOutlined />} /></Button></Tooltip>
        </Dropdown>
      </div>
    </nav>
  );
  const conversationItem = (conversation: Conversation) => {
    const otherParticipant = directMessageParticipants.data?.[conversation.id]
      ?.find((participant) => participant.workspaceMembershipId !== workspace.membershipId);
    return (
    <button
      type="button"
      key={conversation.id}
      className={selectedKey === conversation.id ? 'sidebar-row active' : 'sidebar-row'}
      onClick={() => go(conversation.projectId
        ? `/p/${conversation.projectId}/c/${conversation.id}`
        : `/c/${conversation.id}`)}
    >
      <span className="sidebar-row-icon">{conversation.kind === 'dm' ? <UserOutlined /> : '#'}</span>
      <span className="sidebar-row-label">{conversation.kind === 'dm' ? otherParticipant?.displayName ?? '私聊' : conversation.title || '未命名会话'}</span>
    </button>
    );
  };
  const channelConversations = currentConversations.filter((item) => item.kind === 'channel');
  const directConversations = workspaceDirectConversations;
  const visibleProjects = projects.data.filter((item) => !item.governanceOnly);
  const governanceProjects = projects.data.filter((item) => item.governanceOnly);
  const activeAgentRequests = (agentRequests.data ?? []).filter((request) => (
    request.status === 'pending' || request.run?.status === 'active'
  ));
  const openConversation = () => {
    conversationForm.resetFields();
    setConversationModal(true);
  };
  const openProjectModal = () => {
    setProjectCreateMode('remote');
    projectForm.resetFields();
    projectForm.setFieldsValue({ name: '' });
    setProjectModal(true);
  };
  const contextualSidebar = (
    <aside className="context-sidebar">
      <div className="mobile-workspace-header">{workspaceButton(true)}</div>
      {!desktop && (
        <section className="sidebar-section">
          <div className="sidebar-section-heading"><span>主导航</span></div>
          <button type="button" className={primarySection === 'chat' ? 'sidebar-row active' : 'sidebar-row'} onClick={() => go('')}>
            <MessageOutlined /><span className="sidebar-row-label">协作</span>
          </button>
          <button type="button" className={primarySection === 'projects' ? 'sidebar-row active' : 'sidebar-row'} onClick={() => go('/projects')}>
            <FolderOutlined /><span className="sidebar-row-label">项目</span>
          </button>
          <button type="button" className={primarySection === 'members' ? 'sidebar-row active' : 'sidebar-row'} onClick={() => go('/agents')}>
            <TeamOutlined /><span className="sidebar-row-label">团队</span>
          </button>
          <button type="button" className={primarySection === 'settings' ? 'sidebar-row active' : 'sidebar-row'} onClick={() => go('/settings')}>
            <SettingOutlined /><span className="sidebar-row-label">Workspace 设置</span>
          </button>
        </section>
      )}
      {primarySection === 'chat' && (
        <>
          <header className="context-sidebar-title">协作</header>
          <div className="sidebar-scroll">
            <section className="sidebar-section">
              <div className="sidebar-section-heading"><span>Workspace 会话 <small>{channelConversations.length}</small></span><Button type="text" size="small" aria-label="新建会话" icon={<PlusOutlined />} onClick={openConversation} /></div>
              {channelConversations.map(conversationItem)}
              {!channelConversations.length && <div className="sidebar-empty">还没有 Channel</div>}
            </section>
            <section className="sidebar-section">
              <div className="sidebar-section-heading"><span>私聊 <small>{directConversations.length}</small></span></div>
              {directConversations.map(conversationItem)}
              {!directConversations.length && <div className="sidebar-empty">从团队成员列表发起私信</div>}
            </section>
            <section className="sidebar-section">
              <button type="button" className="sidebar-row" onClick={() => setArchivedModal(true)}>
                <span className="sidebar-row-icon"><InboxOutlined /></span>
                <span className="sidebar-row-label">已归档 Conversation</span>
              </button>
            </section>
          </div>
          {activeAgentRequests.length > 0 && (
            <div className="sidebar-agent-activity" aria-live="polite">
              {activeAgentRequests.map((request) => {
                const agent = agents.data.find((item) => item.id === request.targetAgentId);
                const name = agent?.name ?? 'Agent';
                return (
                  <div className="sidebar-agent-activity-row" key={request.id}>
                    <span className="member-avatar agent">{name.slice(0, 1).toUpperCase()}</span>
                    <span className="sidebar-agent-activity-copy">
                      <strong>{name}</strong>
                      <small><LoadingOutlined spin /> {agentActivityLabel(request)}</small>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
      {primarySection === 'projects' && (
        <>
          <header className="context-sidebar-title">{projectId ? project.data!.name : '项目'}</header>
          <div className="sidebar-scroll">
            {projectId ? (
              <>
                <section className="sidebar-section">
                  <button type="button" className="sidebar-row" onClick={() => go('/projects')}>
                    <span className="sidebar-row-icon">←</span><span className="sidebar-row-label">返回项目列表</span>
                  </button>
                </section>
                <section className="sidebar-section">
                  <div className="sidebar-section-heading"><span>项目会话 <small>{channelConversations.length}</small></span><Button type="text" size="small" aria-label="新建项目会话" icon={<PlusOutlined />} onClick={openConversation} /></div>
                  {channelConversations.map(conversationItem)}
                  {!channelConversations.length && <div className="sidebar-empty">还没有 Channel</div>}
                  <button type="button" className="sidebar-row" onClick={() => setArchivedModal(true)}>
                    <span className="sidebar-row-icon"><InboxOutlined /></span>
                    <span className="sidebar-row-label">已归档 Conversation</span>
                  </button>
                </section>
                <section className="sidebar-section">
                  <div className="sidebar-section-heading"><span>项目管理</span></div>
                  <button type="button" className={selectedKey === 'project-profile' ? 'sidebar-row active' : 'sidebar-row'} onClick={() => go(`/p/${projectId}`)}>
                    <FolderOutlined /><span className="sidebar-row-label">资料与 Repository</span>
                  </button>
                  <button type="button" className={selectedKey === 'project-members' ? 'sidebar-row active' : 'sidebar-row'} onClick={() => go(`/p/${projectId}/members`)}>
                    <TeamOutlined /><span className="sidebar-row-label">成员</span>
                  </button>
                </section>
              </>
            ) : (
              <>
                <section className="sidebar-section">
                  <div className="sidebar-section-heading">
                    <span>项目 <small>{visibleProjects.length}</small></span>
                    <Button type="text" size="small" aria-label="新建项目" icon={<PlusOutlined />} onClick={openProjectModal} />
                  </div>
                  {visibleProjects.map((item) => (
                    <button type="button" className="sidebar-row" key={item.id} onClick={() => go(`/p/${item.id}`)}>
                      <span className="sidebar-row-icon"><FolderOutlined /></span>
                      <span className="sidebar-row-label">{item.name}</span>
                    </button>
                  ))}
                  {!visibleProjects.length && <div className="sidebar-empty">还没有项目</div>}
                </section>
                {governanceProjects.length > 0 && (
                  <section className="sidebar-section">
                    <div className="sidebar-section-heading"><span>项目治理 <small>{governanceProjects.length}</small></span></div>
                    {governanceProjects.map((item) => (
                      <button type="button" className="sidebar-row" key={item.id} onClick={() => go(`/p/${item.id}`)}>
                        <span className="sidebar-row-icon"><SettingOutlined /></span>
                        <span className="sidebar-row-label">{item.name} · 仅元数据</span>
                      </button>
                    ))}
                  </section>
                )}
              </>
            )}
          </div>
          {projectId && activeAgentRequests.length > 0 && (
            <div className="sidebar-agent-activity" aria-live="polite">
              {activeAgentRequests.map((request) => {
                const agent = agents.data.find((item) => item.id === request.targetAgentId);
                const name = agent?.name ?? 'Agent';
                return (
                  <div className="sidebar-agent-activity-row" key={request.id}>
                    <span className="member-avatar agent">{name.slice(0, 1).toUpperCase()}</span>
                    <span className="sidebar-agent-activity-copy">
                      <strong>{name}</strong>
                      <small><LoadingOutlined spin /> {agentActivityLabel(request)}</small>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
      {primarySection === 'members' && (
        <>
          <header className="context-sidebar-title">团队</header>
          <div className="sidebar-scroll">
            <section className="sidebar-section">
              <div className="sidebar-section-heading"><span>Agent <small>{agents.data.length}</small></span><Button type="text" size="small" aria-label="管理 Agent" icon={<PlusOutlined />} onClick={() => go('/agents')} /></div>
              {agents.data.map((agent) => {
                const computer = computers.data?.find((item) => item.id === agent.runtimeBinding?.computerId);
                const runtimeConnected = Boolean(agent.runtimeBinding && computer?.connectionStatus === 'online');
                return (
                <div key={agent.id} className={selectedAgentId === agent.id ? 'sidebar-member-row active-soft' : 'sidebar-member-row'}>
                  <button type="button" className="sidebar-member-main" onClick={() => go(`/agents/${agent.id}`)}>
                    <span className="member-avatar agent">{agent.name.slice(0, 1).toUpperCase()}</span>
                    <span className="sidebar-row-label">{agent.name}</span>
                    <span
                      className={runtimeConnected ? 'runtime-unbound-dot connected' : 'runtime-unbound-dot'}
                      title={agent.runtimeBinding ? `${agent.runtimeBinding.computerName} · ${runtimeConnected ? '已连接' : '离线'}` : '尚未选择计算机和运行时'}
                    />
                  </button>
                  <Tooltip title={`与 ${agent.name} 私聊`}>
                    <Button
                      type="text"
                      size="small"
                      aria-label={`与 ${agent.name} 私聊`}
                      icon={<MessageOutlined />}
                      loading={openDirectMessage.isPending && openDirectMessage.variables === agent.membershipId}
                      onClick={() => openDirectMessage.mutate(agent.membershipId)}
                    />
                  </Tooltip>
                </div>
                );
              })}
              {!agents.data.length && <div className="sidebar-empty">还没有 Agent</div>}
            </section>
            <section className="sidebar-section">
              <div className="sidebar-section-heading"><span>Human 成员 <small>{members.data.filter((item) => item.actorType === 'human').length}</small></span><Button type="text" size="small" aria-label="管理 Human 成员" icon={<PlusOutlined />} onClick={() => go('/members')} /></div>
              {members.data.filter((item) => item.actorType === 'human').map((member) => (
                <div key={member.membershipId} className={selectedKey === 'members' ? 'sidebar-member-row active-soft' : 'sidebar-member-row'}>
                  <button type="button" className="sidebar-member-main" onClick={() => go('/members')}>
                    <span className="member-avatar human">{member.displayName.slice(0, 1).toUpperCase()}</span>
                    <span className="sidebar-row-label">{member.displayName}</span>
                    {member.membershipId === workspace.membershipId && <small>you</small>}
                  </button>
                  {member.membershipId !== workspace.membershipId && (
                    <Tooltip title={`与 ${member.displayName} 私聊`}>
                      <Button
                        type="text"
                        size="small"
                        aria-label={`与 ${member.displayName} 私聊`}
                        icon={<MessageOutlined />}
                        loading={openDirectMessage.isPending && openDirectMessage.variables === member.membershipId}
                        onClick={() => openDirectMessage.mutate(member.membershipId)}
                      />
                    </Tooltip>
                  )}
                </div>
              ))}
            </section>
          </div>
        </>
      )}
      {primarySection === 'settings' && (
        <>
          <header className="context-sidebar-title">Workspace</header>
          <div className="sidebar-scroll sidebar-section">
            <button type="button" className="sidebar-row active" onClick={() => go('/settings')}><SettingOutlined /><span className="sidebar-row-label">基本设置</span></button>
            <button type="button" className="sidebar-row" onClick={() => go('/members')}><TeamOutlined /><span className="sidebar-row-label">成员与邀请</span></button>
            <button type="button" className="sidebar-row" onClick={() => go('/agents')}><RobotOutlined /><span className="sidebar-row-label">Agent</span></button>
          </div>
        </>
      )}
    </aside>
  );

  const context: WorkspaceContextValue = {
    workspace,
    members: members.data,
    agents: agents.data,
    conversations: currentConversations,
    projects: visibleProjects,
    project: projectId ? project.data! : null,
    projectMembers: projectId ? projectMembers.data ?? [] : [],
    openNewProject: openProjectModal,
    openNewConversation: openConversation,
    openDirectMessage: async (membershipId) => {
      await openDirectMessage.mutateAsync(membershipId).catch(() => undefined);
    },
    openingDirectMessageMembershipId: openDirectMessage.isPending ? openDirectMessage.variables ?? null : null,
    refresh,
  };

  return (
    <WorkspaceContext.Provider value={context}>
      <Layout className="workspace-layout">
        {desktop ? (
          <>
            {rail}
            <Sider className="workspace-sidebar" width={244} trigger={null}>{contextualSidebar}</Sider>
          </>
        ) : (
          <Drawer open={sidebarOpen} placement="left" size={300} styles={{ body: { padding: 0 } }} onClose={() => setSidebarOpen(false)}>
            {contextualSidebar}
          </Drawer>
        )}
        <Layout>
          <Content className="workspace-main">
            <Button
              className="sidebar-toggle"
              type="text"
              icon={<MenuUnfoldOutlined />}
              onClick={() => setSidebarOpen(true)}
            />
            {!desktop && showArtifactsPanel && (
              <Button
                className="artifacts-toggle"
                type="text"
                icon={<FileOutlined />}
                aria-label="打开 Artifacts"
                onClick={() => setArtifactsOpen(true)}
              />
            )}
            <Outlet />
          </Content>
        </Layout>
        {desktop && showArtifactsPanel && (
          <Sider className="workspace-artifacts-sider" width={300} trigger={null}>
            <ArtifactsPanel
              workspaceId={workspaceId}
              projectId={projectId ?? null}
              canManageProject={project.data?.role === 'manager' || bootstrap.data?.workspace.membershipRole === 'owner'}
            />
          </Sider>
        )}
      </Layout>
      {!desktop && showArtifactsPanel && (
        <Drawer
          open={artifactsOpen}
          placement="right"
          size={320}
          styles={{ body: { padding: 0 } }}
          onClose={() => setArtifactsOpen(false)}
        >
          <ArtifactsPanel
            workspaceId={workspaceId}
            projectId={projectId ?? null}
            canManageProject={project.data?.role === 'manager' || bootstrap.data?.workspace.membershipRole === 'owner'}
          />
        </Drawer>
      )}
      <Modal
        title={projectId ? `在 ${project.data!.name} 中新建会话` : '新建工作区会话'}
        open={conversationModal}
        forceRender
        okText="创建"
        cancelText="取消"
        confirmLoading={createConversation.isPending}
        onCancel={() => setConversationModal(false)}
        onOk={() => void conversationForm.validateFields().then((value) => createConversation.mutate(value))}
      >
        <Form form={conversationForm} layout="vertical">
          <Form.Item name="title" label="标题" rules={[{ required: true, max: 200 }]}><Input aria-label="标题" /></Form.Item>
          <Alert type="info" showIcon title={projectId ? '成员与当前 Project 自动同步。' : '成员与当前 Workspace 自动同步。'} />
        </Form>
        {createConversation.error && <Text type="danger">{errorMessage(createConversation.error)}</Text>}
      </Modal>
      <Modal
        title={projectId ? `${project.data?.name ?? 'Project'} · 已归档 Conversation` : '已归档 Conversation'}
        open={archivedModal}
        footer={<Button onClick={() => setArchivedModal(false)}>关闭</Button>}
        onCancel={() => setArchivedModal(false)}
      >
        {archivedConversations.isError ? (
          <Alert type="error" showIcon title={errorMessage(archivedConversations.error)} />
        ) : archivedConversations.isPending ? (
          <div className="archived-conversation-loading"><Spin /></div>
        ) : archivedConversations.data?.length ? (
          <div className="archived-conversation-list">
            {archivedConversations.data.map((conversation) => (
              <div className="archived-conversation-row" key={conversation.id}>
                <Avatar icon={conversation.kind === 'dm' ? <UserOutlined /> : <MessageOutlined />} />
                <div className="archived-conversation-copy">
                  <strong>{conversation.kind === 'dm' ? '私聊' : conversation.title || '未命名会话'}</strong>
                  <Text type="secondary">
                    {conversation.archivedAt
                      ? `归档于 ${new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(conversation.archivedAt)}`
                      : '已归档'}
                  </Text>
                </div>
                <Space size={4}>
                  <Button type="link" onClick={() => openArchivedConversation(conversation)}>查看历史</Button>
                  {canManageConversation(conversation) && (
                    <Button
                      type="link"
                      icon={<RollbackOutlined />}
                      loading={restoreArchivedConversation.isPending && restoreArchivedConversation.variables?.id === conversation.id}
                      onClick={() => restoreArchivedConversation.mutate(conversation)}
                    >
                      恢复
                    </Button>
                  )}
                </Space>
              </div>
            ))}
          </div>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有已归档的 Conversation" />
        )}
      </Modal>
      <Modal
        title="创建项目"
        open={projectModal}
        okText="创建 Project"
        cancelText="取消"
        confirmLoading={createProject.isPending}
        onCancel={() => setProjectModal(false)}
        {...(projectCreateMode === 'remote'
          ? { onOk: () => void projectForm.validateFields().then((value) => createProject.mutate(value)) }
          : { footer: <Button onClick={() => setProjectModal(false)}>关闭</Button> })}
      >
        <Tabs
          activeKey={projectCreateMode}
          onChange={(key) => {
            const mode = key as 'remote' | 'local';
            setProjectCreateMode(mode);
            if (mode === 'local') localProjectBaseline.current = new Set(visibleProjects.map((item) => item.id));
          }}
          items={[
            {
              key: 'remote',
              label: '协作 Project',
              children: (
                <Form form={projectForm} layout="vertical" initialValues={{ repository: { defaultBranch: 'main' } }}>
                  <Form.Item name="name" label="Project 名称" rules={[{ required: true, max: 120 }]}>
                    <Input autoFocus placeholder="例如：agent-platform" />
                  </Form.Item>
                  <Form.Item name="description" label="描述（可选）" rules={[{ max: 3000 }]}>
                    <Input.TextArea rows={3} placeholder="这个 Repository 承载什么工作？" />
                  </Form.Item>
                  <Form.Item name={['repository', 'cloneUrl']} label="Primary Repository Clone URL（可选）" rules={[{ max: 2000 }]}>
                    <Input placeholder="可以稍后挂载" />
                  </Form.Item>
                  <Form.Item name={['repository', 'defaultBranch']} label="默认分支" rules={[{ max: 255 }]}>
                    <Input placeholder="main" />
                  </Form.Item>
                  <Alert type="info" showIcon title="Repository 不是 Project 成立条件；没有仓库时 Agent 在隔离 scratch workdir 中运行。" />
                </Form>
              ),
            },
            {
              key: 'local',
              label: '本地 Repository',
              children: (
                <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
                  <Alert
                    type="info"
                    showIcon
                    title="从本机 checkout 创建"
                    description="目录路径与 Git 凭据只保存在 anc-computer 本地，不会发送到 Workspace 服务。"
                  />
                  <div className="command-block">
                    <code>{`anc-computer project create --workspace ${workspaceId}`}</code>
                    <Button size="small" onClick={() => void navigator.clipboard.writeText(`anc-computer project create --workspace ${workspaceId}`)}>复制</Button>
                  </div>
                  <Text type="secondary">命令完成后，此页面会自动刷新并进入新 Project。</Text>
                </Space>
              ),
            },
          ]}
        />
        {createProject.error && <Text type="danger">{errorMessage(createProject.error)}</Text>}
      </Modal>
      <Modal
        title="创建 Workspace"
        open={workspaceModal}
        okText="创建"
        cancelText="取消"
        confirmLoading={createWorkspace.isPending}
        onCancel={() => setWorkspaceModal(false)}
        onOk={() => void workspaceForm.validateFields().then((value) => createWorkspace.mutate(value))}
      >
        <Form form={workspaceForm} layout="vertical">
          <Form.Item name="name" label="Workspace 名称" rules={[{ required: true, max: 120 }]}><Input autoFocus /></Form.Item>
        </Form>
        {createWorkspace.error && <Text type="danger">{errorMessage(createWorkspace.error)}</Text>}
      </Modal>
    </WorkspaceContext.Provider>
  );
}
