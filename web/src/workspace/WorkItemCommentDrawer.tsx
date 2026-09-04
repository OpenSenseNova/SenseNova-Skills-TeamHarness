import { MessageOutlined, RobotOutlined, UserOutlined } from '@ant-design/icons';
import {
  Alert,
  Avatar,
  Button,
  Drawer,
  List,
  Space,
  Spin,
  Typography,
} from 'antd';
import type { ReactNode } from 'react';
import { errorMessage, type WorkItem, type WorkItemComment } from '../api/client';

const { Text: TypographyText } = Typography;

export interface WorkItemCommentDrawerProps {
  open: boolean;
  workItem: WorkItem | null | undefined;
  comments: WorkItemComment[] | undefined;
  commentsPending?: boolean;
  commentsError?: unknown;
  workspaceId: string;
  projectId: string;
  readOnly?: boolean;
  submissionContent?: ReactNode;
  composer?: ReactNode;
  onClose: () => void;
  onOpenTaskComments: (workItemId: string) => void;
}

function commentTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}

export function WorkItemCommentDrawer({
  open,
  workItem,
  comments,
  commentsPending = false,
  commentsError,
  workspaceId,
  projectId,
  readOnly = false,
  submissionContent,
  composer,
  onClose,
  onOpenTaskComments,
}: WorkItemCommentDrawerProps) {
  return (
    <Drawer
      open={open}
      placement="right"
      size="50%"
      title={workItem ? `任务讨论 · #${workItem.taskNumber}` : '任务讨论'}
      styles={{ body: { padding: 20 } }}
      onClose={onClose}
    >
      {submissionContent}
      {commentsPending ? <Spin /> : commentsError ? (
        <Alert type="error" showIcon title="评论加载失败" description={errorMessage(commentsError)} />
      ) : (
        <List
          locale={{ emptyText: '还没有评论' }}
          dataSource={comments ?? []}
          renderItem={(comment) => {
            const missingMentions = (comment.mentions ?? [])
              .filter((mention) => !comment.body.includes(`@${mention.displayName}`))
              .map((mention) => `@${mention.displayName}`)
              .join(' ');
            return (
              <List.Item>
                <List.Item.Meta
                  avatar={<Avatar icon={comment.authorActorType === 'agent' ? <RobotOutlined /> : <UserOutlined />} />}
                  title={(
                    <Space>
                      <strong>{comment.authorDisplayName}</strong>
                      <TypographyText type="secondary">{commentTime(comment.createdAt)}</TypographyText>
                    </Space>
                  )}
                  description={(
                    <div className="work-item-comment-body">
                      <div>{missingMentions ? `${missingMentions} ${comment.body}` : comment.body}</div>
                      {comment.workItemReferences?.map((reference) => (
                        <Button
                          key={reference.workItemId}
                          type="link"
                          size="small"
                          className="message-task-mention"
                          onClick={() => onOpenTaskComments(reference.workItemId)}
                        >
                          @task#{reference.taskNumber}
                        </Button>
                      ))}
                      {comment.artifactReferences?.map((reference) => (
                        <div className="message-artifact-reference" key={reference.artifactVersionId}>
                          {reference.contentAvailable ? (
                            <a href={`/v1/artifact-versions/${reference.artifactVersionId}/download`}>
                              {reference.artifactName} · v{reference.version} · {reference.fileName}
                            </a>
                          ) : (
                            <TypographyText type="secondary">
                              {reference.artifactName} · v{reference.version} · 内容已删除
                            </TypographyText>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                />
              </List.Item>
            );
          }}
        />
      )}
      {!readOnly && composer}
      {workItem && (
        <Button
          type="link"
          icon={<MessageOutlined />}
          href={`/w/${workspaceId}/p/${projectId}/work-items?workItemId=${workItem.id}`}
        >
          打开任务看板
        </Button>
      )}
    </Drawer>
  );
}
