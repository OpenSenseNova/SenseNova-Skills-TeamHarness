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
import { useLanguage } from '../language';

const { Text, Title } = Typography;

export function ArtifactPage() {
  const { artifactId = '', projectId } = useParams();
  const location = useLocation();
  const { workspace } = useWorkspace();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const { isEnglish } = useLanguage();
  const tx = (zh: string, en: string) => isEnglish ? en : zh;
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
  const members = useQuery({ queryKey: workspaceKeys.members(workspace.id), queryFn: () => api.listMembers(workspace.id).then((result) => result.items) });
  const actorName = (id: string): string => (members.data ?? []).find((member) => member.actorId === id)?.displayName ?? id;
  const parentVersionIds = artifact.data?.derivationParentVersionIds ?? [];
  const parents = useQuery({
    queryKey: ['artifact-v2', artifactId, 'parents', parentVersionIds],
    queryFn: () => Promise.all(parentVersionIds.map((id) => api.getArtifactVersionContextV2(id).then((context) => {
      const resolved = context as unknown as { artifact: { name: string }; version: { version: number } };
      return { versionId: id, name: resolved.artifact.name, version: resolved.version.version };
    }))),
    enabled: parentVersionIds.length > 0,
  });
  const taskId = artifact.data?.latestVersion?.taskId ?? null;
  const task = useQuery({ queryKey: ['work-item', taskId], queryFn: () => api.getWorkItem(taskId!), enabled: Boolean(taskId) });
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
    onSuccess: async () => { setRenameOpen(false); await refresh(); void message.success(tx('交付物信息已更新。', 'Deliverable details updated.')); },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteArtifactV2(artifactId),
    onSuccess: async () => { await refresh(); void message.success(tx('交付物已移入回收站。', 'Deliverable moved to trash.')); navigate(projectId ? `/w/${workspace.id}/p/${projectId}/resources` : `/w/${workspace.id}`); },
    onError: (error) => void message.error(errorMessage(error)),
  });
  if (artifact.isPending) return <div className="artifact-page-loading"><Spin size="large" /></div>;
  if (artifact.isError || !artifact.data) return <div className="artifact-page-loading"><Empty description={artifact.error ? errorMessage(artifact.error) : tx('交付物不存在或已被移除', 'Deliverable not found or removed')} /></div>;
  const current = artifact.data.latestVersion;
  return (
    <main className="artifact-page">
      <header className="artifact-page-header">
        <Space>
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate(projectId ? `/w/${workspace.id}/p/${projectId}/resources` : `/w/${workspace.id}`)}>{tx('返回资源', 'Back to resources')}</Button>
          <span className="artifact-page-icon"><FileOutlined /></span>
          <div><Title level={4}>{artifact.data.name}</Title><Text type="secondary">{artifact.data.projectPath || tx('项目根目录', 'Project root')} · {tx('文件交付物', 'File deliverable')}</Text></div>
        </Space>
        <Space>
          <Button icon={<EditOutlined />} onClick={() => { setName(artifact.data!.name); setPath(artifact.data!.projectPath); setRenameOpen(true); }}>{tx('编辑信息', 'Edit details')}</Button>
          <Popconfirm title={tx('移入回收站？', 'Move to trash?')} description={tx('7 天内可以恢复，历史关系会保留。', 'Can be restored within 7 days; historical relationships are preserved.')} onConfirm={() => remove.mutate()}>
            <Button danger icon={<DeleteOutlined />} loading={remove.isPending}>{tx('删除', 'Delete')}</Button>
          </Popconfirm>
        </Space>
      </header>
      <section className="artifact-page-body">
        <Card title={tx('当前版本', 'Current version')} className="artifact-preview-card">
          {current ? <VersionPreview version={current} onPreview={() => setPreviewVersion(current)} /> : <Empty description={tx('暂无可用版本', 'No versions available')} />}
        </Card>
        <Card title={<Space><HistoryOutlined />{tx('版本记录', 'Version history')}</Space>} className="artifact-version-card">
          {(versions.data ?? []).map((version) => <VersionRow key={version.versionId} version={version} authorName={actorName(version.createdByActorId)} onPreview={() => setPreviewVersion(version)} />)}
          {!versions.isPending && !versions.data?.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={tx('暂无版本记录', 'No version history')} />}
        </Card>
        <Card title={tx('来源信息', 'Source information')} className="artifact-context-card">
          <Space orientation="vertical" size={4}>
            <Text>{tx('创建者：', 'Created by: ')}{actorName(artifact.data.createdByActorId)}</Text>
            <Text>{tx('创建时间：', 'Created: ')}{new Date(artifact.data.createdAt).toLocaleString(isEnglish ? 'en-US' : 'zh-CN')}</Text>
            {artifact.data.derivationParentVersionIds.length > 0 && <Text>{tx('派生自：', 'Derived from: ')}{parents.data ? parents.data.map((parent) => `${parent.name} · v${parent.version}`).join(tx('、', ', ')) : tx('加载中…', 'Loading…')}</Text>}
            {current?.taskId && <Text>{tx('任务：', 'Task: ')}{task.data ? `#${task.data.taskNumber}` : tx('加载中…', 'Loading…')}</Text>}
          </Space>
        </Card>
      </section>
      <Modal title={tx('编辑交付物信息', 'Edit deliverable details')} open={renameOpen} okText={tx('保存', 'Save')} cancelText={tx('取消', 'Cancel')} confirmLoading={update.isPending} onCancel={() => setRenameOpen(false)} onOk={() => update.mutate()}>
        <Input aria-label={tx('交付物名称', 'Deliverable name')} value={name} maxLength={255} onChange={(event) => setName(event.target.value)} />
        <Input aria-label={tx('交付物项目路径', 'Deliverable project path')} value={path} maxLength={2000} placeholder={tx('例如 reports/2026', 'e.g. reports/2026')} onChange={(event) => setPath(event.target.value)} style={{ marginTop: 12 }} />
      </Modal>
      <PreviewModal version={previewVersion} onClose={() => setPreviewVersion(null)} />
    </main>
  );
}

