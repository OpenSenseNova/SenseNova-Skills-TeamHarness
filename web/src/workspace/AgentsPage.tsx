import { ArrowRightOutlined, MessageOutlined, PlusOutlined, RobotOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Avatar, Button, Card, Empty, Space, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Agent } from '../api/client';
import { AgentCreateModal } from './AgentCreateModal';
import { runtimeLabel } from './AgentRuntimeFields';
import { useWorkspace, workspaceKeys } from './workspace-context';

const { Text, Title } = Typography;

function lifecycleColor(status: Agent['lifecycleStatus']): string {
  return { active: 'success', suspended: 'warning' }[status];
}

function lifecycleLabel(status: Agent['lifecycleStatus']): string {
  return { active: '可用', suspended: '已暂停' }[status];
}

export function AgentsPage() {
  const { workspace, agents, openDirectMessage, openingDirectMessageMembershipId } = useWorkspace();
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const computers = useQuery({
    queryKey: workspaceKeys.computers,
    queryFn: () => api.listComputers().then((page) => page.items),
    refetchInterval: 10_000,
  });
  const active = agents.filter((agent) => agent.lifecycleStatus === 'active').length;
  const connected = agents.filter((agent) => {
    const computer = computers.data?.find((item) => item.id === agent.runtimeBinding?.computerId);
    return Boolean(agent.runtimeBinding && computer?.connectionStatus === 'online');
  }).length;

  return (
    <main className="page-scroll agent-directory-page">
      <div className="page-header agent-directory-header">
        <div>
          <Text className="page-eyebrow">TEAM</Text>
          <Title level={2}>Agent</Title>
          <Text type="secondary">把需要持续协作的任务交给本地 Agent，并随时查看它的运行状态。</Text>
        </div>
        <Button type="primary" size="large" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          创建 Agent
        </Button>
      </div>

      <div className="agent-directory-summary">
        <Card size="small" variant="borderless"><Text type="secondary">Agent 总数</Text><strong>{agents.length}</strong></Card>
        <Card size="small" variant="borderless"><Text type="secondary">可用</Text><strong>{active}</strong></Card>
        <Card size="small" variant="borderless"><Text type="secondary">本地在线</Text><strong>{connected}</strong></Card>
      </div>

      {agents.length ? (
        <div className="agent-card-grid">
          {agents.map((agent) => {
            const computer = computers.data?.find((item) => item.id === agent.runtimeBinding?.computerId);
            const runtimeConnected = Boolean(agent.runtimeBinding && computer?.connectionStatus === 'online');
            return (
            <Card
              key={agent.id}
              className="agent-directory-card"
              variant="borderless"
              actions={[
                <Button
                  key="message"
                  type="text"
                  icon={<MessageOutlined />}
                  loading={openingDirectMessageMembershipId === agent.membershipId}
                  onClick={() => void openDirectMessage(agent.membershipId)}
                >
                  聊天
                </Button>,
                <Button
                  key="detail"
                  type="text"
                  icon={<ArrowRightOutlined />}
                  onClick={() => navigate(`/w/${workspace.id}/agents/${agent.id}`)}
                >
                  查看详情
                </Button>,
              ]}
            >
              <div className="agent-card-heading">
                <Avatar size={48} className="agent-avatar"><RobotOutlined /></Avatar>
                <div className="agent-card-title">
                  <Space wrap size={6}>
                    <Title level={4}>{agent.name}</Title>
                    <Tag color={lifecycleColor(agent.lifecycleStatus)}>{lifecycleLabel(agent.lifecycleStatus)}</Tag>
                  </Space>
                  <Text type="secondary" ellipsis>{agent.description || '还没有描述'}</Text>
                </div>
              </div>
              <div className={agent.runtimeBinding ? `agent-runtime-summary${runtimeConnected ? ' connected' : ''}` : 'agent-runtime-summary unbound'}>
                <span className={runtimeConnected ? 'runtime-status-dot online' : 'runtime-status-dot'} />
                {agent.runtimeBinding ? (
                  <div>
                    <Text strong>{runtimeLabel(agent.runtimeBinding.runtimeId)}</Text>
                    <Text type="secondary">{agent.runtimeBinding.computerName} · {runtimeConnected ? '已连接' : '离线'}</Text>
                  </div>
                ) : (
                  <div><Text strong>尚未连接</Text><Text type="secondary">选择一台在线计算机和本地 Agent</Text></div>
                )}
              </div>
            </Card>
            );
          })}
        </div>
      ) : (
        <Card className="surface-card agent-empty-card" variant="borderless">
          <Empty
            image={<RobotOutlined className="agent-empty-icon" />}
            description={<Space orientation="vertical" size={2}><Text strong>还没有 Agent</Text><Text type="secondary">连接一台本地计算机后，就可以创建第一个 Agent。</Text></Space>}
          >
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>创建第一个 Agent</Button>
          </Empty>
        </Card>
      )}

      <AgentCreateModal workspaceId={workspace.id} open={createOpen} onClose={() => setCreateOpen(false)} />
    </main>
  );
}
