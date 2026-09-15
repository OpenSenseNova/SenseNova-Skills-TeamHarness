import { CopyOutlined, LinkOutlined, MessageOutlined, StopOutlined, UserDeleteOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Input, Modal, Popconfirm, Space, Table, Tabs, Tag, Typography } from 'antd';
import { useState } from 'react';
import { api, errorMessage, type Member, type WorkspaceJoinLink } from '../api/client';
import { copyText } from '../lib/clipboard';
import { loadAllPages } from '../lib/pagination';
import { useLanguage } from '../language';
import { useWorkspace, workspaceKeys } from './workspace-context';

const { Text, Title } = Typography;

function actorLabel(actorType: Member['actorType'], isEnglish = false): string {
  return actorType === 'agent' ? 'Agent' : (isEnglish ? 'Member' : '成员');
}

function membershipRoleLabel(role: Member['membershipRole'], isEnglish = false): string {
  return role === 'owner' ? (isEnglish ? 'Owner' : '所有者') : (isEnglish ? 'Member' : '成员');
}

export function MembersPage() {
  const { workspace, members, openDirectMessage, openingDirectMessageMembershipId } = useWorkspace();
  const { isEnglish } = useLanguage();
  const tx = (zh: string, en: string) => isEnglish ? en : zh;
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const owner = workspace.membershipRole === 'owner';
  const [generatedJoinUrl, setGeneratedJoinUrl] = useState<string | null>(null);
  const joinLinks = useQuery({
    queryKey: workspaceKeys.joinLinks(workspace.id),
    queryFn: () => loadAllPages((cursor) => api.listWorkspaceJoinLinks(workspace.id, cursor)),
  });
  const refreshMembers = () => queryClient.invalidateQueries({ queryKey: workspaceKeys.members(workspace.id) });
  const refreshJoinLinks = () => queryClient.invalidateQueries({ queryKey: workspaceKeys.joinLinks(workspace.id) });
  const copyJoinLink = async (link: string) => {
    if (await copyText(link)) {
      void message.success(tx('Workspace 邀请链接已复制', 'Workspace invite link copied'));
      return;
    }
    void message.warning(tx('浏览器未允许自动复制，请在弹窗中手动复制链接。', 'Automatic copy is unavailable. Copy the link manually from the dialog.'));
  };

  const createJoinLink = useMutation({
    mutationFn: () => api.createWorkspaceJoinLink(workspace.id),
    onSuccess: async (created) => {
      const link = `${window.location.origin}/join/${created.token}`;
      setGeneratedJoinUrl(link);
      await copyJoinLink(link);
      await refreshJoinLinks();
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const remove = useMutation({
    mutationFn: (member: Member) => api.removeMember(workspace.id, member.membershipId, member.revision),
    onSuccess: async () => { await refreshMembers(); },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const revokeJoinLink = useMutation({
    mutationFn: (item: WorkspaceJoinLink) => api.revokeWorkspaceJoinLink(item.id, item.revision),
    onSuccess: async () => { await refreshJoinLinks(); },
    onError: (error) => void message.error(errorMessage(error)),
  });

  const memberTable = (
    <Card className="surface-card" variant="borderless">
      <Table<Member>
        rowKey="membershipId"
        dataSource={members}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        columns={[
          { title: tx('成员', 'Member'), dataIndex: 'displayName', render: (name, item) => <Space><Text strong>{name}</Text><Tag>{item.actorType === 'agent' ? 'Agent' : tx('成员', 'Member')}</Tag>{item.membershipId === workspace.membershipId && <Tag color="blue">{tx('你', 'You')}</Tag>}</Space> },
          { title: tx('Workspace 角色', 'Workspace role'), dataIndex: 'membershipRole', width: 140, render: (value) => <Tag color={value === 'owner' ? 'gold' : 'default'}>{membershipRoleLabel(value, isEnglish)}</Tag> },
          {
            title: tx('操作', 'Actions'), width: 210,
            render: (_, item) => (
              <div className="table-actions">
                {item.membershipId !== workspace.membershipId && <Button type="link" icon={<MessageOutlined />} loading={openingDirectMessageMembershipId === item.membershipId} onClick={() => void openDirectMessage(item.membershipId)}>{tx('私聊', 'Chat')}</Button>}
                {owner && item.actorType === 'human' && item.membershipId !== workspace.membershipId && (
                    <Popconfirm title={tx('移除后不会恢复原会话访问权，确定继续？', 'Removing will not restore conversation access. Continue?')} onConfirm={() => remove.mutate(item)}>
                      <Button type="link" danger icon={<UserDeleteOutlined />}>{tx('移除', 'Remove')}</Button>
                    </Popconfirm>
                  )}
              </div>
            ),
          },
        ]}
      />
    </Card>
  );

  const joinLinkTable = (
    <Card className="surface-card" variant="borderless">
      <Alert
        type="info"
        showIcon
        title={tx('有效邀请链接对所有 Workspace 成员可见', 'Active invite links are visible to all Workspace members')}
        description={owner
          ? tx('你可以创建、复制和停用链接；任何拿到有效链接并登录的用户都可以确认加入，加入后固定为 member。', 'You can create, copy, and deactivate links. Anyone with a valid link can join as a member after signing in.')
          : tx('你可以查看和分享 Owner 创建的有效链接；只有 Workspace Owner 可以创建或停用链接。', 'You can view and share links created by the Owner. Only the Workspace Owner can create or deactivate links.')}
        style={{ marginBottom: 16 }}
      />
      <Table<WorkspaceJoinLink>
        rowKey="id"
        loading={joinLinks.isPending}
        dataSource={joinLinks.data ?? []}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        columns={[
          { title: tx('创建时间', 'Created'), dataIndex: 'createdAt', render: (value: number) => new Date(value).toLocaleString(isEnglish ? 'en-US' : 'zh-CN') },
          { title: tx('已加入', 'Joined'), dataIndex: 'useCount', width: 100, render: (value: number) => `${value} ${tx('人', 'people')}` },
          { title: tx('状态', 'Status'), dataIndex: 'status', width: 110, render: (value) => <Tag color={value === 'active' ? 'processing' : 'default'}>{value === 'active' ? tx('有效', 'Active') : tx('已停用', 'Inactive')}</Tag> },
          {
            title: tx('操作', 'Actions'), width: owner ? 220 : 120,
            render: (_, item) => (
              <div className="table-actions">
                {item.status === 'active' && item.token && (
                  <Button
                    type="link"
                    icon={<CopyOutlined />}
                    onClick={() => void copyJoinLink(`${window.location.origin}/join/${item.token}`)}
                  >
                    {tx('复制链接', 'Copy link')}
                  </Button>
                )}
                {owner && item.status === 'active' && (
                  <Popconfirm title={tx('停用后，已经分享出去的这个链接将立即失效。', 'This shared link will stop working immediately.')} onConfirm={() => revokeJoinLink.mutate(item)}>
                    <Button type="link" danger icon={<StopOutlined />}>{tx('停用', 'Deactivate')}</Button>
                  </Popconfirm>
                )}
              </div>
            ),
          },
        ]}
        locale={{ emptyText: tx('还没有创建过邀请链接', 'No invite links created yet') }}
      />
    </Card>
  );

  return (
    <main className="page-scroll">
      <div className="page-header">
        <div><Text className="page-eyebrow">WORKSPACE</Text><Title level={2}>{tx('成员与邀请', 'Members and invites')}</Title><Text type="secondary">{tx('邀请成员加入 Workspace，一起参与会话、项目和 Agent 协作。', 'Invite members to collaborate across conversations, projects, and Agents.')}</Text></div>
        {owner && (
          <Button type="primary" icon={<LinkOutlined />} loading={createJoinLink.isPending} onClick={() => createJoinLink.mutate()}>
            {tx('创建并复制邀请链接', 'Create and copy invite link')}
          </Button>
        )}
      </div>
      <Tabs items={[{ key: 'members', label: `${tx('成员', 'Members')} ${members.length}`, children: memberTable }, { key: 'join-links', label: tx('邀请链接', 'Invite links'), children: joinLinkTable }]} />
      <Modal
        title={tx('分享 Workspace', 'Share Workspace')}
        open={Boolean(generatedJoinUrl)}
        onCancel={() => setGeneratedJoinUrl(null)}
        footer={[
          <Button key="close" onClick={() => setGeneratedJoinUrl(null)}>{tx('完成', 'Done')}</Button>,
          <Button
            key="copy"
            type="primary"
            icon={<CopyOutlined />}
            onClick={() => {
              if (generatedJoinUrl) void copyJoinLink(generatedJoinUrl);
            }}
          >
            {tx('复制链接', 'Copy link')}
          </Button>,
        ]}
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Text>{tx(`把下面的链接发给要加入的人。对方登录后确认一次，就会直接进入 ${workspace.name}。`, `Send the link below to whoever should join. After they sign in and confirm once, they go straight into ${workspace.name}.`)}</Text>
          <Input.TextArea
            aria-label={tx('邀请链接', 'Invite link')}
            value={generatedJoinUrl ?? ''}
            readOnly
            autoSize
            onFocus={(event) => event.currentTarget.select()}
          />
          <Text type="secondary">
            {tx('有效链接会继续显示在“邀请链接”列表中，所有 Workspace 成员都可以复制；只有 Owner 可以停用。', 'Active links stay in the “Invite links” list where any Workspace member can copy them; only the Owner can deactivate them.')}
          </Text>
        </Space>
      </Modal>
    </main>
  );
}
