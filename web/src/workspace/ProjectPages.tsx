import {
  FileOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  InboxOutlined,
  LinkOutlined,
  MessageOutlined,
  PlusOutlined,
  ProjectOutlined,
  RollbackOutlined,
  SettingOutlined,
  TeamOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Avatar,
  Button,
  Card,
  Empty,
  Form,
  Input,
  List,
  Modal,
  Popconfirm,
  Select,
  Space,
  Tag,
  Typography,
} from 'antd';
import { useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api, errorMessage, type Project, type ProjectLink, type ProjectMember, type ProjectResource } from '../api/client';
import { useWorkspace, workspaceKeys } from './workspace-context';

const { Text, Title } = Typography;

function formatBytes(byteLength: number) {
  if (byteLength < 1024) return `${byteLength} B`;
  if (byteLength < 1024 * 1024) return `${(byteLength / 1024).toFixed(1)} KB`;
  return `${(byteLength / 1024 / 1024).toFixed(1)} MB`;
}

export function ProjectsPage() {
  const { workspace, projects, archivedProjects = [], openNewProject, restoreProject } = useWorkspace();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [archivedOpen, setArchivedOpen] = useState(false);
  const openProject = (project: Project) => {
    navigate(project.governanceOnly
      ? `/w/${workspace.id}/p/${project.id}`
      : `/w/${workspace.id}/p/${project.id}/resources`);
  };
  return (
    <main className="page-scroll project-directory-page">
      <div className="page-header project-directory-header">
        <div>
          <Text className="page-eyebrow">WORKSPACE</Text>
          <Title level={2}>项目</Title>
          <Text type="secondary">把文件、讨论、任务和交付物放在同一个协作空间。</Text>
        </div>
        <Space>
          {archivedProjects.length > 0 && (
            <Button icon={<InboxOutlined />} onClick={() => setArchivedOpen(true)}>
              已归档 ({archivedProjects.length})
            </Button>
          )}
          <Button type="primary" size="large" icon={<PlusOutlined />} onClick={openNewProject}>新建项目</Button>
        </Space>
      </div>
      {projects.length ? (
        <div className="project-directory-grid" aria-label="项目列表">
          {projects.map((project) => (
            <Card
              key={project.id}
              className={project.governanceOnly ? 'project-directory-card governance-only' : 'project-directory-card'}
              variant="borderless"
              hoverable
              role="button"
              tabIndex={0}
              onClick={() => openProject(project)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  openProject(project);
                }
              }}
            >
              <div className="project-directory-card-heading">
                <span className="project-directory-card-icon"><FolderOpenOutlined /></span>
                <div>
                  <Title level={4}>{project.name}</Title>
                  <Text type="secondary">{project.governanceOnly ? '仅可查看项目治理信息' : (project.description || '还没有项目描述')}</Text>
                </div>
              </div>
              <div className="project-directory-card-meta">
                <span><TeamOutlined /> {project.activeMemberCount} 位成员</span>
                <span><MessageOutlined /> {project.conversationCount} 个会话</span>
              </div>
              <div className="project-directory-card-footer">
                <Tag color={project.governanceOnly ? 'default' : 'blue'}>
                  {project.governanceOnly ? '仅治理权限' : project.role === 'owner' ? '所有者' : project.role === 'manager' ? '管理员' : '成员'}
                </Tag>
                <Button type="link" tabIndex={-1}>打开项目 <span aria-hidden="true">→</span></Button>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Card className="surface-card project-empty-card" variant="borderless">
          <Empty
            image={<FolderOutlined className="project-empty-icon" />}
            description={(
              <Space orientation="vertical" size={2}>
                <Text strong>{archivedProjects.length ? '没有未归档项目' : '还没有项目'}</Text>
                <Text type="secondary">{archivedProjects.length ? '已归档项目可从上方入口恢复。' : '创建一个项目，把资料、任务和 Agent 协作集中起来。'}</Text>
              </Space>
            )}
          >
            {archivedProjects.length ? (
              <Button icon={<InboxOutlined />} onClick={() => setArchivedOpen(true)}>查看已归档项目</Button>
            ) : (
              <Button type="primary" icon={<PlusOutlined />} onClick={openNewProject}>创建第一个项目</Button>
            )}
          </Empty>
        </Card>
      )}
      <Modal
        title="已归档项目"
        open={archivedOpen}
        footer={<Button onClick={() => setArchivedOpen(false)}>关闭</Button>}
        onCancel={() => setArchivedOpen(false)}
      >
        <Text type="secondary">归档只影响当前浏览器的默认展示，不会删除项目资料、会话或交付物。</Text>
        <List
          style={{ marginTop: 16 }}
          dataSource={archivedProjects}
          renderItem={(archivedProject) => (
            <List.Item
              actions={[
                <Button
                  key="restore"
                  type="link"
                  icon={<RollbackOutlined />}
                  onClick={() => {
                    restoreProject?.(archivedProject.id);
                    void message.success('项目已恢复。');
                  }}
                >
                  恢复
                </Button>,
                <Button key="open" type="link" onClick={() => openProject(archivedProject)}>查看</Button>,
              ]}
            >
              <List.Item.Meta
                avatar={<InboxOutlined />}
                title={archivedProject.name}
                description={archivedProject.description || '已归档项目'}
              />
            </List.Item>
          )}
        />
      </Modal>
    </main>
  );
}

/** Project resource surface: project files, deliverables and external links. */
export function ProjectHome() {
  const { workspace, project, projectMembers, openNewConversation } = useWorkspace();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const resourceInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const artifactInput = useRef<HTMLInputElement>(null);
  const [folderName, setFolderName] = useState('');
  const [folderOpen, setFolderOpen] = useState(false);
  const [editingResource, setEditingResource] = useState<ProjectResource | null>(null);
  const [replacementTarget, setReplacementTarget] = useState<ProjectResource | null>(null);
  const [resourceName, setResourceName] = useState('');
  const [resourceParent, setResourceParent] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [editingLink, setEditingLink] = useState<ProjectLink | null>(null);
  const [linkName, setLinkName] = useState('');
  const [linkLocator, setLinkLocator] = useState('');
  const [linkDescription, setLinkDescription] = useState('');
  const resources = useQuery({ queryKey: ['project-v2', project?.id, 'resources'], queryFn: () => api.listProjectResources(project!.id).then((result) => result.items), enabled: Boolean(project) });
  const artifacts = useQuery({ queryKey: ['project-v2', project?.id, 'artifacts'], queryFn: () => api.listProjectArtifactsV2(project!.id).then((result) => result.items), enabled: Boolean(project) });
  const links = useQuery({ queryKey: ['project-v2', project?.id, 'links'], queryFn: () => api.listProjectLinks(project!.id).then((result) => result.items), enabled: Boolean(project) });
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['project-v2', project!.id, 'resources'] }),
      queryClient.invalidateQueries({ queryKey: ['project-v2', project!.id, 'artifacts'] }),
      queryClient.invalidateQueries({ queryKey: ['project-v2', project!.id, 'links'] }),
    ]);
  };
  const uploadResource = useMutation({ mutationFn: (file: File) => api.uploadProjectResource(project!.id, file), onSuccess: async () => { await refresh(); void message.success('项目资料已上传。'); }, onError: (error) => void message.error(errorMessage(error)) });
  const updateResource = useMutation({ mutationFn: () => { if (!editingResource) throw new Error('资料不存在。'); return api.updateProjectResourceInProject(project!.id, editingResource.resourceId, { name: resourceName.trim(), parentResourceId: resourceParent }); }, onSuccess: async () => { setEditingResource(null); await refresh(); void message.success('项目资料已更新。'); }, onError: (error) => void message.error(errorMessage(error)) });
  const deleteResource = useMutation({ mutationFn: (resource: ProjectResource) => api.deleteProjectResource(resource.resourceId), onSuccess: async () => { await refresh(); void message.success('项目资料已移入回收站。'); }, onError: (error) => void message.error(errorMessage(error)) });
  const replaceResource = useMutation({ mutationFn: async (file: File) => { if (!replacementTarget) throw new Error('资料不存在。'); return api.replaceProjectResource(replacementTarget.resourceId, file, replacementTarget.revision); }, onSuccess: async () => { setReplacementTarget(null); await refresh(); void message.success('项目资料已替换。'); }, onError: (error) => void message.error(errorMessage(error)) });
  const publishArtifact = useMutation({ mutationFn: (file: File) => api.publishArtifactV2(project!.id, file, { artifactPath: '' }), onSuccess: async (result) => { await refresh(); navigate(`/w/${workspace.id}/p/${project!.id}/artifacts/${result.artifact.artifactId}`); }, onError: (error) => void message.error(errorMessage(error)) });
  const createFolder = useMutation({ mutationFn: () => api.createProjectResourceFolder(project!.id, { name: folderName.trim() }), onSuccess: async () => { setFolderName(''); setFolderOpen(false); await refresh(); void message.success('文件夹已创建。'); }, onError: (error) => void message.error(errorMessage(error)) });
  const createLink = useMutation({ mutationFn: () => api.createProjectLink(project!.id, { name: linkName.trim(), locator: linkLocator.trim(), description: linkDescription.trim() || null }), onSuccess: async () => { setLinkOpen(false); setLinkName(''); setLinkLocator(''); setLinkDescription(''); await refresh(); void message.success('外部链接已添加。'); }, onError: (error) => void message.error(errorMessage(error)) });
  const updateLink = useMutation({ mutationFn: () => { if (!editingLink) throw new Error('链接不存在。'); return api.updateProjectLinkInProject(project!.id, editingLink.linkId, { name: linkName.trim(), description: linkDescription.trim() || null }); }, onSuccess: async () => { setEditingLink(null); await refresh(); void message.success('外部链接已更新。'); }, onError: (error) => void message.error(errorMessage(error)) });
  const deleteLink = useMutation({ mutationFn: (link: ProjectLink) => api.deleteProjectLink(link.linkId), onSuccess: async () => { await refresh(); void message.success('外部链接已移入回收站。'); }, onError: (error) => void message.error(errorMessage(error)) });
  if (!project) return <Navigate to={`/w/${workspace.id}/projects`} replace />;
  return (
    <main className="page-scroll project-profile-page">
      <div className="page-header project-profile-header"><div className="project-title-lockup"><span className="project-title-icon"><FolderOpenOutlined /></span><div><Text type="secondary">{project.name}</Text><Title level={2}>项目资源</Title><Text type="secondary">项目资料、交付物和外部链接都在这里。</Text></div></div><Space><Button aria-label="任务看板" icon={<ProjectOutlined />} onClick={() => navigate(`/w/${workspace.id}/p/${project.id}/work-items`)}>任务看板</Button><Button aria-label="项目设置" icon={<SettingOutlined />} onClick={() => navigate(`/w/${workspace.id}/p/${project.id}`)}>设置</Button><Button aria-label="项目成员" icon={<TeamOutlined />} onClick={() => navigate(`/w/${workspace.id}/p/${project.id}/members`)}>成员 ({projectMembers.length})</Button><Button type="primary" icon={<MessageOutlined />} onClick={openNewConversation}>新建会话</Button></Space></div>
      <div className="project-profile-grid">
        <Card title="项目资料" className="surface-card" extra={<Space><Button icon={<FolderOutlined />} loading={createFolder.isPending} onClick={() => { setFolderName(''); setFolderOpen(true); }}>新建文件夹</Button><Button type="primary" icon={<UploadOutlined />} loading={uploadResource.isPending} onClick={() => resourceInput.current?.click()}>上传资料</Button></Space>}>
          <input ref={resourceInput} hidden type="file" onChange={(event) => { const file = event.target.files?.[0]; if (file) uploadResource.mutate(file); event.target.value = ''; }} />
          <input ref={replaceInput} hidden type="file" onChange={(event) => { const file = event.target.files?.[0]; if (file) replaceResource.mutate(file); event.target.value = ''; }} />
          {(resources.data ?? []).length ? <div role="list" aria-label="项目资源列表"><List dataSource={resources.data ?? []} renderItem={(resource) => <List.Item role="listitem" actions={[...(resource.kind === 'file' ? [<Button key="download" type="link" href={`/v1/projects/${project.id}/resources/${resource.resourceId}/download`}>下载</Button>, <Button key="replace" type="link" onClick={() => { setReplacementTarget(resource); replaceInput.current?.click(); }}>替换</Button>] : []), <Button key="edit" type="link" onClick={() => { setEditingResource(resource); setResourceName(resource.name); setResourceParent(resource.parentResourceId); }}>整理</Button>, <Popconfirm key="delete" title="移入回收站？" description="删除后可以在回收站中恢复。" onConfirm={() => deleteResource.mutate(resource)}><Button type="link" danger>删除</Button></Popconfirm>]}><List.Item.Meta avatar={resource.kind === 'directory' ? <FolderOutlined /> : <FileOutlined />} title={resource.path} description={resource.kind === 'directory' ? '文件夹' : `${resource.mediaType ?? '文件'} · ${formatBytes(resource.byteLength ?? 0)} · 更新于 ${new Date(resource.updatedAt).toLocaleDateString('zh-CN')}`} /></List.Item>} /></div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有项目资料" />}
        </Card>
        <Card title="交付物" className="surface-card" extra={<><input ref={artifactInput} hidden type="file" onChange={(event) => { const file = event.target.files?.[0]; if (file) publishArtifact.mutate(file); event.target.value = ''; }} /><Button type="primary" icon={<UploadOutlined />} loading={publishArtifact.isPending} onClick={() => artifactInput.current?.click()}>发布交付物</Button></>}>
          {(artifacts.data ?? []).length ? <div role="list" aria-label="交付物列表"><List dataSource={artifacts.data ?? []} renderItem={(artifact) => <List.Item role="listitem" actions={[<Button key="open" type="link" onClick={() => navigate(`/w/${workspace.id}/p/${project.id}/artifacts/${artifact.artifactId}`)}>打开</Button>]}><List.Item.Meta avatar={<FileOutlined />} title={`${artifact.projectPath ? `${artifact.projectPath}/` : ''}${artifact.name}`} description={artifact.latestVersion ? `v${artifact.latestVersion.version} · ${artifact.latestVersion.fileName} · ${artifact.latestVersion.mediaType}` : '暂无可用版本'} /></List.Item>} /></div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有交付物" />}
        </Card>
        <Card title="外部链接" className="surface-card" extra={<Button icon={<LinkOutlined />} onClick={() => { setEditingLink(null); setLinkName(''); setLinkLocator(''); setLinkDescription(''); setLinkOpen(true); }}>添加链接</Button>}>
          {(links.data ?? []).length ? <div role="list" aria-label="外部链接列表"><List dataSource={links.data ?? []} renderItem={(link) => <List.Item role="listitem" actions={[<Button key="edit" type="link" onClick={() => { setEditingLink(link); setLinkName(link.name); setLinkLocator(link.locator); setLinkDescription(link.description ?? ''); }}>编辑</Button>, <Popconfirm key="delete" title="移入回收站？" onConfirm={() => deleteLink.mutate(link)}><Button type="link" danger>删除</Button></Popconfirm>]}><List.Item.Meta avatar={<LinkOutlined />} title={<a href={link.locator} target="_blank" rel="noreferrer">{link.name}</a>} description={link.description || link.locator} /></List.Item>} /></div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有外部链接" />}
        </Card>
      </div>
      <Modal title="整理项目资料" open={Boolean(editingResource)} okText="保存" cancelText="取消" confirmLoading={updateResource.isPending} okButtonProps={{ disabled: !resourceName.trim() }} onCancel={() => setEditingResource(null)} onOk={() => updateResource.mutate()}>
        <Input aria-label="资料名称" value={resourceName} onChange={(event) => setResourceName(event.target.value)} />
        <Select aria-label="所在文件夹" value={resourceParent} allowClear placeholder="项目根目录" style={{ width: '100%', marginTop: 12 }} onChange={(value) => setResourceParent(value ?? null)} options={[{ label: '项目根目录', value: null }, ...(resources.data ?? []).filter((resource) => resource.kind === 'directory' && resource.resourceId !== editingResource?.resourceId).map((resource) => ({ label: resource.path, value: resource.resourceId }))]} />
      </Modal>
      <Modal title="新建文件夹" open={folderOpen} okText="创建文件夹" cancelText="取消" confirmLoading={createFolder.isPending} okButtonProps={{ disabled: !folderName.trim() }} onCancel={() => setFolderOpen(false)} onOk={() => createFolder.mutate()}>
        <Text type="secondary">给资料建立一个清晰的目录，方便团队成员找到文件。</Text>
        <Input autoFocus aria-label="文件夹名称" value={folderName} placeholder="例如：设计稿、会议记录" onChange={(event) => setFolderName(event.target.value)} style={{ marginTop: 12 }} onPressEnter={() => { if (folderName.trim()) createFolder.mutate(); }} />
      </Modal>
      <Modal title={editingLink ? '编辑外部链接' : '添加外部链接'} open={linkOpen || Boolean(editingLink)} okText={editingLink ? '保存' : '添加'} cancelText="取消" confirmLoading={editingLink ? updateLink.isPending : createLink.isPending} okButtonProps={{ disabled: !linkName.trim() || (!editingLink && !linkLocator.trim()) }} onCancel={() => { setLinkOpen(false); setEditingLink(null); }} onOk={() => editingLink ? updateLink.mutate() : createLink.mutate()}><Input placeholder="名称" value={linkName} onChange={(event) => setLinkName(event.target.value)} /><Input placeholder="https://..." value={linkLocator} disabled={Boolean(editingLink)} onChange={(event) => setLinkLocator(event.target.value)} style={{ marginTop: 12 }} /><Input.TextArea placeholder="描述（可选）" value={linkDescription} onChange={(event) => setLinkDescription(event.target.value)} style={{ marginTop: 12 }} /></Modal>
    </main>
  );
}

export function ProjectSettingsPage() {
  const {
    workspace,
    project,
    archiveProject,
    restoreProject,
    isProjectArchived,
  } = useWorkspace();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const [form] = Form.useForm<{ name: string; description: string | null }>();
  const update = useMutation({
    mutationFn: (value: { name: string; description: string | null }) => api.updateProject(project!.id, {
      name: value.name.trim(),
      description: value.description?.trim() || null,
      expectedRevision: project!.revision,
    }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workspaceKeys.project(project!.id) }),
        queryClient.invalidateQueries({ queryKey: workspaceKeys.projects(workspace.id) }),
      ]);
      void message.success('项目设置已保存。');
    },
    onError: (error) => void message.error(errorMessage(error)),
  });

  if (!project) return <Navigate to={`/w/${workspace.id}/projects`} replace />;
  const canManage = project.role === 'owner' || project.role === 'manager';
  const archived = isProjectArchived?.(project.id) ?? false;
  const canArchive = canManage && Boolean(archiveProject) && Boolean(restoreProject);
  return (
    <main className="page-scroll project-settings-page">
      <div className="page-header project-profile-header">
        <div className="project-title-lockup">
          <span className="project-title-icon"><SettingOutlined /></span>
          <div>
            <Text type="secondary">{project.name}</Text>
            <Title level={2}>项目设置</Title>
          </div>
        </div>
        <Space>
          <Button icon={<FolderOpenOutlined />} onClick={() => navigate(`/w/${workspace.id}/p/${project.id}/resources`)}>查看资源</Button>
          <Button icon={<TeamOutlined />} onClick={() => navigate(`/w/${workspace.id}/p/${project.id}/members`)}>成员 ({project.activeMemberCount})</Button>
          {canArchive && (archived ? (
            <Button
              icon={<RollbackOutlined />}
              onClick={() => {
                restoreProject?.(project.id);
                void message.success('项目已恢复。');
              }}
            >
              恢复项目
            </Button>
          ) : (
            <Popconfirm
              title="归档这个项目？"
              description="归档后会从默认项目列表和侧边栏隐藏；项目资料、会话和交付物不会被删除。当前版本仅对这个浏览器生效。"
              okText="归档"
              cancelText="取消"
              onConfirm={() => {
                archiveProject?.(project.id);
                void message.success('项目已归档。');
                navigate(`/w/${workspace.id}/projects`);
              }}
            >
              <Button danger icon={<InboxOutlined />}>归档项目</Button>
            </Popconfirm>
          ))}
        </Space>
      </div>

      <Card title="基本信息" className="surface-card">
        {archived && <Tag icon={<InboxOutlined />} color="gold" style={{ marginBottom: 16 }}>已归档（仅当前浏览器）</Tag>}
          <Form
            form={form}
            layout="vertical"
            initialValues={{ name: project.name, description: project.description }}
            onFinish={(value) => update.mutate(value)}
          >
            <Form.Item name="name" label="项目名称" rules={[{ required: true, max: 120 }]}>
              <Input disabled={!canManage} />
            </Form.Item>
            <Form.Item name="description" label="描述" rules={[{ max: 3000 }]}>
              <Input.TextArea disabled={!canManage} rows={4} placeholder="暂无描述" />
            </Form.Item>
            {canManage && <Button type="primary" htmlType="submit" loading={update.isPending}>保存设置</Button>}
          </Form>
      </Card>
    </main>
  );
}

