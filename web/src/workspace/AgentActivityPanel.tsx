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
import { agentActivityIcon, agentActivityTone, collapseAgentActivityEvents, localizeActivityTitle } from './agent-activity-presentation';
import { loadAllPages } from '../lib/pagination';
import { localizeConversationName, useLanguage } from '../language';

const { Paragraph, Text } = Typography;

interface ActivityItem {
  conversation: Conversation;
  request: AgentRequest;
  sourceMessage: WorkspaceMessage | null;
  messages: WorkspaceMessage[];
}

interface ActivityPresentation {
  icon: React.ReactNode;
  label: string;
  title: string;
  description?: string;
  tone: 'waiting' | 'running' | 'success' | 'failed' | 'neutral';
}

const loadProjectConversations = (projectId: string): Promise<Conversation[]> => loadAllPages(
  (cursor) => api.listProjectConversations(projectId, cursor),
);

function conversationLabel(conversation: Conversation, isEnglish: boolean): string {
  if (conversation.kind === 'dm') return isEnglish ? 'Direct message' : '私信';
  return conversation.title ? `#${localizeConversationName(conversation.title, isEnglish)}` : (isEnglish ? 'Channel' : '频道');
}

function requestPresentation(request: AgentRequest, messageCount: number, isEnglish: boolean): ActivityPresentation {
  if (request.status === 'cancelled') {
    return {
      icon: <CloseCircleOutlined />,
      label: isEnglish ? 'Cancelled' : '已取消',
      title: isEnglish ? 'Message processing cancelled' : '消息处理已取消',
      tone: 'neutral',
    };
  }
  if (request.status === 'rejected') {
    return {
      icon: <CloseCircleOutlined />,
      label: isEnglish ? 'Not processed' : '未处理',
      title: isEnglish ? 'Message was not processed' : '消息未被处理',
      description: request.terminalReason?.detail || (isEnglish ? 'The Agent did not process this message.' : 'Agent 没有处理这条消息。'),
      tone: 'failed',
    };
  }
  if (request.status === 'accepted' && request.run === null) {
    return {
      icon: <CheckCircleOutlined />,
      label: isEnglish ? 'Received' : '已收到',
      title: isEnglish ? 'Agent received the message' : 'Agent 已收到消息',
      tone: 'success',
    };
  }
  if (request.run?.status === 'terminal') {
    if (request.run.outcome === 'publish') {
      return {
        icon: <CheckCircleOutlined />,
        label: messageCount ? (isEnglish ? 'Replied' : '已回复') : (isEnglish ? 'Done' : '已完成'),
        title: messageCount
          ? (isEnglish ? `Agent sent ${messageCount} replies` : `Agent 已发送 ${messageCount} 条回复`)
          : (isEnglish ? 'Agent finished processing' : 'Agent 已完成处理'),
        ...(messageCount ? {} : { description: isEnglish ? 'Replies are syncing.' : '回复正在同步。' }),
        tone: 'success',
      };
    }
    if (request.run.outcome === 'no_output') {
      return {
        icon: <CheckCircleOutlined />,
        label: isEnglish ? 'Done' : '已完成',
        title: isEnglish ? 'Agent finished processing' : 'Agent 已完成处理',
        description: isEnglish ? 'No reply was sent.' : '没有发送回复。',
        tone: 'neutral',
      };
    }
    if (request.run.outcome === 'failed') {
      return {
        icon: <CloseCircleOutlined />,
        label: isEnglish ? 'Failed' : '失败',
        title: isEnglish ? 'Agent processing failed' : 'Agent 处理失败',
        description: request.run.attempt?.failureReason?.message || (isEnglish ? 'No failure reason available.' : '没有可展示的失败原因。'),
        tone: 'failed',
      };
    }
    return {
      icon: <CloseCircleOutlined />,
      label: isEnglish ? 'No reply' : '未回复',
      title: isEnglish ? 'Processing ended without a reply' : '处理结束，未发送回复',
      ...(request.run.outcome === 'cancelled' ? { description: isEnglish ? 'Processing was cancelled.' : '处理已取消。' } : {}),
      tone: 'neutral',
    };
  }
  if (request.run?.status === 'active') {
    return {
      icon: <SyncOutlined spin />,
      label: isEnglish ? 'Processing' : '处理中',
      title: request.run.attempt?.status === 'running'
        ? (isEnglish ? 'Agent is processing' : 'Agent 正在处理')
        : (isEnglish ? 'Agent is preparing to process' : 'Agent 正在准备处理'),
      tone: 'running',
    };
  }
  if (request.intake?.reasons.includes('runtime_unavailable')) {
    return {
      icon: <ClockCircleOutlined />,
      label: isEnglish ? 'Waiting' : '等待中',
      title: isEnglish ? 'Waiting for the Agent to come online' : '等待 Agent 上线',
      description: isEnglish ? 'The bound computer is currently unavailable.' : '绑定的计算机当前不可用。',
      tone: 'waiting',
    };
  }
  if (request.intake?.reasons.includes('agent_suspended')) {
    return {
      icon: <ClockCircleOutlined />,
      label: isEnglish ? 'Suspended' : '已暂停',
      title: isEnglish ? 'Agent is currently suspended' : 'Agent 当前已暂停',
      description: isEnglish ? 'Resume the Agent to continue processing this request.' : '恢复 Agent 后才能继续处理这次请求。',
      tone: 'waiting',
    };
  }
  return {
    icon: <ClockCircleOutlined />,
    label: isEnglish ? 'Waiting' : '等待中',
    title: isEnglish ? 'Waiting for the Agent to process' : '等待 Agent 处理',
    tone: 'waiting',
  };
}

