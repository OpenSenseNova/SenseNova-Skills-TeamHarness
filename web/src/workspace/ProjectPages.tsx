import {
  BranchesOutlined,
  CheckCircleOutlined,
  CloudOutlined,
  CopyOutlined,
  DownOutlined,
  DisconnectOutlined,
  ExclamationCircleOutlined,
  FileMarkdownOutlined,
  FileOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  GlobalOutlined,
  ImportOutlined,
  LinkOutlined,
  MessageOutlined,
  PlusOutlined,
  TeamOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Avatar,
  Button,
  Card,
  Descriptions,
  Dropdown,
  Empty,
  Form,
  Input,
  List,
  Modal,
  Popconfirm,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api, errorMessage, type Artifact, type Project, type ProjectMember, type ProjectResourceLink, type ProjectWorkingCopy } from '../api/client';
import { useWorkspace, workspaceKeys } from './workspace-context';

const { Text, Title } = Typography;

const workingCopyLabels: Record<Project['workingCopySummary'], { label: string; color: string }> = {
  connected: { label: '已连接', color: 'success' },
  not_connected: { label: '未连接', color: 'default' },
  mismatch: { label: 'Repository 不匹配', color: 'error' },
  computer_offline: { label: 'Computer 离线', color: 'warning' },
};

function workingCopyStatus(copy: ProjectWorkingCopy) {
  if (copy.availability === 'mismatch') return { label: 'Repository 不匹配', color: 'error', icon: <ExclamationCircleOutlined /> };
  if (copy.connectionStatus === 'offline') return { label: 'Computer 离线', color: 'warning', icon: <CloudOutlined /> };
  if (copy.availability === 'ready') return { label: '已连接', color: 'success', icon: <CheckCircleOutlined /> };
  return { label: '未连接', color: 'default', icon: <DisconnectOutlined /> };
}

type ProjectResourceItem =
  | { kind: 'artifact'; id: string; updatedAt: number; artifact: Artifact }
  | { kind: 'link'; id: string; updatedAt: number; link: ProjectResourceLink };

function formatBytes(byteLength: number) {
  if (byteLength < 1024) return `${byteLength} B`;
  if (byteLength < 1024 * 1024) return `${(byteLength / 1024).toFixed(1)} KB`;
  return `${(byteLength / 1024 / 1024).toFixed(1)} MB`;
}

function resourceLinkHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function ProjectsPage() {
  const { workspace, projects, openNewProject } = useWorkspace();
  const navigate = useNavigate();
  return (
    <main className="page-scroll project-directory-page">
      <div className="page-header project-directory-header">
        <div>
          <Title level={2}>项目</Title>
          <Text type="secondary">Project 是可选协作范围，用来组织成员、Conversation、Artifact 与外部资料。</Text>
        </div>
        <Button type="primary" size="large" icon={<PlusOutlined />} onClick={openNewProject}>新建项目</Button>
      </div>
      {projects.length ? (
        <section aria-labelledby="project-list-title">
          <div className="project-list-heading">
            <Title id="project-list-title" level={5}>全部项目</Title>
            <Text type="secondary">{projects.length} 个</Text>
          </div>
          <div className="project-repository-list">
            {projects.map((project) => (
              <button
                key={project.id}
                type="button"
                className="project-repository-row"
                aria-label={`打开项目 ${project.name}`}
                onClick={() => navigate(`/w/${workspace.id}/p/${project.id}`)}
              >
                <span className="project-repository-icon"><FolderOpenOutlined /></span>
                <span className="project-repository-main">
                  <strong>{project.name}</strong>
                  <span>{project.repository?.repositoryIdentity ?? project.description ?? '无需 Repository 也可协作'}</span>
                </span>
                <span className="project-repository-branch">{project.repository ? <><BranchesOutlined /> {project.repository.defaultBranch}</> : 'Scratch Run'}</span>
                <Tag color={project.repository ? workingCopyLabels[project.workingCopySummary].color : 'blue'}>
                  {project.repository ? workingCopyLabels[project.workingCopySummary].label : '无 Repository'}
                </Tag>
                <span className="project-repository-meta">
                  <span><TeamOutlined /> {project.activeMemberCount}</span>
                  <span><MessageOutlined /> {project.conversationCount}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : (
        <Card className="surface-card project-empty-card" variant="borderless">
          <Empty
            image={<FolderOutlined className="project-empty-icon" />}
            description={(
              <Space orientation="vertical" size={2}>
                <Text strong>还没有项目</Text>
                <Text type="secondary">先创建协作范围；Primary Repository 可以现在挂载，也可以以后再添加。</Text>
              </Space>
            )}
          >
            <Button type="primary" icon={<PlusOutlined />} onClick={openNewProject}>创建第一个项目</Button>
          </Empty>
        </Card>
      )}
    </main>
  );
}

export function ProjectHome() {
  const { workspace, project, conversations, openNewConversation } = useWorkspace();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const [form] = Form.useForm<{ name: string; description: string | null }>();
  const [repositoryForm] = Form.useForm<{ cloneUrl: string; defaultBranch: string }>();
  const [resourceLinkForm] = Form.useForm<{ title: string; url: string; description?: string }>();
  const [resourceLinkEditForm] = Form.useForm<{ title: string; url: string; description?: string }>();
  const [editingResourceLink, setEditingResourceLink] = useState<ProjectResourceLink | null>(null);
  const [artifactToMove, setArtifactToMove] = useState<string>();
  const [artifactPickerOpen, setArtifactPickerOpen] = useState(false);
  const [resourceLinkCreateOpen, setResourceLinkCreateOpen] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null);
  const workingCopies = useQuery({
    queryKey: workspaceKeys.projectWorkingCopies(project?.id ?? ''),
    queryFn: () => api.listProjectWorkingCopies(project!.id).then((page) => page.items),
    enabled: Boolean(project),
    refetchInterval: 10_000,
  });
  const resourceLinks = useQuery({
    queryKey: workspaceKeys.projectResourceLinks(project?.id ?? ''),
    queryFn: () => api.listProjectResourceLinks(project!.id).then((page) => page.items),
    enabled: Boolean(project),
  });
  const projectArtifacts = useQuery({
    queryKey: workspaceKeys.artifacts(workspace.id, project?.id),
    queryFn: () => api.listArtifacts(workspace.id, project!.id).then((page) => page.items),
    enabled: Boolean(project),
  });
  const workspaceArtifacts = useQuery({
    queryKey: workspaceKeys.artifacts(workspace.id),
    queryFn: () => api.listArtifacts(workspace.id).then((page) => page.items),
    enabled: Boolean(project),
  });
  const refreshProject = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: workspaceKeys.project(project!.id) }),
      queryClient.invalidateQueries({ queryKey: workspaceKeys.projects(workspace.id) }),
      queryClient.invalidateQueries({ queryKey: workspaceKeys.projectWorkingCopies(project!.id) }),
    ]);
  };
  const refreshProjectResources = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['workspace', workspace.id, 'artifacts'] }),
      queryClient.invalidateQueries({ queryKey: workspaceKeys.projectResourceLinks(project!.id) }),
      queryClient.invalidateQueries({ queryKey: workspaceKeys.project(project!.id) }),
      queryClient.invalidateQueries({ queryKey: workspaceKeys.projects(workspace.id) }),
    ]);
  };
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
      void message.success('Project 资料已更新。');
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const putRepository = useMutation({
    mutationFn: (value: { cloneUrl: string; defaultBranch: string }) => api.putProjectRepository(project!.id, {
      cloneUrl: value.cloneUrl.trim(),
      defaultBranch: value.defaultBranch.trim(),
      expectedProjectRevision: project!.revision,
      ...(project!.repository ? { expectedRepositoryRevision: project!.repository.revision } : {}),
    }),
    onSuccess: async () => {
      await refreshProject();
      void message.success(project!.repository ? '默认分支已更新。' : 'Primary Repository 已挂载。');
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const detachRepository = useMutation({
    mutationFn: () => api.deleteProjectRepository(project!.id, {
      expectedProjectRevision: project!.revision,
      expectedRepositoryRevision: project!.repository!.revision,
    }),
    onSuccess: async () => {
      repositoryForm.resetFields();
      await refreshProject();
      void message.success('Primary Repository 已解除；后续 Run 将使用 scratch workdir。');
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const createResourceLink = useMutation({
    mutationFn: (value: { title: string; url: string; description?: string }) => api.createProjectResourceLink(project!.id, {
      title: value.title.trim(), url: value.url.trim(), description: value.description?.trim() || null,
    }),
    onSuccess: async () => {
      resourceLinkForm.resetFields();
      setResourceLinkCreateOpen(false);
      await refreshProjectResources();
      void message.success('外部链接已添加。');
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const deleteResourceLink = useMutation({
    mutationFn: (link: { id: string; revision: number }) => api.deleteProjectResourceLink(project!.id, link.id, link.revision),
    onSuccess: async () => {
      await refreshProjectResources();
      void message.success('外部链接已删除。');
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const updateResourceLink = useMutation({
    mutationFn: (value: { title: string; url: string; description?: string }) => api.updateProjectResourceLink(
      project!.id,
      editingResourceLink!.id,
      {
        title: value.title.trim(),
        url: value.url.trim(),
        description: value.description?.trim() || null,
        expectedRevision: editingResourceLink!.revision,
      },
    ),
    onSuccess: async () => {
      setEditingResourceLink(null);
      await refreshProjectResources();
      void message.success('外部链接已更新。');
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const uploadProjectFile = useMutation({
    mutationFn: (file: File) => api.createFileArtifact(workspace.id, file, file.name, [project!.id]),
    onSuccess: async () => {
      await refreshProjectResources();
      void message.success('文件已上传到项目资源。');
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const moveArtifactToProject = useMutation({
    mutationFn: (artifactId: string) => api.associateArtifact(project!.id, artifactId),
    onSuccess: async () => {
      setArtifactToMove(undefined);
      setArtifactPickerOpen(false);
      await refreshProjectResources();
      void message.success('Artifact 已加入项目资源。');
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const removeArtifactFromProject = useMutation({
    mutationFn: (artifactId: string) => api.dissociateArtifact(project!.id, artifactId),
    onSuccess: async () => {
      await refreshProjectResources();
      void message.success('Artifact 已移出项目资源。');
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  if (!project) return <Navigate to={`/w/${workspace.id}/projects`} replace />;
  const bindCommand = `anc-computer project bind --project ${project.id}`;
  const cloneCommand = `anc-computer project clone --project ${project.id}`;
  const connected = project.workingCopySummary === 'connected';
  const movableArtifacts = (workspaceArtifacts.data ?? []).filter((artifact) => !artifact.projectIds.includes(project.id));
  const projectResources: ProjectResourceItem[] = [
    ...(projectArtifacts.data ?? []).map((artifact) => ({
      kind: 'artifact' as const,
      id: artifact.id,
      updatedAt: artifact.updatedAt,
      artifact,
    })),
    ...(resourceLinks.data ?? []).map((link) => ({
      kind: 'link' as const,
      id: link.id,
      updatedAt: link.updatedAt,
      link,
    })),
  ].sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
  const addResourceMenu = {
    items: [
      { key: 'upload', icon: <UploadOutlined />, label: '上传文件' },
      { key: 'artifact', icon: <ImportOutlined />, label: '加入已有 Artifact' },
      { key: 'link', icon: <LinkOutlined />, label: '添加外部链接' },
    ],
    onClick: ({ key }: { key: string }) => {
      if (key === 'upload') uploadInput.current?.click();
      if (key === 'artifact') setArtifactPickerOpen(true);
      if (key === 'link') setResourceLinkCreateOpen(true);
    },
  };
  return (
    <main className="page-scroll project-profile-page">
      <div className="page-header project-profile-header">
        <div className="project-title-lockup">
          <span className="project-title-icon"><FolderOpenOutlined /></span>
          <div>
            <Title level={2}>{project.name}</Title>
            <Text type="secondary">{project.description || 'Project 协作概览'}</Text>
          </div>
        </div>
        <Space>
          <Button aria-label="管理项目成员" icon={<TeamOutlined />} onClick={() => navigate(`/w/${workspace.id}/p/${project.id}/members`)}>成员</Button>
          <Button aria-label="新建项目会话" type="primary" icon={<MessageOutlined />} onClick={openNewConversation}>新建会话</Button>
        </Space>
      </div>

      {project.repository && !connected && (
        <Alert
          className="project-connection-alert"
          type={project.workingCopySummary === 'mismatch' ? 'error' : 'warning'}
          showIcon
          title={project.workingCopySummary === 'mismatch' ? 'Repository 不匹配' : '需要连接仓库'}
          description="仍然可以进入 Conversation，并使用 Artifact 和 Resource Link；需要仓库的 Project Run 会等待匹配的 Working Copy。"
        />
      )}

      <div className="project-profile-grid">
        <Card title="资料" className="surface-card">
          <Form
            form={form}
            layout="vertical"
            initialValues={{ name: project.name, description: project.description }}
            onFinish={(value) => update.mutate(value)}
          >
            <Form.Item name="name" label="显示名称" rules={[{ required: true, max: 120 }]}>
              <Input disabled={project.role !== 'manager'} />
            </Form.Item>
            <Form.Item name="description" label="描述" rules={[{ max: 3000 }]}>
              <Input.TextArea disabled={project.role !== 'manager'} rows={4} placeholder="暂无描述" />
            </Form.Item>
            {project.role === 'manager' && <Button htmlType="submit" loading={update.isPending}>保存资料</Button>}
          </Form>
        </Card>

        <Card title="Primary Repository" className="surface-card">
          {project.repository && (
            <Descriptions column={1} size="small">
              <Descriptions.Item label="Identity"><Text code>{project.repository.repositoryIdentity}</Text></Descriptions.Item>
              <Descriptions.Item label="Clone URL"><Text copyable>{project.repository.cloneUrl}</Text></Descriptions.Item>
            </Descriptions>
          )}
          <Form
            form={repositoryForm}
            layout="vertical"
            initialValues={{
              cloneUrl: project.repository?.cloneUrl ?? '',
              defaultBranch: project.repository?.defaultBranch ?? 'main',
            }}
            onFinish={(value) => putRepository.mutate(value)}
          >
            <Form.Item name="cloneUrl" label="Clone URL" rules={[{ required: true, max: 2000 }]}>
              <Input disabled={Boolean(project.repository) || project.role !== 'manager'} placeholder="https://github.com/org/repo.git" />
            </Form.Item>
            <Form.Item name="defaultBranch" label="默认分支" rules={[{ required: true, max: 255 }]}>
              <Input disabled={project.role !== 'manager'} />
            </Form.Item>
            {project.role === 'manager' && (
              <Space>
                <Button htmlType="submit" loading={putRepository.isPending}>{project.repository ? '更新默认分支' : '挂载 Repository'}</Button>
                {project.repository && (
                  <Popconfirm title="解除 Primary Repository？" description="有 active Attempt 时会被拒绝。" onConfirm={() => detachRepository.mutate()}>
                    <Button danger loading={detachRepository.isPending}>解除</Button>
                  </Popconfirm>
                )}
              </Space>
            )}
          </Form>
          <Text type="secondary">Repository identity 不可原地修改；更换时先解除，再挂载新的 Repository。</Text>
        </Card>
      </div>

      {project.repository && <Card title="本机 Working Copy" className="surface-card project-working-copies">
        {workingCopies.data?.length ? (
          <List
            dataSource={workingCopies.data}
            renderItem={(copy) => {
              const status = workingCopyStatus(copy);
              return (
                <List.Item>
                  <List.Item.Meta
                    avatar={<Avatar icon={status.icon} />}
                    title={<Space><Text strong>{copy.computerName}</Text><Tag color={status.color}>{status.label}</Tag></Space>}
                    description={copy.branch && copy.headCommit
                      ? `${copy.branch} · ${copy.headCommit.slice(0, 8)}${copy.dirty ? ' · 有未提交修改（不会进入 Attempt）' : ''}`
                      : '当前没有可用的 Repository 状态'}
                  />
                </List.Item>
              );
            }}
          />
        ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未连接本机 Repository" />}
        <div className="project-command-list">
          {([['绑定已有 checkout', bindCommand], ['Clone 并绑定', cloneCommand]] as const).map(([label, command]) => (
            <div className="command-block" key={command}>
              <span><Text strong>{label}</Text><code>{command}</code></span>
              <Tooltip title="复制命令"><Button aria-label={`复制${label}命令`} icon={<CopyOutlined />} onClick={() => void navigator.clipboard.writeText(command)} /></Tooltip>
            </div>
          ))}
        </div>
      </Card>}

      <Card title="协作" className="surface-card project-collaboration-summary">
        <Text>{project.activeMemberCount} 位成员 · {conversations.length} 个当前可见 Conversation</Text>
        <Text type="secondary">Project 内只创建 Channel，参与者由当前 active Project Membership 决定；DM 始终位于 Workspace 协作区。</Text>
      </Card>

      <Card
        title="项目资源"
        className="surface-card project-resources"
        extra={(
          <Dropdown menu={addResourceMenu} trigger={['click']}>
            <Button type="primary" icon={<PlusOutlined />} loading={uploadProjectFile.isPending}>
              添加资源 <DownOutlined />
            </Button>
          </Dropdown>
        )}
      >
        <input
          ref={uploadInput}
          className="project-resource-file-input"
          type="file"
          aria-label="选择要上传的项目文件"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) uploadProjectFile.mutate(file);
            event.target.value = '';
          }}
        />
        <Text type="secondary">文件、Markdown Artifact 和外部链接统一列在这里。</Text>
        {projectResources.length ? (
          <div className="project-resource-list" role="list" aria-label="项目资源列表">
            {projectResources.map((resource) => {
              if (resource.kind === 'artifact') {
                const { artifact } = resource;
                const isFile = artifact.artifactType === 'file';
                const currentLabel = `当前修订 r${artifact.currentState.currentRevision}`;
                const snapshotLabel = artifact.latestSnapshot
                  ? artifact.latestSnapshot.label ?? '已保存快照'
                  : '尚无快照';
                const detail = isFile
                  ? `文件 · ${currentLabel} · ${formatBytes(artifact.currentState.byteLength)}`
                  : `Markdown · ${currentLabel} · ${snapshotLabel}`;
                return (
                  <div className="project-resource-row" role="listitem" key={`artifact-${artifact.id}`}>
                    <span className={`project-resource-icon ${isFile ? 'file' : 'markdown'}`}>
                      {isFile ? <FileOutlined /> : <FileMarkdownOutlined />}
                    </span>
                    <button
                      type="button"
                      className="project-resource-copy"
                      onClick={() => navigate(`/w/${workspace.id}/p/${project.id}/artifacts/${artifact.id}`)}
                    >
                      <strong>{artifact.name}</strong>
                      <span>{detail}</span>
                    </button>
                    <Tag>{isFile ? '文件' : 'Artifact'}</Tag>
                    <time>{new Date(artifact.updatedAt).toLocaleDateString('zh-CN')}</time>
                    <Space className="project-resource-actions" size={2}>
                      <Button type="link" onClick={() => navigate(`/w/${workspace.id}/p/${project.id}/artifacts/${artifact.id}`)}>打开</Button>
                      {project.role === 'manager' && (
                        <Popconfirm
                          title="将这个 Artifact 移出当前项目？"
                          description="Artifact 本身、版本以及其他 Project 关联都不会被删除。"
                          onConfirm={() => removeArtifactFromProject.mutate(artifact.id)}
                        >
                          <Button type="link" danger loading={removeArtifactFromProject.isPending}>移出项目</Button>
                        </Popconfirm>
                      )}
                    </Space>
                  </div>
                );
              }
              const { link } = resource;
              const canEditLink = link.createdByMembershipId === workspace.membershipId || project.role === 'manager';
              return (
                <div className="project-resource-row" role="listitem" key={`link-${link.id}`}>
                  <span className="project-resource-icon link"><GlobalOutlined /></span>
                  <a className="project-resource-copy" href={link.url} target="_blank" rel="noreferrer">
                    <strong>{link.title}</strong>
                    <span>{resourceLinkHost(link.url)}{link.description ? ` · ${link.description}` : ''}</span>
                  </a>
                  <Tag>外部链接</Tag>
                  <time>{new Date(link.updatedAt).toLocaleDateString('zh-CN')}</time>
                  <Space className="project-resource-actions" size={2}>
                    <Button type="link" href={link.url} target="_blank">打开链接</Button>
                    {canEditLink && (
                      <>
                        <Button type="link" onClick={() => {
                          setEditingResourceLink(link);
                          resourceLinkEditForm.setFieldsValue({
                            title: link.title,
                            url: link.url,
                            description: link.description ?? '',
                          });
                        }}>修改</Button>
                        <Popconfirm title="删除这个外部链接？" onConfirm={() => deleteResourceLink.mutate(link)}>
                          <Button type="link" danger loading={deleteResourceLink.isPending}>删除</Button>
                        </Popconfirm>
                      </>
                    )}
                  </Space>
                </div>
              );
            })}
          </div>
        ) : (
          <Empty
            className="project-resource-empty"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="还没有项目资源"
          >
            <Space wrap>
              <Button icon={<UploadOutlined />} onClick={() => uploadInput.current?.click()}>上传文件</Button>
              <Button icon={<ImportOutlined />} onClick={() => setArtifactPickerOpen(true)}>加入已有 Artifact</Button>
              <Button icon={<LinkOutlined />} onClick={() => setResourceLinkCreateOpen(true)}>添加外部链接</Button>
            </Space>
          </Empty>
        )}
        <Text className="project-resource-footnote" type="secondary">
          加入已有 Artifact 只建立当前 Project 关联，不复制内容，也不移除其他 Project 关联。
        </Text>
      </Card>
      <Modal
        title="加入已有 Artifact"
        open={artifactPickerOpen}
        okText="加入项目"
        cancelText="取消"
        okButtonProps={{ disabled: !artifactToMove }}
        confirmLoading={moveArtifactToProject.isPending}
        onCancel={() => {
          setArtifactPickerOpen(false);
          setArtifactToMove(undefined);
        }}
        onOk={() => artifactToMove && moveArtifactToProject.mutate(artifactToMove)}
      >
        <Text type="secondary">这里只显示尚未加入当前 Project 的 Workspace Artifact。</Text>
        <Select
          aria-label="选择要加入项目的 Artifact"
          value={artifactToMove}
          placeholder={movableArtifacts.length ? '搜索并选择 Artifact' : '没有可加入的 Artifact'}
          showSearch
          optionFilterProp="label"
          options={movableArtifacts.map((artifact) => ({
            label: `${artifact.name} · ${artifact.artifactType === 'file' ? '文件' : 'Markdown'}`,
            value: artifact.id,
          }))}
          onChange={setArtifactToMove}
          style={{ width: '100%', marginTop: 16 }}
        />
      </Modal>
      <Modal
        title="添加外部链接"
        open={resourceLinkCreateOpen}
        okText="添加"
        cancelText="取消"
        confirmLoading={createResourceLink.isPending}
        onCancel={() => setResourceLinkCreateOpen(false)}
        onOk={() => void resourceLinkForm.validateFields().then((value) => createResourceLink.mutate(value))}
      >
        <Form form={resourceLinkForm} layout="vertical">
          <Form.Item name="title" label="标题" rules={[{ required: true, max: 200 }]}>
            <Input aria-label="外部链接标题" placeholder="例如：产品需求文档" />
          </Form.Item>
          <Form.Item name="url" label="URL" rules={[{ required: true, type: 'url', max: 4000 }]}>
            <Input aria-label="外部链接 URL" placeholder="https://…" />
          </Form.Item>
          <Form.Item name="description" label="说明（可选）" rules={[{ max: 3000 }]}>
            <Input.TextArea aria-label="外部链接说明" rows={3} />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title="修改 Resource Link"
        open={Boolean(editingResourceLink)}
        okText="保存"
        cancelText="取消"
        confirmLoading={updateResourceLink.isPending}
        onCancel={() => setEditingResourceLink(null)}
        onOk={() => void resourceLinkEditForm.validateFields().then((value) => updateResourceLink.mutate(value))}
      >
        <Form form={resourceLinkEditForm} layout="vertical">
          <Form.Item name="title" label="标题" rules={[{ required: true, max: 200 }]}>
            <Input aria-label="修改 Resource Link 标题" />
          </Form.Item>
          <Form.Item name="url" label="URL" rules={[{ required: true, type: 'url', max: 4000 }]}>
            <Input aria-label="修改 Resource Link URL" />
          </Form.Item>
          <Form.Item name="description" label="说明" rules={[{ max: 3000 }]}>
            <Input.TextArea aria-label="修改 Resource Link 说明" rows={3} />
          </Form.Item>
        </Form>
      </Modal>
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
  const canManage = project?.role === 'manager';
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
    mutationFn: ({ member, role }: { member: ProjectMember; role: 'manager' | 'member' }) => {
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
        <div><Title level={2}>项目成员</Title><Text type="secondary">加入项目不会自动获得任何会话的查看权限。</Text></div>
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
                placeholder="选择工作区成员或 Agent"
                onChange={(workspaceMembershipId) => {
                  if (candidates.find((item) => item.membershipId === workspaceMembershipId)?.actorType === 'agent') {
                    form.setFieldValue('role', 'member');
                  }
                }}
                options={candidates.map((item) => ({
                  label: `${item.displayName} · ${item.actorType}`,
                  value: item.membershipId,
                }))}
              />
            </Form.Item>
            <Form.Item name="role">
              <Select disabled={selectedCandidateIsAgent} style={{ width: 130 }} options={[
                { label: '成员', value: 'member' },
                { label: '管理员', value: 'manager' },
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
                    disabled={member.actorType === 'agent' || update.isPending}
                    style={{ width: 110 }}
                    options={[
                      { label: '成员', value: 'member' },
                      { label: '管理员', value: 'manager' },
                    ]}
                    onChange={(role) => update.mutate({ member, role })}
                  />,
                  <Popconfirm
                    key="remove"
                    title="移出项目？"
                    disabled={isSelf}
                    onConfirm={() => remove.mutate(member)}
                  >
                    <Button type="text" danger disabled={isSelf}>移除</Button>
                  </Popconfirm>,
                ] : []}
              >
                <List.Item.Meta
                  avatar={<Avatar>{member.displayName.slice(0, 1).toUpperCase()}</Avatar>}
                  title={<Space>{member.displayName}{isSelf && <Tag>you</Tag>}</Space>}
                  description={`${member.actorType === 'agent' ? 'Agent' : 'Human'} · ${member.role}`}
                />
              </List.Item>
            );
          }}
        />
      </Card>
    </main>
  );
}
