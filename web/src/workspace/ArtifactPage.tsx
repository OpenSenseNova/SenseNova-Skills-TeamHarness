import {
  ArrowLeftOutlined,
  CloudDownloadOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  FileMarkdownOutlined,
  FileOutlined,
  HistoryOutlined,
  MoreOutlined,
  RollbackOutlined,
  SaveOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView, basicSetup } from 'codemirror';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { yCollab } from 'y-codemirror.next';
import {
  Alert,
  App,
  Button,
  Card,
  Dropdown,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Space,
  Spin,
  Tag,
  Typography,
  Upload,
} from 'antd';
import { useEffect, useRef, useState, type ComponentType } from 'react';
import ReactMarkdown from 'react-markdown';
import { useNavigate, useParams } from 'react-router-dom';
import * as Y from 'yjs';
import {
  api,
  errorMessage,
  type Artifact,
  type ArtifactSnapshot,
} from '../api/client';
import { useWorkspace, workspaceKeys } from './workspace-context';

const { Text, Title } = Typography;

interface ArtifactEditorProps {
  artifact: Artifact;
  refresh: () => Promise<void>;
}

const artifactEditors: Record<Artifact['artifactType'], ComponentType<ArtifactEditorProps>> = {
  markdown: MarkdownArtifactEditor,
  file: FileArtifactEditor,
};

