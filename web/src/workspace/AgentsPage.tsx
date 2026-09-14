import { ArrowRightOutlined, MessageOutlined, PlusOutlined, RobotOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Avatar, Button, Card, Empty, Space, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Agent } from '../api/client';
import { useLanguage } from '../language';
import { AgentCreateModal } from './AgentCreateModal';
import { runtimeLabel } from './AgentRuntimeFields';
import { useWorkspace, workspaceKeys } from './workspace-context';

const { Text, Title } = Typography;

function lifecycleColor(status: Agent['lifecycleStatus']): string {
  return { active: 'success', suspended: 'warning' }[status];
}

function lifecycleLabel(status: Agent['lifecycleStatus'], isEnglish = false): string {
  return isEnglish ? ({ active: 'Available', suspended: 'Suspended' }[status]) : ({ active: '可用', suspended: '已暂停' }[status]);
}

export function AgentsPage() {
  const { workspace, agents, openDirectMessage, openingDirectMessageMembershipId } = useWorkspace();
  const { isEnglish } = useLanguage();
  const tx = (zh: string, en: string) => isEnglish ? en : zh;
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
          <Text type="secondary">{tx('把需要持续协作的任务交给本地 Agent，并随时查看它的运行状态。', 'Delegate ongoing work to local Agents and monitor their runtime status.')}</Text>
        </div>
        <Button type="primary" size="large" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          {tx('创建 Agent', 'Create Agent')}
        </Button>
      </div>

      <div className="agent-directory-summary">
        <Card size="small" variant="borderless"><Text type="secondary">{tx('Agent 总数', 'Total Agents')}</Text><strong>{agents.length}</strong></Card>
        <Card size="small" variant="borderless"><Text type="secondary">{tx('可用', 'Available')}</Text><strong>{active}</strong></Card>
        <Card size="small" variant="borderless"><Text type="secondary">{tx('本地在线', 'Online locally')}</Text><strong>{connected}</strong></Card>
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
                  {tx('聊天', 'Chat')}
                </Button>,
                <Button
                  key="detail"
                  type="text"
                  icon={<ArrowRightOutlined />}
                  onClick={() => navigate(`/w/${workspace.id}/agents/${agent.id}`)}
                >
                  {tx('查看详情', 'View details')}
                </Button>,
              ]}
            >
              <div className="agent-card-heading">
                <Avatar size={48} className="agent-avatar"><RobotOutlined /></Avatar>
                <div className="agent-card-title">
                  <Space wrap size={6}>
                    <Title level={4}>{agent.name}</Title>
                    <Tag color={lifecycleColor(agent.lifecycleStatus)}>{lifecycleLabel(agent.lifecycleStatus, isEnglish)}</Tag>
                  </Space>
                  <Text type="secondary" ellipsis>{agent.description || tx('还没有描述', 'No description')}</Text>
                </div>
              </div>
              <div className={agent.runtimeBinding ? `agent-runtime-summary${runtimeConnected ? ' connected' : ''}` : 'agent-runtime-summary unbound'}>
                <span className={runtimeConnected ? 'runtime-status-dot online' : 'runtime-status-dot'} />
                {agent.runtimeBinding ? (
                  <div>
                    <Text strong>{runtimeLabel(agent.runtimeBinding.runtimeId)}</Text>
                    <Text type="secondary">{agent.runtimeBinding.computerName} · {runtimeConnected ? tx('已连接', 'Connected') : tx('离线', 'Offline')}</Text>
                  </div>
                ) : (
                  <div><Text strong>{tx('尚未连接', 'Not connected')}</Text><Text type="secondary">{tx('选择一台在线计算机和本地 Agent', 'Choose an online computer and local Agent')}</Text></div>
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
            description={<Space orientation="vertical" size={2}><Text strong>{tx('还没有 Agent', 'No Agents yet')}</Text><Text type="secondary">{tx('连接一台本地计算机后，就可以创建第一个 Agent。', 'Connect a local computer to create your first Agent.')}</Text></Space>}
          >
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>{tx('创建第一个 Agent', 'Create your first Agent')}</Button>
          </Empty>
        </Card>
      )}

      <AgentCreateModal workspaceId={workspace.id} open={createOpen} onClose={() => setCreateOpen(false)} />
    </main>
  );
}
