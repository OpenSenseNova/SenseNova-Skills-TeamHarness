import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { authorizeAgentInConversation, createTestService, reportReadyRuntime } from './helpers.js';

describe('Project WorkItem board', () => {
  it('creates a Project WorkItem with an independent comment stream, lets the assigned Agent submit, and keeps Human completion authoritative', () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Workspace', 'work-item-workspace');
    const computer = service.registerComputer(principal, { name: 'Alice Mac' }, 'work-item-computer');
    reportReadyRuntime(service, computer.computerId, alice.humanId);
    const agent = service.createAgent(principal, workspace.id, {
      name: 'Builder',
      runtimeBinding: { computerId: computer.computerId, runtimeId: 'generic-acp' },
    }, 'work-item-agent');
    const project = service.createProject(principal, workspace.id, { name: 'Launch' }, 'work-item-project');
    const agentProjectMembership = service.addProjectMember(principal, project.id, {
      workspaceMembershipId: agent.membershipId,
      role: 'member',
    }, 'work-item-agent-project');

    const created = service.createWorkItem(principal, project.id, {
      description: '交付一版可验证的任务看板',
      assigneeProjectMembershipId: agentProjectMembership.projectMembershipId,
    }, 'work-item-create');

    expect(created).toMatchObject({
      projectId: project.id,
      lifecycleStatus: 'open',
      sourceConversationId: null,
      sourceMessageId: null,
      sourceThreadId: null,
      assignmentRevision: 1,
      assignee: { actorId: agent.id, actorType: 'agent', displayName: 'Builder' },
      currentSubmission: null,
      commentFrontier: 0,
    });

    const computerPrincipal = { kind: 'computer' as const, computerId: computer.computerId, ownerHumanId: alice.humanId, agentId: agent.id };
    const target = service.getComputerAgentInbox(computer.computerId, agent.id).targets[0]!;
    expect(target).toMatchObject({
      kind: 'work_item',
      target: `work-item:${created.id}`,
      workItemId: created.id,
      requiresAction: true,
    });
    const comment = service.postComputerAgentWorkItemComment(computer.computerId, agent.id, created.id, {
      body: '看板已经实现并通过测试，请验收。',
    }, 'work-item-result-comment');
    expect(comment).toMatchObject({
      workItemId: created.id,
      authorActorId: agent.id,
      body: '看板已经实现并通过测试，请验收。',
      position: 1,
    });
    expect(service.listWorkItemComments(principal, created.id)).toEqual([comment]);

    const submitted = service.submitComputerAgentWorkItemResult(
      computerPrincipal.computerId,
      agent.id,
      created.id,
      {
        commentId: comment.id,
        expectedRevision: created.revision,
        expectedAssignmentRevision: created.assignmentRevision,
      },
      'work-item-submit',
    );
    expect(submitted).toMatchObject({
      lifecycleStatus: 'open',
      revision: 2,
      currentSubmission: {
        commentId: comment.id,
        submittedByActorId: agent.id,
        assignmentRevision: 1,
      },
    });
    expect(service.listComputerAgentWorkItems(computer.computerId, agent.id)).toHaveLength(1);

    const completed = service.completeWorkItem(principal, created.id, submitted.revision, 'work-item-complete');
    expect(completed).toMatchObject({
      lifecycleStatus: 'completed',
      assignee: { actorId: agent.id },
      assignees: [{ actorId: agent.id }],
      assignmentRevision: 2,
      currentSubmission: { commentId: comment.id },
    });
    expect(service.listComputerAgentWorkItems(computer.computerId, agent.id)).toEqual([
      expect.objectContaining({ id: created.id, lifecycleStatus: 'completed' }),
    ]);
    expect(() => service.cancelWorkItem(principal, created.id, {
      reason: '不能改写终态', expectedRevision: completed.revision,
    }, 'work-item-cancel-completed')).toThrow(/terminal/i);
  });

  it('exposes WorkItem references to a Mention Session while allowing Project-scoped CLI reads', () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Workspace', 'mentioned-work-item-workspace');
    const computer = service.registerComputer(principal, { name: 'Alice Mac' }, 'mentioned-work-item-computer');
    reportReadyRuntime(service, computer.computerId, alice.humanId);
    const agent = service.createAgent(principal, workspace.id, {
      name: 'Builder',
      runtimeBinding: { computerId: computer.computerId, runtimeId: 'generic-acp' },
    }, 'mentioned-work-item-agent');
    const project = service.createProject(principal, workspace.id, { name: 'Launch' }, 'mentioned-work-item-project');
    service.addProjectMember(principal, project.id, {
      workspaceMembershipId: agent.membershipId,
      role: 'member',
    }, 'mentioned-work-item-agent-project');
    const conversation = authorizeAgentInConversation(
      service,
      principal,
      service.listProjectConversations(principal, project.id).items[0]!,
      agent.membershipId,
      'mentioned-work-item-conversation-agent',
    );
    const referenced = service.createWorkItem(principal, project.id, {
      description: '读取这个任务的最新 Artifact',
    }, 'mentioned-work-item-create');
    const source = service.postMessage(principal, conversation.id, {
      body: '@Builder 请读取这个任务',
      mentionedActorIds: [agent.id],
      workItemIds: [referenced.id],
    }, 'mentioned-work-item-source');
    const requestId = source.mentionOutcomes.find((outcome) => outcome.targetAgentId === agent.id)?.agentRequestId;
    expect(requestId).toBeTruthy();

    const input = service.getComputerAgentSessionInput(computer.computerId, agent.id, {
      kind: 'mention',
      key: requestId!,
    });
    expect(input.referencedWorkItemIds).toEqual([referenced.id]);
    expect(input.contextJsonl).toContain(JSON.stringify({
      type: 'work_item_mention',
      workItemId: referenced.id,
      taskNumber: referenced.taskNumber,
      instruction: `use teamctl work-item read ${referenced.id} to inspect its current state and artifacts`,
    }));
    const sourceContextLine = input.contextJsonl.split('\n')
      .map((line) => JSON.parse(line) as { type?: string; message?: { id?: string; workItemReferences?: unknown[] } })
      .find((line) => line.type === 'message' && line.message?.id === source.id);
    expect(sourceContextLine?.message?.workItemReferences).toEqual([]);

    expect(service.getComputerAgentWorkItem(computer.computerId, agent.id, referenced.id)).toMatchObject({
      id: referenced.id,
      description: referenced.description,
      currentSubmission: null,
    });
    expect(service.listComputerAgentWorkItemComments(computer.computerId, agent.id, referenced.id)).toEqual([]);
    const unrelated = service.createWorkItem(principal, project.id, { description: '同项目可读取任务' }, 'mentioned-work-item-unrelated');
    expect(service.getComputerAgentWorkItem(computer.computerId, agent.id, unrelated.id)).toMatchObject({ id: unrelated.id });

    const sourceTask = service.createWorkItemFromMessage(principal, source.id, {
      description: '处理这条消息对应的任务',
    }, 'mentioned-work-item-source-task');
    expect(sourceTask.relatedWorkItemReferences).toEqual([
      { workItemId: referenced.id, taskNumber: referenced.taskNumber },
    ]);
    expect(service.listMessages(principal, conversation.id).find((message) => message.id === source.id)?.workItemReferences).toEqual([
      { workItemId: referenced.id, taskNumber: referenced.taskNumber },
    ]);
    service.postWorkItemComment(principal, sourceTask.id, {
      body: '补充关联任务',
      workItemIds: [referenced.id],
    }, 'mentioned-work-item-comment');
    const workItemSession = service.getComputerAgentSessionInput(computer.computerId, agent.id, {
      kind: 'work_item',
      key: sourceTask.id,
    });
    expect(workItemSession.referencedWorkItemIds).toEqual([sourceTask.id, referenced.id]);
    const mentionLines = workItemSession.contextJsonl.split('\n')
      .map((line) => JSON.parse(line) as { type?: string; workItemId?: string })
      .filter((line) => line.type === 'work_item_mention');
    expect(mentionLines).toEqual([
      { type: 'work_item_mention', workItemId: sourceTask.id, taskNumber: sourceTask.taskNumber, instruction: `use teamctl work-item read ${sourceTask.id} to inspect its current state and artifacts` },
      { type: 'work_item_mention', workItemId: referenced.id, taskNumber: referenced.taskNumber, instruction: `use teamctl work-item read ${referenced.id} to inspect its current state and artifacts` },
    ]);
    const relationLine = workItemSession.contextJsonl.split('\n')
      .map((line) => JSON.parse(line) as { type?: string; workItemId?: string; relatedWorkItemId?: string; relation?: string })
      .find((line) => line.type === 'work_item_relation');
    expect(relationLine).toMatchObject({
      workItemId: sourceTask.id,
      relatedWorkItemId: referenced.id,
      relation: 'created_from_message_reference',
    });
  });

  it('lets the assigned Agent report a blocker while only Human authority can unblock or cancel', () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Workspace', 'blocked-workspace');
    const computer = service.registerComputer(principal, { name: 'Alice Mac' }, 'blocked-computer');
    reportReadyRuntime(service, computer.computerId, alice.humanId);
    const agent = service.createAgent(principal, workspace.id, {
      name: 'Builder',
      runtimeBinding: { computerId: computer.computerId, runtimeId: 'generic-acp' },
    }, 'blocked-agent');
    const project = service.createProject(principal, workspace.id, { name: 'Launch' }, 'blocked-project');
    const projectMember = service.addProjectMember(principal, project.id, {
      workspaceMembershipId: agent.membershipId, role: 'member',
    }, 'blocked-agent-project');
    const workItem = service.createWorkItem(principal, project.id, {
      description: '等待外部接口', assigneeProjectMembershipId: projectMember.projectMembershipId,
    }, 'blocked-work-item');

    const blocked = service.blockComputerAgentWorkItem(computer.computerId, agent.id, workItem.id, {
      reason: '缺少测试环境访问权限',
      expectedRevision: workItem.revision,
      expectedAssignmentRevision: workItem.assignmentRevision,
    }, 'blocked-by-agent');
    expect(blocked).toMatchObject({
      lifecycleStatus: 'blocked',
      blockerReason: '缺少测试环境访问权限',
      assignee: { actorId: agent.id },
    });

    const reopened = service.unblockWorkItem(principal, workItem.id, blocked.revision, 'unblock-by-human');
    expect(reopened).toMatchObject({ lifecycleStatus: 'open', blockerReason: null });
    const cancelled = service.cancelWorkItem(principal, workItem.id, {
      reason: '需求已经撤销', expectedRevision: reopened.revision,
    }, 'cancel-by-human');
    expect(cancelled).toMatchObject({
      lifecycleStatus: 'cancelled',
      cancellationReason: '需求已经撤销',
      assignee: { actorId: agent.id },
      assignees: [{ actorId: agent.id }],
    });
    const cancelledWithoutReason = service.createWorkItem(principal, project.id, {
      description: '允许不填写取消原因',
    }, 'cancel-without-reason-work-item');
    expect(service.cancelWorkItem(principal, cancelledWithoutReason.id, {
      expectedRevision: cancelledWithoutReason.revision,
    }, 'cancel-without-reason')).toMatchObject({
      lifecycleStatus: 'cancelled',
      cancellationReason: null,
    });
  });

  it('stores Artifact versions in a dedicated Submission and allows Human upload submission', async () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Workspace', 'submission-artifact-workspace');
    const computer = service.registerComputer(principal, { name: 'Alice Mac' }, 'submission-artifact-computer');
    reportReadyRuntime(service, computer.computerId, alice.humanId);
    const agent = service.createAgent(principal, workspace.id, {
      name: 'Builder', runtimeBinding: { computerId: computer.computerId, runtimeId: 'generic-acp' },
    }, 'submission-artifact-agent');
    const project = service.createProject(principal, workspace.id, { name: 'Launch' }, 'submission-artifact-project');
    const agentMember = service.addProjectMember(principal, project.id, {
      workspaceMembershipId: agent.membershipId, role: 'member',
    }, 'submission-artifact-agent-project');
    const workItem = service.createWorkItem(principal, project.id, {
      description: '上传最终图片并等待验收', assigneeProjectMembershipId: agentMember.projectMembershipId,
    }, 'submission-artifact-work-item');
    const computerPrincipal = { kind: 'computer' as const, computerId: computer.computerId, ownerHumanId: alice.humanId, agentId: agent.id };
    const published = await service.artifactV2.publish(
      computerPrincipal,
      project.id,
      { fileName: 'result.png', artifactName: '最终图片', taskId: workItem.id },
      service.artifactV2.blobs.writeBufferSync(Buffer.from('png-bytes'), 'image/png'),
    );
    const submitted = service.submitComputerAgentWorkItemResult(
      computer.computerId,
      agent.id,
      workItem.id,
      {
        artifactVersionIds: [published.version.versionId],
        expectedRevision: workItem.revision,
        expectedAssignmentRevision: workItem.assignmentRevision,
      },
      'submission-artifact-agent-submit',
    );
    expect(submitted.currentSubmission).toMatchObject({ commentId: null, artifactReferences: [{
      artifactId: published.artifact.artifactId,
      artifactVersionId: published.version.versionId,
      fileName: 'result.png',
      mediaType: 'image/png',
      contentAvailable: true,
    }] });
    const referenceCount = (service as any).workspaceDatabase.raw.prepare(
      'SELECT COUNT(*) AS count FROM work_item_submission_artifact_references_v2 WHERE submission_id = ?',
    ).get(submitted.currentSubmission!.id) as { count: number };
    expect(referenceCount.count).toBe(1);

    const humanTask = service.createWorkItem(principal, project.id, {
      description: '由负责人直接上传交付物',
    }, 'submission-artifact-human-work-item');
    const humanArtifact = await service.artifactV2.publish(
      principal,
      project.id,
      { fileName: 'human.png', artifactName: '人工结果', taskId: humanTask.id },
      service.artifactV2.blobs.writeBufferSync(Buffer.from('human-png'), 'image/png'),
    );
    const humanSubmitted = service.submitHumanWorkItemResult(principal, humanTask.id, {
      artifactVersionIds: [humanArtifact.version.versionId], expectedRevision: humanTask.revision,
    }, 'submission-artifact-human-submit');
    expect(humanSubmitted.currentSubmission).toMatchObject({
      commentId: null,
      submittedByActorId: alice.humanId,
      artifactReferences: [{ artifactVersionId: humanArtifact.version.versionId }],
    });
  });

  it('requires a description for new tasks and only edits unassigned open tasks', () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Workspace', 'work-item-details-workspace');
    const project = service.createProject(principal, workspace.id, { name: 'Launch' }, 'work-item-details-project');
    expect(() => service.createWorkItem(principal, project.id, { description: '   ' }, 'work-item-details-missing-description'))
      .toThrow(/description/i);
    const created = service.createWorkItem(principal, project.id, {
      description: '旧描述',
    }, 'work-item-details-create');
    const updated = service.updateWorkItemDetails(principal, created.id, {
      description: '包含验收标准的具体描述', expectedRevision: created.revision,
    }, 'work-item-details-update');
    expect(updated).toMatchObject({ taskNumber: 1, description: '包含验收标准的具体描述', revision: 2 });
    const assigned = service.assignWorkItem(principal, updated.id, {
      assigneeProjectMembershipId: project.membershipId,
      expectedRevision: updated.revision,
      expectedAssignmentRevision: updated.assignmentRevision,
    }, 'work-item-details-assign');
    expect(() => service.updateWorkItemDetails(principal, assigned.id, {
      description: '已分配任务不可编辑', expectedRevision: assigned.revision,
    }, 'work-item-details-rejected')).toThrow(/unassigned open/i);
  });

  it('creates a task from a Project Conversation message without creating a second Conversation', () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Workspace', 'source-workspace');
    const computer = service.registerComputer(principal, { name: 'Alice Mac' }, 'source-computer');
    reportReadyRuntime(service, computer.computerId, alice.humanId);
    const agent = service.createAgent(principal, workspace.id, {
      name: 'Builder', runtimeBinding: { computerId: computer.computerId, runtimeId: 'generic-acp' },
    }, 'source-agent');
    const project = service.createProject(principal, workspace.id, { name: 'Launch' }, 'source-project');
    const agentMember = service.addProjectMember(principal, project.id, {
      workspaceMembershipId: agent.membershipId, role: 'member',
    }, 'source-agent-project');
    const projectConversation = service.listProjectConversations(principal, project.id).items[0]!;
    const source = service.postMessage(principal, projectConversation.id, {
      body: '完成发布前检查',
    }, 'source-message');
    const conversationCount = service.listProjectConversations(principal, project.id).items.length;

    const created = service.createWorkItemFromMessage(principal, source.id, {
      assigneeProjectMembershipId: agentMember.projectMembershipId,
    }, 'source-work-item');

    expect(created).toMatchObject({
      projectId: project.id,
      description: source.body,
      sourceConversationId: projectConversation.id,
      sourceMessageId: source.id,
      sourceThreadId: null,
      assignee: { actorId: agent.id },
    });
    expect(service.listMessages(principal, projectConversation.id).find((message) => message.id === source.id)).toMatchObject({
      workItemReferences: [],
    });
    const secondFromSameMessage = service.createWorkItemFromMessage(
      principal,
      source.id,
      { description: '拆分一个独立的验收任务' },
      'source-second-work-item',
    );
    expect(secondFromSameMessage).toMatchObject({
      sourceConversationId: projectConversation.id,
      sourceMessageId: source.id,
      description: '拆分一个独立的验收任务',
    });
    expect(secondFromSameMessage.id).not.toBe(created.id);
    expect(service.listProjectConversations(principal, project.id).items).toHaveLength(conversationCount);
    expect(service.listWorkItemComments(principal, created.id)).toEqual([]);
    expect(service.getComputerAgentInbox(computer.computerId, agent.id).targets).toContainEqual(
      expect.objectContaining({ kind: 'work_item', workItemId: created.id }),
    );
    const privateSession = service.getComputerAgentSessionInput(
      computer.computerId,
      agent.id,
      { kind: 'work_item', key: created.id },
    );
    expect(privateSession.contextJsonl).not.toContain('work_item_source_message');
    authorizeAgentInConversation(
      service,
      principal,
      projectConversation,
      agent.membershipId,
      'source-agent-conversation',
    );
    const authorizedSession = service.getComputerAgentSessionInput(
      computer.computerId,
      agent.id,
      { kind: 'work_item', key: created.id },
    );
    expect(authorizedSession.contextJsonl).toContain('work_item_source_message');
    expect(authorizedSession.contextJsonl).toContain(source.body);

    const reply = service.replyToMessage(principal, source.id, { body: '补充检查 staging' }, 'source-reply');
    const threaded = service.createWorkItemFromMessage(principal, reply.id, {
      description: '检查 staging 发布链路',
    }, 'source-threaded-work-item');
    expect(threaded).toMatchObject({
      sourceConversationId: projectConversation.id,
      sourceMessageId: reply.id,
      sourceThreadId: reply.threadId,
      description: '检查 staging 发布链路',
    });

    const workspaceGeneral = service.listConversations(principal, workspace.id).items.find(
      (conversation) => conversation.scope.type === 'workspace_general',
    )!;
    const workspaceMessage = service.postMessage(principal, workspaceGeneral.id, { body: 'Workspace 任务' }, 'source-workspace-message');
    expect(() => service.createWorkItemFromMessage(principal, workspaceMessage.id, {}, 'source-workspace-work-item'))
      .toThrow(/Project Conversation/i);
  });

  it('coalesces a source Mention and its assigned WorkItem into one composite Session', () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Workspace', 'composite-session-workspace');
    const computer = service.registerComputer(principal, { name: 'Alice Mac' }, 'composite-session-computer');
    reportReadyRuntime(service, computer.computerId, alice.humanId);
    const agent = service.createAgent(principal, workspace.id, {
      name: 'Builder', runtimeBinding: { computerId: computer.computerId, runtimeId: 'generic-acp' },
    }, 'composite-session-agent');
    const project = service.createProject(principal, workspace.id, { name: 'Launch' }, 'composite-session-project');
    const agentMember = service.addProjectMember(principal, project.id, {
      workspaceMembershipId: agent.membershipId, role: 'member',
    }, 'composite-session-agent-project');
    const conversation = authorizeAgentInConversation(
      service,
      principal,
      service.listProjectConversations(principal, project.id).items[0]!,
      agent.membershipId,
      'composite-session-agent-conversation',
    );
    const source = service.postMessage(principal, conversation.id, {
      body: '@Builder 完成并在群里同步', mentionedActorIds: [agent.id],
    }, 'composite-session-source');
    const requestId = source.mentionOutcomes.find((outcome) => outcome.targetAgentId === agent.id)?.agentRequestId;
    expect(requestId).toBeTruthy();
    const workItem = service.createWorkItemFromMessage(principal, source.id, {
      assigneeProjectMembershipId: agentMember.projectMembershipId,
    }, 'composite-session-work-item');

    const summary = service.getComputerAgentInbox(computer.computerId, agent.id);
    const linked = summary.sessionTriggers.filter((trigger) => trigger.messageId === source.id || trigger.workItemId === workItem.id);
    expect(linked).toHaveLength(2);
    expect(linked.map((trigger) => trigger.session)).toEqual([
      { kind: 'work_item', key: workItem.id },
      { kind: 'work_item', key: workItem.id },
    ]);

    const input = service.getComputerAgentSessionInput(computer.computerId, agent.id, {
      kind: 'work_item', key: workItem.id,
    });
    expect(input.discussion).toMatchObject({
      target: `conversation:${conversation.id}`,
      agentRequestId: requestId,
      initialDiscussionFrontier: source.scopePosition,
    });
    expect(input.contextJsonl).toContain('"type":"work_item"');
    expect(input.contextJsonl).toContain('"type":"work_item_source_message"');
    expect(input.contextJsonl).toContain(source.body);
  });

  it('exposes the message-to-task creation endpoint with source provenance', async () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Workspace', 'source-http-workspace');
    const project = service.createProject(principal, workspace.id, { name: 'Launch' }, 'source-http-project');
    const conversation = service.listProjectConversations(principal, project.id).items[0]!;
    const source = service.postMessage(principal, conversation.id, { body: '准备 HTTP 验收' }, 'source-http-message');
    const app = await buildApp(service);
    const headers = {
      authorization: `Bearer ${alice.token}`,
      'idempotency-key': 'source-http-work-item',
    };
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/messages/${source.id}/work-item`,
        headers,
        payload: {},
      });
      expect(response.statusCode, response.body).toBe(201);
      expect(response.json()).toMatchObject({
        projectId: project.id,
        description: source.body,
        sourceConversationId: conversation.id,
        sourceMessageId: source.id,
        sourceThreadId: null,
      });
    } finally {
      await app.close();
    }
  });

  it('fences reassignment revisions and releases active WorkItems when the assignee leaves the Project', () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Workspace', 'reassign-workspace');
    const computer = service.registerComputer(principal, { name: 'Alice Mac' }, 'reassign-computer');
    reportReadyRuntime(service, computer.computerId, alice.humanId);
    const builder = service.createAgent(principal, workspace.id, {
      name: 'Builder', runtimeBinding: { computerId: computer.computerId, runtimeId: 'generic-acp' },
    }, 'reassign-builder');
    const reviewer = service.createAgent(principal, workspace.id, {
      name: 'Reviewer', runtimeBinding: { computerId: computer.computerId, runtimeId: 'generic-acp' },
    }, 'reassign-reviewer');
    const project = service.createProject(principal, workspace.id, { name: 'Launch' }, 'reassign-project');
    const builderMember = service.addProjectMember(principal, project.id, {
      workspaceMembershipId: builder.membershipId, role: 'member',
    }, 'reassign-builder-project');
    const reviewerMember = service.addProjectMember(principal, project.id, {
      workspaceMembershipId: reviewer.membershipId, role: 'member',
    }, 'reassign-reviewer-project');
    const created = service.createWorkItem(principal, project.id, {
      description: '交叉检查任务看板', assigneeProjectMembershipId: builderMember.projectMembershipId,
    }, 'reassign-work-item');

    const reassigned = service.assignWorkItem(principal, created.id, {
      assigneeProjectMembershipId: reviewerMember.projectMembershipId,
      expectedRevision: created.revision,
      expectedAssignmentRevision: created.assignmentRevision,
    }, 'reassign-to-reviewer');
    expect(reassigned).toMatchObject({
      assignee: { actorId: reviewer.id }, assignmentRevision: 2, revision: 2, currentSubmission: null,
    });
    expect(service.listComputerAgentWorkItems(computer.computerId, builder.id)).toEqual([
      expect.objectContaining({ id: created.id, assignee: expect.objectContaining({ actorId: reviewer.id }) }),
    ]);
    expect(service.listComputerAgentWorkItems(computer.computerId, reviewer.id)).toEqual([
      expect.objectContaining({ id: created.id, assignmentRevision: 2 }),
    ]);
    expect(service.getComputerAgentInbox(computer.computerId, reviewer.id).targets).toEqual([
      expect.objectContaining({ kind: 'work_item', workItemId: created.id }),
    ]);
    expect(() => service.assignWorkItem(principal, created.id, {
      assigneeProjectMembershipId: builderMember.projectMembershipId,
      expectedRevision: created.revision,
      expectedAssignmentRevision: created.assignmentRevision,
    }, 'stale-reassignment')).toThrow(/changed concurrently/i);

    service.removeProjectMember(
      principal,
      project.id,
      reviewerMember.projectMembershipId,
      reviewerMember.revision,
      'remove-reviewer',
    );
    expect(service.getWorkItem(principal, created.id)).toMatchObject({
      lifecycleStatus: 'open', assignee: null, assignmentRevision: 3, revision: 3, currentSubmission: null,
    });
    expect(service.listComputerAgentWorkItems(computer.computerId, reviewer.id)).toEqual([]);
  });
});
