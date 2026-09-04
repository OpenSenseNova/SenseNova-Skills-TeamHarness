import {
  ArrowLeftOutlined,
  CloudDownloadOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  FileOutlined,
  HistoryOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Empty, Input, Modal, Popconfirm, Space, Spin, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, errorMessage, type ArtifactVersionV2 } from '../api/client';
import { useWorkspace, workspaceKeys } from './workspace-context';

const { Text, Title } = Typography;

export function ArtifactPage() {
  const { artifactId = '', projectId } = useParams();
  const location = useLocation();
  const { workspace } = useWorkspace();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const [renameOpen, setRenameOpen] = useState(false);
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [previewVersion, setPreviewVersion] = useState<ArtifactVersionV2 | null>(null);
  const requestedVersionId = new URLSearchParams(location.search).get('versionId');
  const artifact = useQuery({ queryKey: ['artifact-v2', artifactId], queryFn: () => api.getArtifactV2(artifactId), enabled: Boolean(artifactId) });
  const versions = useQuery({ queryKey: ['artifact-v2', artifactId, 'versions'], queryFn: () => api.listArtifactVersionsV2(artifactId).then((result) => result.items), enabled: Boolean(artifactId) });
  useEffect(() => {
    if (!requestedVersionId || !versions.data) return;
    const requested = versions.data.find((version) => version.versionId === requestedVersionId);
    if (requested) setPreviewVersion(requested);
  }, [requestedVersionId, versions.data]);
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['artifact-v2', artifactId] }),
      queryClient.invalidateQueries({ queryKey: ['artifact-v2', artifactId, 'versions'] }),
      queryClient.invalidateQueries({ queryKey: ['project-v2', projectId, 'artifacts'] }),
      queryClient.invalidateQueries({ queryKey: workspaceKeys.project(projectId ?? '') }),
    ]);
  };
  const update = useMutation({
    mutationFn: () => api.updateArtifactV2(artifactId, { name: name.trim(), projectPath: path.trim() }),
    onSuccess: async () => { setRenameOpen(false); await refresh(); void message.success('交付物信息已更新。'); },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteArtifactV2(artifactId),
    onSuccess: async () => { await refresh(); void message.success('交付物已移入回收站。'); navigate(projectId ? `/w/${workspace.id}/p/${projectId}/resources` : `/w/${workspace.id}`); },
    onError: (error) => void message.error(errorMessage(error)),
  });
  if (artifact.isPending) return <div className="artifact-page-loading"><Spin size="large" /></div>;
  if (artifact.isError || !artifact.data) return <div className="artifact-page-loading"><Empty description={artifact.error ? errorMessage(artifact.error) : '交付物不存在或已被移除'} /></div>;
  const current = artifact.data.latestVersion;
  return (
    <main className="artifact-page">
      <header className="artifact-page-header">
        <Space>
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate(projectId ? `/w/${workspace.id}/p/${projectId}/resources` : `/w/${workspace.id}`)}>返回资源</Button>
          <span className="artifact-page-icon"><FileOutlined /></span>
          <div><Title level={4}>{artifact.data.name}</Title><Text type="secondary">{artifact.data.projectPath || '项目根目录'} · 文件交付物</Text></div>
        </Space>
        <Space>
          <Button icon={<EditOutlined />} onClick={() => { setName(artifact.data!.name); setPath(artifact.data!.projectPath); setRenameOpen(true); }}>编辑信息</Button>
          <Popconfirm title="移入回收站？" description="7 天内可以恢复，历史关系会保留。" onConfirm={() => remove.mutate()}>
            <Button danger icon={<DeleteOutlined />} loading={remove.isPending}>删除</Button>
          </Popconfirm>
        </Space>
      </header>
      <section className="artifact-page-body">
        <Card title="当前版本" className="artifact-preview-card">
          {current ? <VersionPreview version={current} onPreview={() => setPreviewVersion(current)} /> : <Empty description="暂无可用版本" />}
        </Card>
        <Card title={<Space><HistoryOutlined />版本记录</Space>} className="artifact-version-card">
          {(versions.data ?? []).map((version) => <VersionRow key={version.versionId} version={version} onPreview={() => setPreviewVersion(version)} />)}
          {!versions.isPending && !versions.data?.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无版本记录" />}
        </Card>
        <Card title="来源信息" className="artifact-context-card">
          <Space orientation="vertical" size={4}>
            <Text>创建者：{artifact.data.createdByActorId}</Text>
            <Text>创建时间：{new Date(artifact.data.createdAt).toLocaleString('zh-CN')}</Text>
            {artifact.data.derivationParentVersionIds.length > 0 && <Text>派生父版本：{artifact.data.derivationParentVersionIds.join('、')}</Text>}
            {current?.taskId && <Text>Task：{current.taskId}</Text>}
            {current?.messageId && <Text>Message：{current.messageId}</Text>}
          </Space>
        </Card>
      </section>
      <Modal title="编辑交付物信息" open={renameOpen} okText="保存" cancelText="取消" confirmLoading={update.isPending} onCancel={() => setRenameOpen(false)} onOk={() => update.mutate()}>
        <Input aria-label="交付物名称" value={name} maxLength={255} onChange={(event) => setName(event.target.value)} />
        <Input aria-label="交付物项目路径" value={path} maxLength={2000} placeholder="例如 reports/2026" onChange={(event) => setPath(event.target.value)} style={{ marginTop: 12 }} />
      </Modal>
      <PreviewModal version={previewVersion} onClose={() => setPreviewVersion(null)} />
    </main>
  );
}

