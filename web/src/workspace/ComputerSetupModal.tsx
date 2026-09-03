import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Form, Input, Modal, Typography } from 'antd';
import { useState } from 'react';
import { api, errorMessage, type ComputerRegistration } from '../api/client';
import { workspaceKeys } from './workspace-context';

const { Paragraph, Text } = Typography;

export function ComputerSetupModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form] = Form.useForm<{ name: string }>();
  const [registration, setRegistration] = useState<ComputerRegistration | null>(null);
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const register = useMutation({
    mutationFn: ({ name }: { name: string }) => api.createComputer(name.trim()),
    onSuccess: (created) => setRegistration(created),
  });
  const serverUrl = window.location.origin;
  const installCommand = `npm install --global '${serverUrl}/downloads/anc-local-computer.tgz'`;
  const command = registration
    ? `anc-computer connect --server '${serverUrl}' --token '${registration.token}'\nanc-computer run`
    : '';

  const finish = async () => {
    await queryClient.invalidateQueries({ queryKey: workspaceKeys.computers });
    void message.success('已刷新计算机状态');
    setRegistration(null);
    register.reset();
    form.resetFields();
    onClose();
  };
  const close = () => {
    if (register.isPending) return;
    setRegistration(null);
    register.reset();
    form.resetFields();
    onClose();
  };

  return (
    <Modal
      title={registration ? '连接本地计算机' : '添加本地计算机'}
      open={open}
      okText={registration ? '我已启动，刷新状态' : '继续'}
      cancelText="取消"
      confirmLoading={register.isPending}
      onCancel={close}
      onOk={() => registration
        ? void finish()
        : void form.validateFields().then((value) => register.mutate(value))}
    >
      {registration ? (
        <>
          <Alert
            type="info"
            showIcon
            title="连接凭据只显示这一次"
            description="本地计算机是独立客户端。安装一次后，可以在这台计算机的任意目录启动。"
            style={{ marginBottom: 18 }}
          />
          <Text type="secondary">首次安装</Text>
          <Paragraph code copyable={{ text: installCommand }} className="computer-setup-command">
            {installCommand}
          </Paragraph>
          <Text type="secondary">保存连接并启动客户端</Text>
          <Paragraph code copyable={{ text: command }} className="computer-setup-command">{command}</Paragraph>
          <Text type="secondary">连接成功后，页面会自动显示这台计算机已检测到的本地 Agent。</Text>
        </>
      ) : (
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label="本地计算机名称"
            rules={[{ required: true, whitespace: true, max: 120, message: '请输入计算机名称' }]}
          >
            <Input autoFocus placeholder="例如：我的 Mac" />
          </Form.Item>
          <Text type="secondary">添加后，请在这台计算机上启动客户端，系统才能检测 Codex CLI 等本地 Agent。</Text>
        </Form>
      )}
      {register.error && <Alert type="error" showIcon title={errorMessage(register.error)} style={{ marginTop: 18 }} />}
    </Modal>
  );
}
