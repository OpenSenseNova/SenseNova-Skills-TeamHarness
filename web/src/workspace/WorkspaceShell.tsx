import {
  CheckOutlined,
  DownOutlined,
  FileOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  InboxOutlined,
  LockOutlined,
  LoadingOutlined,
  LogoutOutlined,
  MenuUnfoldOutlined,
  MessageOutlined,
  PlusOutlined,
  ProjectOutlined,
  RobotOutlined,
  RollbackOutlined,
  SettingOutlined,
  TeamOutlined,
  UserOutlined,
  WarningOutlined,
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
  Tooltip,
  Typography,
} from 'antd';
import { useEffect, useRef, useState } from 'react';
import { Navigate, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  ApiError,
  errorMessage,
  type AgentActivityEvent,
  type AgentRequest,
  type Conversation,
  type CreateProjectInput,
  type Human,
  type Project,
} from '../api/client';
import { sessionQueryKey } from '../app';
import { WorkspaceContext, type WorkspaceContextValue, useWorkspace, workspaceKeys } from './workspace-context';
import { ArtifactsPanel } from './ArtifactsPanel';
import { agentActivityIcon, agentActivityTone } from './agent-activity-presentation';
import { readArchivedProjectIds, writeArchivedProjectIds } from './project-archive';
import { ThemeToggleButton, useThemeMode } from '../theme';
import { loadAllPages } from '../lib/pagination';

const { Sider, Content } = Layout;
const { Text, Title } = Typography;

function agentActivityLabel(request: AgentRequest): string {
  if (request.intake?.reasons.includes('runtime_unavailable')) return '等待本地 Agent 上线…';
  if (request.intake?.reasons.includes('agent_suspended')) return 'Agent 已暂停';
  if (request.intake?.reasons.includes('authority_revoked')) return '当前会话不可用';
  return '有待处理消息…';
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
        if (projectId) await queryClient.invalidateQueries({ queryKey: workspaceKeys.projectArtifacts(projectId) });
        await queryClient.invalidateQueries({ queryKey: ['artifact-v2'] });
      }
      if (sourceType === 'workspace_membership') {
        await queryClient.invalidateQueries({ queryKey: workspaceKeys.members(workspaceId) });
        await queryClient.invalidateQueries({ queryKey: ['conversation'] });
      }
      if (sourceType === 'project' || sourceType === 'project_membership') {
        await queryClient.invalidateQueries({ queryKey: workspaceKeys.projects(workspaceId) });
        if (sourceType === 'project_membership') {
          await queryClient.invalidateQueries({ queryKey: ['conversation'] });
        }
        if (projectId) {
          await queryClient.invalidateQueries({ queryKey: workspaceKeys.project(projectId) });
          await queryClient.invalidateQueries({ queryKey: workspaceKeys.projectMembers(projectId) });
        }
      }
      if (sourceType === 'work_item' && projectId) {
        await queryClient.invalidateQueries({ queryKey: workspaceKeys.projectWorkItems(projectId) });
      }
      if (sourceType === 'workspace_join_link') await queryClient.invalidateQueries({ queryKey: workspaceKeys.joinLinks(workspaceId) });
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
    queryFn: () => loadAllPages(api.listWorkspaces),
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
      <ThemeToggleButton className="entry-theme-toggle" compact />
      <Card className="empty-workspace" variant="borderless">
        <span className="empty-workspace-icon"><RobotOutlined /></span>
        <Text className="page-eyebrow">AI NATIVE COLLABORATION</Text>
        <Title level={2}>创建你的第一个 Workspace</Title>
        <Text type="secondary">邀请团队成员，连接本地 Agent，把讨论、任务和交付物放在一起。</Text>
        <div className="onboarding-steps" aria-label="开始使用的步骤">
          <div><span>1</span><Text>创建工作区</Text></div>
          <div><span>2</span><Text>邀请成员</Text></div>
          <div><span>3</span><Text>连接 Agent</Text></div>
        </div>
        <Form form={form} layout="vertical" style={{ marginTop: 28 }} onFinish={({ name }) => create.mutate(name)}>
          <Form.Item name="name" label="Workspace 名称" rules={[{ required: true, max: 120, whitespace: true }]}>
            <Input size="large" placeholder="例如：产品团队" autoFocus />
          </Form.Item>
          <Button type="primary" htmlType="submit" size="large" block loading={create.isPending}>创建 Workspace，开始协作</Button>
        </Form>
        {create.error && <Text type="danger">{errorMessage(create.error)}</Text>}
      </Card>
    </main>
  );
}

