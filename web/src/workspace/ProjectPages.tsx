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
import { useLanguage } from '../language';
import { useWorkspace, workspaceKeys } from './workspace-context';

const { Text, Title } = Typography;

function formatBytes(byteLength: number) {
  if (byteLength < 1024) return `${byteLength} B`;
  if (byteLength < 1024 * 1024) return `${(byteLength / 1024).toFixed(1)} KB`;
  return `${(byteLength / 1024 / 1024).toFixed(1)} MB`;
}

export function ProjectsPage() {
  const { workspace, projects, archivedProjects = [], openNewProject, restoreProject } = useWorkspace();
  const { isEnglish } = useLanguage();
  const tx = (zh: string, en: string) => isEnglish ? en : zh;
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
          <Title level={2}>{tx('项目', 'Projects')}</Title>
          <Text type="secondary">{tx('把文件、讨论、任务和交付物放在同一个协作空间。', 'Keep files, discussions, tasks, and deliverables in one collaborative space.')}</Text>
        </div>
        <Space>
          {archivedProjects.length > 0 && (
            <Button icon={<InboxOutlined />} onClick={() => setArchivedOpen(true)}>
              {tx('已归档', 'Archived')} ({archivedProjects.length})
            </Button>
          )}
          <Button type="primary" size="large" icon={<PlusOutlined />} onClick={openNewProject}>{tx('新建项目', 'New project')}</Button>
        </Space>
      </div>
      {projects.length ? (
        <div className="project-directory-grid" aria-label={tx('项目列表', 'Project list')}>
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
                  <Text type="secondary">{project.governanceOnly ? tx('仅可查看项目治理信息', 'Governance information only') : (project.description || tx('还没有项目描述', 'No project description'))}</Text>
                </div>
              </div>
              <div className="project-directory-card-meta">
                <span><TeamOutlined /> {project.activeMemberCount} {tx('位成员', 'members')}</span>
                <span><MessageOutlined /> {project.conversationCount} {tx('个会话', 'conversations')}</span>
              </div>
              <div className="project-directory-card-footer">
                <Tag color={project.governanceOnly ? 'default' : 'blue'}>
                  {project.governanceOnly ? tx('仅治理权限', 'Governance only') : project.role === 'owner' ? tx('所有者', 'Owner') : project.role === 'manager' ? tx('管理员', 'Manager') : tx('成员', 'Member')}
                </Tag>
                <Button type="link" tabIndex={-1}>{tx('打开项目', 'Open project')} <span aria-hidden="true">→</span></Button>
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
                <Text strong>{archivedProjects.length ? tx('没有未归档项目', 'No unarchived projects') : tx('还没有项目', 'No projects yet')}</Text>
                <Text type="secondary">{archivedProjects.length ? tx('已归档项目可从上方入口恢复。', 'Restore archived projects from the entry above.') : tx('创建一个项目，把资料、任务和 Agent 协作集中起来。', 'Create a project to bring files, tasks, and Agent collaboration together.')}</Text>
              </Space>
            )}
          >
            {archivedProjects.length ? (
              <Button icon={<InboxOutlined />} onClick={() => setArchivedOpen(true)}>{tx('查看已归档项目', 'View archived projects')}</Button>
            ) : (
              <Button type="primary" icon={<PlusOutlined />} onClick={openNewProject}>{tx('创建第一个项目', 'Create your first project')}</Button>
            )}
          </Empty>
        </Card>
      )}
      <Modal
        title={tx('已归档项目', 'Archived projects')}
        open={archivedOpen}
        footer={<Button onClick={() => setArchivedOpen(false)}>{tx('关闭', 'Close')}</Button>}
        onCancel={() => setArchivedOpen(false)}
      >
        <Text type="secondary">{tx('归档只影响当前浏览器的默认展示，不会删除项目资料、会话或交付物。', 'Archiving only affects the default display in this browser; it does not delete project files, conversations, or deliverables.')}</Text>
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
                    void message.success(tx('项目已恢复。', 'Project restored.'));
                  }}
                >
                  {tx('恢复', 'Restore')}
                </Button>,
                <Button key="open" type="link" onClick={() => openProject(archivedProject)}>{tx('查看', 'View')}</Button>,
              ]}
            >
              <List.Item.Meta
                avatar={<InboxOutlined />}
                title={archivedProject.name}
                description={archivedProject.description || tx('已归档项目', 'Archived projects')}
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
  const { isEnglish } = useLanguage();
  const tx = (zh: string, en: string) => isEnglish ? en : zh;
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
  const uploadResource = useMutation({ mutationFn: (file: File) => api.uploadProjectResource(project!.id, file), onSuccess: async () => { await refresh(); void message.success(tx('项目资料已上传。', 'Project file uploaded.')); }, onError: (error) => void message.error(errorMessage(error)) });
  const updateResource = useMutation({ mutationFn: () => { if (!editingResource) throw new Error(tx('资料不存在。', 'Resource not found.')); return api.updateProjectResourceInProject(project!.id, editingResource.resourceId, { name: resourceName.trim(), parentResourceId: resourceParent }); }, onSuccess: async () => { setEditingResource(null); await refresh(); void message.success(tx('项目资料已更新。', 'Project file updated.')); }, onError: (error) => void message.error(errorMessage(error)) });
  const deleteResource = useMutation({ mutationFn: (resource: ProjectResource) => api.deleteProjectResource(resource.resourceId), onSuccess: async () => { await refresh(); void message.success(tx('项目资料已移入回收站。', 'Project file moved to trash.')); }, onError: (error) => void message.error(errorMessage(error)) });
  const replaceResource = useMutation({ mutationFn: async (file: File) => { if (!replacementTarget) throw new Error(tx('资料不存在。', 'Resource not found.')); return api.replaceProjectResource(replacementTarget.resourceId, file, replacementTarget.revision); }, onSuccess: async () => { setReplacementTarget(null); await refresh(); void message.success(tx('项目资料已替换。', 'Project file replaced.')); }, onError: (error) => void message.error(errorMessage(error)) });
  const publishArtifact = useMutation({ mutationFn: (file: File) => api.publishArtifactV2(project!.id, file, { artifactPath: '' }), onSuccess: async (result) => { await refresh(); navigate(`/w/${workspace.id}/p/${project!.id}/artifacts/${result.artifact.artifactId}`); }, onError: (error) => void message.error(errorMessage(error)) });
  const createFolder = useMutation({ mutationFn: () => api.createProjectResourceFolder(project!.id, { name: folderName.trim() }), onSuccess: async () => { setFolderName(''); setFolderOpen(false); await refresh(); void message.success(tx('文件夹已创建。', 'Folder created.')); }, onError: (error) => void message.error(errorMessage(error)) });
  const createLink = useMutation({ mutationFn: () => api.createProjectLink(project!.id, { name: linkName.trim(), locator: linkLocator.trim(), description: linkDescription.trim() || null }), onSuccess: async () => { setLinkOpen(false); setLinkName(''); setLinkLocator(''); setLinkDescription(''); await refresh(); void message.success(tx('外部链接已添加。', 'External link added.')); }, onError: (error) => void message.error(errorMessage(error)) });
  const updateLink = useMutation({ mutationFn: () => { if (!editingLink) throw new Error(tx('链接不存在。', 'Link not found.')); return api.updateProjectLinkInProject(project!.id, editingLink.linkId, { name: linkName.trim(), description: linkDescription.trim() || null }); }, onSuccess: async () => { setEditingLink(null); await refresh(); void message.success(tx('外部链接已更新。', 'External link updated.')); }, onError: (error) => void message.error(errorMessage(error)) });
  const deleteLink = useMutation({ mutationFn: (link: ProjectLink) => api.deleteProjectLink(link.linkId), onSuccess: async () => { await refresh(); void message.success(tx('外部链接已移入回收站。', 'External link moved to trash.')); }, onError: (error) => void message.error(errorMessage(error)) });
  if (!project) return <Navigate to={`/w/${workspace.id}/projects`} replace />;
  return (
    <main className="page-scroll project-profile-page">
      <div className="page-header project-profile-header"><div className="project-title-lockup"><span className="project-title-icon"><FolderOpenOutlined /></span><div><Text type="secondary">{project.name}</Text><Title level={2}>{tx('项目资源', 'Project resources')}</Title><Text type="secondary">{tx('项目资料、交付物和外部链接都在这里。', 'Project files, deliverables, and external links live here.')}</Text></div></div><Space><Button aria-label={tx('任务看板', 'Task board')} icon={<ProjectOutlined />} onClick={() => navigate(`/w/${workspace.id}/p/${project.id}/work-items`)}>{tx('任务看板', 'Task board')}</Button><Button aria-label={tx('项目设置', 'Project settings')} icon={<SettingOutlined />} onClick={() => navigate(`/w/${workspace.id}/p/${project.id}`)}>{tx('设置', 'Settings')}</Button><Button aria-label={tx('项目成员', 'Project members')} icon={<TeamOutlined />} onClick={() => navigate(`/w/${workspace.id}/p/${project.id}/members`)}>{tx('成员', 'Members')} ({projectMembers.length})</Button><Button type="primary" icon={<MessageOutlined />} onClick={openNewConversation}>{tx('新建会话', 'New conversation')}</Button></Space></div>
      <div className="project-profile-grid">
        <Card title={tx('项目资料', 'Project files')} className="surface-card" extra={<Space><Button icon={<FolderOutlined />} loading={createFolder.isPending} onClick={() => { setFolderName(''); setFolderOpen(true); }}>{tx('新建文件夹', 'New folder')}</Button><Button type="primary" icon={<UploadOutlined />} loading={uploadResource.isPending} onClick={() => resourceInput.current?.click()}>{tx('上传资料', 'Upload files')}</Button></Space>}>
          <input ref={resourceInput} hidden type="file" onChange={(event) => { const file = event.target.files?.[0]; if (file) uploadResource.mutate(file); event.target.value = ''; }} />
          <input ref={replaceInput} hidden type="file" onChange={(event) => { const file = event.target.files?.[0]; if (file) replaceResource.mutate(file); event.target.value = ''; }} />
          {(resources.data ?? []).length ? <div role="list" aria-label={tx('项目资源列表', 'Project resource list')}><List dataSource={resources.data ?? []} renderItem={(resource) => <List.Item role="listitem" actions={[...(resource.kind === 'file' ? [<Button key="download" type="link" href={`/v1/projects/${project.id}/resources/${resource.resourceId}/download`}>{tx('下载', 'Download')}</Button>, <Button key="replace" type="link" onClick={() => { setReplacementTarget(resource); replaceInput.current?.click(); }}>{tx('替换', 'Replace')}</Button>] : []), <Button key="edit" type="link" onClick={() => { setEditingResource(resource); setResourceName(resource.name); setResourceParent(resource.parentResourceId); }}>{tx('整理', 'Organize')}</Button>, <Popconfirm key="delete" title={tx('移入回收站？', 'Move to trash?')} description={tx('删除后可以在回收站中恢复。', 'You can restore it from the trash after deleting.')} onConfirm={() => deleteResource.mutate(resource)}><Button type="link" danger>{tx('删除', 'Delete')}</Button></Popconfirm>]}><List.Item.Meta avatar={resource.kind === 'directory' ? <FolderOutlined /> : <FileOutlined />} title={resource.path} description={resource.kind === 'directory' ? tx('文件夹', 'Folder') : `${resource.mediaType ?? tx('文件', 'File')} · ${formatBytes(resource.byteLength ?? 0)} · ${tx('更新于', 'Updated')} ${new Date(resource.updatedAt).toLocaleDateString(isEnglish ? 'en-US' : 'zh-CN')}`} /></List.Item>} /></div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={tx('还没有项目资料', 'No project files yet')} />}
        </Card>
        <Card title={tx('交付物', 'Deliverables')} className="surface-card" extra={<><input ref={artifactInput} hidden type="file" onChange={(event) => { const file = event.target.files?.[0]; if (file) publishArtifact.mutate(file); event.target.value = ''; }} /><Button type="primary" icon={<UploadOutlined />} loading={publishArtifact.isPending} onClick={() => artifactInput.current?.click()}>{tx('发布交付物', 'Publish deliverable')}</Button></>}>
          {(artifacts.data ?? []).length ? <div role="list" aria-label={tx('交付物列表', 'Deliverables list')}><List dataSource={artifacts.data ?? []} renderItem={(artifact) => <List.Item role="listitem" actions={[<Button key="open" type="link" onClick={() => navigate(`/w/${workspace.id}/p/${project.id}/artifacts/${artifact.artifactId}`)}>{tx('打开', 'Open')}</Button>]}><List.Item.Meta avatar={<FileOutlined />} title={`${artifact.projectPath ? `${artifact.projectPath}/` : ''}${artifact.name}`} description={artifact.latestVersion ? `v${artifact.latestVersion.version} · ${artifact.latestVersion.fileName} · ${artifact.latestVersion.mediaType}` : tx('暂无可用版本', 'No available version')} /></List.Item>} /></div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={tx('还没有交付物', 'No deliverables yet')} />}
        </Card>
        <Card title={tx('外部链接', 'External links')} className="surface-card" extra={<Button icon={<LinkOutlined />} onClick={() => { setEditingLink(null); setLinkName(''); setLinkLocator(''); setLinkDescription(''); setLinkOpen(true); }}>{tx('添加链接', 'Add link')}</Button>}>
          {(links.data ?? []).length ? <div role="list" aria-label={tx('外部链接列表', 'External links list')}><List dataSource={links.data ?? []} renderItem={(link) => <List.Item role="listitem" actions={[<Button key="edit" type="link" onClick={() => { setEditingLink(link); setLinkName(link.name); setLinkLocator(link.locator); setLinkDescription(link.description ?? ''); }}>{tx('编辑', 'Edit')}</Button>, <Popconfirm key="delete" title={tx('移入回收站？', 'Move to trash?')} onConfirm={() => deleteLink.mutate(link)}><Button type="link" danger>{tx('删除', 'Delete')}</Button></Popconfirm>]}><List.Item.Meta avatar={<LinkOutlined />} title={<a href={link.locator} target="_blank" rel="noreferrer">{link.name}</a>} description={link.description || link.locator} /></List.Item>} /></div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={tx('还没有外部链接', 'No external links yet')} />}
        </Card>
      </div>
      <Modal title={tx('整理项目资料', 'Organize project files')} open={Boolean(editingResource)} okText={tx('保存', 'Save')} cancelText={tx('取消', 'Cancel')} confirmLoading={updateResource.isPending} okButtonProps={{ disabled: !resourceName.trim() }} onCancel={() => setEditingResource(null)} onOk={() => updateResource.mutate()}>
        <Input aria-label={tx('资料名称', 'Resource name')} value={resourceName} onChange={(event) => setResourceName(event.target.value)} />
        <Select aria-label={tx('所在文件夹', 'Folder')} value={resourceParent} allowClear placeholder={tx('项目根目录', 'Project root')} style={{ width: '100%', marginTop: 12 }} onChange={(value) => setResourceParent(value ?? null)} options={[{ label: tx('项目根目录', 'Project root'), value: null }, ...(resources.data ?? []).filter((resource) => resource.kind === 'directory' && resource.resourceId !== editingResource?.resourceId).map((resource) => ({ label: resource.path, value: resource.resourceId }))]} />
      </Modal>
      <Modal title={tx('新建文件夹', 'New folder')} open={folderOpen} okText={tx('创建文件夹', 'Create folder')} cancelText={tx('取消', 'Cancel')} confirmLoading={createFolder.isPending} okButtonProps={{ disabled: !folderName.trim() }} onCancel={() => setFolderOpen(false)} onOk={() => createFolder.mutate()}>
        <Text type="secondary">{tx('给资料建立一个清晰的目录，方便团队成员找到文件。', 'Create a clear folder structure so teammates can find files easily.')}</Text>
        <Input autoFocus aria-label={tx('文件夹名称', 'Folder name')} value={folderName} placeholder={tx('例如：设计稿、会议记录', 'e.g. Design drafts, Meeting notes')} onChange={(event) => setFolderName(event.target.value)} style={{ marginTop: 12 }} onPressEnter={() => { if (folderName.trim()) createFolder.mutate(); }} />
      </Modal>
      <Modal title={editingLink ? tx('编辑外部链接', 'Edit external link') : tx('添加外部链接', 'Add external link')} open={linkOpen || Boolean(editingLink)} okText={editingLink ? tx('保存', 'Save') : tx('添加', 'Add')} cancelText={tx('取消', 'Cancel')} confirmLoading={editingLink ? updateLink.isPending : createLink.isPending} okButtonProps={{ disabled: !linkName.trim() || (!editingLink && !linkLocator.trim()) }} onCancel={() => { setLinkOpen(false); setEditingLink(null); }} onOk={() => editingLink ? updateLink.mutate() : createLink.mutate()}><Input placeholder={tx('名称', 'Name')} value={linkName} onChange={(event) => setLinkName(event.target.value)} /><Input placeholder="https://..." value={linkLocator} disabled={Boolean(editingLink)} onChange={(event) => setLinkLocator(event.target.value)} style={{ marginTop: 12 }} /><Input.TextArea placeholder={tx('描述（可选）', 'Description (optional)')} value={linkDescription} onChange={(event) => setLinkDescription(event.target.value)} style={{ marginTop: 12 }} /></Modal>
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
  const { isEnglish } = useLanguage();
  const tx = (zh: string, en: string) => isEnglish ? en : zh;
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
      void message.success(tx('项目设置已保存。', 'Project settings saved.'));
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
            <Title level={2}>{tx('项目设置', 'Project settings')}</Title>
          </div>
        </div>
        <Space>
          <Button icon={<FolderOpenOutlined />} onClick={() => navigate(`/w/${workspace.id}/p/${project.id}/resources`)}>{tx('查看资源', 'View resources')}</Button>
          <Button icon={<TeamOutlined />} onClick={() => navigate(`/w/${workspace.id}/p/${project.id}/members`)}>{tx('成员', 'Members')} ({project.activeMemberCount})</Button>
          {canArchive && (archived ? (
            <Button
              icon={<RollbackOutlined />}
              onClick={() => {
                restoreProject?.(project.id);
                void message.success(tx('项目已恢复。', 'Project restored.'));
              }}
            >
              {tx('恢复项目', 'Restore project')}
            </Button>
          ) : (
            <Popconfirm
              title={tx('归档这个项目？', 'Archive this project?')}
              description={tx('归档后会从默认项目列表和侧边栏隐藏；项目资料、会话和交付物不会被删除。当前版本仅对这个浏览器生效。', 'Archiving hides it from the default project list and sidebar; project files, conversations, and deliverables are not deleted. This version only applies to this browser.')}
              okText={tx('归档', 'Archive')}
              cancelText={tx('取消', 'Cancel')}
              onConfirm={() => {
                archiveProject?.(project.id);
                void message.success(tx('项目已归档。', 'Project archived.'));
                navigate(`/w/${workspace.id}/projects`);
              }}
            >
              <Button danger icon={<InboxOutlined />}>{tx('归档项目', 'Archive project')}</Button>
            </Popconfirm>
          ))}
        </Space>
      </div>

      <Card title={tx('基本信息', 'Basic information')} className="surface-card">
        {archived && <Tag icon={<InboxOutlined />} color="gold" style={{ marginBottom: 16 }}>{tx('已归档（仅当前浏览器）', 'Archived (this browser only).')}</Tag>}
          <Form
            form={form}
            layout="vertical"
            initialValues={{ name: project.name, description: project.description }}
            onFinish={(value) => update.mutate(value)}
          >
            <Form.Item name="name" label={tx('项目名称', 'Project name')} rules={[{ required: true, max: 120 }]}>
              <Input disabled={!canManage} />
            </Form.Item>
            <Form.Item name="description" label={tx('描述', 'Description')} rules={[{ max: 3000 }]}>
              <Input.TextArea disabled={!canManage} rows={4} placeholder={tx('暂无描述', 'No description')} />
            </Form.Item>
            {canManage && <Button type="primary" htmlType="submit" loading={update.isPending}>{tx('保存设置', 'Save settings')}</Button>}
          </Form>
      </Card>
    </main>
  );
}

