import { Alert, Button, Form, Select, Space, Tag, Typography } from 'antd';
import { useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import { ApiError, errorMessage, type Computer, type RuntimeId, type RuntimeReasoningEffort } from '../api/client';
import { useLanguage } from '../language';

const { Text } = Typography;

export interface RuntimeBindingFormValue {
  computerId: string;
  runtimeId: RuntimeId;
  model?: string | null;
  reasoningEffort?: RuntimeReasoningEffort;
  mode?: string | null;
}

export const runtimeOptions: Array<{ value: RuntimeId; label: string; description: string; descriptionEn: string }> = [
  { value: 'codex', label: 'Codex CLI', description: '使用这台计算机上已登录的 Codex CLI', descriptionEn: 'Use the Codex CLI signed in on this computer' },
  { value: 'claude', label: 'Claude Code', description: '使用这台计算机上已登录的 Claude Code', descriptionEn: 'Use the Claude Code signed in on this computer' },
  { value: 'gemini', label: 'Gemini CLI', description: '使用这台计算机上已登录的 Gemini CLI', descriptionEn: 'Use the Gemini CLI signed in on this computer' },
  { value: 'goose', label: 'Goose', description: '使用这台计算机上的 Goose', descriptionEn: 'Use the Goose on this computer' },
  { value: 'hermes', label: 'Hermes Agent', description: '使用这台计算机上已安装的 Hermes Agent', descriptionEn: 'Use the Hermes Agent installed on this computer' },
];

export function runtimeLabel(runtimeId: RuntimeId): string {
  return runtimeOptions.find((runtime) => runtime.value === runtimeId)?.label ?? runtimeId;
}

export function runtimeDescription(runtimeId: RuntimeId, isEnglish: boolean): string {
  const option = runtimeOptions.find((runtime) => runtime.value === runtimeId);
  if (!option) return runtimeId;
  return isEnglish ? option.descriptionEn : option.description;
}

export function computerLoadErrorMessage(error: unknown, isEnglish: boolean): string {
  if (error instanceof ApiError && error.status === 404) {
    return isEnglish
      ? 'The current service version is too old and cannot read the local computer for now. Please restart the backend service and try again.'
      : '当前服务版本过旧，暂时无法读取本地计算机。请重启后端服务后再试。';
  }
  return errorMessage(error);
}

export function AgentRuntimeFields({ computers, children, onSetupComputer }: {
  computers: Computer[];
  children?: ReactNode;
  onSetupComputer?: () => void;
}) {
  const { isEnglish } = useLanguage();
  const tx = (zh: string, en: string) => isEnglish ? en : zh;
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
    ? tx('本地 Agent 未暴露推理强度。', 'The local Agent does not expose reasoning effort.')
    : effectiveModelId !== null && supportedReasoningEfforts === null
      ? tx(`本地 Agent 未声明模型 ${effectiveModelId} 支持哪些推理强度，因此不允许显式选择。`, `The local Agent does not declare which reasoning efforts model ${effectiveModelId} supports, so explicit selection is not allowed.`)
      : effectiveModelId !== null && supportedReasoningEfforts?.length === 0
        ? tx(`模型 ${effectiveModelId} 不提供推理强度配置。`, `Model ${effectiveModelId} does not offer reasoning effort configuration.`)
        : tx('只显示当前模型明确支持的推理强度；不支持的组合不会进入本地 Agent 绑定。', 'Only reasoning efforts explicitly supported by the current model are shown; unsupported combinations will not be used in the local Agent binding.');

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
          title={activeComputers.length ? tx('没有可用于运行 Agent 的计算机', 'No computer available to run an Agent') : tx('还没有添加计算机', 'No computers added yet')}
          description={activeComputers.length
            ? tx('可以启动已有计算机，或添加另一台已安装并登录本地 Agent 的计算机。', 'Start an existing computer or add another with a local Agent installed and signed in.')
            : tx('先添加这台计算机，再连接本机已经安装并登录的本地 Agent。', 'Add this computer first, then connect a local Agent installed and signed in here.')}
          action={onSetupComputer
            ? <Button size="small" onClick={onSetupComputer}>{tx('添加计算机', 'Add computer')}</Button>
            : undefined}
          style={{ marginBottom: 18 }}
        />
      )}
      <Form.Item name="computerId" label={tx('计算机', 'Computer')} rules={[{ required: true, message: tx('请选择运行 Agent 的计算机', 'Select a computer to run the Agent') }]}>
        <Select
          size="large"
          placeholder={tx('选择已连接的计算机', 'Select a connected computer')}
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
                <Tag color={computer?.connectionStatus === 'online' ? 'success' : 'default'}>{computer?.connectionStatus === 'online' ? tx('在线', 'Online') : tx('离线', 'Offline')}</Tag>
                {computer && !computer.runtimes.some((runtime) => runtime.availability === 'ready') && <Text type="secondary">{tx('未检测到本地 Agent', 'No local Agent detected')}</Text>}
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
              ? tx('在线', 'Online')
              : tx('当前离线', 'Currently offline')}
          </Text>
        </div>
      )}
      {children}
      {selectedComputer && !readyRuntimes.length && (
        <Alert
          type="warning"
          showIcon
          title={tx('这台计算机未检测到本地 Agent', 'No local Agent detected on this computer')}
          description={tx('请先在这台计算机上安装并登录对应的本地 Agent 命令行工具。', 'Install and sign in to the corresponding local Agent CLI on this computer first.')}
          style={{ marginBottom: 18 }}
        />
      )}
      <Form.Item name="runtimeId" label={tx('本地 Agent', 'Local Agent')} rules={[{ required: true, message: tx('请选择本地 Agent', 'Select a local Agent') }]}>
        <Select
          size="large"
          placeholder={tx('选择本地 Agent', 'Select a local Agent')}
          disabled={!selectedComputer || !readyRuntimes.length}
          options={readyRuntimes.map((runtime) => ({
            value: runtime.runtimeId,
            label: runtimeLabel(runtime.runtimeId),
            description: runtimeDescription(runtime.runtimeId, isEnglish),
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
          title={tx('本地 Agent 能力尚未完成检测', 'Local Agent capability detection not finished')}
          description={tx('这台计算机需要重新上报本地 Agent 的模型、推理强度和模式后才能绑定。', 'This computer must re-report the local Agent model, reasoning effort, and mode before it can be bound.')}
          style={{ marginBottom: 18 }}
        />
      )}
      <Form.Item
        name="model"
        label={tx('模型', 'Model')}
        extra={runtimeConfiguration?.defaultModelId
          ? tx(`留空时使用本地 Agent 当前默认模型：${runtimeConfiguration.defaultModelId}`, `Leave blank to use the local Agent's current default model: ${runtimeConfiguration.defaultModelId}`)
          : tx('留空时使用本地 Agent 当前默认模型。', "Leave blank to use the local Agent's current default model.")}
      >
        <Select
          size="large"
          allowClear
          disabled={!runtimeConfiguration?.models.length}
          placeholder={runtimeConfiguration?.models.length ? tx('使用本地 Agent 默认模型', 'Use the local Agent default model') : tx('本地 Agent 未暴露模型选择', 'The local Agent does not expose model selection')}
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
        label={tx('推理强度', 'Reasoning effort')}
        extra={reasoningHelp}
      >
        <Select
          size="large"
          allowClear
          disabled={!reasoningOptions.length}
          placeholder={reasoningOptions.length ? tx('使用本地 Agent 默认值', 'Use the local Agent default') : tx('本地 Agent 未暴露推理强度', 'The local Agent does not expose reasoning effort')}
          options={reasoningOptions.map((option) => ({ value: option.id, label: option.label }))}
        />
      </Form.Item>
      <Form.Item
        name="mode"
        label={tx('运行模式', 'Run mode')}
        extra={runtimeConfiguration?.defaultModeId
          ? tx(`留空时使用本地 Agent 当前默认模式：${runtimeConfiguration.defaultModeId}`, `Leave blank to use the local Agent's current default mode: ${runtimeConfiguration.defaultModeId}`)
          : tx('留空时使用本地 Agent 当前默认模式。', "Leave blank to use the local Agent's current default mode.")}
      >
        <Select
          size="large"
          allowClear
          disabled={!runtimeConfiguration?.modes.length}
          placeholder={runtimeConfiguration?.modes.length ? tx('使用本地 Agent 默认模式', 'Use the local Agent default mode') : tx('本地 Agent 未暴露模式选择', 'The local Agent does not expose mode selection')}
          options={(runtimeConfiguration?.modes ?? []).map((mode) => ({
            value: mode.id,
            label: mode.label,
          }))}
        />
      </Form.Item>
      <Text type="secondary">
        {tx('这里只显示这台计算机已经安装、登录并通过能力检测的本地 Agent。', 'Only local Agents on this computer that are installed, signed in, and passed capability detection are shown here.')}
      </Text>
    </>
  );
}