export function AgentActivityPanel({ agent, conversations, projects, enabled }: {
  agent: Agent;
  conversations: Conversation[];
  projects: Project[];
  enabled: boolean;
}) {
  const { isEnglish } = useLanguage();
  const tx = (zh: string, en: string) => isEnglish ? en : zh;
  const dateTime = new Intl.DateTimeFormat(isEnglish ? 'en-US' : 'zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
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
        sourceMessage: (messagesByConversation.get(conversation.id) ?? [])
          .find((item) => item.id === request.sourceMessageId) ?? null,
        messages: request.run
          ? (messagesByConversation.get(conversation.id) ?? []).filter((item) => item.producingRunId === request.run?.id)
          : [],
      }))).sort((left, right) => right.request.updatedAt - left.request.updatedAt);
    },
    enabled,
    refetchInterval: enabled ? 2_000 : false,
  });
  const runtimeActivity = useQuery({
    queryKey: ['workspace', agent.workspaceId, 'agent-activity', agent.id],
    queryFn: () => api.listAgentActivity(agent.workspaceId, agent.id).then((page) => page.items),
    enabled,
    refetchInterval: enabled ? 1_000 : false,
  });

  if (activity.isPending || runtimeActivity.isPending) return <div className="agent-activity-loading"><Spin /></div>;
  if (activity.isError) return <Alert type="error" showIcon title={tx('动态加载失败', 'Failed to load activity')} description={errorMessage(activity.error)} />;
  const runtimeEvents = collapseAgentActivityEvents(runtimeActivity.data ?? []);
  if (!activity.data.length && !runtimeEvents.length && !runtimeActivity.isError) {
    return <Card className="surface-card agent-activity-empty" variant="borderless"><Empty description={tx('还没有 Agent 动态', 'No Agent activity yet')} /></Card>;
  }

  return (
    <div className="agent-activity-list">
      {runtimeActivity.isError && (
        <Alert type="warning" showIcon title={tx('执行动态暂时不可用', 'Runtime activity is temporarily unavailable')} description={errorMessage(runtimeActivity.error)} />
      )}
      {runtimeEvents.length > 0 && (
        <Card className="surface-card agent-runtime-activity" variant="borderless">
          <div className="agent-runtime-activity-heading">
            <div>
              <Text strong>{tx('执行动态', 'Runtime activity')}</Text>
              <Text type="secondary">{tx('Agent 处理过程中的实时动作', 'Live actions while the Agent is running')}</Text>
            </div>
            {runtimeEvents[0]?.turnStatus === 'active' && <Tag color="processing">{tx('进行中', 'In progress')}</Tag>}
          </div>
          <div className="agent-runtime-activity-events">
            {runtimeEvents.slice(0, 30).map((item) => (
              <div className={`agent-runtime-activity-event ${agentActivityTone(item)}`} key={item.eventId}>
                <span className="agent-runtime-activity-event-icon">{agentActivityIcon(item)}</span>
                <span>{localizeActivityTitle(item.title, isEnglish)}</span>
                <time>{dateTime.format(item.createdAt)}</time>
              </div>
            ))}
          </div>
        </Card>
      )}
      {activity.data.map(({ conversation, request, sourceMessage, messages }) => {
        const presentation = requestPresentation(request, messages.length, isEnglish);
        return (
          <Card className={`surface-card agent-activity-item ${presentation.tone}`} variant="borderless" key={request.id}>
            <div className="agent-activity-icon">{presentation.icon}</div>
            <div className="agent-activity-content">
              <div className="agent-activity-heading">
                <div>
                  <Text strong>{presentation.title}</Text>
                  <Text type="secondary">{dateTime.format(request.updatedAt)} · {conversationLabel(conversation, isEnglish)}</Text>
                </div>
                <Tag>{presentation.label}</Tag>
              </div>
              {presentation.description && <Text type="secondary">{presentation.description}</Text>}
              {sourceMessage && (
                <div className="agent-activity-message">
                  <MessageOutlined />
                  <Paragraph ellipsis={{ rows: 3 }}>{sourceMessage.authorDisplayName}{tx('：', ': ')}{sourceMessage.body}</Paragraph>
                </div>
              )}
              {messages.map((item) => (
                <div className="agent-activity-message" key={item.id}>
                  <MessageOutlined />
                  <Paragraph ellipsis={{ rows: 3 }}>{tx('Agent 回复：', 'Agent reply: ')}{item.body}</Paragraph>
                </div>
              ))}
              <Button type="link" onClick={() => navigate(conversation.projectId
                ? `/w/${agent.workspaceId}/p/${conversation.projectId}/c/${conversation.id}`
                : `/w/${agent.workspaceId}/c/${conversation.id}`)}>{tx('查看会话', 'View conversation')}</Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
