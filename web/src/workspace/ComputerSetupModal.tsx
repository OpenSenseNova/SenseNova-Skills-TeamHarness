import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Form, Input, Modal, Typography } from 'antd';
import { useState } from 'react';
import { api, errorMessage, type ComputerRegistration } from '../api/client';
import { workspaceKeys } from './workspace-context';
import { useLanguage } from '../language';

const { Paragraph, Text } = Typography;

export function ComputerSetupModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form] = Form.useForm<{ name: string }>();
  const [registration, setRegistration] = useState<ComputerRegistration | null>(null);
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const { isEnglish } = useLanguage();
  const copy = (zh: string, en: string) => isEnglish ? en : zh;
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
    void message.success(copy('已刷新计算机状态', 'Computer status refreshed'));
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
      title={registration ? copy('连接本地计算机', 'Connect local computer') : copy('添加本地计算机', 'Add local computer')}
      open={open}
      okText={registration ? copy('我已启动，刷新状态', 'I started it, refresh status') : copy('继续', 'Continue')}
      cancelText={copy('取消', 'Cancel')}
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
            title={copy('连接凭据只显示这一次', 'Connection credentials are shown only once')}
            description={copy('本地计算机是独立客户端。安装一次后，可以在这台计算机的任意目录启动。', 'The local computer is a standalone client. After one installation, you can start it from any directory on this computer.')}
            style={{ marginBottom: 18 }}
          />
          <Text type="secondary">{copy('首次安装', 'First installation')}</Text>
          <Paragraph code copyable={{ text: installCommand }} className="computer-setup-command">
            {installCommand}
          </Paragraph>
          <Text type="secondary">{copy('保存连接并启动客户端', 'Save the connection and start the client')}</Text>
          <Paragraph code copyable={{ text: command }} className="computer-setup-command">{command}</Paragraph>
          <Text type="secondary">{copy('连接成功后，页面会自动显示这台计算机已检测到的本地 Agent。', 'After connecting, this page will show local Agents detected on this computer.')}</Text>
        </>
      ) : (
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label={copy('本地计算机名称', 'Local computer name')}
            rules={[{ required: true, whitespace: true, max: 120, message: copy('请输入计算机名称', 'Enter a computer name') }]}
          >
            <Input autoFocus placeholder={copy('例如：我的 Mac', 'For example: My Mac')} />
          </Form.Item>
          <Text type="secondary">{copy('添加后，请在这台计算机上启动客户端，系统才能检测 Codex CLI 等本地 Agent。', 'After adding it, start the client on this computer so the system can detect local Agents such as Codex CLI.')}</Text>
        </Form>
      )}
      {register.error && <Alert type="error" showIcon title={errorMessage(register.error)} style={{ marginTop: 18 }} />}
    </Modal>
  );
}
