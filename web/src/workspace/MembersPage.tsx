import { CopyOutlined, EditOutlined, MailOutlined, MessageOutlined, PlusOutlined, StopOutlined, UserDeleteOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Table, Tabs, Tag, Typography } from 'antd';
import { useState } from 'react';
import { api, errorMessage, type Invitation, type Member } from '../api/client';
import { useWorkspace, workspaceKeys } from './workspace-context';

const { Text, Title } = Typography;

export function MembersPage() {
  const { workspace, members, openDirectMessage, openingDirectMessageMembershipId } = useWorkspace();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const owner = workspace.membershipRole === 'owner';
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);
  const [inviteForm] = Form.useForm<{ verifiedEmail: string; membershipRole: 'owner' | 'member' }>();
  const [editForm] = Form.useForm<{ membershipRole: 'owner' | 'member' }>();
  const invitations = useQuery({
    queryKey: workspaceKeys.invitations(workspace.id),
    queryFn: async () => {
      const items: Invitation[] = [];
      let cursor: string | undefined;
      do {
        const page = await api.listInvitations(workspace.id, cursor);
        items.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return items;
    },
    enabled: owner,
  });
  const refreshMembers = () => queryClient.invalidateQueries({ queryKey: workspaceKeys.members(workspace.id) });
  const refreshInvitations = () => queryClient.invalidateQueries({ queryKey: workspaceKeys.invitations(workspace.id) });

  const invite = useMutation({
    mutationFn: (value: { verifiedEmail: string; membershipRole: 'owner' | 'member' }) =>
      api.createInvitation(workspace.id, value),
    onSuccess: async (created) => {
      setInviteOpen(false);
      inviteForm.resetFields();
      await refreshInvitations();
      const link = `${window.location.origin}/invitations/${created.id}?revision=${created.revision}`;
      await navigator.clipboard.writeText(link);
      await message.success('邀请已创建，接受链接已复制');
    },
  });
  const update = useMutation({
    mutationFn: (value: { membershipRole: 'owner' | 'member' }) =>
      api.updateMember(workspace.id, editing!.membershipId, { ...value, expectedRevision: editing!.revision }),
    onSuccess: async () => {
      setEditing(null);
      await refreshMembers();
      await queryClient.invalidateQueries({ queryKey: workspaceKeys.bootstrap(workspace.id) });
    },
  });
  const remove = useMutation({
    mutationFn: (member: Member) => api.removeMember(workspace.id, member.membershipId, member.revision),
    onSuccess: async () => { await refreshMembers(); },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const revoke = useMutation({
    mutationFn: (item: Invitation) => api.revokeInvitation(item.id, item.revision),
    onSuccess: async () => { await refreshInvitations(); },
    onError: (error) => void message.error(errorMessage(error)),
  });

  const memberTable = (
    <Card className="surface-card" variant="borderless">
      <Table<Member>
        rowKey="membershipId"
        dataSource={members}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        columns={[
          { title: '成员', dataIndex: 'displayName', render: (name, item) => <Space><Text strong>{name}</Text><Tag>{item.actorType}</Tag>{item.membershipId === workspace.membershipId && <Tag color="blue">你</Tag>}</Space> },
          { title: 'Workspace 角色', dataIndex: 'membershipRole', width: 140, render: (value) => <Tag color={value === 'owner' ? 'gold' : 'default'}>{value}</Tag> },
          {
            title: '操作', width: 210,
            render: (_, item) => (
              <div className="table-actions">
                {item.membershipId !== workspace.membershipId && <Button type="link" icon={<MessageOutlined />} loading={openingDirectMessageMembershipId === item.membershipId} onClick={() => void openDirectMessage(item.membershipId)}>私聊</Button>}
                {owner && item.actorType === 'human' && <Button type="link" icon={<EditOutlined />} onClick={() => { setEditing(item); editForm.setFieldsValue({ membershipRole: item.membershipRole }); }}>修改</Button>}
                {owner && item.actorType === 'human' && item.membershipId !== workspace.membershipId && (
                    <Popconfirm title="移除后不会恢复原 Conversation 访问权，确定继续？" onConfirm={() => remove.mutate(item)}>
                      <Button type="link" danger icon={<UserDeleteOutlined />}>移除</Button>
                    </Popconfirm>
                  )}
              </div>
            ),
          },
        ]}
      />
    </Card>
  );

  const invitationTable = owner ? (
    <Card className="surface-card" variant="borderless">
      <Table<Invitation>
        rowKey="id"
        loading={invitations.isPending}
        dataSource={invitations.data ?? []}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        columns={[
          { title: '邮箱', dataIndex: 'verifiedEmail' },
          { title: 'Workspace 角色', dataIndex: 'membershipRole', width: 140 },
          { title: '状态', dataIndex: 'status', width: 110, render: (value) => <Tag color={value === 'pending' ? 'processing' : value === 'accepted' ? 'success' : 'default'}>{value}</Tag> },
          {
            title: '操作', width: 220,
            render: (_, item) => (
              <div className="table-actions">
                {item.status === 'pending' && <Button type="link" icon={<CopyOutlined />} onClick={async () => {
                  await navigator.clipboard.writeText(`${window.location.origin}/invitations/${item.id}?revision=${item.revision}`);
                  await message.success('邀请链接已复制');
                }}>复制链接</Button>}
                {item.status === 'pending' && <Popconfirm title="撤销这个邀请？" onConfirm={() => revoke.mutate(item)}><Button type="link" danger icon={<StopOutlined />}>撤销</Button></Popconfirm>}
              </div>
            ),
          },
        ]}
      />
    </Card>
  ) : <Card><Text type="secondary">只有 Workspace Owner 可以查看和管理邀请。</Text></Card>;

  return (
    <main className="page-scroll">
      <div className="page-header">
        <div><Title level={2}>成员与邀请</Title><Text type="secondary">Workspace 只使用 owner/member 两种治理角色。</Text></div>
        {owner && <Button type="primary" icon={<PlusOutlined />} onClick={() => setInviteOpen(true)}>邀请 Human</Button>}
      </div>
      <Tabs items={[{ key: 'members', label: `成员 ${members.length}`, children: memberTable }, { key: 'invitations', label: '邀请', children: invitationTable }]} />
      <Modal title="邀请 Human" open={inviteOpen} okText="创建并复制链接" confirmLoading={invite.isPending} onCancel={() => setInviteOpen(false)} onOk={() => void inviteForm.validateFields().then((value) => invite.mutate(value))}>
        <Form form={inviteForm} layout="vertical" initialValues={{ membershipRole: 'member' }}>
          <Form.Item name="verifiedEmail" label="已验证邮箱" rules={[{ required: true }, { type: 'email' }]}><Input prefix={<MailOutlined />} /></Form.Item>
          <Form.Item name="membershipRole" label="责任角色"><Select options={[{ value: 'owner', label: 'owner' }, { value: 'member', label: 'member' }]} /></Form.Item>
        </Form>
        {invite.error && <Text type="danger">{errorMessage(invite.error)}</Text>}
      </Modal>
      <Modal title={`修改 ${editing?.displayName ?? ''}`} open={Boolean(editing)} okText="保存" confirmLoading={update.isPending} onCancel={() => setEditing(null)} onOk={() => void editForm.validateFields().then((value) => update.mutate(value))}>
        <Form form={editForm} layout="vertical">
          <Form.Item name="membershipRole" label="责任角色"><Select options={[{ value: 'owner', label: 'owner' }, { value: 'member', label: 'member' }]} /></Form.Item>
        </Form>
        {update.error && <Text type="danger">{errorMessage(update.error)}</Text>}
      </Modal>
    </main>
  );
}
