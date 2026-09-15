import { DeleteOutlined, SaveOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Descriptions, Form, Input, Popconfirm, Space, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import { ThemeToggleButton } from '../theme';
import { LanguageToggleButton, useLanguage } from '../language';
import { useWorkspace, workspaceKeys } from './workspace-context';

const { Text, Title } = Typography;

export function SettingsPage() {
  const { t } = useLanguage();
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
      await message.success(t('settings.updated'));
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
      <div className="page-header"><div><Text className="page-eyebrow">WORKSPACE</Text><Title level={2}>{t('settings.title')}</Title><Text type="secondary">{t('settings.subtitle')}</Text></div></div>
      <Space orientation="vertical" size="large" style={{ width: '100%', maxWidth: 760 }}>
        <Card title={t('settings.profile')} className="surface-card" variant="borderless">
          <Form form={form} layout="vertical" initialValues={{ name: workspace.name }} onFinish={(value) => update.mutate(value)}>
            <Form.Item name="name" label={t('settings.workspaceName')} rules={[{ required: true, max: 120 }]}><Input disabled={workspace.membershipRole !== 'owner'} /></Form.Item>
            {workspace.membershipRole === 'owner' && <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={update.isPending}>{t('settings.save')}</Button>}
          </Form>
          {update.error && <Text type="danger">{errorMessage(update.error)}</Text>}
        </Card>
        <Card title={t('settings.identity')} className="surface-card" variant="borderless">
          <Descriptions column={1} items={[
            { key: 'role', label: t('settings.role'), children: workspace.membershipRole === 'owner' ? t('settings.owner') : t('settings.member') },
            { key: 'membership', label: t('settings.membershipId'), children: <span className="muted-id">{workspace.membershipId}</span> },
          ]} />
        </Card>
        <Card title={t('settings.appearance')} className="surface-card" variant="borderless">
          <Space align="center" size="middle">
            <span>{t('settings.darkMode')}</span>
            <ThemeToggleButton />
            <span>{t('settings.language')}</span>
            <LanguageToggleButton />
          </Space>
        </Card>
        <Card title={t('settings.danger')} className="surface-card" variant="borderless">
          <Space orientation="vertical">
            <Text type="secondary">{t('settings.leaveHint')}</Text>
            <Popconfirm title={t('settings.leaveConfirm')} description={t('settings.leaveDescription')} onConfirm={() => leave.mutate()}>
              <Button danger icon={<DeleteOutlined />} loading={leave.isPending}>{t('settings.leave')}</Button>
            </Popconfirm>
          </Space>
        </Card>
      </Space>
    </main>
  );
}
