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
const dateTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
type AgentRuntimeBinding = NonNullable<Agent['runtimeBinding']>;

function hasCurrentRuntimeBinding(value: Agent['runtimeBinding'] | undefined): value is AgentRuntimeBinding {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AgentRuntimeBinding>;
  return (candidate.computerConnectionStatus === 'online' || candidate.computerConnectionStatus === 'offline')
    && typeof candidate.configuration === 'object'
    && candidate.configuration !== null
    && typeof candidate.configuration.effective === 'object';
}

function effectiveRuntimeValue(value: string | null, source: 'explicit' | 'runtime_default' | 'unavailable'): string {
  if (value === null) return 'Runtime 未暴露';
  return source === 'runtime_default' ? `${value}（Runtime 默认）` : value;
}

function lifecycleColor(status: Agent['lifecycleStatus']): string {
  return { active: 'success', suspended: 'warning' }[status];
}

function lifecycleLabel(status: Agent['lifecycleStatus']): string {
  return { active: '可用', suspended: '已暂停' }[status];
}

function ComputerOfflineHelp({ computerName }: { computerName: string }) {
  const installCommand = `npm install --global '${window.location.origin}/downloads/anc-local-computer.tgz'`;
  return (
    <Popover
      trigger="click"
      placement="bottomLeft"
      title="让计算机重新上线"
      content={(
        <div className="computer-offline-help">
          <Text>在已绑定的计算机“{computerName}”上打开终端并运行：</Text>
          <Paragraph code copyable={{ text: 'anc-computer run' }} className="computer-offline-help-command">
            anc-computer run
          </Paragraph>
          <Text type="secondary">保持客户端运行，重新连接后本页面会自动更新。</Text>
          <Text type="secondary">
            如果提示找不到命令，或出现“ANC_SERVER_URL and ANC_COMPUTER_TOKEN are required”，说明客户端未安装或版本过旧，请先安装最新版：
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
        aria-label={`如何让 ${computerName} 上线`}
        icon={<QuestionCircleOutlined />}
      />
    </Popover>
  );
}

export function AgentDetailPage() {
  const { agentId = '' } = useParams();
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
      await message.success('Agent 资料已更新');
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
      await message.success('Agent 已重启；下一条消息会启动新的 Runtime 会话');
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
      await message.success(agent?.membershipStatus === 'active' ? 'Agent Membership 已终止' : 'Agent Membership 已重新准入');
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
      void message.success('Agent 已永久删除');
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
      await message.success('Agent Owner 已转移');
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
      await message.success(agent?.runtimeBinding ? '运行设置已更新' : '运行时已连接');
    },
  });

  if (agentQuery.isPending) return <div className="full-page-center"><Spin /></div>;
  if (agentQuery.isError || !agent) {
    return <div className="full-page-center"><Empty description={errorMessage(agentQuery.error)}><Button onClick={() => navigate(`/w/${workspace.id}/agents`)}>返回 Agent 列表</Button></Empty></div>;
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
          <Text type="secondary">显示名称</Text>
          {agentOwner && agent.membershipStatus === 'active' && <Button type="link" icon={<EditOutlined />} onClick={openEditor}>编辑</Button>}
        </div>
        <Text strong>{agent.name}</Text>
      </section>
      <section className="agent-profile-section">
        <Text type="secondary">描述</Text>
        <Text>{agent.description || '暂无描述'}</Text>
      </section>
      <section className="agent-profile-section">
        <Title level={5}>信息</Title>
        <Descriptions column={{ xs: 1, sm: 2 }} items={[
          { key: 'role', label: '角色', children: <Tag>成员</Tag> },
          {
            key: 'computer',
            label: '计算机',
            children: runtimeBindingOutdated
              ? <Text type="danger">前后端数据版本不一致</Text>
              : runtimeBinding
              ? <Space><span className={connected ? 'runtime-status-dot online' : 'runtime-status-dot'} />{runtimeBinding.computerName}<Text type="secondary">{connected ? '已连接' : '离线'}</Text></Space>
              : <Text type="secondary">未连接</Text>,
          },
          { key: 'created', label: '创建时间', children: dateTime.format(agent.createdAt) },
          { key: 'creator', label: '创建者', children: creator?.displayName ?? '未知成员' },
          { key: 'owner', label: '当前 Owner', children: agent.ownerDisplayName },
          { key: 'membership', label: 'Membership', children: <Tag color={agent.membershipStatus === 'active' ? 'success' : 'default'}>{agent.membershipStatus}</Tag> },
        ]} />
      </section>
      <section className="agent-profile-section">
        <div className="agent-profile-section-heading">
          <Title level={5}>运行时配置</Title>
          {canBind && <Button type="link" icon={<EditOutlined />} onClick={() => setBindingOpen(true)}>编辑</Button>}
        </div>
        {runtimeBindingOutdated ? (
          <Alert
            type="error"
            showIcon
            title="运行配置加载失败"
            description="当前后端返回的数据不符合最新 Runtime Binding 契约。请完成后端数据升级并重启服务后刷新页面。"
          />
        ) : runtimeBinding ? (
          <>
            {runtimeBinding.configuration.status !== 'valid' && (
              <Alert type="warning" showIcon title={runtimeBinding.configuration.invalidReason?.message ?? '当前运行配置不可用'} />
            )}
            <div className="agent-runtime-fields">
              <div><Text type="secondary">运行时</Text><Tag color="cyan">{runtimeLabel(runtimeBinding.runtimeId)}</Tag></div>
              <div><Text type="secondary">模型</Text><Tag color="geekblue">{effectiveRuntimeValue(runtimeBinding.configuration.effective.model.value, runtimeBinding.configuration.effective.model.source)}</Tag></div>
              <div><Text type="secondary">推理强度</Text><Tag color="gold">{effectiveRuntimeValue(runtimeBinding.configuration.effective.reasoningEffort.value, runtimeBinding.configuration.effective.reasoningEffort.source)}</Tag></div>
              <div><Text type="secondary">模式</Text><Tag color="orange">{effectiveRuntimeValue(runtimeBinding.configuration.effective.mode.value, runtimeBinding.configuration.effective.mode.source)}</Tag></div>
            </div>
            <Text type="secondary">{runtimeBinding.computerName} · {runtimeBinding.detectedVersion || boundRuntime?.detectedVersion || '未检测到版本'}</Text>
          </>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未选择计算机和运行时">
            {canBind && <Button type="primary" icon={<LinkOutlined />} onClick={() => setBindingOpen(true)}>连接运行时</Button>}
          </Empty>
        )}
      </section>
      {(agentOwner || workspaceOwner) && (
        <section className="agent-profile-section agent-management-section">
          <Title level={5}>Agent 管理</Title>
          <Space wrap>
            {agentOwner && agent.membershipStatus === 'active' && agent.lifecycleStatus === 'active' && <Button icon={<PauseCircleOutlined />} loading={lifecycle.isPending} onClick={() => lifecycle.mutate('suspend')}>暂停 Agent</Button>}
            {agentOwner && agent.membershipStatus === 'active' && agent.lifecycleStatus === 'suspended' && <Button icon={<PlayCircleOutlined />} loading={lifecycle.isPending} onClick={() => lifecycle.mutate('resume')}>恢复 Agent</Button>}
            {agentOwner && agent.membershipStatus === 'active' && agent.lifecycleStatus === 'active' && runtimeBinding && (
              <Popconfirm
                title="重启这个 Agent？"
                description="当前执行会被取消，Runtime 会话会清空；Agent 资料和历史消息不受影响。"
                okText="重启 Agent"
                onConfirm={() => restart.mutate()}
              >
                <Button icon={<ReloadOutlined />} loading={restart.isPending}>重启 Agent</Button>
              </Popconfirm>
            )}
            {workspaceOwner && <Button onClick={() => setTransferOpen(true)}>转移 Owner</Button>}
            {workspaceOwner && <Popconfirm
              title="永久删除这个 Agent？"
              description="Agent 会从 Workspace 永久移除，Membership 和进行中的任务会终止；历史消息仍保留并标记为“已删除”。此操作无法撤销。"
              okText="删除 Agent"
              okButtonProps={{ danger: true }}
              onConfirm={() => deleteAgent.mutate()}
            >
              <Button danger icon={<DeleteOutlined />} loading={deleteAgent.isPending}>删除 Agent</Button>
            </Popconfirm>}
            {workspaceOwner && agent.membershipStatus === 'removed' && (
              <Button type="primary" loading={membershipLifecycle.isPending} onClick={() => membershipLifecycle.mutate('readmit')}>重新准入</Button>
            )}
          </Space>
        </section>
      )}
    </Card>
  );
  return (
    <main className="page-scroll agent-detail-page">
      <Button className="agent-back-button" type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate(`/w/${workspace.id}/agents`)}>AGENTS</Button>
      <Card className="agent-profile-header surface-card" variant="borderless">
        <div className="agent-profile-main">
          <Avatar size={72} className="agent-profile-avatar"><RobotOutlined /></Avatar>
          <div className="agent-profile-copy">
            <Space wrap size={8}>
              <Title level={2}>{agent.name}</Title>
              <Tag color={lifecycleColor(agent.lifecycleStatus)}>{lifecycleLabel(agent.lifecycleStatus)}</Tag>
              <Space size={5}>
                <span className={connected ? 'runtime-status-dot online' : 'runtime-status-dot'} />
                <Text type={runtimeBindingOutdated ? 'danger' : 'secondary'}>{runtimeBindingOutdated ? '配置未同步' : connected ? '已连接' : runtimeBinding ? '离线' : '未连接'}</Text>
                {runtimeBinding && !connected && !runtimeBindingOutdated && <ComputerOfflineHelp computerName={runtimeBinding.computerName} />}
              </Space>
            </Space>
            <Text type="secondary">{agent.description || '暂无描述'}</Text>
          </div>
        </div>
      </Card>
      <Tabs
        className="agent-profile-tabs"
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          { key: 'profile', label: '资料', children: profilePanel },
          { key: 'activity', label: '动态', children: <AgentActivityPanel agent={agent} conversations={conversations} projects={projects} enabled={activeTab === 'activity'} /> },
        ]}
      />

      <Modal title="编辑 Agent 资料" open={editOpen} okText="保存" confirmLoading={update.isPending} onCancel={() => setEditOpen(false)} onOk={() => void editForm.validateFields().then((value) => update.mutate(value))}>
        <Form form={editForm} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true, max: 120, whitespace: true }]}><Input /></Form.Item>
          <Form.Item name="description" label="描述" rules={[{ max: 2000 }]}><Input.TextArea rows={4} maxLength={2000} showCount /></Form.Item>
        </Form>
        {update.error && <Alert type="error" showIcon title={errorMessage(update.error)} />}
      </Modal>
      <Modal
        title="转移 Agent Owner"
        open={transferOpen}
        okText="转移"
        confirmLoading={transferOwnership.isPending}
        onCancel={() => setTransferOpen(false)}
        onOk={() => void transferForm.validateFields().then((value) => transferOwnership.mutate(value))}
      >
        <Form form={transferForm} layout="vertical">
          <Form.Item name="newOwnerMembershipId" label="新的 Human Owner" rules={[{ required: true }]}>
            <Select options={members
              .filter((member) => member.actorType === 'human' && member.membershipId !== agent.ownerMembershipId)
              .map((member) => ({ value: member.membershipId, label: member.displayName }))} />
          </Form.Item>
        </Form>
        {transferOwnership.error && <Alert type="error" showIcon title={errorMessage(transferOwnership.error)} />}
      </Modal>
      <Modal
        title={agent.runtimeBinding ? '编辑运行设置' : '连接运行时'}
        open={bindingOpen}
        okText="保存"
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
            title="暂时无法连接运行时"
            description={computerLoadErrorMessage(computers.error)}
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