export function WorkspaceHome() {
  const { workspace, conversations, agents } = useWorkspace();
  const navigate = useNavigate();
  if (conversations.length > 0) {
    return <Navigate to={`/w/${workspace.id}/c/${conversations[0]!.id}`} replace />;
  }
  const activeAgents = agents.filter((agent) => agent.lifecycleStatus === 'active').length;
  return (
    <main className="full-page-center page-background workspace-home">
      <Card className="empty-workspace" variant="borderless">
        <span className="empty-workspace-icon"><MessageOutlined /></span>
        <Text className="page-eyebrow">WORKSPACE</Text>
        <Title level={2}>{workspace.name} 已准备好</Title>
        <Text type="secondary">
          这里还没有团队会话。你可以先创建项目、邀请成员，或连接一个本地 Agent。
        </Text>
        <div className="workspace-home-summary">
          <span><strong>{activeAgents}</strong> 个可用 Agent</span>
          <span><strong>{agents.length}</strong> 个 Agent 总数</span>
        </div>
        <Space orientation="vertical" size="middle" style={{ width: '100%', marginTop: 28 }}>
          <Button type="primary" size="large" icon={<FolderOutlined />} block onClick={() => navigate(`/w/${workspace.id}/projects`)}>
              查看项目
          </Button>
          {activeAgents === 0 && (
            <Button size="large" icon={<RobotOutlined />} block onClick={() => navigate(`/w/${workspace.id}/agents`)}>
              连接本地 Agent
            </Button>
          )}
        </Space>
      </Card>
    </main>
  );
}

