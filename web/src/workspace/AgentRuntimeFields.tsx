import { Alert, Button, Form, Select, Space, Tag, Typography } from 'antd';
import { useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import { ApiError, errorMessage, type Computer, type RuntimeId, type RuntimeReasoningEffort } from '../api/client';

const { Text } = Typography;

export interface RuntimeBindingFormValue {
  computerId: string;
  runtimeId: RuntimeId;
  model?: string | null;
  reasoningEffort?: RuntimeReasoningEffort;
  mode?: string | null;
}

export const runtimeOptions: Array<{ value: RuntimeId; label: string; description: string }> = [
  { value: 'codex', label: 'Codex CLI', description: '使用这台计算机上已登录的 Codex CLI' },
  { value: 'claude', label: 'Claude Code', description: '使用这台计算机上已登录的 Claude Code' },
  { value: 'gemini', label: 'Gemini CLI', description: '使用这台计算机上已登录的 Gemini CLI' },
  { value: 'goose', label: 'Goose', description: '使用这台计算机上的 Goose' },
  { value: 'hermes', label: 'Hermes Agent', description: '使用这台计算机上已安装的 Hermes Agent' },
];

export function runtimeLabel(runtimeId: RuntimeId): string {
  return runtimeOptions.find((runtime) => runtime.value === runtimeId)?.label ?? runtimeId;
}

export function computerLoadErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) {
    return '当前服务版本过旧，暂时无法读取本地计算机。请重启后端服务后再试。';
  }
  return errorMessage(error);
}