function VersionRow({ version, authorName, onPreview }: { version: ArtifactVersionV2; authorName: string; onPreview: () => void }) {
  const { isEnglish } = useLanguage();
  const tx = (zh: string, en: string) => isEnglish ? en : zh;
  const previewStatus = version.preview.status === 'ready' ? tx('可预览', 'Previewable') : version.preview.status === 'pending' ? tx('准备中', 'Preparing') : tx('暂不可预览', 'Preview unavailable');
  return <div className="artifact-version-row"><span><strong>v{version.version} · {version.fileName}</strong><small>{new Date(version.createdAt).toLocaleString(isEnglish ? 'en-US' : 'zh-CN')} · {authorName} · {version.status === 'active' ? tx('可访问', 'Accessible') : tx('已删除', 'Deleted')}</small></span><Space><Button type="link" icon={<EyeOutlined />} disabled={version.status !== 'active'} onClick={onPreview}>{tx('预览', 'Preview')}</Button><Button type="link" icon={<CloudDownloadOutlined />} disabled={version.status !== 'active'} href={`/v1/artifact-versions/${version.versionId}/download`}>{tx('下载', 'Download')}</Button><Tag>{previewStatus}</Tag></Space></div>;
}

function VersionPreview({ version, onPreview }: { version: ArtifactVersionV2; onPreview: () => void }) {
  const { isEnglish } = useLanguage();
  const tx = (zh: string, en: string) => isEnglish ? en : zh;
  return <div className="artifact-current-summary"><FileOutlined /><div><Title level={5}>{version.fileName} · v{version.version}</Title><Text type="secondary">{version.mediaType} · {formatBytes(version.byteLength)} · {version.digest.slice(0, 12)}…</Text></div><Button type="primary" icon={<EyeOutlined />} onClick={onPreview}>{tx('预览', 'Preview')}</Button><Button icon={<CloudDownloadOutlined />} href={`/v1/artifact-versions/${version.versionId}/download`}>{tx('下载', 'Download')}</Button></div>;
}

function PreviewModal({ version, onClose }: { version: ArtifactVersionV2 | null; onClose: () => void }) {
  const { isEnglish } = useLanguage();
  const tx = (zh: string, en: string) => isEnglish ? en : zh;
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
  return <Modal title={version ? `v${version.version} · ${version.fileName}` : tx('文件预览', 'File preview')} open={Boolean(version)} footer={version ? <Button href={`/v1/artifact-versions/${version.versionId}/download`}>{tx('下载', 'Download')}</Button> : null} width={900} onCancel={onClose}>{version?.status !== 'active' ? <Empty description={tx('该版本已删除，内容不可访问，但历史记录仍保留。', 'This version has been deleted; its content is inaccessible, but the history is retained.')} /> : text !== null ? <pre style={{ maxHeight: '65vh', overflow: 'auto', whiteSpace: 'pre-wrap' }}>{text}</pre> : url && version.mediaType.startsWith('image/') ? <img src={url} alt={version.fileName} style={{ maxWidth: '100%', maxHeight: '65vh', display: 'block', margin: '0 auto' }} /> : url && version.mediaType === 'application/pdf' ? <iframe title={version.fileName} src={url} style={{ width: '100%', height: '65vh', border: 0 }} /> : <Empty description={tx('此类型暂不支持在线预览，可以下载原始文件。', 'Online preview is not supported for this type; you can download the original file.')} />}</Modal>;
}

function formatBytes(bytes: number): string { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`; return `${(bytes / 1024 / 1024).toFixed(1)} MiB`; }

export function artifactReturnTarget(historyState: unknown, workspaceId: string, projectId?: string): number | string {
  const historyIndex = typeof historyState === 'object' && historyState !== null && 'idx' in historyState ? (historyState as { idx?: unknown }).idx : null;
  if (typeof historyIndex === 'number' && historyIndex > 0) return -1;
  return projectId ? `/w/${workspaceId}/p/${projectId}` : `/w/${workspaceId}`;
}
