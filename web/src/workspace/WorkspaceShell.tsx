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
import { agentActivityIcon, agentActivityTone, localizeActivityTitle } from './agent-activity-presentation';
import { readArchivedProjectIds, writeArchivedProjectIds } from './project-archive';
import { ThemeToggleButton, useThemeMode } from '../theme';
import { LanguageToggleButton, localizeConversationName, useLanguage } from '../language';
import { loadAllPages } from '../lib/pagination';

const { Sider, Content } = Layout;
const { Text, Title } = Typography;

function agentActivityLabel(request: AgentRequest, isEnglish: boolean): string {
  if (request.intake?.reasons.includes('runtime_unavailable')) return isEnglish ? 'Waiting for local Agent…' : '等待本地 Agent 上线…';
  if (request.intake?.reasons.includes('agent_suspended')) return isEnglish ? 'Agent paused' : 'Agent 已暂停';
  if (request.intake?.reasons.includes('authority_revoked')) return isEnglish ? 'Current session unavailable' : '当前会话不可用';
  return isEnglish ? 'Pending message…' : '有待处理消息…';
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
  const { t } = useLanguage();
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
      <LanguageToggleButton className="entry-language-toggle" compact />
      <Card className="empty-workspace" variant="borderless">
        <span className="empty-workspace-icon"><RobotOutlined /></span>
        <Text className="page-eyebrow">AI NATIVE COLLABORATION</Text>
        <Title level={2}>{t('entry.title')}</Title>
        <Text type="secondary">{t('entry.subtitle')}</Text>
        <div className="onboarding-steps" aria-label={t('workspace.onboardingSteps')}>
          <div><span>1</span><Text>{t('entry.step1')}</Text></div>
          <div><span>2</span><Text>{t('entry.step2')}</Text></div>
          <div><span>3</span><Text>{t('entry.step3')}</Text></div>
        </div>
        <Form form={form} layout="vertical" style={{ marginTop: 28 }} onFinish={({ name }) => create.mutate(name)}>
          <Form.Item name="name" label={t('entry.workspaceName')} rules={[{ required: true, max: 120, whitespace: true }]}>
            <Input size="large" placeholder={t('entry.workspacePlaceholder')} autoFocus />
          </Form.Item>
          <Button type="primary" htmlType="submit" size="large" block loading={create.isPending}>{t('entry.submit')}</Button>
        </Form>
        {create.error && <Text type="danger">{errorMessage(create.error)}</Text>}
      </Card>
    </main>
  );
}