export function ArtifactPage() {
  const { artifactId = '', projectId } = useParams();
  const { workspace } = useWorkspace();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const [renameOpen, setRenameOpen] = useState(false);
  const [nextName, setNextName] = useState('');
  const [snapshotToRename, setSnapshotToRename] = useState<ArtifactSnapshot | null>(null);
  const [nextSnapshotLabel, setNextSnapshotLabel] = useState('');
  const [preview, setPreview] = useState<{
    snapshot: ArtifactSnapshot;
    text: string | null;
    objectUrl: string | null;
  } | null>(null);
  const artifact = useQuery({
    queryKey: workspaceKeys.artifact(artifactId),
    queryFn: () => api.getArtifact(artifactId),
    enabled: Boolean(artifactId),
  });
  const snapshots = useQuery({
    queryKey: workspaceKeys.artifactSnapshots(artifactId),
    queryFn: () => api.listArtifactSnapshots(artifactId).then((page) => page.items),
    enabled: Boolean(artifactId),
  });
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: workspaceKeys.artifact(artifactId) }),
      queryClient.invalidateQueries({ queryKey: workspaceKeys.artifactSnapshots(artifactId) }),
      queryClient.invalidateQueries({ queryKey: ['workspace', workspace.id, 'artifacts'] }),
    ]);
  };
  const remove = useMutation({
    mutationFn: () => api.deleteArtifact(artifactId, artifact.data!.revision),
    onSuccess: async () => {
      await refresh();
      void message.success('Artifact 已移入回收站。');
      navigate(projectId ? `/w/${workspace.id}/p/${projectId}` : `/w/${workspace.id}`);
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const rename = useMutation({
    mutationFn: () => api.renameArtifact(artifactId, {
      name: nextName.trim(),
      expectedRevision: artifact.data!.revision,
    }),
    onSuccess: async () => {
      setRenameOpen(false);
      await refresh();
      void message.success('Artifact 已重命名。');
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const renameSnapshot = useMutation({
    mutationFn: () => api.renameArtifactSnapshot(artifactId, snapshotToRename!.snapshotId, {
      label: nextSnapshotLabel.trim() || null,
      expectedRevision: snapshotToRename!.revision,
    }),
    onSuccess: async () => {
      setSnapshotToRename(null);
      await refresh();
      void message.success('历史名称已更新。');
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const deleteSnapshot = useMutation({
    mutationFn: (snapshot: ArtifactSnapshot) => api.deleteArtifactSnapshot(
      artifactId,
      snapshot.snapshotId,
      snapshot.revision,
    ),
    onSuccess: async () => {
      await refresh();
      void message.success('历史快照已删除。');
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const restoreSnapshot = useMutation({
    mutationFn: (snapshot: ArtifactSnapshot) => api.restoreArtifactSnapshot(
      artifactId,
      snapshot.snapshotId,
      artifact.data!.currentState.currentRevision,
    ),
    onSuccess: async () => {
      await refresh();
      void message.success('已恢复为当前状态；原历史快照保持不变。');
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const previewSnapshot = useMutation({
    mutationFn: async (snapshot: ArtifactSnapshot) => {
      const blob = await api.getArtifactSnapshotContent(artifactId, snapshot.snapshotId);
      if (snapshot.mediaType.startsWith('text/') || snapshot.mediaType.includes('json')) {
        return { snapshot, text: await blob.text(), objectUrl: null };
      }
      return { snapshot, text: null, objectUrl: URL.createObjectURL(blob) };
    },
    onSuccess: (next) => setPreview(next),
    onError: (error) => void message.error(errorMessage(error)),
  });

  useEffect(() => () => {
    if (preview?.objectUrl) URL.revokeObjectURL(preview.objectUrl);
  }, [preview]);
  if (artifact.isPending) return <div className="artifact-page-loading"><Spin size="large" /></div>;
  if (!artifact.data) return <div className="artifact-page-loading"><Empty description="Artifact 不存在" /></div>;
  const Editor = artifactEditors[artifact.data.artifactType];
  const returnTarget = artifactReturnTarget(window.history.state, workspace.id, projectId);
  return (
    <main className="artifact-page">
      <header className="artifact-page-header">
        <Space>
          <Button
            type="text"
            icon={<ArrowLeftOutlined />}
            onClick={() => typeof returnTarget === 'number' ? navigate(returnTarget) : navigate(returnTarget)}
          >返回协作</Button>
          <span className={`artifact-page-icon ${artifact.data.artifactType}`}>
            {artifact.data.artifactType === 'markdown' ? <FileMarkdownOutlined /> : <FileOutlined />}
          </span>
          <div>
            <Title level={4}>{artifact.data.name}</Title>
            <Text type="secondary">当前状态 · 已自动保存</Text>
          </div>
        </Space>
        <Space>
          <Button icon={<EditOutlined />} onClick={() => {
            setNextName(artifact.data!.name);
            setRenameOpen(true);
          }}>重命名</Button>
          <Popconfirm title="移入回收站？" description="7 天内可以恢复。" onConfirm={() => remove.mutate()}>
            <Button danger icon={<DeleteOutlined />} loading={remove.isPending}>删除</Button>
          </Popconfirm>
        </Space>
      </header>
      <section className="artifact-page-body">
        <Editor artifact={artifact.data} refresh={refresh} />
        <Card className="artifact-version-card" title={<Space><HistoryOutlined />历史快照</Space>}>
          {(snapshots.data ?? []).map((snapshot) => (
            <div className="artifact-version-row" key={snapshot.snapshotId}>
              <span>
                <strong>{snapshot.label || formatSnapshotTime(snapshot.createdAt)}</strong>
                <small>{formatSnapshotTime(snapshot.createdAt)} · {snapshot.createdByDisplayName}</small>
              </span>
              <Space wrap>
                <Button
                  type="link"
                  icon={<EyeOutlined />}
                  loading={previewSnapshot.isPending && previewSnapshot.variables?.snapshotId === snapshot.snapshotId}
                  onClick={() => previewSnapshot.mutate(snapshot)}
                >查看</Button>
                <Button
                  type="link"
                  icon={<CloudDownloadOutlined />}
                  href={api.artifactSnapshotDownloadUrl(artifactId, snapshot.snapshotId)}
                >下载</Button>
                <Popconfirm
                  title="恢复这个历史快照？"
                  description="只会更新当前状态，不会修改这条历史记录。"
                  onConfirm={() => restoreSnapshot.mutate(snapshot)}
                >
                  <Button type="link" icon={<RollbackOutlined />}>恢复</Button>
                </Popconfirm>
                <Button type="link" icon={<EditOutlined />} onClick={() => {
                  setSnapshotToRename(snapshot);
                  setNextSnapshotLabel(snapshot.label ?? '');
                }}>{snapshot.label ? '重命名' : '添加名称'}</Button>
                <Popconfirm
                  title="删除这个历史快照？"
                  description="消息中的文件元数据会保留，但内容将不可访问。"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => deleteSnapshot.mutate(snapshot)}
                >
                  <Button danger type="link" icon={<DeleteOutlined />}>删除</Button>
                </Popconfirm>
                <Dropdown menu={{ items: [{
                  key: 'copy-id',
                  icon: <CopyOutlined />,
                  label: '复制快照 ID',
                  onClick: () => void navigator.clipboard.writeText(snapshot.snapshotId).then(() => message.success('快照 ID 已复制。')),
                }] }}>
                  <Button type="text" aria-label="更多历史操作" icon={<MoreOutlined />} />
                </Dropdown>
              </Space>
            </div>
          ))}
          {!snapshots.isPending && !snapshots.data?.length && (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有历史快照" />
          )}
        </Card>
      </section>
      <Modal
        title="重命名 Artifact"
        open={renameOpen}
        okText="保存"
        cancelText="取消"
        okButtonProps={{ disabled: !nextName.trim() }}
        confirmLoading={rename.isPending}
        onCancel={() => setRenameOpen(false)}
        onOk={() => rename.mutate()}
      >
        <Input aria-label="Artifact 名称" value={nextName} maxLength={500} onChange={(event) => setNextName(event.target.value)} />
      </Modal>
      <Modal
        title={snapshotToRename?.label ? '重命名历史' : '添加历史名称'}
        open={Boolean(snapshotToRename)}
        okText="保存"
        cancelText="取消"
        confirmLoading={renameSnapshot.isPending}
        onCancel={() => setSnapshotToRename(null)}
        onOk={() => renameSnapshot.mutate()}
      >
        <Input
          aria-label="历史名称"
          value={nextSnapshotLabel}
          maxLength={200}
          allowClear
          placeholder="可选；留空后以保存时间显示"
          onChange={(event) => setNextSnapshotLabel(event.target.value)}
        />
      </Modal>
      <Modal
        title={preview ? (preview.snapshot.label || formatSnapshotTime(preview.snapshot.createdAt)) : '历史预览'}
        open={Boolean(preview)}
        width={900}
        footer={preview ? <Button href={api.artifactSnapshotDownloadUrl(artifactId, preview.snapshot.snapshotId)}>下载</Button> : null}
        onCancel={() => setPreview(null)}
      >
        {preview && <SnapshotPreview preview={preview} />}
      </Modal>
    </main>
  );
}

function SnapshotPreview({ preview }: {
  preview: { snapshot: ArtifactSnapshot; text: string | null; objectUrl: string | null };
}) {
  if (preview.text !== null) {
    return preview.snapshot.mediaType.includes('markdown')
      ? <article className="markdown-preview"><ReactMarkdown>{preview.text}</ReactMarkdown></article>
      : <pre style={{ maxHeight: '65vh', overflow: 'auto', whiteSpace: 'pre-wrap' }}>{preview.text}</pre>;
  }
  if (preview.objectUrl && preview.snapshot.mediaType.startsWith('image/')) {
    return <img src={preview.objectUrl} alt="历史快照预览" style={{ maxWidth: '100%', maxHeight: '65vh', display: 'block', margin: '0 auto' }} />;
  }
  if (preview.objectUrl && preview.snapshot.mediaType === 'application/pdf') {
    return <iframe title="历史快照预览" src={preview.objectUrl} style={{ width: '100%', height: '65vh', border: 0 }} />;
  }
  return <Empty description="此文件类型不支持在线预览，请下载查看。" />;
}

export function artifactReturnTarget(
  historyState: unknown,
  workspaceId: string,
  projectId?: string,
): number | string {
  const historyIndex = typeof historyState === 'object' && historyState !== null && 'idx' in historyState
    ? (historyState as { idx?: unknown }).idx
    : null;
  if (typeof historyIndex === 'number' && historyIndex > 0) return -1;
  return projectId ? `/w/${workspaceId}/p/${projectId}` : `/w/${workspaceId}`;
}

function SaveSnapshotButton({
  artifact,
  refresh,
  beforeSave,
}: {
  artifact: Artifact;
  refresh: () => Promise<void>;
  beforeSave?: () => Promise<Artifact>;
}) {
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const save = useMutation({
    mutationFn: async () => {
      const latest = beforeSave ? await beforeSave() : artifact;
      return api.saveArtifactSnapshot(artifact.id, {
        expectedCurrentRevision: latest.currentState.currentRevision,
        label: label.trim() || null,
      });
    },
    onSuccess: async (result) => {
      setOpen(false);
      setLabel('');
      await refresh();
      if (result.created) void message.success('已保存到历史。');
      else if (result.labelChanged) void message.success('当前内容已在历史中，名称已更新。');
      else void message.info('当前内容已在历史中。');
    },
    onError: async (error) => {
      await refresh();
      void message.error(errorMessage(error));
    },
  });
  return (
    <>
      <Button type="primary" icon={<SaveOutlined />} onClick={() => setOpen(true)}>保存到历史</Button>
      <Modal
        title="保存到历史"
        open={open}
        okText="保存"
        cancelText="取消"
        confirmLoading={save.isPending}
        onCancel={() => setOpen(false)}
        onOk={() => save.mutate()}
      >
        <Input
          aria-label="历史名称"
          value={label}
          maxLength={200}
          allowClear
          placeholder="名称可选；留空后以保存时间显示"
          onChange={(event) => setLabel(event.target.value)}
        />
      </Modal>
    </>
  );
}

function MarkdownArtifactEditor({ artifact, refresh }: ArtifactEditorProps) {
  const editorHost = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [content, setContent] = useState('');
  const [collaborators, setCollaborators] = useState(1);
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
  useEffect(() => {
    if (!editorHost.current) return undefined;
    const document = new Y.Doc();
    const ytext = document.getText('content');
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const nextProvider = new HocuspocusProvider({
      url: `${scheme}//${window.location.host}/v1/artifacts/collaboration`,
      name: artifact.id,
      document,
      token: '',
      flushDelay: 150,
      onStatus: ({ status: nextStatus }) => setStatus(nextStatus === 'connected' ? 'connected' : nextStatus === 'disconnected' ? 'disconnected' : 'connecting'),
      onAwarenessChange: ({ states }) => setCollaborators(Math.max(states.length, 1)),
    });
    setProvider(nextProvider);
    const updateContent = () => setContent(ytext.toString());
    ytext.observe(updateContent);
    updateContent();
    const view = new EditorView({
      parent: editorHost.current,
      state: EditorState.create({
        extensions: [
          basicSetup,
          markdown(),
          yCollab(ytext, nextProvider.awareness),
          EditorView.lineWrapping,
          EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { overflow: 'auto' } }),
        ],
      }),
    });
    return () => {
      ytext.unobserve(updateContent);
      view.destroy();
      nextProvider.destroy();
      document.destroy();
      setProvider(null);
    };
  }, [artifact.id]);
  const flush = async () => {
    if (!provider?.isSynced) throw new Error('实时内容仍在同步，请稍后再保存。');
    return api.flushArtifactDraft(artifact.id);
  };
  return (
    <div className="markdown-artifact-editor">
      <div className="artifact-editor-toolbar">
        <Space>
          <Tag color={status === 'connected' ? 'success' : status === 'connecting' ? 'processing' : 'error'}>{statusLabel(status)}</Tag>
          <Text type="secondary">{collaborators} 位协作者在线</Text>
          <Text type="secondary">当前状态 revision {artifact.currentState.currentRevision}</Text>
        </Space>
        <SaveSnapshotButton artifact={artifact} refresh={refresh} beforeSave={flush} />
      </div>
      <div className="markdown-editor-grid">
        <div className="markdown-source" ref={editorHost} />
        <article className="markdown-preview"><ReactMarkdown>{content}</ReactMarkdown></article>
      </div>
    </div>
  );
}

function FileArtifactEditor({ artifact, refresh }: ArtifactEditorProps) {
  const { message } = App.useApp();
  const upload = useMutation({
    mutationFn: (file: File) => api.replaceFileArtifactCurrent(
      artifact.id,
      file,
      artifact.currentState.currentRevision,
    ),
    onSuccess: async () => {
      await refresh();
      void message.success('当前文件已替换；未自动加入历史。');
    },
    onError: async (error) => {
      await refresh();
      void message.error(errorMessage(error));
    },
  });
  return (
    <Card className="file-artifact-card">
      <div className="file-artifact-summary">
        <span className="file-artifact-icon"><FileOutlined /></span>
        <div>
          <Title level={4}>{artifact.name}</Title>
          <Text type="secondary">{artifact.currentState.mediaType} · {formatBytes(artifact.currentState.byteLength)}</Text>
        </div>
      </div>
      <Space wrap>
        <Button type="primary" icon={<CloudDownloadOutlined />} href={api.artifactCurrentDownloadUrl(artifact.id)}>下载当前文件</Button>
        <Upload
          showUploadList={false}
          beforeUpload={(file) => {
            upload.mutate(file as File);
            return false;
          }}
        >
          <Button icon={<UploadOutlined />} loading={upload.isPending}>替换当前文件</Button>
        </Upload>
        <SaveSnapshotButton artifact={artifact} refresh={refresh} />
      </Space>
    </Card>
  );
}

function statusLabel(status: 'connecting' | 'connected' | 'disconnected'): string {
  if (status === 'connected') return '实时已连接';
  if (status === 'disconnected') return '实时已断开';
  return '正在连接';
}

function formatSnapshotTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(timestamp);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