export function AgentRuntimeFields({ computers, children, onSetupComputer }: {
  computers: Computer[];
  children?: ReactNode;
  onSetupComputer?: () => void;
}) {
  const activeComputers = computers.filter((computer) => computer.status === 'active');
  const bindableComputers = activeComputers.filter((computer) => (
    computer.connectionStatus === 'online'
    && computer.runtimes.some((runtime) => runtime.availability === 'ready')
  ));
  const form = Form.useFormInstance<RuntimeBindingFormValue>();
  const computerId = Form.useWatch('computerId', form);
  const selectedComputer = activeComputers.find((computer) => computer.id === computerId);
  const selectedRuntimeId = Form.useWatch('runtimeId', form);
  const runtimeCatalog = useMemo(() => selectedComputer?.runtimes ?? [], [selectedComputer]);
  const readyRuntimes = useMemo(
    () => runtimeCatalog.filter((runtime) => runtime.availability === 'ready'),
    [runtimeCatalog],
  );
  const selectedRuntime = runtimeCatalog.find((runtime) => runtime.runtimeId === selectedRuntimeId);
  const runtimeConfiguration = selectedRuntime?.configuration ?? null;
  const selectedModel = Form.useWatch('model', form);
  const selectedReasoningEffort = Form.useWatch('reasoningEffort', form);
  const selectedMode = Form.useWatch('mode', form);
  const effectiveModelId = selectedModel ?? runtimeConfiguration?.defaultModelId ?? null;
  const selectedModelCapability = runtimeConfiguration?.models.find((model) => model.id === effectiveModelId);
  const supportedReasoningEfforts = selectedModelCapability?.supportedReasoningEfforts;
  const reasoningOptions = (runtimeConfiguration?.reasoningEfforts ?? []).filter((effort) => (
    effectiveModelId === null
    || (supportedReasoningEfforts !== null
      && supportedReasoningEfforts !== undefined
      && supportedReasoningEfforts.includes(effort.id as Exclude<RuntimeReasoningEffort, null>))
  ));
  const reasoningHelp = !runtimeConfiguration?.reasoningEfforts.length
    ? '本地 Agent 未暴露推理强度。'
    : effectiveModelId !== null && supportedReasoningEfforts === null
      ? `本地 Agent 未声明模型 ${effectiveModelId} 支持哪些推理强度，因此不允许显式选择。`
      : effectiveModelId !== null && supportedReasoningEfforts?.length === 0
        ? `模型 ${effectiveModelId} 不提供推理强度配置。`
        : '只显示当前模型明确支持的推理强度；不支持的组合不会进入本地 Agent 绑定。';

  useEffect(() => {
    if (bindableComputers.some((computer) => computer.id === computerId)) return;
    const fallbackComputerId = bindableComputers[0]?.id;
    if (fallbackComputerId) form.setFieldValue('computerId', fallbackComputerId);
    else if (computerId !== undefined) form.resetFields(['computerId', 'runtimeId']);
  }, [bindableComputers, computerId, form]);

  useEffect(() => {
    if (!selectedComputer) return;
    if (!readyRuntimes.some((runtime) => runtime.runtimeId === selectedRuntimeId)) {
      const fallback = readyRuntimes[0]?.runtimeId;
      if (fallback) form.setFieldValue('runtimeId', fallback);
      else if (selectedRuntimeId !== undefined) form.resetFields(['runtimeId']);
    }
  }, [form, readyRuntimes, selectedComputer, selectedRuntimeId]);

  useEffect(() => {
    if (selectedModel && !runtimeConfiguration?.models.some((model) => model.id === selectedModel)) {
      form.setFieldValue('model', null);
    }
    if (selectedReasoningEffort && !reasoningOptions.some((effort) => effort.id === selectedReasoningEffort)) {
      form.setFieldValue('reasoningEffort', null);
    }
    if (selectedMode && !runtimeConfiguration?.modes.some((mode) => mode.id === selectedMode)) {
      form.setFieldValue('mode', null);
    }
  }, [form, reasoningOptions, runtimeConfiguration, selectedMode, selectedModel, selectedReasoningEffort]);

  return (
    <>
      {!bindableComputers.length && (
        <Alert
          type="warning"
          showIcon
          title={activeComputers.length ? '没有可用于运行 Agent 的计算机' : '还没有添加计算机'}
          description={activeComputers.length
            ? '可以启动已有计算机，或添加另一台已安装并登录本地 Agent 的计算机。'
            : '先添加这台计算机，再连接本机已经安装并登录的本地 Agent。'}
          action={onSetupComputer
            ? <Button size="small" onClick={onSetupComputer}>添加计算机</Button>
            : undefined}
          style={{ marginBottom: 18 }}
        />
      )}
      <Form.Item name="computerId" label="计算机" rules={[{ required: true, message: '请选择运行 Agent 的计算机' }]}>
        <Select
          size="large"
          placeholder="选择已连接的计算机"
          disabled={!bindableComputers.length}
          options={activeComputers.map((computer) => ({
            value: computer.id,
            label: computer.name,
            connectionStatus: computer.connectionStatus,
            disabled: computer.connectionStatus !== 'online'
              || !computer.runtimes.some((runtime) => runtime.availability === 'ready'),
          }))}
          optionRender={(option) => {
            const computer = activeComputers.find((item) => item.id === option.value);
            return (
              <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                <span>{option.label}</span>
                <Tag color={computer?.connectionStatus === 'online' ? 'success' : 'default'}>{computer?.connectionStatus === 'online' ? '在线' : '离线'}</Tag>
                {computer && !computer.runtimes.some((runtime) => runtime.availability === 'ready') && <Text type="secondary">未检测到本地 Agent</Text>}
              </Space>
            );
          }}
        />
      </Form.Item>
      {selectedComputer && (
        <div className="computer-selection-meta">
          <span className={selectedComputer.connectionStatus === 'online' ? 'runtime-status-dot online' : 'runtime-status-dot'} />
          <Text type="secondary">
            {selectedComputer.connectionStatus === 'online'
              ? '在线'
              : '当前离线'}
          </Text>
        </div>
      )}
      {children}
      {selectedComputer && !readyRuntimes.length && (
        <Alert
          type="warning"
          showIcon
          title="这台计算机未检测到本地 Agent"
          description="请先在这台计算机上安装并登录对应的本地 Agent 命令行工具。"
          style={{ marginBottom: 18 }}
        />
      )}
      <Form.Item name="runtimeId" label="本地 Agent" rules={[{ required: true, message: '请选择本地 Agent' }]}>
        <Select
          size="large"
          placeholder="选择本地 Agent"
          disabled={!selectedComputer || !readyRuntimes.length}
          options={readyRuntimes.map((runtime) => ({
            value: runtime.runtimeId,
            label: runtimeLabel(runtime.runtimeId),
            description: runtimeOptions.find((item) => item.value === runtime.runtimeId)?.description ?? runtime.runtimeId,
            detectedVersion: runtime.detectedVersion,
          }))}
          optionRender={(option) => (
            <Space style={{ width: '100%', justifyContent: 'space-between' }}>
              <Space orientation="vertical" size={0}>
                <Text strong>{option.label}</Text>
                <Text type="secondary">{String(option.data.description)}</Text>
              </Space>
              {option.data.detectedVersion && <Text type="secondary">{String(option.data.detectedVersion)}</Text>}
            </Space>
          )}
        />
      </Form.Item>
      {selectedRuntime?.availability === 'ready' && !runtimeConfiguration && (
        <Alert
          type="error"
          showIcon
          title="本地 Agent 能力尚未完成检测"
          description="这台计算机需要重新上报本地 Agent 的模型、推理强度和模式后才能绑定。"
          style={{ marginBottom: 18 }}
        />
      )}
      <Form.Item
        name="model"
        label="模型"
        extra={runtimeConfiguration?.defaultModelId
          ? `留空时使用本地 Agent 当前默认模型：${runtimeConfiguration.defaultModelId}`
          : '留空时使用本地 Agent 当前默认模型。'}
      >
        <Select
          size="large"
          allowClear
          disabled={!runtimeConfiguration?.models.length}
          placeholder={runtimeConfiguration?.models.length ? '使用本地 Agent 默认模型' : '本地 Agent 未暴露模型选择'}
          options={(runtimeConfiguration?.models ?? []).map((model) => ({
            value: model.id,
            label: model.label,
            description: model.description,
          }))}
          optionRender={(option) => (
            <Space orientation="vertical" size={0}>
              <Text strong>{option.label}</Text>
              {option.data.description && <Text type="secondary">{String(option.data.description)}</Text>}
              <Text type="secondary">{String(option.value)}</Text>
            </Space>
          )}
        />
      </Form.Item>
      <Form.Item
        name="reasoningEffort"
        label="推理强度"
        extra={reasoningHelp}
      >
        <Select
          size="large"
          allowClear
          disabled={!reasoningOptions.length}
          placeholder={reasoningOptions.length ? '使用本地 Agent 默认值' : '本地 Agent 未暴露推理强度'}
          options={reasoningOptions.map((option) => ({ value: option.id, label: option.label }))}
        />
      </Form.Item>
      <Form.Item
        name="mode"
        label="运行模式"
        extra={runtimeConfiguration?.defaultModeId
          ? `留空时使用本地 Agent 当前默认模式：${runtimeConfiguration.defaultModeId}`
          : '留空时使用本地 Agent 当前默认模式。'}
      >
        <Select
          size="large"
          allowClear
          disabled={!runtimeConfiguration?.modes.length}
          placeholder={runtimeConfiguration?.modes.length ? '使用本地 Agent 默认模式' : '本地 Agent 未暴露模式选择'}
          options={(runtimeConfiguration?.modes ?? []).map((mode) => ({
            value: mode.id,
            label: mode.label,
          }))}
        />
      </Form.Item>
      <Text type="secondary">
        这里只显示这台计算机已经安装、登录并通过能力检测的本地 Agent。
      </Text>
    </>
  );
}