export function ProjectMembersPage() {
  const { workspace, project, projectMembers, members } = useWorkspace();
  const { isEnglish } = useLanguage();
  const tx = (zh: string, en: string) => isEnglish ? en : zh;
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
      if (!project) throw new Error(tx('项目不存在。', 'Project not found.'));
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
      if (!project) throw new Error(tx('项目不存在。', 'Project not found.'));
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
      if (!project) throw new Error(tx('项目不存在。', 'Project not found.'));
      return api.removeProjectMember(project.id, member.projectMembershipId, member.revision);
    },
    onSuccess: refresh,
    onError: (error) => void message.error(errorMessage(error)),
  });
  if (!project) return <Navigate to={`/w/${workspace.id}/projects`} replace />;

  return (
    <main className="page-scroll">
      <div className="page-header">
        <div><Text className="page-eyebrow">PROJECT</Text><Title level={2}>{tx('项目成员', 'Project members')}</Title><Text type="secondary">{tx('项目成员会自动进入主群；其他群聊按显式成员管理。', 'Project members automatically join the main group; other group chats are managed by explicit membership.')}</Text></div>
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
                placeholder={tx('选择成员或 Agent', 'Select a member or Agent')}
                onChange={(workspaceMembershipId) => {
                  if (candidates.find((item) => item.membershipId === workspaceMembershipId)?.actorType === 'agent') {
                    form.setFieldValue('role', 'member');
                  }
                }}
                options={candidates.map((item) => ({
                  label: `${item.displayName} · ${item.actorType === 'agent' ? 'Agent' : tx('成员', 'Member')}`,
                  value: item.membershipId,
                }))}
              />
            </Form.Item>
            <Form.Item name="role">
              <Select disabled={selectedCandidateIsAgent} style={{ width: 130 }} options={[
                { label: tx('成员', 'Member'), value: 'member' },
                ...(canChangeRoles ? [{ label: tx('管理员', 'Manager'), value: 'manager' as const }] : []),
              ]} />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={add.isPending}>{tx('添加', 'Add')}</Button>
          </Form>
        </Card>
      )}
      <Card>
        <List
          locale={{ emptyText: <Empty description={tx('还没有项目成员', 'No project members yet')} /> }}
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
                      { label: tx('成员', 'Member'), value: 'member' },
                      { label: tx('管理员', 'Manager'), value: 'manager' },
                      { label: tx('转让所有权', 'Transfer ownership'), value: 'owner' },
                    ]}
                    onChange={(role) => update.mutate({ member, role })}
                  />,
                  <Popconfirm
                    key="remove"
                    title={tx('移出项目？', 'Remove from project?')}
                    disabled={isSelf || member.role === 'owner'}
                    onConfirm={() => remove.mutate(member)}
                  >
                    <Button type="text" danger disabled={isSelf || member.role === 'owner'}>{tx('移除', 'Remove')}</Button>
                  </Popconfirm>,
                ] : []}
              >
                <List.Item.Meta
                  avatar={<Avatar>{member.displayName.slice(0, 1).toUpperCase()}</Avatar>}
                  title={<Space>{member.displayName}{isSelf && <Tag>{tx('你', 'You')}</Tag>}</Space>}
                  description={`${member.actorType === 'agent' ? 'Agent' : tx('成员', 'Member')} · ${member.role === 'owner' ? tx('所有者', 'Owner') : member.role === 'manager' ? tx('管理员', 'Manager') : tx('成员', 'Member')}`}
                />
              </List.Item>
            );
          }}
        />
      </Card>
    </main>
  );
}