function VersionRow({ version, onPreview }: { version: ArtifactVersionV2; onPreview: () => void }) {
  const previewStatus = version.preview.status === 'ready' ? '可预览' : version.preview.status === 'pending' ? '准备中' : '暂不可预览';
  return <div className="artifact-version-row"><span><strong>v{version.version} · {version.fileName}</strong><small>{new Date(version.createdAt).toLocaleString('zh-CN')} · {version.createdByActorId} · {version.status === 'active' ? '可访问' : '已删除'}</small></span><Space><Button type="link" icon={<EyeOutlined />} disabled={version.status !== 'active'} onClick={onPreview}>预览</Button><Button type="link" icon={<CloudDownloadOutlined />} disabled={version.status !== 'active'} href={`/v1/artifact-versions/${version.versionId}/download`}>下载</Button><Tag>{previewStatus}</Tag></Space></div>;
}

function VersionPreview({ version, onPreview }: { version: ArtifactVersionV2; onPreview: () => void }) {
  return <div className="artifact-current-summary"><FileOutlined /><div><Title level={5}>{version.fileName} · v{version.version}</Title><Text type="secondary">{version.mediaType} · {formatBytes(version.byteLength)} · {version.digest.slice(0, 12)}…</Text></div><Button type="primary" icon={<EyeOutlined />} onClick={onPreview}>预览</Button><Button icon={<CloudDownloadOutlined />} href={`/v1/artifact-versions/${version.versionId}/download`}>下载</Button></div>;
}

function PreviewModal({ version, onClose }: { version: ArtifactVersionV2 | null; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setUrl(null); setText(null);
    if (!version || version.status !== 'active') return undefined;
    void api.downloadArtifactVersionV2(version.versionId).then(async (blob) => {
      if (cancelled) return;
      // SVG is both an image and XML. Prefer the image renderer so vector
      // deliverables are previewed as images instead of exposing raw markup.
      const isImage = version.mediaType.startsWith('image/');
      if (!isImage && (version.mediaType.startsWith('text/') || version.mediaType.includes('json') || version.mediaType.includes('xml'))) {
        setText(await blob.text());
      } else {
        setUrl(URL.createObjectURL(blob));
      }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [version]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  return <Modal title={version ? `v${version.version} · ${version.fileName}` : '文件预览'} open={Boolean(version)} footer={version ? <Button href={`/v1/artifact-versions/${version.versionId}/download`}>下载</Button> : null} width={900} onCancel={onClose}>{version?.status !== 'active' ? <Empty description="该版本已删除，内容不可访问，但历史记录仍保留。" /> : text !== null ? <pre style={{ maxHeight: '65vh', overflow: 'auto', whiteSpace: 'pre-wrap' }}>{text}</pre> : url && version.mediaType.startsWith('image/') ? <img src={url} alt={version.fileName} style={{ maxWidth: '100%', maxHeight: '65vh', display: 'block', margin: '0 auto' }} /> : url && version.mediaType === 'application/pdf' ? <iframe title={version.fileName} src={url} style={{ width: '100%', height: '65vh', border: 0 }} /> : <Empty description="此类型暂不支持在线预览，可以下载原始文件。" />}</Modal>;
}

function formatBytes(bytes: number): string { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`; return `${(bytes / 1024 / 1024).toFixed(1)} MiB`; }

export function artifactReturnTarget(historyState: unknown, workspaceId: string, projectId?: string): number | string {
  const historyIndex = typeof historyState === 'object' && historyState !== null && 'idx' in historyState ? (historyState as { idx?: unknown }).idx : null;
  if (typeof historyIndex === 'number' && historyIndex > 0) return -1;
  return projectId ? `/w/${workspaceId}/p/${projectId}` : `/w/${workspaceId}`;
}
