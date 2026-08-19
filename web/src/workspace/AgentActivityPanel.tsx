import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  MessageOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Empty, Spin, Tag, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import {
  api,
  errorMessage,
  type Agent,
  type AgentRequest,
  type Conversation,
  type Project,
  type WorkspaceMessage,
} from '../api/client';

const { Paragraph, Text } = Typography;
const dateTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });

interface ActivityItem {
  conversation: Conversation;
  request: AgentRequest;
  messages: WorkspaceMessage[];
}

interface ActivityPresentation {
  icon: React.ReactNode;
  label: string;
  title: string;
  description: string;
  tone: 'waiting' | 'running' | 'success' | 'failed' | 'neutral';
}

async function loadProjectConversations(projectId: string): Promise<Conversation[]> {
  const conversations: Conversation[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.listProjectConversations(projectId, cursor);
    conversations.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return conversations;
}

function conversationLabel(conversation: Conversation): string {
  if (conversation.kind === 'dm') return '私信';
  return conversation.title ? `#${conversation.title}` : '频道';
}

function requestPresentation(request: AgentRequest, messageCount: number): ActivityPresentation {
  if (request.status === 'cancelled') {
    return {
      icon: <CloseCircleOutlined />,
      label: '已取消',
      title: '请求已取消',
      description: '这次请求没有继续交给 Runtime 执行。',
      tone: 'neutral',
    };
  }
  if (request.status === 'rejected') {
    return {
      icon: <CloseCircleOutlined />,
      label: '未执行',
      title: '请求未被执行',
      description: request.terminalReason?.detail || 'Runtime 没有接受这次请求。',
      tone: 'failed',
    };
  }
  if (request.run?.status === 'terminal') {
    if (request.run.outcome === 'publish') {
      return {
        icon: <CheckCircleOutlined />,
        label: '已完成',
        title: messageCount ? `已向 Conversation 返回 ${messageCount} 条消息` : 'ACP 已完成返回',
        description: messageCount ? '返回内容已作为普通 Agent 消息写入 Conversation。' : '执行已结束，正在等待返回消息同步。',
        tone: 'success',
      };
    }
    if (request.run.outcome === 'no_output') {
      return {
        icon: <CheckCircleOutlined />,
        label: '已完成',
        title: '运行完成，没有返回消息',
        description: '这次 ACP 执行正常结束，但没有向 Conversation 写入内容。',
        tone: 'neutral',
      };
    }
    if (request.run.outcome === 'failed') {
      return {
        icon: <CloseCircleOutlined />,
        label: '失败',
        title: 'ACP 执行失败',
        description: request.run.attempt?.failureReason?.message || 'Runtime 未提供可展示的失败原因。',
        tone: 'failed',
      };
    }
    return {
      icon: <CloseCircleOutlined />,
      label: '未发布',
      title: '运行结束，结果未发布',
      description: request.run.outcome === 'cancelled' ? '运行已取消。' : '返回结果没有写入 Conversation。',
      tone: 'neutral',
    };
  }
  if (request.run?.status === 'active') {
    return {
      icon: <SyncOutlined spin />,
      label: '执行中',
      title: request.run.attempt?.status === 'running' ? 'ACP 正在执行' : 'Runtime 已接受请求',
      description: request.run.attempt?.status === 'running' ? '正在等待 Runtime 返回执行结果。' : '正在等待 ACP Attempt 启动。',
      tone: 'running',
    };
  }
  if (request.intake?.reasons.includes('runtime_unavailable')) {
    return {
      icon: <ClockCircleOutlined />,
      label: '等待中',
      title: '等待 Runtime 上线',
      description: '绑定的 Computer 或 Runtime 当前不可用。',
      tone: 'waiting',
    };
  }
  if (request.intake?.reasons.includes('agent_suspended')) {
    return {
      icon: <ClockCircleOutlined />,
      label: '已暂停',
      title: 'Agent 当前已暂停',
      description: '恢复 Agent 后才能继续处理这次请求。',
      tone: 'waiting',
    };
  }
  return {
    icon: <ClockCircleOutlined />,
    label: '等待中',
    title: '等待 Runtime 接收请求',
    description: '请求已经建立，尚未开始执行。',
    tone: 'waiting',
  };
}

export function AgentActivityPanel({ agent, conversations, projects, enabled }: {
  agent: Agent;
  conversations: Conversation[];
  projects: Project[];
  enabled: boolean;
}) {
  const navigate = useNavigate();
  const activity = useQuery({
    queryKey: [
      'workspace', agent.workspaceId, 'agent', agent.id, 'activity',
      conversations.map((item) => item.id),
      projects.map((item) => item.id),
    ],
    queryFn: async (): Promise<ActivityItem[]> => {
      const projectConversations = (await Promise.all(
        projects.filter((project) => !project.governanceOnly).map((project) => loadProjectConversations(project.id)),
      )).flat();
      const visibleConversations = Array.from(new Map(
        [...conversations, ...projectConversations].map((conversation) => [conversation.id, conversation]),
      ).values());
      const requestGroups = await Promise.all(visibleConversations.map(async (conversation) => ({
        conversation,
        requests: (await api.listAgentRequests(conversation.id)).items.filter((request) => request.targetAgentId === agent.id),
      })));
      const relevantGroups = requestGroups.filter((group) => group.requests.length > 0);
      const messagesByConversation = new Map(await Promise.all(relevantGroups.map(async ({ conversation }) => (
        [conversation.id, (await api.listMessages(conversation.id)).items] as const
      ))));
      return relevantGroups.flatMap(({ conversation, requests }) => requests.map((request) => ({
        conversation,
        request,
        messages: request.run
          ? (messagesByConversation.get(conversation.id) ?? []).filter((item) => item.producingRunId === request.run?.id)
          : [],
      }))).sort((left, right) => right.request.updatedAt - left.request.updatedAt);
    },
    enabled,
    refetchInterval: enabled ? 2_000 : false,
  });

  if (activity.isPending) return <div className="agent-activity-loading"><Spin /></div>;
  if (activity.isError) return <Alert type="error" showIcon title="动态加载失败" description={errorMessage(activity.error)} />;
  if (!activity.data.length) {
    return <Card className="surface-card agent-activity-empty" variant="borderless"><Empty description="还没有 Agent 运行记录" /></Card>;
  }

  return (
    <div className="agent-activity-list">
      {activity.data.map(({ conversation, request, messages }) => {
        const presentation = requestPresentation(request, messages.length);
        return (
          <Card className={`surface-card agent-activity-item ${presentation.tone}`} variant="borderless" key={request.id}>
            <div className="agent-activity-icon">{presentation.icon}</div>
            <div className="agent-activity-content">
              <div className="agent-activity-heading">
                <div>
                  <Text strong>{presentation.title}</Text>
                  <Text type="secondary">{dateTime.format(request.updatedAt)} · {conversationLabel(conversation)}</Text>
                </div>
                <Tag>{presentation.label}</Tag>
              </div>
              <Text type="secondary">{presentation.description}</Text>
              {messages.map((item) => (
                <div className="agent-activity-message" key={item.id}>
                  <MessageOutlined />
                  <Paragraph ellipsis={{ rows: 3 }}>{item.body}</Paragraph>
                </div>
              ))}
              <Button type="link" onClick={() => navigate(conversation.projectId
                ? `/w/${agent.workspaceId}/p/${conversation.projectId}/c/${conversation.id}`
                : `/w/${agent.workspaceId}/c/${conversation.id}`)}>查看 Conversation</Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
