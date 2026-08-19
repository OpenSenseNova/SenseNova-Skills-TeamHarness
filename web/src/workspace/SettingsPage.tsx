import { DeleteOutlined, SaveOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Descriptions, Form, Input, Popconfirm, Space, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import { useWorkspace, workspaceKeys } from './workspace-context';

const { Text, Title } = Typography;

export function SettingsPage() {
  const { workspace, members } = useWorkspace();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const ownMembership = members.find((member) => member.membershipId === workspace.membershipId)!;
  const [form] = Form.useForm<{ name: string }>();
  const update = useMutation({
    mutationFn: ({ name }: { name: string }) => api.updateWorkspace(workspace.id, { name, expectedRevision: workspace.revision }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workspaceKeys.bootstrap(workspace.id) }),
        queryClient.invalidateQueries({ queryKey: workspaceKeys.list }),
      ]);
      await message.success('Workspace 名称已更新');
    },
  });
  const leave = useMutation({
    mutationFn: () => api.leaveWorkspace(workspace.id, ownMembership.revision),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: ['workspace', workspace.id] });
      await queryClient.invalidateQueries({ queryKey: workspaceKeys.list });
      navigate('/', { replace: true });
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  return (
    <main className="page-scroll">
      <div className="page-header"><div><Title level={2}>Workspace 设置</Title><Text type="secondary">修改共享资料或管理当前 Membership。</Text></div></div>
      <Space orientation="vertical" size="large" style={{ width: '100%', maxWidth: 760 }}>
        <Card title="基本资料" className="surface-card" variant="borderless">
          <Form form={form} layout="vertical" initialValues={{ name: workspace.name }} onFinish={(value) => update.mutate(value)}>
            <Form.Item name="name" label="Workspace 名称" rules={[{ required: true, max: 120 }]}><Input disabled={workspace.membershipRole !== 'owner'} /></Form.Item>
            {workspace.membershipRole === 'owner' && <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={update.isPending}>保存</Button>}
          </Form>
          {update.error && <Text type="danger">{errorMessage(update.error)}</Text>}
        </Card>
        <Card title="我的 Membership" className="surface-card" variant="borderless">
          <Descriptions column={1} items={[
            { key: 'role', label: '责任角色', children: workspace.membershipRole },
            { key: 'role', label: 'Workspace 角色', children: workspace.membershipRole },
            { key: 'membership', label: 'Membership ID', children: <span className="muted-id">{workspace.membershipId}</span> },
          ]} />
        </Card>
        <Card title="危险操作" className="surface-card" variant="borderless">
          <Space orientation="vertical">
            <Text type="secondary">离开后不会自动恢复原来的 Conversation 访问权；最后一名 Owner 不能离开。</Text>
            <Popconfirm title="确定离开这个 Workspace？" description="此操作会移除当前 Membership。" onConfirm={() => leave.mutate()}>
              <Button danger icon={<DeleteOutlined />} loading={leave.isPending}>离开 Workspace</Button>
            </Popconfirm>
          </Space>
        </Card>
      </Space>
    </main>
  );
}