function ProjectTreeNode({
  project,
  expanded,
  activeProjectId,
  selectedConversationId,
  selectedKey,
  onToggle,
  onNavigate,
  onNewConversation,
}: {
  project: Project;
  expanded: boolean;
  activeProjectId: string | undefined;
  selectedConversationId: string | null;
  selectedKey: string;
  onToggle: () => void;
  onNavigate: (path: string) => void;
  onNewConversation: () => void;
}) {
  const conversations = useQuery({
    queryKey: workspaceKeys.projectConversations(project.id),
    queryFn: () => loadAllPages((cursor) => api.listProjectConversations(project.id, cursor)),
    enabled: expanded,
  });
  const channels = (conversations.data ?? []).filter((conversation) => conversation.kind === 'channel');

  return (
    <div className="project-tree-node">
      <div className="project-tree-row">
        <button
          type="button"
          className={activeProjectId === project.id ? 'sidebar-row project-tree-toggle active-soft' : 'sidebar-row project-tree-toggle'}
          aria-expanded={expanded}
          aria-label={`${expanded ? '收起' : '展开'}项目 ${project.name}`}
          onClick={onToggle}
        >
          <DownOutlined className={expanded ? 'project-tree-chevron expanded' : 'project-tree-chevron'} />
          <span className="sidebar-row-icon">{expanded ? <FolderOpenOutlined /> : <FolderOutlined />}</span>
          <span className="sidebar-row-label">{project.name}</span>
        </button>
        {project.role !== null && (
          <Tooltip title={`在 ${project.name} 中新建群聊`}>
            <Button
              type="text"
              size="small"
              aria-label={`在 ${project.name} 中新建群聊`}
              icon={<PlusOutlined />}
              onClick={onNewConversation}
            />
          </Tooltip>
        )}
      </div>
      {expanded && (
        <div className="project-tree-children" role="group" aria-label={`${project.name} 项目内容`}>
          {conversations.isPending ? (
            <div className="project-tree-loading"><LoadingOutlined spin /> 加载群聊…</div>
          ) : conversations.isError ? (
            <div className="sidebar-empty">群聊加载失败，请稍后重试</div>
          ) : (
            <>
              {channels.map((conversation) => (
                <button
                  type="button"
                  key={conversation.id}
                  className={selectedConversationId === conversation.id ? 'sidebar-row project-tree-child active' : 'sidebar-row project-tree-child'}
                  onClick={() => onNavigate(`/p/${project.id}/c/${conversation.id}`)}
                >
                  <span className="sidebar-row-icon">#</span>
                  <span className="sidebar-row-label">{conversation.title || '未命名群聊'}</span>
                </button>
              ))}
              {!channels.length && <div className="project-tree-empty">还没有项目会话</div>}
            </>
          )}
          <button
            type="button"
            aria-label="资源"
            className={activeProjectId === project.id && selectedKey === 'project-resources'
              ? 'sidebar-row project-tree-child active'
              : 'sidebar-row project-tree-child'}
            onClick={() => onNavigate(`/p/${project.id}/resources`)}
          >
            <span className="sidebar-row-icon"><FolderOpenOutlined /></span>
            <span className="sidebar-row-label">资源</span>
          </button>
          <button
            type="button"
            aria-label="项目成员"
            className={activeProjectId === project.id && selectedKey === 'project-members'
              ? 'sidebar-row project-tree-child active'
              : 'sidebar-row project-tree-child'}
            onClick={() => onNavigate(`/p/${project.id}/members`)}
          >
            <span className="sidebar-row-icon"><TeamOutlined /></span>
            <span className="sidebar-row-label">项目成员</span>
          </button>
          <button
            type="button"
            aria-label="任务看板"
            className={activeProjectId === project.id && selectedKey === 'project-work-items'
              ? 'sidebar-row project-tree-child active'
              : 'sidebar-row project-tree-child'}
            onClick={() => onNavigate(`/p/${project.id}/work-items`)}
          >
            <span className="sidebar-row-icon"><ProjectOutlined /></span>
            <span className="sidebar-row-label">任务看板</span>
          </button>
          <button
            type="button"
            aria-label="设置"
            className={activeProjectId === project.id && selectedKey === 'project-settings'
              ? 'sidebar-row project-tree-child active'
              : 'sidebar-row project-tree-child'}
            onClick={() => onNavigate(`/p/${project.id}`)}
          >
            <span className="sidebar-row-icon"><SettingOutlined /></span>
            <span className="sidebar-row-label">设置</span>
          </button>
        </div>
      )}
    </div>
  );
}

