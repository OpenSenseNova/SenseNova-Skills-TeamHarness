import { CopyOutlined, LinkOutlined, MessageOutlined, StopOutlined, UserDeleteOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Input, Modal, Popconfirm, Space, Table, Tabs, Tag, Typography } from 'antd';
import { useState } from 'react';
import { api, errorMessage, type Member, type WorkspaceJoinLink } from '../api/client';
import { copyText } from '../lib/clipboard';
import { loadAllPages } from '../lib/pagination';
import { useWorkspace, workspaceKeys } from './workspace-context';

const { Text, Title } = Typography;

function actorLabel(actorType: Member['actorType']): string {
  return actorType === 'agent' ? 'Agent' : '成员';
}

function membershipRoleLabel(role: Member['membershipRole']): string {
  return role === 'owner' ? '所有者' : '成员';
}

export function MembersPage() {
  const { workspace, members, openDirectMessage, openingDirectMessageMembershipId } = useWorkspace();
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
      void message.success('Workspace 邀请链接已复制');
      return;
    }
    void message.warning('浏览器未允许自动复制，请在弹窗中手动复制链接。');
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
          { title: '成员', dataIndex: 'displayName', render: (name, item) => <Space><Text strong>{name}</Text><Tag>{actorLabel(item.actorType)}</Tag>{item.membershipId === workspace.membershipId && <Tag color="blue">你</Tag>}</Space> },
          { title: 'Workspace 角色', dataIndex: 'membershipRole', width: 140, render: (value) => <Tag color={value === 'owner' ? 'gold' : 'default'}>{membershipRoleLabel(value)}</Tag> },
          {
            title: '操作', width: 210,
            render: (_, item) => (
              <div className="table-actions">
                {item.membershipId !== workspace.membershipId && <Button type="link" icon={<MessageOutlined />} loading={openingDirectMessageMembershipId === item.membershipId} onClick={() => void openDirectMessage(item.membershipId)}>私聊</Button>}
                {owner && item.actorType === 'human' && item.membershipId !== workspace.membershipId && (
                    <Popconfirm title="移除后不会恢复原会话访问权，确定继续？" onConfirm={() => remove.mutate(item)}>
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

  const joinLinkTable = (
    <Card className="surface-card" variant="borderless">
      <Alert
        type="info"
        showIcon
        title="有效邀请链接对所有 Workspace 成员可见"
        description={owner
          ? '你可以创建、复制和停用链接；任何拿到有效链接并登录的用户都可以确认加入，加入后固定为 member。'
          : '你可以查看和分享 Owner 创建的有效链接；只有 Workspace Owner 可以创建或停用链接。'}
        style={{ marginBottom: 16 }}
      />
      <Table<WorkspaceJoinLink>
        rowKey="id"
        loading={joinLinks.isPending}
        dataSource={joinLinks.data ?? []}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        columns={[
          { title: '创建时间', dataIndex: 'createdAt', render: (value: number) => new Date(value).toLocaleString() },
          { title: '已加入', dataIndex: 'useCount', width: 100, render: (value: number) => `${value} 人` },
          { title: '状态', dataIndex: 'status', width: 110, render: (value) => <Tag color={value === 'active' ? 'processing' : 'default'}>{value === 'active' ? '有效' : '已停用'}</Tag> },
          {
            title: '操作', width: owner ? 220 : 120,
            render: (_, item) => (
              <div className="table-actions">
                {item.status === 'active' && item.token && (
                  <Button
                    type="link"
                    icon={<CopyOutlined />}
                    onClick={() => void copyJoinLink(`${window.location.origin}/join/${item.token}`)}
                  >
                    复制链接
                  </Button>
                )}
                {owner && item.status === 'active' && (
                  <Popconfirm title="停用后，已经分享出去的这个链接将立即失效。" onConfirm={() => revokeJoinLink.mutate(item)}>
                    <Button type="link" danger icon={<StopOutlined />}>停用</Button>
                  </Popconfirm>
                )}
              </div>
            ),
          },
        ]}
        locale={{ emptyText: '还没有创建过邀请链接' }}
      />
    </Card>
  );

  return (
    <main className="page-scroll">
      <div className="page-header">
        <div><Text className="page-eyebrow">WORKSPACE</Text><Title level={2}>成员与邀请</Title><Text type="secondary">邀请成员加入 Workspace，一起参与会话、项目和 Agent 协作。</Text></div>
        {owner && (
          <Button type="primary" icon={<LinkOutlined />} loading={createJoinLink.isPending} onClick={() => createJoinLink.mutate()}>
            创建并复制邀请链接
          </Button>
        )}
      </div>
      <Tabs items={[{ key: 'members', label: `成员 ${members.length}`, children: memberTable }, { key: 'join-links', label: '邀请链接', children: joinLinkTable }]} />
      <Modal
        title="分享 Workspace"
        open={Boolean(generatedJoinUrl)}
        onCancel={() => setGeneratedJoinUrl(null)}
        footer={[
          <Button key="close" onClick={() => setGeneratedJoinUrl(null)}>完成</Button>,
          <Button
            key="copy"
            type="primary"
            icon={<CopyOutlined />}
            onClick={() => {
              if (generatedJoinUrl) void copyJoinLink(generatedJoinUrl);
            }}
          >
            复制链接
          </Button>,
        ]}
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Text>把下面的链接发给要加入的人。对方登录后确认一次，就会直接进入 {workspace.name}。</Text>
          <Input.TextArea
            aria-label="邀请链接"
            value={generatedJoinUrl ?? ''}
            readOnly
            autoSize
            onFocus={(event) => event.currentTarget.select()}
          />
          <Text type="secondary">
            有效链接会继续显示在“邀请链接”列表中，所有 Workspace 成员都可以复制；只有 Owner 可以停用。
          </Text>
        </Space>
      </Modal>
    </main>
  );
}