export function ProjectMembersPage() {
  const { workspace, project, projectMembers, members } = useWorkspace();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const [form] = Form.useForm<{ workspaceMembershipId: string; role: 'manager' | 'member' }>();
  const selectedWorkspaceMembershipId = Form.useWatch('workspaceMembershipId', form);
  const projectId = project?.id ?? '';
  const canManage = project?.role === 'owner' || project?.role === 'manager';
  const canChangeRoles = project?.role === 'owner';
  const activeWorkspaceMembershipIds = new Set(projectMembers.map((item) => item.workspaceMembershipId));
  const candidates = members.filter((item) => !activeWorkspaceMembershipIds.has(item.membershipId));
  const selectedCandidateIsAgent = candidates.find(
    (item) => item.membershipId === selectedWorkspaceMembershipId,
  )?.actorType === 'agent';
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: workspaceKeys.project(projectId) }),
    queryClient.invalidateQueries({ queryKey: workspaceKeys.projectMembers(projectId) }),
    queryClient.invalidateQueries({ queryKey: workspaceKeys.projects(workspace.id) }),
  ]);
  const add = useMutation({
    mutationFn: (value: { workspaceMembershipId: string; role: 'manager' | 'member' }) => {
      if (!project) throw new Error('项目不存在。');
      return api.addProjectMember(project.id, value);
    },
    onSuccess: async () => {
      form.resetFields();
      await refresh();
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const update = useMutation({
    mutationFn: ({ member, role }: { member: ProjectMember; role: ProjectMember['role'] }) => {
      if (!project) throw new Error('项目不存在。');
      return api.updateProjectMember(project.id, member.projectMembershipId, {
        role,
        expectedRevision: member.revision,
      });
    },
    onSuccess: refresh,
    onError: (error) => void message.error(errorMessage(error)),
  });
  const remove = useMutation({
    mutationFn: (member: ProjectMember) => {
      if (!project) throw new Error('项目不存在。');
      return api.removeProjectMember(project.id, member.projectMembershipId, member.revision);
    },
    onSuccess: refresh,
    onError: (error) => void message.error(errorMessage(error)),
  });
  if (!project) return <Navigate to={`/w/${workspace.id}/projects`} replace />;

  return (
    <main className="page-scroll">
      <div className="page-header">
        <div><Text className="page-eyebrow">PROJECT</Text><Title level={2}>项目成员</Title><Text type="secondary">项目成员会自动进入主群；其他群聊按显式成员管理。</Text></div>
      </div>
      {canManage && (
        <Card style={{ marginBottom: 20 }}>
          <Form
            form={form}
            layout="inline"
            initialValues={{ role: 'member' }}
            onFinish={(value) => add.mutate(value)}
          >
            <Form.Item name="workspaceMembershipId" rules={[{ required: true }]} style={{ minWidth: 260 }}>
              <Select
                showSearch
                optionFilterProp="label"
                placeholder="选择成员或 Agent"
                onChange={(workspaceMembershipId) => {
                  if (candidates.find((item) => item.membershipId === workspaceMembershipId)?.actorType === 'agent') {
                    form.setFieldValue('role', 'member');
                  }
                }}
                options={candidates.map((item) => ({
                  label: `${item.displayName} · ${item.actorType === 'agent' ? 'Agent' : '成员'}`,
                  value: item.membershipId,
                }))}
              />
            </Form.Item>
            <Form.Item name="role">
              <Select disabled={selectedCandidateIsAgent} style={{ width: 130 }} options={[
                { label: '成员', value: 'member' },
                ...(canChangeRoles ? [{ label: '管理员', value: 'manager' as const }] : []),
              ]} />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={add.isPending}>添加</Button>
          </Form>
        </Card>
      )}
      <Card>
        <List
          locale={{ emptyText: <Empty description="还没有项目成员" /> }}
          dataSource={projectMembers}
          renderItem={(member) => {
            const isSelf = member.projectMembershipId === project.membershipId;
            return (
              <List.Item
                actions={canManage ? [
                  <Select
                    key="role"
                    size="small"
                    value={member.role}
                    disabled={!canChangeRoles || member.actorType === 'agent' || member.role === 'owner' || update.isPending}
                    style={{ width: 110 }}
                    options={[
                      { label: '成员', value: 'member' },
                      { label: '管理员', value: 'manager' },
                      { label: '转让所有权', value: 'owner' },
                    ]}
                    onChange={(role) => update.mutate({ member, role })}
                  />,
                  <Popconfirm
                    key="remove"
                    title="移出项目？"
                    disabled={isSelf || member.role === 'owner'}
                    onConfirm={() => remove.mutate(member)}
                  >
                    <Button type="text" danger disabled={isSelf || member.role === 'owner'}>移除</Button>
                  </Popconfirm>,
                ] : []}
              >
                <List.Item.Meta
                  avatar={<Avatar>{member.displayName.slice(0, 1).toUpperCase()}</Avatar>}
                  title={<Space>{member.displayName}{isSelf && <Tag>你</Tag>}</Space>}
                  description={`${member.actorType === 'agent' ? 'Agent' : '成员'} · ${member.role === 'owner' ? '所有者' : member.role === 'manager' ? '管理员' : '成员'}`}
                />
              </List.Item>
            );
          }}
        />
      </Card>
    </main>
  );
}
