import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Form, Input, Modal, Spin } from 'antd';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import { AgentRuntimeFields, computerLoadErrorMessage, type RuntimeBindingFormValue } from './AgentRuntimeFields';
import { ComputerSetupModal } from './ComputerSetupModal';
import { workspaceKeys } from './workspace-context';
import { useLanguage } from '../language';

interface AgentCreateValue extends RuntimeBindingFormValue {
  name: string;
  description?: string;
}

export function AgentCreateModal({ workspaceId, open, onClose }: {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [form] = Form.useForm<AgentCreateValue>();
  const [computerSetupOpen, setComputerSetupOpen] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const { isEnglish } = useLanguage();
  const tx = (zh: string, en: string) => isEnglish ? en : zh;
  const computers = useQuery({
    queryKey: workspaceKeys.computers,
    queryFn: () => api.listComputers().then((page) => page.items),
    enabled: open,
    refetchInterval: open ? 10_000 : false,
  });
  const bindableComputers = (computers.data ?? []).filter((computer) => (
    computer.status === 'active'
    && computer.connectionStatus === 'online'
    && computer.runtimes.some((runtime) => runtime.availability === 'ready')
  ));

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      computerId: form.getFieldValue('computerId') ?? bindableComputers[0]?.id,
    });
  }, [bindableComputers, form, open]);

  const create = useMutation({
    mutationFn: (value: AgentCreateValue) => api.createAgent(workspaceId, {
      name: value.name.trim(),
      ...(value.description?.trim() ? { description: value.description.trim() } : {}),
      runtimeBinding: {
        computerId: value.computerId,
        runtimeId: value.runtimeId,
        model: value.model?.trim() || null,
        reasoningEffort: value.reasoningEffort ?? null,
        mode: value.mode?.trim() || null,
      },
    }),
    onSuccess: async (agent) => {
      form.resetFields();
      onClose();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workspaceKeys.agents(workspaceId) }),
        queryClient.invalidateQueries({ queryKey: workspaceKeys.members(workspaceId) }),
      ]);
      queryClient.setQueryData(workspaceKeys.agent(workspaceId, agent.id), agent);
      void message.success(tx('Agent 已创建，并已连接本地运行环境', 'Agent created and connected to the local runtime'));
      navigate(`/w/${workspaceId}/agents/${agent.id}`);
    },
  });

  const close = () => {
    if (create.isPending) return;
    create.reset();
    form.resetFields();
    onClose();
  };

  return (
    <Modal
      className="agent-create-modal"
      title={tx('创建 Agent', 'Create Agent')}
      open={open}
      width={600}
      okText={tx('创建 Agent', 'Create Agent')}
      cancelText={tx('取消', 'Cancel')}
      confirmLoading={create.isPending}
      okButtonProps={{ disabled: computers.isPending || !bindableComputers.length }}
      onCancel={close}
      onOk={() => void form.validateFields().then((value) => create.mutate(value))}
    >
      <Form form={form} layout="vertical" requiredMark="optional">
        {computers.isPending ? (
          <div className="modal-loading"><Spin /></div>
        ) : computers.isError ? (
          <Alert
            type="error"
            showIcon
            title={tx('暂时无法创建 Agent', 'Unable to create Agent right now')}
            description={computerLoadErrorMessage(computers.error, isEnglish)}
          />
        ) : (
          <AgentRuntimeFields computers={computers.data ?? []} onSetupComputer={() => setComputerSetupOpen(true)}>
            <Form.Item name="name" label={tx('名称', 'Name')} required rules={[{ required: true, max: 120, whitespace: true }]}>
              <Input size="large" placeholder={tx('例如 Alice', 'For example: Alice')} autoFocus />
            </Form.Item>
            <Form.Item name="description" label={tx('描述', 'Description')} rules={[{ max: 2000 }]}>
              <Input.TextArea
                rows={4}
                maxLength={2000}
                showCount
              placeholder={tx('例如：负责整理资料、跟进任务或生成周报', 'For example: organize research, track tasks, or prepare weekly reports')}
              />
            </Form.Item>
          </AgentRuntimeFields>
        )}
      </Form>
      {create.error && <Alert type="error" showIcon title={errorMessage(create.error)} />}
      <ComputerSetupModal open={computerSetupOpen} onClose={() => setComputerSetupOpen(false)} />
    </Modal>
  );
}
