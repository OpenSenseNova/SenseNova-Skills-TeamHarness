import {
  DeleteOutlined,
  FileMarkdownOutlined,
  FileOutlined,
  LinkOutlined,
  PlusOutlined,
  DisconnectOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Empty, Form, Input, Modal, Segmented, Space, Tooltip, Typography, Upload } from 'antd';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorMessage, type Artifact } from '../api/client';
import { workspaceKeys } from './workspace-context';

const { Text } = Typography;

export function ArtifactsPanel({
  workspaceId,
  projectId,
  canManageProject = false,
}: {
  workspaceId: string;
  projectId: string | null;
  canManageProject?: boolean;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const [scope, setScope] = useState<'project' | 'workspace'>(projectId ? 'project' : 'workspace');
  const [createOpen, setCreateOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [form] = Form.useForm<{ name: string }>();
  const filteredProjectId = projectId && scope === 'project' ? projectId : undefined;
  const artifacts = useQuery({
    queryKey: workspaceKeys.artifacts(workspaceId, filteredProjectId),
    queryFn: () => api.listArtifacts(workspaceId, filteredProjectId).then((page) => page.items),
  });
  const trash = useQuery({
    queryKey: workspaceKeys.artifactTrash(workspaceId),
    queryFn: () => api.listArtifactTrash(workspaceId).then((page) => page.items),
    enabled: trashOpen,
  });
  const cleanup = useQuery({
    queryKey: workspaceKeys.artifactCleanup(workspaceId),
    queryFn: () => api.getArtifactCleanupStatus(workspaceId),
    enabled: trashOpen,
  });
  const projectIds = projectId ? [projectId] : [];
  const refresh = async (artifactId?: string) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['workspace', workspaceId, 'artifacts'] }),
      queryClient.invalidateQueries({ queryKey: workspaceKeys.artifactTrash(workspaceId) }),
      queryClient.invalidateQueries({ queryKey: workspaceKeys.artifactCleanup(workspaceId) }),
      ...(artifactId ? [queryClient.invalidateQueries({ queryKey: workspaceKeys.artifact(artifactId) })] : []),
    ]);
  };
  const createMarkdown = useMutation({
    mutationFn: ({ name }: { name: string }) => api.createMarkdownArtifact(workspaceId, { name: name.trim(), projectIds }),
    onSuccess: async (artifact) => {
      setCreateOpen(false);
      form.resetFields();
      await refresh(artifact.id);
      navigate(artifactPath(workspaceId, projectId, artifact.id));
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const uploadFile = useMutation({
    mutationFn: (file: File) => api.createFileArtifact(workspaceId, file, file.name, projectIds),
    onSuccess: async (artifact) => {
      await refresh(artifact.id);
      navigate(artifactPath(workspaceId, projectId, artifact.id));
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const associate = useMutation({
    mutationFn: (artifact: Artifact) => api.associateArtifact(projectId!, artifact.id),
    onSuccess: async () => {
      await refresh();
      void message.success('Artifact 已关联到当前 Project。');
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const dissociate = useMutation({
    mutationFn: (artifact: Artifact) => api.dissociateArtifact(projectId!, artifact.id),
    onSuccess: async () => {
      await refresh();
      void message.success('Artifact 已从当前 Project 解除关联。');
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const restore = useMutation({
    mutationFn: (artifact: Artifact) => api.restoreArtifact(artifact.id, artifact.revision),
    onSuccess: async () => {
      await refresh();
      void message.success('Artifact 已恢复。');
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const items = useMemo(() => artifacts.data ?? [], [artifacts.data]);

  return (
    <aside className="artifacts-panel" aria-label="Artifacts">
      <header className="artifacts-panel-header">
        <div><strong>Artifacts</strong><Text type="secondary">{items.length}</Text></div>
        <Space size={2}>
          <Tooltip title="新建 Markdown"><Button aria-label="新建 Markdown" type="text" size="small" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)} /></Tooltip>
          <Upload
            showUploadList={false}
            beforeUpload={(file) => {
              uploadFile.mutate(file as File);
              return false;
            }}
          >
            <Tooltip title="上传文件"><Button aria-label="上传文件" type="text" size="small" loading={uploadFile.isPending} icon={<UploadOutlined />} /></Tooltip>
          </Upload>
        </Space>
      </header>
      {projectId && (
        <div className="artifacts-panel-scope">
          <Segmented
            block
            size="small"
            value={scope}
            options={[{ label: '当前项目', value: 'project' }, { label: 'Workspace', value: 'workspace' }]}
            onChange={(value) => setScope(value as 'project' | 'workspace')}
          />
        </div>
      )}
      <div className="artifacts-panel-list">
        {items.map((artifact) => {
          const associated = projectId ? artifact.projectIds.includes(projectId) : false;
          return (
            <div className="artifact-panel-row" key={artifact.id}>
              <button type="button" onClick={() => navigate(artifactPath(workspaceId, projectId, artifact.id))}>
                <span className={`artifact-kind ${artifact.artifactType}`}>
                  {artifact.artifactType === 'markdown' ? <FileMarkdownOutlined /> : <FileOutlined />}
                </span>
                <span className="artifact-panel-copy">
                  <strong>{artifact.name}</strong>
                  <small>当前状态 · {artifact.artifactType === 'markdown' ? 'Markdown' : formatBytes(artifact.currentState.byteLength)}</small>
                </span>
              </button>
              {projectId && scope === 'workspace' && !associated && (
                <Tooltip title="关联到当前 Project">
                  <Button aria-label={`关联 ${artifact.name}`} type="text" size="small" icon={<LinkOutlined />} loading={associate.isPending} onClick={() => associate.mutate(artifact)} />
                </Tooltip>
              )}
              {projectId && scope === 'project' && associated && canManageProject && (
                <Tooltip title="从当前 Project 解除关联">
                  <Button aria-label={`解除关联 ${artifact.name}`} type="text" size="small" icon={<DisconnectOutlined />} loading={dissociate.isPending} onClick={() => dissociate.mutate(artifact)} />
                </Tooltip>
              )}
            </div>
          );
        })}
        {!artifacts.isPending && !items.length && (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={projectId && scope === 'project' ? '当前 Project 还没有 Artifact' : '还没有 Artifact'} />
        )}
      </div>
      <button type="button" className="artifact-trash-link" onClick={() => setTrashOpen(true)}>
        <DeleteOutlined /> 回收站
      </button>

      <Modal
        title="新建 Markdown Artifact"
        open={createOpen}
        okText="创建并打开"
        cancelText="取消"
        confirmLoading={createMarkdown.isPending}
        onCancel={() => setCreateOpen(false)}
        onOk={() => void form.validateFields().then((value) => createMarkdown.mutate(value))}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true, max: 500 }]}>
            <Input aria-label="名称" autoFocus placeholder="例如：方案说明.md" />
          </Form.Item>
        </Form>
      </Modal>
      <Modal title="Artifacts 回收站" open={trashOpen} footer={null} onCancel={() => setTrashOpen(false)}>
        {cleanup.data && (
          <Text type="secondary">
            {cleanup.data.deletedCount} 个待清理
            {cleanup.data.nextPurgeAt ? ` · 下次到期 ${new Date(cleanup.data.nextPurgeAt).toLocaleString()}` : ''}
          </Text>
        )}
        <div className="artifact-trash-list">
          {(trash.data ?? []).map((artifact) => (
            <div key={artifact.id}>
              <span>
                <strong>{artifact.name}</strong>
                <small>
                  当前状态 · 将在 {artifact.purgeAfter ? new Date(artifact.purgeAfter).toLocaleString() : '—'} 清理
                </small>
              </span>
              <Button
                aria-label={`恢复 ${artifact.name}`}
                size="small"
                loading={restore.isPending}
                onClick={() => restore.mutate(artifact)}
              >恢复</Button>
            </div>
          ))}
          {!trash.isPending && !trash.data?.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="回收站为空" />}
        </div>
      </Modal>
    </aside>
  );
}

function artifactPath(workspaceId: string, projectId: string | null, artifactId: string): string {
  return projectId
    ? `/w/${workspaceId}/p/${projectId}/artifacts/${artifactId}`
    : `/w/${workspaceId}/artifacts/${artifactId}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
