import {
  ArrowLeftOutlined,
  DeleteOutlined,
  EditOutlined,
  LinkOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  QuestionCircleOutlined,
  ReloadOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Avatar,
  Button,
  Card,
  Descriptions,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Popover,
  Select,
  Space,
  Spin,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, errorMessage, type Agent, type Human } from '../api/client';
import { sessionQueryKey } from '../app';
import { useLanguage } from '../language';
import { AgentActivityPanel } from './AgentActivityPanel';
import {
  AgentRuntimeFields,
  computerLoadErrorMessage,
  runtimeLabel,
  type RuntimeBindingFormValue,
} from './AgentRuntimeFields';
import { ComputerSetupModal } from './ComputerSetupModal';
import { useWorkspace, workspaceKeys } from './workspace-context';

const { Paragraph, Text, Title } = Typography;
function formatDateTime(timestamp: number, isEnglish: boolean): string {
  return new Intl.DateTimeFormat(isEnglish ? 'en-US' : 'zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
}
type AgentRuntimeBinding = NonNullable<Agent['runtimeBinding']>;

function hasCurrentRuntimeBinding(value: Agent['runtimeBinding'] | undefined): value is AgentRuntimeBinding {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AgentRuntimeBinding>;
  return (candidate.computerConnectionStatus === 'online' || candidate.computerConnectionStatus === 'offline')
    && typeof candidate.configuration === 'object'
    && candidate.configuration !== null
    && typeof candidate.configuration.effective === 'object';
}

function effectiveRuntimeValue(value: string | null, source: 'explicit' | 'runtime_default' | 'unavailable', isEnglish = false): string {
  if (value === null) return isEnglish ? 'Not exposed by local Agent' : '本地 Agent 未暴露';
  return source === 'runtime_default' ? (isEnglish ? `${value} (local Agent default)` : `${value}（本地 Agent 默认）`) : value;
}

function lifecycleColor(status: Agent['lifecycleStatus']): string {
  return { active: 'success', suspended: 'warning' }[status];
}

function lifecycleLabel(status: Agent['lifecycleStatus'], isEnglish = false): string {
  return isEnglish ? { active: 'Available', suspended: 'Suspended' }[status] : { active: '可用', suspended: '已暂停' }[status];
}

function ComputerOfflineHelp({ computerName }: { computerName: string }) {
  const { isEnglish } = useLanguage();
  const tx = (zh: string, en: string) => isEnglish ? en : zh;
  const installCommand = `npm install --global '${window.location.origin}/downloads/anc-local-computer.tgz'`;
  return (
    <Popover
      trigger="click"
      placement="bottomLeft"
      title={tx('让计算机重新上线', 'Bring the computer back online')}
      content={(
        <div className="computer-offline-help">
          <Text>{tx(`在已绑定的计算机“${computerName}”上打开终端并运行：`, `Open a terminal on the bound computer “${computerName}” and run:`)}</Text>
          <Paragraph code copyable={{ text: 'anc-computer service install' }} className="computer-offline-help-command">
            anc-computer service install
          </Paragraph>
          <Text type="secondary">{tx('客户端会立即上线，并在以后登录这台计算机时自动启动。本页面会自动更新。', 'The client comes online immediately and starts automatically the next time you log in to this computer. This page updates on its own.')}</Text>
          <Text type="secondary">{tx('只想临时前台运行本地 Agent 时，可使用 ', 'To run the local Agent temporarily in the foreground, use ')}<Text code>anc-computer run</Text>{tx('。', '.')}</Text>
          <Text type="secondary">
            {tx('如果提示找不到命令，或出现“ANC_SERVER_URL and ANC_COMPUTER_TOKEN are required”，说明客户端未安装或版本过旧，请先安装最新版：', 'If the command is not found, or you see “ANC_SERVER_URL and ANC_COMPUTER_TOKEN are required”, the client is not installed or is out of date. Install the latest version first:')}
          </Text>
          <Paragraph code copyable={{ text: installCommand }} className="computer-offline-help-command">
            {installCommand}
          </Paragraph>
        </div>
      )}
    >
      <Button
        type="text"
        size="small"
        className="computer-offline-help-button"
        aria-label={tx(`如何让 ${computerName} 上线`, `How to bring ${computerName} online`)}
        icon={<QuestionCircleOutlined />}
      />
    </Popover>
  );
}

export function AgentDetailPage() {
  const { agentId = '' } = useParams();
  const { isEnglish } = useLanguage();
  const tx = (zh: string, en: string) => isEnglish ? en : zh;
  const { workspace, members, agents, conversations, projects } = useWorkspace();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [editOpen, setEditOpen] = useState(false);
  const [bindingOpen, setBindingOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [computerSetupOpen, setComputerSetupOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('profile');
  const [editForm] = Form.useForm<{ name: string; description?: string }>();
  const [bindingForm] = Form.useForm<RuntimeBindingFormValue>();
  const [transferForm] = Form.useForm<{ newOwnerMembershipId: string }>();
  const cachedAgent = agents.find((agent) => agent.id === agentId);
  const session = queryClient.getQueryData<Human>(sessionQueryKey)!;
  const agentQuery = useQuery({
    queryKey: workspaceKeys.agent(workspace.id, agentId),
    queryFn: () => api.getAgent(workspace.id, agentId),
    initialData: cachedAgent,
  });
  const computers = useQuery({
    queryKey: workspaceKeys.computers,
    queryFn: () => api.listComputers().then((page) => page.items),
    refetchInterval: 10_000,
  });
  const agent = agentQuery.data;
  const workspaceOwner = workspace.membershipRole === 'owner';
  const agentOwner = agent?.ownerHumanId === session.id;
  const runtimeBindingCurrent = agent?.runtimeBinding === null || hasCurrentRuntimeBinding(agent?.runtimeBinding);
  const canBind = Boolean(agent && agent.membershipStatus === 'active' && runtimeBindingCurrent && agentOwner);

  useEffect(() => {
    if (!bindingOpen || !agent) return;
    const currentBinding = hasCurrentRuntimeBinding(agent.runtimeBinding) ? agent.runtimeBinding : null;
    const bindableComputers = (computers.data ?? []).filter((computer) => (
      computer.status === 'active'
      && computer.connectionStatus === 'online'
      && computer.runtimes.some((runtime) => runtime.availability === 'ready')
    ));
    const computerId = currentBinding?.computerId ?? bindableComputers[0]?.id;
    bindingForm.setFieldsValue({
      ...(computerId ? { computerId } : {}),
      ...(currentBinding?.runtimeId ? { runtimeId: currentBinding.runtimeId } : {}),
      model: currentBinding?.configuration.requested.model ?? null,
      reasoningEffort: currentBinding?.configuration.requested.reasoningEffort ?? null,
      mode: currentBinding?.configuration.requested.mode ?? null,
    });
  }, [agent, bindingForm, bindingOpen, computers.data]);

  const refreshAgent = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: workspaceKeys.agents(workspace.id) }),
      queryClient.invalidateQueries({ queryKey: workspaceKeys.agent(workspace.id, agentId) }),
    ]);
  };
  const update = useMutation({
    mutationFn: (value: { name: string; description?: string }) => api.updateAgent(workspace.id, agentId, {
      name: value.name.trim(),
      description: value.description?.trim() || null,
      expectedRevision: agent!.revision,
    }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(workspaceKeys.agent(workspace.id, agentId), updated);
      setEditOpen(false);
      await refreshAgent();
      await message.success(tx('Agent 资料已更新', 'Agent profile updated'));
    },
  });
  const lifecycle = useMutation({
    mutationFn: (action: 'suspend' | 'resume') => api.setAgentAvailability(workspace.id, agentId, action, agent!.revision),
    onSuccess: async (updated) => {
      queryClient.setQueryData(workspaceKeys.agent(workspace.id, agentId), updated);
      await refreshAgent();
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const restart = useMutation({
    mutationFn: () => api.restartAgent(workspace.id, agentId, agent!.revision),
    onSuccess: async (updated) => {
      queryClient.setQueryData(workspaceKeys.agent(workspace.id, agentId), updated);
      await refreshAgent();
      await message.success(tx('Agent 已重启；下一条消息会启动新的本地 Agent 会话', 'Agent restarted; the next message will start a new local Agent session'));
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const membershipLifecycle = useMutation({
    mutationFn: async (action: 'terminate' | 'readmit') => {
      if (action === 'terminate') {
        await api.terminateAgentMembership(workspace.id, agentId, agent!.revision);
        return api.getAgent(workspace.id, agentId);
      }
      return api.readmitAgentMembership(workspace.id, agentId, agent!.revision);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workspaceKeys.bootstrap(workspace.id) }),
        queryClient.invalidateQueries({ queryKey: workspaceKeys.members(workspace.id) }),
        queryClient.invalidateQueries({ queryKey: workspaceKeys.agents(workspace.id) }),
        queryClient.invalidateQueries({ queryKey: workspaceKeys.conversations(workspace.id) }),
      ]);
      await message.success(agent?.membershipStatus === 'active' ? tx('Agent 已从 Workspace 移除', 'Agent removed from the Workspace') : tx('Agent 已重新加入 Workspace', 'Agent re-added to the Workspace'));
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const deleteAgent = useMutation({
    mutationFn: async () => {
      let expectedRevision = agent!.revision;
      if (agent!.membershipStatus === 'active') {
        await api.terminateAgentMembership(workspace.id, agentId, expectedRevision);
        expectedRevision += 1;
      }
      return api.deleteAgent(workspace.id, agentId, expectedRevision);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workspaceKeys.bootstrap(workspace.id) }),
        queryClient.invalidateQueries({ queryKey: workspaceKeys.members(workspace.id) }),
        queryClient.invalidateQueries({ queryKey: workspaceKeys.agents(workspace.id) }),
        queryClient.invalidateQueries({ queryKey: workspaceKeys.conversations(workspace.id) }),
      ]);
      void message.success(tx('Agent 已永久删除', 'Agent permanently deleted'));
      navigate(`/w/${workspace.id}/agents`);
    },
    onError: async (error) => {
      await refreshAgent();
      await message.error(errorMessage(error));
    },
  });
  const transferOwnership = useMutation({
    mutationFn: ({ newOwnerMembershipId }: { newOwnerMembershipId: string }) =>
      api.transferAgentOwnership(workspace.id, agentId, newOwnerMembershipId, agent!.revision),
    onSuccess: async () => {
      setTransferOpen(false);
      transferForm.resetFields();
      await refreshAgent();
      await message.success(tx('Agent Owner 已转移', 'Agent Owner transferred'));
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const bind = useMutation({
    mutationFn: (value: RuntimeBindingFormValue) => api.bindAgentRuntime(workspace.id, agentId, {
      computerId: value.computerId,
      runtimeId: value.runtimeId,
      model: value.model?.trim() || null,
      reasoningEffort: value.reasoningEffort ?? null,
      mode: value.mode?.trim() || null,
      expectedRevision: agent?.runtimeBinding?.bindingRevision ?? 0,
    }),
    onSuccess: async () => {
      setBindingOpen(false);
      await refreshAgent();
      await message.success(agent?.runtimeBinding ? tx('运行设置已更新', 'Runtime settings updated') : tx('本地 Agent 已连接', 'Local Agent connected'));
    },
  });

  if (agentQuery.isPending) return <div className="full-page-center"><Spin /></div>;
  if (agentQuery.isError || !agent) {
    return <div className="full-page-center"><Empty description={errorMessage(agentQuery.error)}><Button onClick={() => navigate(`/w/${workspace.id}/agents`)}>{tx('返回 Agent 列表', 'Back to Agent list')}</Button></Empty></div>;
  }

  const runtimeBinding = hasCurrentRuntimeBinding(agent.runtimeBinding) ? agent.runtimeBinding : null;
  const runtimeBindingOutdated = agent.runtimeBinding !== null && runtimeBinding === null;
  const boundComputer = computers.data?.find((computer) => computer.id === runtimeBinding?.computerId);
  const boundRuntime = boundComputer?.runtimes.find((runtime) => runtime.runtimeId === runtimeBinding?.runtimeId);
  const connected = runtimeBinding?.computerConnectionStatus === 'online';
  const creator = members.find((member) => member.actorType === 'human' && member.actorId === agent.createdByHumanId);
  const hasBindableComputer = (computers.data ?? []).some((computer) => (
    computer.status === 'active'
    && computer.connectionStatus === 'online'
    && computer.runtimes.some((runtime) => runtime.availability === 'ready')
  ));
  const openEditor = () => {
    editForm.setFieldsValue(agent.description === null ? { name: agent.name } : { name: agent.name, description: agent.description });
    setEditOpen(true);
  };
  const profilePanel = (
    <Card className="surface-card agent-profile-panel" variant="borderless">
      <section className="agent-profile-section">
        <div className="agent-profile-section-heading">
          <Text type="secondary">{tx('显示名称', 'Display name')}</Text>
          {agentOwner && agent.membershipStatus === 'active' && <Button type="link" icon={<EditOutlined />} onClick={openEditor}>{tx('编辑', 'Edit')}</Button>}
        </div>
        <Text strong>{agent.name}</Text>
      </section>
      <section className="agent-profile-section">
        <Text type="secondary">{tx('描述', 'Description')}</Text>
        <Text>{agent.description || tx('还没有描述', 'No description')}</Text>
      </section>
      <section className="agent-profile-section">
        <Title level={5}>{tx('信息', 'Information')}</Title>
        <Descriptions column={{ xs: 1, sm: 2 }} items={[
          { key: 'role', label: tx('角色', 'Role'), children: <Tag>{tx('成员', 'Member')}</Tag> },
          {
            key: 'computer',
            label: tx('计算机', 'Computer'),
            children: runtimeBindingOutdated
              ? <Text type="danger">{tx('前后端数据版本不一致', 'Frontend and backend data versions do not match')}</Text>
              : runtimeBinding
              ? <Space><span className={connected ? 'runtime-status-dot online' : 'runtime-status-dot'} />{runtimeBinding.computerName}<Text type="secondary">{connected ? tx('已连接', 'Connected') : tx('离线', 'Offline')}</Text></Space>
              : <Text type="secondary">{tx('未连接', 'Not connected')}</Text>,
          },
          { key: 'created', label: tx('创建时间', 'Created'), children: formatDateTime(agent.createdAt, isEnglish) },
          { key: 'creator', label: tx('创建者', 'Creator'), children: creator?.displayName ?? tx('未知成员', 'Unknown member') },
          { key: 'owner', label: tx('当前 Owner', 'Current owner'), children: agent.ownerDisplayName },
          { key: 'membership', label: tx('成员状态', 'Membership status'), children: <Tag color={agent.membershipStatus === 'active' ? 'success' : 'default'}>{agent.membershipStatus === 'active' ? tx('正常', 'Active') : tx('已移除', 'Removed')}</Tag> },
        ]} />
      </section>
      <section className="agent-profile-section">
        <div className="agent-profile-section-heading">
          <Title level={5}>{tx('本地 Agent 配置', 'Local Agent configuration')}</Title>
          {canBind && <Button type="link" icon={<EditOutlined />} onClick={() => setBindingOpen(true)}>{tx('编辑', 'Edit')}</Button>}
        </div>
        {runtimeBindingOutdated ? (
          <Alert
            type="error"
            showIcon
            title={tx('运行配置加载失败', 'Failed to load run configuration')}
            description={tx('当前后端返回的数据不符合最新本地 Agent 绑定契约。请完成后端数据升级并重启服务后刷新页面。', 'The data returned by the backend does not match the latest local Agent binding contract. Complete the backend data upgrade, restart the service, then refresh this page.')}
          />
        ) : runtimeBinding ? (
          <>
            {runtimeBinding.configuration.status !== 'valid' && (
              <Alert type="warning" showIcon title={runtimeBinding.configuration.invalidReason?.message ?? tx('当前运行配置不可用', 'Current run configuration is unavailable')} />
            )}
            <div className="agent-runtime-fields">
              <div><Text type="secondary">{tx('本地 Agent', 'Local Agent')}</Text><Tag color="cyan">{runtimeLabel(runtimeBinding.runtimeId)}</Tag></div>
              <div><Text type="secondary">{tx('模型', 'Model')}</Text><Tag color="geekblue">{effectiveRuntimeValue(runtimeBinding.configuration.effective.model.value, runtimeBinding.configuration.effective.model.source, isEnglish)}</Tag></div>
              <div><Text type="secondary">{tx('推理强度', 'Reasoning effort')}</Text><Tag color="gold">{effectiveRuntimeValue(runtimeBinding.configuration.effective.reasoningEffort.value, runtimeBinding.configuration.effective.reasoningEffort.source, isEnglish)}</Tag></div>
              <div><Text type="secondary">{tx('模式', 'Mode')}</Text><Tag color="orange">{effectiveRuntimeValue(runtimeBinding.configuration.effective.mode.value, runtimeBinding.configuration.effective.mode.source, isEnglish)}</Tag></div>
            </div>
            <Text type="secondary">{runtimeBinding.computerName} · {runtimeBinding.detectedVersion || boundRuntime?.detectedVersion || tx('未检测到版本', 'Version not detected')}</Text>
          </>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={tx('尚未选择计算机和本地 Agent', 'No computer or local Agent selected yet')}>
            {canBind && <Button type="primary" icon={<LinkOutlined />} onClick={() => setBindingOpen(true)}>{tx('连接本地 Agent', 'Connect local Agent')}</Button>}
          </Empty>
        )}
      </section>
      {(agentOwner || workspaceOwner) && (
        <section className="agent-profile-section agent-management-section">
          <Title level={5}>{tx('Agent 管理', 'Agent management')}</Title>
          <Space wrap>
            {agentOwner && agent.membershipStatus === 'active' && agent.lifecycleStatus === 'active' && <Button icon={<PauseCircleOutlined />} loading={lifecycle.isPending} onClick={() => lifecycle.mutate('suspend')}>{tx('暂停 Agent', 'Suspend Agent')}</Button>}
            {agentOwner && agent.membershipStatus === 'active' && agent.lifecycleStatus === 'suspended' && <Button icon={<PlayCircleOutlined />} loading={lifecycle.isPending} onClick={() => lifecycle.mutate('resume')}>{tx('恢复 Agent', 'Resume Agent')}</Button>}
            {agentOwner && agent.membershipStatus === 'active' && agent.lifecycleStatus === 'active' && runtimeBinding && (
              <Popconfirm
                title={tx('重启这个 Agent？', 'Restart this Agent?')}
                description={tx('当前执行会被取消，本地 Agent 会话会清空；Agent 资料和历史消息不受影响。', 'The current execution will be cancelled and the local Agent session cleared; the Agent profile and message history are unaffected.')}
                okText={tx('重启 Agent', 'Restart Agent')}
                onConfirm={() => restart.mutate()}
              >
                <Button icon={<ReloadOutlined />} loading={restart.isPending}>{tx('重启 Agent', 'Restart Agent')}</Button>
              </Popconfirm>
            )}
            {workspaceOwner && <Button onClick={() => setTransferOpen(true)}>{tx('转移 Owner', 'Transfer owner')}</Button>}
            {workspaceOwner && <Popconfirm
              title={tx('永久删除这个 Agent？', 'Permanently delete this Agent?')}
              description={tx('Agent 会从 Workspace 永久移除，进行中的任务会终止；历史消息仍保留并标记为“已删除”。此操作无法撤销。', 'The Agent will be permanently removed from the Workspace and any ongoing tasks will be terminated; message history is retained and marked as “Deleted”. This action cannot be undone.')}
              okText={tx('删除 Agent', 'Delete Agent')}
              okButtonProps={{ danger: true }}
              onConfirm={() => deleteAgent.mutate()}
            >
              <Button danger icon={<DeleteOutlined />} loading={deleteAgent.isPending}>{tx('删除 Agent', 'Delete Agent')}</Button>
            </Popconfirm>}
            {workspaceOwner && agent.membershipStatus === 'removed' && (
              <Button type="primary" loading={membershipLifecycle.isPending} onClick={() => membershipLifecycle.mutate('readmit')}>{tx('重新准入', 'Re-admit')}</Button>
            )}
          </Space>
        </section>
      )}
    </Card>
  );
  return (
    <main className="page-scroll agent-detail-page">
      <Button className="agent-back-button" type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate(`/w/${workspace.id}/agents`)}>{tx('返回 Agent 列表', 'Back to Agents')}</Button>
      <Card className="agent-profile-header surface-card" variant="borderless">
        <div className="agent-profile-main">
          <Avatar size={72} className="agent-profile-avatar"><RobotOutlined /></Avatar>
          <div className="agent-profile-copy">
            <Space wrap size={8}>
              <Title level={2}>{agent.name}</Title>
              <Tag color={lifecycleColor(agent.lifecycleStatus)}>{lifecycleLabel(agent.lifecycleStatus, isEnglish)}</Tag>
              <Space size={5}>
                <span className={connected ? 'runtime-status-dot online' : 'runtime-status-dot'} />
                <Text type={runtimeBindingOutdated ? 'danger' : 'secondary'}>{runtimeBindingOutdated ? tx('配置未同步', 'Configuration out of sync') : connected ? tx('已连接', 'Connected') : runtimeBinding ? tx('离线', 'Offline') : tx('未连接', 'Not connected')}</Text>
                {runtimeBinding && !connected && !runtimeBindingOutdated && <ComputerOfflineHelp computerName={runtimeBinding.computerName} />}
              </Space>
            </Space>
            <Text type="secondary">{agent.description || tx('还没有描述', 'No description')}</Text>
          </div>
        </div>
      </Card>
      <Tabs
        className="agent-profile-tabs"
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          { key: 'profile', label: tx('资料', 'Profile'), children: profilePanel },
          { key: 'activity', label: tx('动态', 'Activity'), children: <AgentActivityPanel agent={agent} conversations={conversations} projects={projects} enabled={activeTab === 'activity'} /> },
        ]}
      />

      <Modal title={tx('编辑 Agent 资料', 'Edit Agent profile')} open={editOpen} okText={tx('保存', 'Save')} confirmLoading={update.isPending} onCancel={() => setEditOpen(false)} onOk={() => void editForm.validateFields().then((value) => update.mutate(value))}>
        <Form form={editForm} layout="vertical">
          <Form.Item name="name" label={tx('名称', 'Name')} rules={[{ required: true, max: 120, whitespace: true }]}><Input /></Form.Item>
          <Form.Item name="description" label={tx('描述', 'Description')} rules={[{ max: 2000 }]}><Input.TextArea rows={4} maxLength={2000} showCount /></Form.Item>
        </Form>
        {update.error && <Alert type="error" showIcon title={errorMessage(update.error)} />}
      </Modal>
      <Modal
        title={tx('转移 Agent Owner', 'Transfer Agent Owner')}
        open={transferOpen}
        okText={tx('转移', 'Transfer')}
        confirmLoading={transferOwnership.isPending}
        onCancel={() => setTransferOpen(false)}
        onOk={() => void transferForm.validateFields().then((value) => transferOwnership.mutate(value))}
      >
        <Form form={transferForm} layout="vertical">
          <Form.Item name="newOwnerMembershipId" label={tx('新的所有者', 'New owner')} rules={[{ required: true }]}>
            <Select options={members
              .filter((member) => member.actorType === 'human' && member.membershipId !== agent.ownerMembershipId)
              .map((member) => ({ value: member.membershipId, label: member.displayName }))} />
          </Form.Item>
        </Form>
        {transferOwnership.error && <Alert type="error" showIcon title={errorMessage(transferOwnership.error)} />}
      </Modal>
      <Modal
        title={agent.runtimeBinding ? tx('编辑运行设置', 'Edit runtime settings') : tx('连接本地 Agent', 'Connect local Agent')}
        open={bindingOpen}
        okText={tx('保存', 'Save')}
        confirmLoading={bind.isPending}
        okButtonProps={{ disabled: computers.isPending || computers.isError || !hasBindableComputer }}
        onCancel={() => setBindingOpen(false)}
        onOk={() => void bindingForm.validateFields().then((value) => bind.mutate(value))}
      >
        {computers.isPending ? (
          <div className="modal-loading"><Spin /></div>
        ) : computers.isError ? (
          <Alert
            type="error"
            showIcon
            title={tx('暂时无法连接本地 Agent', 'Cannot connect to the local Agent right now')}
            description={computerLoadErrorMessage(computers.error, isEnglish)}
          />
        ) : (
          <Form form={bindingForm} layout="vertical">
            <AgentRuntimeFields computers={computers.data ?? []} onSetupComputer={() => setComputerSetupOpen(true)} />
          </Form>
        )}
        {bind.error && <Alert type="error" showIcon title={errorMessage(bind.error)} />}
      </Modal>
      <ComputerSetupModal open={computerSetupOpen} onClose={() => setComputerSetupOpen(false)} />
    </main>
  );
}