export function WorkspaceHome() {
  const { workspace, conversations, agents } = useWorkspace();
  const { t } = useLanguage();
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
        <Title level={2}>{workspace.name} {t('workspace.ready')}</Title>
        <Text type="secondary">{t('workspace.noConversations')}</Text>
        <div className="workspace-home-summary">
          <span><strong>{activeAgents}</strong> {t('workspace.availableAgents')}</span>
          <span><strong>{agents.length}</strong> {t('workspace.totalAgents')}</span>
        </div>
        <Space orientation="vertical" size="middle" style={{ width: '100%', marginTop: 28 }}>
          <Button type="primary" size="large" icon={<FolderOutlined />} block onClick={() => navigate(`/w/${workspace.id}/projects`)}>
              {t('workspace.viewProjects')}
          </Button>
          {activeAgents === 0 && (
            <Button size="large" icon={<RobotOutlined />} block onClick={() => navigate(`/w/${workspace.id}/agents`)}>
              {t('workspace.connectAgent')}
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
  const { t, isEnglish } = useLanguage();
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
          aria-label={`${expanded ? t('workspace.collapse') : t('workspace.expand')} ${project.name}`}
          onClick={onToggle}
        >
          <DownOutlined className={expanded ? 'project-tree-chevron expanded' : 'project-tree-chevron'} />
          <span className="sidebar-row-icon">{expanded ? <FolderOpenOutlined /> : <FolderOutlined />}</span>
          <span className="sidebar-row-label">{project.name}</span>
        </button>
        {project.role !== null && (
          <Tooltip title={`${t('workspace.newChannel')} · ${project.name}`}>
            <Button
              type="text"
              size="small"
              aria-label={`${t('workspace.newChannel')} · ${project.name}`}
              icon={<PlusOutlined />}
              onClick={onNewConversation}
            />
          </Tooltip>
        )}
      </div>
      {expanded && (
        <div className="project-tree-children" role="group" aria-label={`${project.name} ${t('workspace.projectContent')}`}>
          {conversations.isPending ? (
            <div className="project-tree-loading"><LoadingOutlined spin /> {t('workspace.loadingChannels')}</div>
          ) : conversations.isError ? (
            <div className="sidebar-empty">{t('workspace.channelsError')}</div>
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
                  <span className="sidebar-row-label">{localizeConversationName(conversation.title, isEnglish) || t('workspace.unnamedChannel')}</span>
                </button>
              ))}
              {!channels.length && <div className="project-tree-empty">{t('workspace.noProjectConversations')}</div>}
            </>
          )}
          <button
            type="button"
            aria-label={t('workspace.resources')}
            className={activeProjectId === project.id && selectedKey === 'project-resources'
              ? 'sidebar-row project-tree-child active'
              : 'sidebar-row project-tree-child'}
            onClick={() => onNavigate(`/p/${project.id}/resources`)}
          >
            <span className="sidebar-row-icon"><FolderOpenOutlined /></span>
            <span className="sidebar-row-label">{t('workspace.resources')}</span>
          </button>
          <button
            type="button"
            aria-label={t('workspace.projectMembers')}
            className={activeProjectId === project.id && selectedKey === 'project-members'
              ? 'sidebar-row project-tree-child active'
              : 'sidebar-row project-tree-child'}
            onClick={() => onNavigate(`/p/${project.id}/members`)}
          >
            <span className="sidebar-row-icon"><TeamOutlined /></span>
            <span className="sidebar-row-label">{t('workspace.projectMembers')}</span>
          </button>
          <button
            type="button"
            aria-label={t('workspace.workItems')}
            className={activeProjectId === project.id && selectedKey === 'project-work-items'
              ? 'sidebar-row project-tree-child active'
              : 'sidebar-row project-tree-child'}
            onClick={() => onNavigate(`/p/${project.id}/work-items`)}
          >
            <span className="sidebar-row-icon"><ProjectOutlined /></span>
            <span className="sidebar-row-label">{t('workspace.workItems')}</span>
          </button>
          <button
            type="button"
            aria-label={t('workspace.projectSettings')}
            className={activeProjectId === project.id && selectedKey === 'project-settings'
              ? 'sidebar-row project-tree-child active'
              : 'sidebar-row project-tree-child'}
            onClick={() => onNavigate(`/p/${project.id}`)}
          >
            <span className="sidebar-row-icon"><SettingOutlined /></span>
            <span className="sidebar-row-label">{t('workspace.projectSettings')}</span>
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
  const { t, isEnglish } = useLanguage();
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
      if (!conversationProjectId) throw new Error(t('workspace.selectProject'));
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
      void message.success(t('workspace.restored'));
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const openDirectMessage = useMutation({
    mutationFn: async (targetMembershipId: string) => {
      const ownMembershipId = bootstrap.data?.workspace.membershipId;
      if (!ownMembershipId || targetMembershipId === ownMembershipId) {
        throw new Error(t('workspace.cannotMessageSelf'));
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
          <Button onClick={() => navigate('/')}>{t('workspace.backToWorkspaces')}</Button>
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
              {t('workspace.governanceDescription').replace('{members}', String(selectedProject.activeMemberCount)).replace('{conversations}', String(selectedProject.conversationCount))}
            </Text>
            <Alert type="info" showIcon title={t('workspace.governanceAlert')} />
            <Button onClick={() => navigate(`/w/${workspaceId}/projects`)}>{t('workspace.backToProjects')}</Button>
          </Space>
        </Card>
      </div>
    );
  }

  const workspace = bootstrap.data.workspace;
  const conversationParticipantOptions = (conversationProjectMembers.data ?? []).map((member) => ({
    value: member.projectMembershipId,
    label: `${member.displayName} · ${member.actorType === 'agent' ? 'Agent' : t('workspace.member')}`,
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
      { key: 'create-workspace', icon: <PlusOutlined />, label: t('workspace.createWorkspace') },
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
      <Button className={expanded ? 'mobile-workspace-switcher' : 'workspace-rail-switcher'} aria-label={t('workspace.switchWorkspace')}>
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
    <nav className="workspace-rail" aria-label={t('workspace.mainNav')}>
      {workspaceButton()}
      <div className="rail-nav">
        <Tooltip title={t('nav.collaboration')} placement="right"><Button aria-label={t('nav.collaboration')} className={primarySection === 'chat' ? 'rail-button active' : 'rail-button'} icon={<MessageOutlined />} onClick={() => go('')} /></Tooltip>
        <Tooltip title={t('nav.projects')} placement="right"><Button aria-label={t('nav.projects')} className={primarySection === 'projects' ? 'rail-button active' : 'rail-button'} icon={<FolderOutlined />} onClick={() => go('/projects')} /></Tooltip>
        <Tooltip title={t('nav.team')} placement="right"><Button aria-label={t('nav.team')} className={primarySection === 'members' ? 'rail-button active' : 'rail-button'} icon={<TeamOutlined />} onClick={() => go('/agents')} /></Tooltip>
      </div>
      <div className="rail-bottom">
        <Tooltip title={isDark ? (isEnglish ? 'Switch to light mode' : '切换为浅色模式') : (isEnglish ? 'Switch to dark mode' : '切换为深色模式')} placement="right"><ThemeToggleButton className="rail-button" compact /></Tooltip>
        <Tooltip title={isEnglish ? t('language.switchToZh') : t('language.switchToEn')} placement="right"><LanguageToggleButton className="rail-button" compact /></Tooltip>
        <Tooltip title={t('nav.workspaceSettings')} placement="right"><Button aria-label={t('nav.workspaceSettings')} className={primarySection === 'settings' ? 'rail-button active' : 'rail-button'} icon={<SettingOutlined />} onClick={() => go('/settings')} /></Tooltip>
        <Dropdown
          trigger={['click']}
          placement="topLeft"
          menu={{ items: [{ key: 'logout', icon: <LogoutOutlined />, label: t('nav.logout'), danger: true }], onClick: () => logout.mutate() }}
        >
          <Tooltip title={session.displayName} placement="right"><Button aria-label={t('workspace.accountMenu')} className="rail-account"><Avatar size={28} icon={<UserOutlined />} /></Button></Tooltip>
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
      <span className="sidebar-row-label">{conversation.kind === 'dm' ? otherParticipant?.displayName ?? t('workspace.privateChat') : localizeConversationName(conversation.title, isEnglish) || t('workspace.unnamedConversation')}</span>
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
    <div className="sidebar-agent-activity" aria-live="polite" aria-label={t('workspace.agentActivity')}>
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
                  {agentActivityIcon(item.activity)} <span>{localizeActivityTitle(item.activity.title, isEnglish)}</span>
                </small>
              ) : agentActivity.isError ? (
                <small className="agent-activity-failed"><WarningOutlined /> {t('workspace.activityError')}</small>
              ) : (
                <small><LoadingOutlined spin /> {agentActivityLabel(item.request!, isEnglish)}</small>
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
          <div className="sidebar-section-heading"><span>{t('workspace.mainNav')}</span></div>
          <button type="button" className={primarySection === 'chat' ? 'sidebar-row active' : 'sidebar-row'} onClick={() => go('')}>
            <MessageOutlined /><span className="sidebar-row-label">{t('workspace.chat')}</span>
          </button>
          <button type="button" className={primarySection === 'projects' ? 'sidebar-row active' : 'sidebar-row'} onClick={() => go('/projects')}>
            <FolderOutlined /><span className="sidebar-row-label">{t('nav.projects')}</span>
          </button>
          <button type="button" className={primarySection === 'members' ? 'sidebar-row active' : 'sidebar-row'} onClick={() => go('/agents')}>
            <TeamOutlined /><span className="sidebar-row-label">{t('nav.team')}</span>
          </button>
          <button type="button" className={primarySection === 'settings' ? 'sidebar-row active' : 'sidebar-row'} onClick={() => go('/settings')}>
            <SettingOutlined /><span className="sidebar-row-label">{t('nav.workspaceSettings')}</span>
          </button>
        </section>
      )}
      {primarySection === 'chat' && (
        <>
          <header className="context-sidebar-title">{t('workspace.chat')}</header>
          <div className="sidebar-scroll">
            <section className="sidebar-section">
              <div className="sidebar-section-heading"><span>{t('workspace.teamConversations')}</span></div>
              {channelConversations.map(conversationItem)}
              {!channelConversations.length && <div className="sidebar-empty">{t('workspace.noTeamConversations')}</div>}
            </section>
            <section className="sidebar-section">
              <div className="sidebar-section-heading"><span>{t('workspace.privateChat')} <small>{directConversations.length}</small></span></div>
              {directConversations.map(conversationItem)}
              {!directConversations.length && <div className="sidebar-empty">{t('workspace.noDirectMessages')}</div>}
            </section>
            <section className="sidebar-section">
              <button type="button" className="sidebar-row" onClick={() => setArchivedModal(true)}>
                <span className="sidebar-row-icon"><InboxOutlined /></span>
                <span className="sidebar-row-label">{t('workspace.archivedConversations')}</span>
              </button>
            </section>
          </div>
        </>
      )}
      {primarySection === 'projects' && (
        <>
          <header className="context-sidebar-title">{t('nav.projects')}</header>
          <div className="sidebar-scroll">
            <section className="sidebar-section project-tree-section">
              <div className="sidebar-section-heading">
                <span>{t('workspace.projectCount')} <small>{visibleProjects.length}</small></span>
                <Button type="text" size="small" aria-label={t('workspace.newProject')} icon={<PlusOutlined />} onClick={openProjectModal} />
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
              {!visibleProjects.length && <div className="sidebar-empty">{t('workspace.noProjects')}</div>}
            </section>
            {governanceProjects.length > 0 && (
              <section className="sidebar-section">
                <div className="sidebar-section-heading"><span>{t('workspace.projectGovernance')} <small>{governanceProjects.length}</small></span></div>
                {governanceProjects.map((item) => (
                  <button type="button" className="sidebar-row" key={item.id} onClick={() => go(`/p/${item.id}`)}>
                    <span className="sidebar-row-icon"><SettingOutlined /></span>
                  <span className="sidebar-row-label">{item.name} · {t('workspace.governanceOnly')}</span>
                  </button>
                ))}
              </section>
            )}
          </div>
        </>
      )}
      {primarySection === 'members' && (
        <>
          <header className="context-sidebar-title">{t('nav.team')}</header>
          <div className="sidebar-scroll">
            <section className="sidebar-section">
              <div className="sidebar-section-heading"><span>Agent <small>{agents.data.length}</small></span><Button type="text" size="small" aria-label={t('workspace.manageAgent')} icon={<PlusOutlined />} onClick={() => go('/agents')} /></div>
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
                        ? t('workspace.agentWorking')
                        : agent.runtimeBinding ? `${agent.runtimeBinding.computerName} · ${runtimeConnected ? t('workspace.connected') : t('workspace.offline')}` : t('workspace.noComputer')}
                    />
                  </button>
                  <Tooltip title={`${t('workspace.privateChat')} · ${agent.name}`}>
                    <Button
                      type="text"
                      size="small"
                      aria-label={`${t('workspace.privateChat')} · ${agent.name}`}
                      icon={<MessageOutlined />}
                      loading={openDirectMessage.isPending && openDirectMessage.variables === agent.membershipId}
                      onClick={() => openDirectMessage.mutate(agent.membershipId)}
                    />
                  </Tooltip>
                </div>
                );
              })}
              {!agents.data.length && <div className="sidebar-empty">{t('workspace.noAgents')}</div>}
            </section>
            <section className="sidebar-section">
              <div className="sidebar-section-heading"><span>{t('workspace.member')} <small>{members.data.filter((item) => item.actorType === 'human').length}</small></span><Button type="text" size="small" aria-label={t('workspace.manageMembers')} icon={<PlusOutlined />} onClick={() => go('/members')} /></div>
              {members.data.filter((item) => item.actorType === 'human').map((member) => (
                <div key={member.membershipId} className={selectedKey === 'members' ? 'sidebar-member-row active-soft' : 'sidebar-member-row'}>
                  <button type="button" className="sidebar-member-main" onClick={() => go('/members')}>
                    <span className="member-avatar human">{member.displayName.slice(0, 1).toUpperCase()}</span>
                    <span className="sidebar-row-label">{member.displayName}</span>
                    {member.membershipId === workspace.membershipId && <small>{t('workspace.you')}</small>}
                  </button>
                  {member.membershipId !== workspace.membershipId && (
                    <Tooltip title={`${t('workspace.privateChat')} · ${member.displayName}`}>
                      <Button
                        type="text"
                        size="small"
                        aria-label={`${t('workspace.privateChat')} · ${member.displayName}`}
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
            <button type="button" className="sidebar-row active" onClick={() => go('/settings')}><SettingOutlined /><span className="sidebar-row-label">{t('workspace.basicSettings')}</span></button>
            <button type="button" className="sidebar-row" onClick={() => go('/members')}><TeamOutlined /><span className="sidebar-row-label">{t('workspace.membersAndInvites')}</span></button>
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
                aria-label={t('workspace.openDeliverables')}
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
        title={t('workspace.createChannelTitle').replace('{project}', (projects.data ?? []).find((item) => item.id === conversationProjectId)?.name ?? t('nav.projects'))}
        open={conversationModal}
        forceRender
        okText={t('workspace.create')}
        cancelText={t('workspace.cancel')}
        confirmLoading={createConversation.isPending}
        onCancel={() => {
          setConversationModal(false);
          setConversationProjectId(undefined);
        }}
        onOk={() => void conversationForm.validateFields().then((value) => createConversation.mutate(value))}
      >
        <Form form={conversationForm} layout="vertical">
          <Form.Item name="title" label={t('workspace.conversationName')} rules={[{ required: true, max: 200, whitespace: true }]}><Input aria-label={t('workspace.conversationName')} placeholder={t('workspace.conversationPlaceholder')} /></Form.Item>
          <Form.Item name="participantProjectMembershipIds" label={t('workspace.channelMembers')} rules={[{ required: true, type: 'array', min: 1 }]}>
            <Select
              mode="multiple"
              aria-label={t('workspace.channelMembers')}
              placeholder={t('workspace.channelMembersPlaceholder')}
              loading={conversationProjectMembers.isPending}
              options={conversationParticipantOptions}
            />
          </Form.Item>
          <Alert
            type="info"
            showIcon
            title={t('workspace.channelInfo')}
          />
        </Form>
        {createConversation.error && <Text type="danger">{errorMessage(createConversation.error)}</Text>}
      </Modal>
      <Modal
        title={projectId ? `${project.data?.name ?? t('nav.projects')} · ${t('workspace.archivedConversations')}` : t('workspace.archivedConversations')}
        open={archivedModal}
        footer={<Button onClick={() => setArchivedModal(false)}>{t('workspace.close')}</Button>}
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
                  <strong>{conversation.kind === 'dm' ? t('workspace.privateChat') : localizeConversationName(conversation.title, isEnglish) || t('workspace.unnamedConversation')}</strong>
                  <Text type="secondary">
                    {conversation.archivedAt
                      ? `${t('workspace.archivedAt')} ${new Intl.DateTimeFormat(isEnglish ? 'en-US' : 'zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(conversation.archivedAt)}`
                      : t('workspace.archived')}
                  </Text>
                </div>
                <Space size={4}>
                  <Button type="link" onClick={() => openArchivedConversation(conversation)}>{t('workspace.viewHistory')}</Button>
                  {canManageConversation(conversation) && (
                    <Button
                      type="link"
                      icon={<RollbackOutlined />}
                      loading={restoreArchivedConversation.isPending && restoreArchivedConversation.variables?.id === conversation.id}
                      onClick={() => restoreArchivedConversation.mutate(conversation)}
                    >
                      {t('workspace.restore')}
                    </Button>
                  )}
                </Space>
              </div>
            ))}
          </div>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('workspace.noArchived')} />
        )}
      </Modal>
      <Modal
        title={t('workspace.createProject')}
        open={projectModal}
        okText={t('workspace.createProject')}
        cancelText={t('workspace.cancel')}
        confirmLoading={createProject.isPending}
        onCancel={() => setProjectModal(false)}
        onOk={() => void projectForm.validateFields().then((value) => createProject.mutate(value))}
      >
        <Form form={projectForm} layout="vertical">
          <Form.Item name="name" label={t('workspace.projectName')} rules={[{ required: true, max: 120, whitespace: true }]}><Input autoFocus placeholder={t('workspace.projectPlaceholder')} /></Form.Item>
          <Form.Item name="description" label={t('workspace.descriptionOptional')} rules={[{ max: 3000 }]}><Input.TextArea rows={3} placeholder={t('workspace.descriptionPlaceholder')} /></Form.Item>
          <Alert type="info" showIcon title={t('workspace.projectInfo')} />
        </Form>
        {createProject.error && <Text type="danger">{errorMessage(createProject.error)}</Text>}
      </Modal>
      <Modal
        title={t('workspace.createWorkspace')}
        open={workspaceModal}
        okText={t('workspace.create')}
        cancelText={t('workspace.cancel')}
        confirmLoading={createWorkspace.isPending}
        onCancel={() => setWorkspaceModal(false)}
        onOk={() => void workspaceForm.validateFields().then((value) => createWorkspace.mutate(value))}
      >
        <Form form={workspaceForm} layout="vertical">
          <Form.Item name="name" label={t('workspace.workspaceName')} rules={[{ required: true, max: 120 }]}><Input autoFocus /></Form.Item>
        </Form>
        {createWorkspace.error && <Text type="danger">{errorMessage(createWorkspace.error)}</Text>}
      </Modal>
    </WorkspaceContext.Provider>
  );
}