export function WorkspaceShell() {
  const { workspaceId = '', projectId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const { isDark } = useThemeMode();
  const screens = Grid.useBreakpoint();
  const desktop = screens.lg ?? false;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [conversationModal, setConversationModal] = useState(false);
  const [conversationProjectId, setConversationProjectId] = useState<string>();
  const [archivedModal, setArchivedModal] = useState(false);
  const [projectModal, setProjectModal] = useState(false);
  const [archivedProjectIds, setArchivedProjectIds] = useState<Set<string>>(
    () => readArchivedProjectIds(workspaceId),
  );
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(`anc:expanded-projects:${workspaceId}`);
      return new Set(stored ? JSON.parse(stored) as string[] : []);
    } catch {
      return new Set();
    }
  });
  const [workspaceModal, setWorkspaceModal] = useState(false);
  const [conversationForm] = Form.useForm<{
    title: string;
    participantProjectMembershipIds: string[];
  }>();
  const [projectForm] = Form.useForm<CreateProjectInput>();
  const [workspaceForm] = Form.useForm<{ name: string }>();
  const selectedConversationId = location.pathname.match(/\/c\/([^/]+)/)?.[1] ?? null;

  const session = queryClient.getQueryData<Human>(sessionQueryKey)!;
  const workspaceList = useQuery({ queryKey: workspaceKeys.list, queryFn: () => loadAllPages(api.listWorkspaces) });
  const bootstrap = useQuery({
    queryKey: workspaceKeys.bootstrap(workspaceId),
    queryFn: () => api.bootstrapWorkspace(workspaceId),
  });
  const members = useQuery({
    queryKey: workspaceKeys.members(workspaceId),
    queryFn: () => loadAllPages((cursor) => api.listMembers(workspaceId, cursor)),
    enabled: bootstrap.isSuccess,
  });
  const agents = useQuery({
    queryKey: workspaceKeys.agents(workspaceId),
    queryFn: () => loadAllPages((cursor) => api.listAgents(workspaceId, cursor)),
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
    queryFn: () => loadAllPages((cursor) => api.listConversations(workspaceId, cursor)),
    enabled: bootstrap.isSuccess,
  });
  const projects = useQuery({
    queryKey: workspaceKeys.projects(workspaceId),
    queryFn: () => loadAllPages((cursor) => api.listProjects(workspaceId, cursor)),
    enabled: bootstrap.isSuccess,
  });
  const project = useQuery({
    queryKey: workspaceKeys.project(projectId ?? ''),
    queryFn: () => api.getProject(projectId!),
    enabled: bootstrap.isSuccess && Boolean(projectId),
  });
  const projectMembers = useQuery({
    queryKey: workspaceKeys.projectMembers(projectId ?? ''),
    queryFn: () => loadAllPages((cursor) => api.listProjectMembers(projectId!, cursor)),
    enabled: project.isSuccess && !project.data.governanceOnly,
  });
  const projectConversations = useQuery({
    queryKey: workspaceKeys.projectConversations(projectId ?? ''),
    queryFn: () => loadAllPages((cursor) => api.listProjectConversations(projectId!, cursor)),
    enabled: project.isSuccess && !project.data.governanceOnly,
  });
  const conversationProjectMembers = useQuery({
    queryKey: workspaceKeys.projectMembers(conversationProjectId ?? ''),
    queryFn: () => loadAllPages((cursor) => api.listProjectMembers(conversationProjectId!, cursor)),
    enabled: conversationModal && Boolean(conversationProjectId),
  });
  const archivedConversations = useQuery({
    queryKey: projectId
      ? workspaceKeys.projectArchivedConversations(projectId)
      : workspaceKeys.archivedConversations(workspaceId),
    queryFn: () => loadAllPages((cursor) => projectId
      ? api.listProjectConversations(projectId, cursor, 'archived')
      : api.listConversations(workspaceId, cursor, 'archived')),
    enabled: archivedModal && bootstrap.isSuccess && (!projectId || (project.isSuccess && !project.data.governanceOnly)),
  });
  const currentConversations = projectId ? (projectConversations.data ?? []) : (conversations.data ?? []);
  const selectedConversation = currentConversations.find((item) => item.id === selectedConversationId);
  const agentRequests = useQuery({
    queryKey: ['conversation', selectedConversationId, 'requests'],
    queryFn: () => api.listAgentRequests(selectedConversationId!).then((page) => page.items),
    enabled: bootstrap.isSuccess && selectedConversationId !== null && selectedConversation?.accessMode === 'content',
    refetchInterval: 2_000,
  });
  const agentActivity = useQuery({
    queryKey: ['workspace', workspaceId, 'agent-activity'],
    queryFn: () => api.listAgentActivity(workspaceId).then((page) => page.items),
    enabled: bootstrap.isSuccess,
    refetchInterval: 1_000,
  });
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
    if (!projectId) return;
    setExpandedProjectIds((current) => {
      if (current.has(projectId)) return current;
      return new Set(current).add(projectId);
    });
  }, [projectId]);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(`anc:expanded-projects:${workspaceId}`);
      const next = new Set(stored ? JSON.parse(stored) as string[] : []);
      if (projectId) next.add(projectId);
      setExpandedProjectIds(next);
    } catch {
      setExpandedProjectIds(new Set());
    }
  }, [projectId, workspaceId]);

  useEffect(() => {
    localStorage.setItem(
      `anc:expanded-projects:${workspaceId}`,
      JSON.stringify([...expandedProjectIds]),
    );
  }, [expandedProjectIds, workspaceId]);

  const createConversation = useMutation({
    mutationFn: (value: { title: string; participantProjectMembershipIds: string[] }) => {
      if (!conversationProjectId) throw new Error('请先选择 Project。');
      return api.createProjectConversation(conversationProjectId, {
        kind: 'channel',
        title: value.title.trim(),
        participantProjectMembershipIds: value.participantProjectMembershipIds,
      });
    },
    onSuccess: async (conversation) => {
      setConversationModal(false);
      conversationForm.resetFields();
      await queryClient.invalidateQueries({ queryKey: workspaceKeys.projectConversations(conversation.projectId!) });
      navigate(`/w/${workspaceId}/p/${conversation.projectId}/c/${conversation.id}`);
      setConversationProjectId(undefined);
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
      return api.createProject(workspaceId, {
        name: value.name.trim(),
        description: value.description?.trim() || null,
      });
    },
    onSuccess: async (created) => {
      projectForm.resetFields();
      setProjectModal(false);
      await queryClient.invalidateQueries({ queryKey: workspaceKeys.projects(workspaceId) });
      setExpandedProjectIds((current) => new Set(current).add(created.id));
      const conversations = await api.listProjectConversations(created.id);
      const main = conversations.items.find((conversation) => (
        conversation.scope.type === 'project_group'
        && conversation.scope.membershipMode === 'project_all'
      ));
      navigate(main
        ? `/w/${workspaceId}/p/${created.id}/c/${main.id}`
        : `/w/${workspaceId}/p/${created.id}`);
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

  useEffect(() => {
    setArchivedProjectIds(readArchivedProjectIds(workspaceId));
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
              你当前只有 Workspace 治理信息权限：{selectedProject.activeMemberCount} 位成员，{selectedProject.conversationCount} 个会话。成员详情和内容暂不可见。
            </Text>
            <Alert type="info" showIcon title="Workspace 所有者只能查看治理信息，不能因此获得项目内容权限。" />
            <Button onClick={() => navigate(`/w/${workspaceId}/projects`)}>返回项目列表</Button>
          </Space>
        </Card>
      </div>
    );
  }

  const workspace = bootstrap.data.workspace;
  const conversationParticipantOptions = (conversationProjectMembers.data ?? []).map((member) => ({
    value: member.projectMembershipId,
    label: `${member.displayName} · ${member.actorType === 'agent' ? 'Agent' : '成员'}`,
  }));
  const selectedKey = projectId && location.pathname.endsWith('/work-items') ? 'project-work-items'
    : projectId && location.pathname.endsWith('/members') ? 'project-members'
    : projectId && location.pathname.endsWith('/resources') ? 'project-resources'
    : projectId && location.pathname.endsWith(`/p/${projectId}`) ? 'project-settings'
    : location.pathname.endsWith('/projects') ? 'projects'
    : location.pathname.includes('/agents') ? 'agents'
    : location.pathname.includes('/members') ? 'members'
      : location.pathname.includes('/settings') ? 'settings'
        : selectedConversationId ?? '';
  const primarySection = projectId || selectedKey === 'projects' ? 'projects' : selectedKey === 'agents' || selectedKey === 'members'
    ? 'members'
    : selectedKey === 'settings' ? 'settings' : 'chat';
  const showArtifactsPanel = selectedKey !== 'project-resources' && selectedKey !== 'project-members' && selectedKey !== 'project-work-items' && selectedKey !== 'project-settings';
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
    || (conversation.scope.type === 'project_group'
      && conversation.scope.membershipMode === 'explicit'
      && (
        conversation.createdByMembershipId === workspace.membershipId
        || project.data?.role === 'owner'
        || project.data?.role === 'manager'
      ));
  const rail = (
    <nav className="workspace-rail" aria-label="Workspace 主导航">
      {workspaceButton()}
      <div className="rail-nav">
        <Tooltip title="协作" placement="right"><Button aria-label="协作" className={primarySection === 'chat' ? 'rail-button active' : 'rail-button'} icon={<MessageOutlined />} onClick={() => go('')} /></Tooltip>
        <Tooltip title="项目" placement="right"><Button aria-label="项目" className={primarySection === 'projects' ? 'rail-button active' : 'rail-button'} icon={<FolderOutlined />} onClick={() => go('/projects')} /></Tooltip>
        <Tooltip title="团队" placement="right"><Button aria-label="团队" className={primarySection === 'members' ? 'rail-button active' : 'rail-button'} icon={<TeamOutlined />} onClick={() => go('/agents')} /></Tooltip>
      </div>
      <div className="rail-bottom">
        <Tooltip title={isDark ? '切换为浅色模式' : '切换为深色模式'} placement="right"><ThemeToggleButton className="rail-button" compact /></Tooltip>
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
      <span className="sidebar-row-icon">{conversation.kind === 'dm'
        ? <UserOutlined />
        : conversation.visibility === 'private' ? <LockOutlined /> : '#'}</span>
      <span className="sidebar-row-label">{conversation.kind === 'dm' ? otherParticipant?.displayName ?? '私聊' : conversation.title || '未命名会话'}</span>
    </button>
    );
  };
  const channelConversations = currentConversations.filter((item) => item.kind === 'channel');
  const directConversations = workspaceDirectConversations;
  const visibleProjects = projects.data.filter((item) => !item.governanceOnly && !archivedProjectIds.has(item.id));
  const archivedProjects = projects.data.filter((item) => !item.governanceOnly && archivedProjectIds.has(item.id));
  const governanceProjects = projects.data.filter((item) => item.governanceOnly);
  const archiveProject = (projectId: string) => {
    setArchivedProjectIds((current) => {
      const next = new Set(current);
      next.add(projectId);
      writeArchivedProjectIds(workspaceId, next);
      return next;
    });
  };
  const restoreProject = (projectId: string) => {
    setArchivedProjectIds((current) => {
      const next = new Set(current);
      next.delete(projectId);
      writeArchivedProjectIds(workspaceId, next);
      return next;
    });
  };
  const activeAgentRequests = Array.from(new Map(
    (agentRequests.data ?? [])
      .filter((request) => request.status === 'pending')
      .map((request) => [request.targetAgentId, request] as const),
  ).values());
  const latestActivityByAgent = new Map<string, AgentActivityEvent>();
  for (const activity of agentActivity.data ?? []) {
    if (!latestActivityByAgent.has(activity.agentId)) latestActivityByAgent.set(activity.agentId, activity);
  }
  const pendingRequestByAgent = new Map(activeAgentRequests.map((request) => [request.targetAgentId, request]));
  const visibleAgentIds = new Set(agents.data.map((agent) => agent.id));
  const activityAgentIds = new Set(
    [...latestActivityByAgent.keys(), ...pendingRequestByAgent.keys()].filter((agentId) => visibleAgentIds.has(agentId)),
  );
  const sidebarAgentActivity: Array<{
    agentId: string;
    activity: AgentActivityEvent | null;
    request: AgentRequest | null;
    timestamp: number;
  }> = [];
  for (const agentId of activityAgentIds) {
    const activity = latestActivityByAgent.get(agentId);
    const request = pendingRequestByAgent.get(agentId);
    if (request && (!activity || (activity.turnStatus !== 'active' && request.updatedAt > activity.turnUpdatedAt))) {
      sidebarAgentActivity.push({ agentId, activity: null, request, timestamp: request.updatedAt });
      continue;
    }
    if (activity && (activity.turnStatus === 'active' || Date.now() - activity.turnUpdatedAt < 15_000)) {
      sidebarAgentActivity.push({ agentId, activity, request: null, timestamp: activity.turnUpdatedAt });
    }
  }
  sidebarAgentActivity.sort((left, right) => right.timestamp - left.timestamp);
  const openConversation = () => {
    if (projectId) openProjectConversation(projectId);
  };
  const openProjectConversation = (targetProjectId: string) => {
    if (projectId !== targetProjectId) navigate(`/w/${workspaceId}/p/${targetProjectId}`);
    setConversationProjectId(targetProjectId);
    conversationForm.resetFields();
    setConversationModal(true);
  };
  const openProjectModal = () => {
    projectForm.resetFields();
    projectForm.setFieldsValue({ name: '' });
    setProjectModal(true);
  };
  const agentActivityArea = sidebarAgentActivity.length > 0 && (
    <div className="sidebar-agent-activity" aria-live="polite" aria-label="Agent 实时动态">
      {sidebarAgentActivity.map((item) => {
        const agent = agents.data.find((candidate) => candidate.id === item.agentId);
        const name = item.activity?.agentName ?? agent?.name ?? 'Agent';
        return (
          <div className="sidebar-agent-activity-row" key={item.agentId}>
            <span className="member-avatar agent">{name.slice(0, 1).toUpperCase()}</span>
            <span className="sidebar-agent-activity-copy">
              <strong>{name}</strong>
              {item.activity ? (
                <small className={`agent-activity-${agentActivityTone(item.activity)}`}>
                  {agentActivityIcon(item.activity)} <span>{item.activity.title}</span>
                </small>
              ) : agentActivity.isError ? (
                <small className="agent-activity-failed"><WarningOutlined /> 动态连接异常，正在重试…</small>
              ) : (
                <small><LoadingOutlined spin /> {agentActivityLabel(item.request!)}</small>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
  const contextualSidebar = (
    <aside className="context-sidebar">
      <div className="mobile-workspace-header"><div className="mobile-workspace-header-row">{workspaceButton(true)}<ThemeToggleButton compact /></div></div>
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
              <div className="sidebar-section-heading"><span>团队会话</span></div>
              {channelConversations.map(conversationItem)}
              {!channelConversations.length && <div className="sidebar-empty">还没有团队会话</div>}
            </section>
            <section className="sidebar-section">
              <div className="sidebar-section-heading"><span>私聊 <small>{directConversations.length}</small></span></div>
              {directConversations.map(conversationItem)}
              {!directConversations.length && <div className="sidebar-empty">从“团队”中选择成员开始私聊</div>}
            </section>
            <section className="sidebar-section">
              <button type="button" className="sidebar-row" onClick={() => setArchivedModal(true)}>
                <span className="sidebar-row-icon"><InboxOutlined /></span>
                <span className="sidebar-row-label">已归档会话</span>
              </button>
            </section>
          </div>
        </>
      )}
      {primarySection === 'projects' && (
        <>
          <header className="context-sidebar-title">项目</header>
          <div className="sidebar-scroll">
            <section className="sidebar-section project-tree-section">
              <div className="sidebar-section-heading">
                <span>项目 <small>{visibleProjects.length}</small></span>
                <Button type="text" size="small" aria-label="新建项目" icon={<PlusOutlined />} onClick={openProjectModal} />
              </div>
              {visibleProjects.map((item) => (
                <ProjectTreeNode
                  key={item.id}
                  project={item}
                  expanded={expandedProjectIds.has(item.id)}
                  activeProjectId={projectId}
                  selectedConversationId={selectedConversationId}
                  selectedKey={selectedKey}
                  onToggle={() => setExpandedProjectIds((current) => {
                    const next = new Set(current);
                    if (next.has(item.id)) next.delete(item.id);
                    else next.add(item.id);
                    return next;
                  })}
                  onNavigate={go}
                  onNewConversation={() => openProjectConversation(item.id)}
                />
              ))}
              {!visibleProjects.length && <div className="sidebar-empty">还没有项目，点击 + 创建一个</div>}
            </section>
            {governanceProjects.length > 0 && (
              <section className="sidebar-section">
                <div className="sidebar-section-heading"><span>项目治理 <small>{governanceProjects.length}</small></span></div>
                {governanceProjects.map((item) => (
                  <button type="button" className="sidebar-row" key={item.id} onClick={() => go(`/p/${item.id}`)}>
                    <span className="sidebar-row-icon"><SettingOutlined /></span>
                  <span className="sidebar-row-label">{item.name} · 仅治理信息</span>
                  </button>
                ))}
              </section>
            )}
          </div>
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
                const agentWorking = latestActivityByAgent.get(agent.id)?.turnStatus === 'active';
                return (
                <div key={agent.id} className={selectedAgentId === agent.id ? 'sidebar-member-row active-soft' : 'sidebar-member-row'}>
                  <button type="button" className="sidebar-member-main" onClick={() => go(`/agents/${agent.id}`)}>
                    <span className="member-avatar agent">{agent.name.slice(0, 1).toUpperCase()}</span>
                    <span className="sidebar-row-label">{agent.name}</span>
                    <span
                      className={agentWorking
                        ? 'runtime-unbound-dot working'
                        : runtimeConnected ? 'runtime-unbound-dot connected' : 'runtime-unbound-dot'}
                      title={agentWorking
                        ? 'Agent 正在处理'
                        : agent.runtimeBinding ? `${agent.runtimeBinding.computerName} · ${runtimeConnected ? '已连接' : '离线'}` : '尚未选择计算机和本地 Agent'}
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
              {!agents.data.length && <div className="sidebar-empty">还没有 Agent，点击 + 创建一个</div>}
            </section>
            <section className="sidebar-section">
              <div className="sidebar-section-heading"><span>成员 <small>{members.data.filter((item) => item.actorType === 'human').length}</small></span><Button type="text" size="small" aria-label="管理成员" icon={<PlusOutlined />} onClick={() => go('/members')} /></div>
              {members.data.filter((item) => item.actorType === 'human').map((member) => (
                <div key={member.membershipId} className={selectedKey === 'members' ? 'sidebar-member-row active-soft' : 'sidebar-member-row'}>
                  <button type="button" className="sidebar-member-main" onClick={() => go('/members')}>
                    <span className="member-avatar human">{member.displayName.slice(0, 1).toUpperCase()}</span>
                    <span className="sidebar-row-label">{member.displayName}</span>
                    {member.membershipId === workspace.membershipId && <small>你</small>}
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
      {agentActivityArea}
    </aside>
  );

  const context: WorkspaceContextValue = {
    workspace,
    members: members.data,
    agents: agents.data,
    conversations: currentConversations,
    projects: visibleProjects,
    archivedProjects,
    project: projectId ? project.data! : null,
    projectMembers: projectId ? projectMembers.data ?? [] : [],
    archiveProject,
    restoreProject,
    isProjectArchived: (id) => archivedProjectIds.has(id),
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
                aria-label="打开交付物"
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
          />
        </Drawer>
      )}
      <Modal
        title={`在 ${(projects.data ?? []).find((item) => item.id === conversationProjectId)?.name ?? '项目'} 中新建群聊`}
        open={conversationModal}
        forceRender
        okText="创建"
        cancelText="取消"
        confirmLoading={createConversation.isPending}
        onCancel={() => {
          setConversationModal(false);
          setConversationProjectId(undefined);
        }}
        onOk={() => void conversationForm.validateFields().then((value) => createConversation.mutate(value))}
      >
        <Form form={conversationForm} layout="vertical">
          <Form.Item name="title" label="会话名称" rules={[{ required: true, max: 200, whitespace: true }]}><Input aria-label="会话名称" placeholder="例如：设计评审" /></Form.Item>
          <Form.Item name="participantProjectMembershipIds" label="群聊成员" rules={[{ required: true, type: 'array', min: 1 }]}>
            <Select
              mode="multiple"
              aria-label="群聊成员"
              placeholder="选择项目成员或你拥有的 Agent"
              loading={conversationProjectMembers.isPending}
              options={conversationParticipantOptions}
            />
          </Form.Item>
          <Alert
            type="info"
            showIcon
            title="创建者会自动加入。Agent 需要单独加入会话，不会因为加入项目而自动出现。"
          />
        </Form>
        {createConversation.error && <Text type="danger">{errorMessage(createConversation.error)}</Text>}
      </Modal>
      <Modal
        title={projectId ? `${project.data?.name ?? '项目'} · 已归档会话` : '已归档会话'}
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
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有已归档的会话" />
        )}
      </Modal>
      <Modal
        title="创建项目"
        open={projectModal}
        okText="创建项目"
        cancelText="取消"
        confirmLoading={createProject.isPending}
        onCancel={() => setProjectModal(false)}
        onOk={() => void projectForm.validateFields().then((value) => createProject.mutate(value))}
      >
        <Form form={projectForm} layout="vertical">
          <Form.Item name="name" label="项目名称" rules={[{ required: true, max: 120, whitespace: true }]}><Input autoFocus placeholder="例如：agent-platform" /></Form.Item>
          <Form.Item name="description" label="描述（可选）" rules={[{ max: 3000 }]}><Input.TextArea rows={3} placeholder="这个项目用于什么协作？" /></Form.Item>
          <Alert type="info" showIcon title="项目会集中管理资料、交付物和外部链接；Agent 会在隔离的临时环境中运行。" />
        </Form>
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
