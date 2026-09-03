import { FileOutlined, UploadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Empty, Tooltip, Typography } from 'antd';
import { useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../api/client';

const { Text } = Typography;

export function ArtifactsPanel({ workspaceId, projectId }: { workspaceId: string; projectId: string | null }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const input = useRef<HTMLInputElement>(null);
  const artifacts = useQuery({ queryKey: ['project-v2', projectId, 'artifacts'], queryFn: () => api.listProjectArtifactsV2(projectId!).then((result) => result.items), enabled: Boolean(projectId) });
  const publish = useMutation({ mutationFn: (file: File) => api.publishArtifactV2(projectId!, file), onSuccess: async (result) => { await queryClient.invalidateQueries({ queryKey: ['project-v2', projectId, 'artifacts'] }); navigate(`/w/${workspaceId}/p/${projectId}/artifacts/${result.artifact.artifactId}`); }, onError: (error) => void message.error(errorMessage(error)) });
  if (!projectId) return <aside className="artifacts-panel" aria-label="交付物"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="进入项目查看交付物" /></aside>;
  const items = artifacts.data ?? [];
  return <aside className="artifacts-panel" aria-label="交付物"><header className="artifacts-panel-header"><div><strong>交付物</strong><Text type="secondary">{items.length}</Text></div><Tooltip title="发布交付物"><Button aria-label="发布交付物" type="text" size="small" loading={publish.isPending} icon={<UploadOutlined />} onClick={() => input.current?.click()} /></Tooltip></header><input ref={input} type="file" hidden aria-label="选择要发布的交付物" onChange={(event) => { const file = event.target.files?.[0]; if (file) publish.mutate(file); event.target.value = ''; }} /><div className="artifacts-panel-list" role="list" aria-label="交付物列表">{items.map((artifact) => <div className="artifact-panel-row" role="listitem" key={artifact.artifactId}><button type="button" onClick={() => navigate(`/w/${workspaceId}/p/${projectId}/artifacts/${artifact.artifactId}`)}><span className="artifact-kind"><FileOutlined /></span><span className="artifact-panel-copy"><strong>{artifact.name}</strong><small>{artifact.latestVersion ? `v${artifact.latestVersion.version} · ${artifact.latestVersion.fileName}` : '暂无版本'}</small></span></button></div>)}{!artifacts.isPending && !items.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前项目还没有交付物" />}</div></aside>;
}
