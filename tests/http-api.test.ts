import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { createTestService, testRuntimeConfigurationCapabilities } from './helpers.js';

describe('HTTP API', () => {
  it('exposes Project management and Project-scoped Conversation routes without merging Workspace Conversations', async () => {
    const { service } = createTestService();
    const bootstrap = service.bootstrapHuman('Alice', 'alice@example.com');
    const app = await buildApp(service);
    const headers = { authorization: `Bearer ${bootstrap.token}` };
    try {
      const workspaceResponse = await app.inject({
        method: 'POST', url: '/v1/workspaces',
        headers: { ...headers, 'idempotency-key': 'project-http-workspace' },
        payload: { name: 'Product' },
      });
      const workspace = workspaceResponse.json<{ id: string }>();
      const projectResponse = await app.inject({
        method: 'POST', url: `/v1/workspaces/${workspace.id}/projects`,
        headers: { ...headers, 'idempotency-key': 'project-http-create' },
        payload: {
          name: 'Launch',
          description: 'Launch repository',
          repository: { cloneUrl: 'git@github.com:example/launch.git', defaultBranch: 'main' },
        },
      });
      expect(projectResponse.statusCode).toBe(201);
      const project = projectResponse.json<{ id: string; membershipId: string; role: string }>();
      expect(project).toMatchObject({ role: 'manager' });

      const projectDmResponse = await app.inject({
        method: 'POST', url: `/v1/projects/${project.id}/conversations`,
        headers: { ...headers, 'idempotency-key': 'project-http-dm' },
        payload: { kind: 'dm' },
      });
      expect(projectDmResponse.statusCode).toBe(400);

      const conversationResponse = await app.inject({
        method: 'POST', url: `/v1/projects/${project.id}/conversations`,
        headers: { ...headers, 'idempotency-key': 'project-http-conversation' },
        payload: { kind: 'channel', title: 'Launch room' },
      });
      expect(conversationResponse.statusCode).toBe(201);
      expect(conversationResponse.json()).toMatchObject({ projectId: project.id });

      const projectList = await app.inject({
        method: 'GET', url: `/v1/projects/${project.id}/conversations`, headers,
      });
      expect(projectList.json<{ items: unknown[] }>().items).toHaveLength(1);
      const workspaceList = await app.inject({
        method: 'GET', url: `/v1/workspaces/${workspace.id}/conversations`, headers,
      });
      expect(workspaceList.json<{ items: unknown[] }>().items).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('exposes the versioned Workspace Document Library', async () => {
    const { service } = createTestService();
    const bootstrap = service.bootstrapHuman('Alice', 'alice@example.com');
    const app = await buildApp(service);
    const headers = { authorization: `Bearer ${bootstrap.token}` };
    try {
      const workspaceResponse = await app.inject({
        method: 'POST', url: '/v1/workspaces',
        headers: { ...headers, 'idempotency-key': 'docs-workspace' }, payload: { name: 'Product' },
      });
      const workspace = workspaceResponse.json<{ id: string }>();
      const createdResponse = await app.inject({
        method: 'POST', url: `/v1/workspaces/${workspace.id}/documents`,
        headers: { ...headers, 'idempotency-key': 'docs-create' },
        payload: { title: 'Team guide', contentMarkdown: '# Team guide\n\nUse review.' },
      });
      expect(createdResponse.statusCode).toBe(201);
      const created = createdResponse.json<{ id: string; revision: number }>();
      const updatedResponse = await app.inject({
        method: 'PUT', url: `/v1/workspaces/${workspace.id}/documents/${created.id}`,
        headers: { ...headers, 'idempotency-key': 'docs-update' },
        payload: { title: 'Team guide', contentMarkdown: '# Team guide\n\nUse review and record decisions.', expectedRevision: created.revision },
      });
      expect(updatedResponse.statusCode).toBe(200);
      expect(updatedResponse.json()).toMatchObject({ id: created.id, revision: 2, version: 2 });
      const listedResponse = await app.inject({
        method: 'GET', url: `/v1/workspaces/${workspace.id}/documents`, headers,
      });
      expect(listedResponse.statusCode).toBe(200);
      expect(listedResponse.json()).toMatchObject({ items: [{ id: created.id, version: 2 }] });
    } finally {
      await app.close();
    }
  });

  it('binds the actor from a hashed bearer token and exposes the minimal collaboration chain', async () => {
    const { service, workspaceDatabase } = createTestService();
    const bootstrap = service.bootstrapHuman('Alice', 'alice@example.com');
    const app = await buildApp(service);

    const unauthorized = await app.inject({ method: 'POST', url: '/v1/workspaces', payload: { name: 'Product' } });
    expect(unauthorized.statusCode).toBe(400);

    const workspaceResponse = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: { authorization: `Bearer ${bootstrap.token}`, 'idempotency-key': 'http-workspace' },
      payload: { name: 'Product' },
    });
    expect(workspaceResponse.statusCode).toBe(201);
    const workspace = workspaceResponse.json<{ id: string; membershipId: string }>();

    const conversationResponse = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/conversations`,
      headers: { authorization: `Bearer ${bootstrap.token}`, 'idempotency-key': 'http-conversation' },
      payload: { kind: 'channel', title: 'General' },
    });
    expect(conversationResponse.statusCode, conversationResponse.body).toBe(201);
    const conversation = conversationResponse.json<{ id: string }>();

    const messageResponse = await app.inject({
      method: 'POST',
      url: `/v1/conversations/${conversation.id}/messages`,
      headers: { authorization: `Bearer ${bootstrap.token}`, 'idempotency-key': 'http-message' },
      payload: { body: 'hello' },
    });
    expect(messageResponse.statusCode).toBe(201);

    const listResponse = await app.inject({
      method: 'GET',
      url: `/v1/conversations/${conversation.id}/messages`,
      headers: { authorization: `Bearer ${bootstrap.token}` },
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json<{ items: unknown[] }>().items).toHaveLength(1);

    const tokenRow = workspaceDatabase.raw.prepare('SELECT token_hash FROM api_tokens WHERE human_actor_id = ?').get(bootstrap.humanId) as {
      token_hash: string;
    };
    expect(tokenRow.token_hash).not.toContain(bootstrap.token);
    expect(tokenRow.token_hash).toHaveLength(64);
    const persistedText = JSON.stringify(workspaceDatabase.raw.prepare('SELECT * FROM idempotency_records').all());
    expect(persistedText).not.toContain(bootstrap.token);

    await app.close();
  });

  it('uses a Computer token for the pull-based Agent Inbox', async () => {
    const { service, workspaceDatabase } = createTestService();
    const bootstrap = service.bootstrapHuman('Alice', 'alice@example.com');
    const humanHeaders = { authorization: `Bearer ${bootstrap.token}` };
    const app = await buildApp(service);

    const workspaceResponse = await app.inject({
      method: 'POST', url: '/v1/workspaces',
      headers: { ...humanHeaders, 'idempotency-key': 'ctx-workspace' }, payload: { name: 'Product' },
    });
    const workspace = workspaceResponse.json<{ id: string }>();
    const agentResponse = await app.inject({
      method: 'POST', url: `/v1/workspaces/${workspace.id}/agents`,
      headers: { ...humanHeaders, 'idempotency-key': 'ctx-agent' }, payload: { name: 'Researcher' },
    });
    const agent = agentResponse.json<{ id: string; membershipId: string }>();
    const computerResponse = await app.inject({
      method: 'POST', url: '/v1/computers',
      headers: { ...humanHeaders, 'idempotency-key': 'ctx-computer' }, payload: { name: 'Alice Mac' },
    });
    const computer = computerResponse.json<{ computerId: string; token: string }>();
    const replayedComputer = await app.inject({
      method: 'POST', url: '/v1/computers',
      headers: { ...humanHeaders, 'idempotency-key': 'ctx-computer' }, payload: { name: 'Alice Mac' },
    });
    expect(replayedComputer.statusCode).toBe(409);
    expect(replayedComputer.json<{ error: { code: string } }>().error.code).toBe('TOKEN_ALREADY_ISSUED');
    expect(JSON.stringify(workspaceDatabase.raw.prepare('SELECT * FROM idempotency_records').all())).not.toContain(computer.token);
    const runtimeCatalogResponse = await app.inject({
      method: 'PUT', url: '/v1/computers/self/runtime-catalog',
      headers: { authorization: `Bearer ${computer.token}` },
      payload: {
        runtimes: ['generic-acp', 'codex', 'claude', 'gemini', 'goose', 'hermes'].map((runtimeId) => ({
          runtimeId,
          availability: runtimeId === 'generic-acp' ? 'ready' : 'not_installed',
          skills: { global: [], workspace: [] },
          ...(runtimeId === 'generic-acp'
            ? { configuration: testRuntimeConfigurationCapabilities() }
            : {
                unavailableReason: {
                  code: 'not_installed',
                  message: 'The Runtime is not installed in this HTTP fixture.',
                },
              }),
        })),
      },
    });
    expect(runtimeCatalogResponse.statusCode).toBe(200);
    const computersResponse = await app.inject({
      method: 'GET', url: '/v1/computers', headers: humanHeaders,
    });
    expect(computersResponse.statusCode).toBe(200);
    expect(computersResponse.json<{ items: unknown[] }>().items).toEqual([
      expect.objectContaining({
        id: computer.computerId,
        connectionStatus: 'online',
        runtimeCatalogRevision: 1,
        runtimes: expect.arrayContaining([
          expect.objectContaining({
            runtimeId: 'generic-acp',
            availability: 'ready',
            configuration: expect.objectContaining({
              defaultModelId: 'runtime-default',
              defaultReasoningEffort: 'medium',
              defaultModeId: 'default',
            }),
            unavailableReason: null,
          }),
        ]),
      }),
    ]);
    expect(computersResponse.body).not.toContain(computer.token);
    expect(computersResponse.body).not.toContain('command');
    const bindingResponse = await app.inject({
      method: 'POST', url: `/v1/workspaces/${workspace.id}/agents/${agent.id}/runtime-bindings`,
      headers: { ...humanHeaders, 'idempotency-key': 'ctx-binding' },
      payload: { computerId: computer.computerId, runtimeId: 'generic-acp', expectedRevision: 0 },
    });
    expect(bindingResponse.statusCode).toBe(201);
    expect(bindingResponse.json()).toMatchObject({
      computerConnectionStatus: 'online',
      runtimeAvailability: 'ready',
      validatedRuntimeCatalogRevision: 1,
      runtimeCatalogRevision: 1,
      bindingRevision: 1,
      configuration: {
        requested: { model: null, reasoningEffort: null, mode: null },
        effective: {
          model: { value: 'runtime-default', source: 'runtime_default' },
          reasoningEffort: { value: 'medium', source: 'runtime_default' },
          mode: { value: 'default', source: 'runtime_default' },
        },
        status: 'valid',
        invalidReason: null,
      },
    });
    const conversationResponse = await app.inject({
      method: 'POST', url: `/v1/workspaces/${workspace.id}/conversations`,
      headers: { ...humanHeaders, 'idempotency-key': 'ctx-conversation' },
      payload: { kind: 'dm', directWorkspaceMembershipIds: [agent.membershipId] },
    });
    expect(conversationResponse.statusCode, conversationResponse.body).toBe(201);
    const conversation = conversationResponse.json<{ id: string }>();
    const sourceResponse = await app.inject({
      method: 'POST', url: `/v1/conversations/${conversation.id}/messages`,
      headers: { ...humanHeaders, 'idempotency-key': 'ctx-source' },
      payload: { body: '@Researcher 请直接查一下 xxx', mentionedActorIds: [agent.id] },
    });
    expect(sourceResponse.statusCode).toBe(201);
    const source = sourceResponse.json<{ id: string; mentionOutcomes: Array<{ agentRequestId: string }> }>();
    const requestId = source.mentionOutcomes[0]!.agentRequestId;
    const computerHeaders = { authorization: `Bearer ${computer.token}` };
    const acceptResponse = await app.inject({
      method: 'POST', url: `/v1/agent-requests/${requestId}/accept`,
      headers: { ...computerHeaders, 'idempotency-key': 'ctx-accept' }, payload: { expectedVersion: 1 },
    });
    expect(acceptResponse.statusCode).toBe(201);
    const run = acceptResponse.json<{ id: string }>();
    const attemptResponse = await app.inject({
      method: 'POST', url: `/v1/runs/${run.id}/attempts`,
      headers: { ...computerHeaders, 'idempotency-key': 'ctx-attempt' },
    });
    expect(attemptResponse.statusCode).toBe(201);
    const attempt = attemptResponse.json<{ id: string }>();

    const denied = await app.inject({
      method: 'GET', url: `/v1/computers/self/agents/${agent.id}/inbox`, headers: humanHeaders,
    });
    expect(denied.statusCode).toBe(403);

    const inboxResponse = await app.inject({
      method: 'GET', url: `/v1/computers/self/agents/${agent.id}/inbox`, headers: computerHeaders,
    });
    expect(inboxResponse.statusCode).toBe(200);
    expect(inboxResponse.json<{ targets: Array<{ pendingCount: number }> }>().targets[0]?.pendingCount).toBe(1);

    await app.inject({
      method: 'POST', url: `/v1/conversations/${conversation.id}/messages`,
      headers: { ...humanHeaders, 'idempotency-key': 'ctx-update' }, payload: { body: '不用查了' },
    });
    const receipt = `${attempt.id}:http-inbox`;
    const claimResponse = await app.inject({
      method: 'POST', url: `/v1/computers/self/agents/${agent.id}/inbox/claim`,
      headers: { ...computerHeaders, 'idempotency-key': 'ctx-claim' },
      payload: { attemptId: attempt.id, conversationId: conversation.id, threadId: null, receipt },
    });
    expect(claimResponse.statusCode, claimResponse.body).toBe(200);
    expect(claimResponse.json<{ discussion: { messages: Array<{ body: string }> } }>().discussion.messages
      .map((item) => item.body)).toEqual(['@Researcher 请直接查一下 xxx', '不用查了']);
    service.localExecutions.start(attempt.id, workspace.id, run.id);
    const sendResponse = await app.inject({
      method: 'POST', url: `/v1/computers/self/agents/${agent.id}/messages`,
      headers: { ...computerHeaders, 'idempotency-key': 'ctx-send' },
      payload: {
        attemptId: attempt.id,
        conversationId: conversation.id,
        threadId: null,
        receipt,
        body: '收到，已停止查询。',
      },
    });
    expect(sendResponse.statusCode, sendResponse.body).toBe(201);

    const finishResponse = await app.inject({
      method: 'POST', url: `/v1/attempts/${attempt.id}/return`,
      headers: { ...computerHeaders, 'idempotency-key': 'ctx-return' },
      payload: { disposition: 'publish', messages: [], artifactPublications: [] },
    });
    expect(finishResponse.statusCode).toBe(200);
    expect(finishResponse.json<{ run: { status: string; outcome: string } }>().run).toMatchObject({
      status: 'terminal', outcome: 'publish',
    });
    await app.close();
  });

  it('exposes the durable mention-to-request and cancellation contract', async () => {
    const { service } = createTestService();
    const bootstrap = service.bootstrapHuman('Alice', 'alice@example.com');
    const headers = { authorization: `Bearer ${bootstrap.token}` };
    const app = await buildApp(service);

    const workspaceResponse = await app.inject({
      method: 'POST', url: '/v1/workspaces',
      headers: { ...headers, 'idempotency-key': 'collab-workspace' }, payload: { name: 'Product' },
    });
    const workspace = workspaceResponse.json<{ id: string }>();
    const agentResponse = await app.inject({
      method: 'POST', url: `/v1/workspaces/${workspace.id}/agents`,
      headers: { ...headers, 'idempotency-key': 'collab-agent' }, payload: { name: 'Researcher' },
    });
    const agent = agentResponse.json<{ id: string; membershipId: string }>();
    const conversationResponse = await app.inject({
      method: 'POST', url: `/v1/workspaces/${workspace.id}/conversations`,
      headers: { ...headers, 'idempotency-key': 'collab-conversation' },
      payload: { kind: 'channel' },
    });
    const conversation = conversationResponse.json<{ id: string }>();

    const messageResponse = await app.inject({
      method: 'POST', url: `/v1/conversations/${conversation.id}/messages`,
      headers: { ...headers, 'idempotency-key': 'collab-message' },
      payload: { body: '@Researcher 查一下', mentionedActorIds: [agent.id] },
    });
    expect(messageResponse.statusCode).toBe(201);
    const message = messageResponse.json<{
      id: string;
      mentionOutcomes: Array<{ outcome: string; agentRequestId: string }>;
    }>();
    expect(message.mentionOutcomes).toHaveLength(1);
    expect(message.mentionOutcomes[0]?.outcome).toBe('requested');
    const requestId = message.mentionOutcomes[0]!.agentRequestId;

    const requestsResponse = await app.inject({
      method: 'GET', url: `/v1/conversations/${conversation.id}/agent-requests`, headers,
    });
    expect(requestsResponse.statusCode).toBe(200);
    expect(requestsResponse.json<{ items: Array<{ id: string; status: string }> }>().items).toEqual([
      expect.objectContaining({ id: requestId, status: 'pending' }),
    ]);

    const cancelResponse = await app.inject({
      method: 'POST', url: `/v1/agent-requests/${requestId}/cancel`,
      headers: { ...headers, 'idempotency-key': 'collab-cancel' },
      payload: { expectedVersion: 1 },
    });
    expect(cancelResponse.statusCode).toBe(200);
    expect(cancelResponse.json<{ status: string; version: number; terminalReason: { code: string } }>()).toMatchObject({
      status: 'cancelled',
      version: 2,
      terminalReason: { code: 'requestor_cancelled' },
    });

    const messagesResponse = await app.inject({
      method: 'GET', url: `/v1/conversations/${conversation.id}/messages`, headers,
    });
    expect(messagesResponse.json<{ items: Array<{ mentionOutcomes: Array<{ outcome: string }> }> }>()
      .items[0]!.mentionOutcomes[0]!.outcome).toBe('requested');
    await app.close();
  });

  it('exposes Markdown, multipart File, version download, recycle and cleanup Artifact contracts', async () => {
    const { service } = createTestService();
    const bootstrap = service.bootstrapHuman('Alice', 'alice@example.com');
    const headers = { authorization: `Bearer ${bootstrap.token}` };
    const app = await buildApp(service);
    try {
      const workspace = (await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        headers: { ...headers, 'idempotency-key': 'artifact-http-workspace' },
        payload: { name: 'Artifacts' },
      })).json<{ id: string }>();
      const projectResponse = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspace.id}/projects`,
        headers: { ...headers, 'idempotency-key': 'artifact-http-project' },
        payload: { name: 'No repository required' },
      });
      expect(projectResponse.statusCode).toBe(201);
      const project = projectResponse.json<{ id: string; repository: null }>();
      expect(project.repository).toBeNull();

      const markdownResponse = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspace.id}/artifacts/markdown`,
        headers: { ...headers, 'idempotency-key': 'artifact-http-markdown' },
        payload: { name: 'Notes.md', projectIds: [project.id] },
      });
      expect(markdownResponse.statusCode).toBe(201);
      const markdown = markdownResponse.json<{
        id: string;
        currentState: { currentRevision: number };
        latestSnapshot: null;
      }>();
      expect(markdown.latestSnapshot).toBeNull();
      const savedResponse = await app.inject({
        method: 'POST',
        url: `/v1/artifacts/${markdown.id}/snapshots`,
        headers: { ...headers, 'idempotency-key': 'artifact-http-save' },
        payload: {
          expectedCurrentRevision: markdown.currentState.currentRevision,
          label: null,
        },
      });
      expect(savedResponse.statusCode).toBe(200);
      expect(savedResponse.json<{ snapshot: { snapshotId: string; label: null }; created: boolean }>().created).toBe(true);

      const boundary = 'anc-artifact-boundary';
      const fileResponse = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspace.id}/artifacts/files`,
        headers: {
          ...headers,
          'idempotency-key': 'artifact-http-file',
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: multipart(boundary, [
          { name: 'name', value: 'payload.txt' },
          { name: 'projectIds', value: JSON.stringify([project.id]) },
          { name: 'file', filename: 'payload.txt', contentType: 'text/plain', value: 'streamed payload' },
        ]),
      });
      expect(fileResponse.statusCode).toBe(201);
      const file = fileResponse.json<{ id: string; currentState: { byteLength: number } }>();
      expect(file.currentState.byteLength).toBe(Buffer.byteLength('streamed payload'));
      const download = await app.inject({
        method: 'GET',
        url: `/v1/artifacts/${file.id}/current/download`,
        headers,
      });
      expect(download.statusCode).toBe(200);
      expect(download.body).toBe('streamed payload');

      const artifact = (await app.inject({ method: 'GET', url: `/v1/artifacts/${file.id}`, headers }))
        .json<{ revision: number }>();
      expect((await app.inject({
        method: 'DELETE',
        url: `/v1/artifacts/${file.id}`,
        headers: { ...headers, 'idempotency-key': 'artifact-http-delete' },
        payload: { expectedRevision: artifact.revision },
      })).statusCode).toBe(200);
      expect((await app.inject({
        method: 'GET', url: `/v1/workspaces/${workspace.id}/artifacts/trash`, headers,
      })).json<{ items: Array<{ id: string }> }>().items.map((item) => item.id)).toContain(file.id);
      expect((await app.inject({
        method: 'GET', url: `/v1/workspaces/${workspace.id}/artifacts/cleanup-status`, headers,
      })).json<{ deletedCount: number }>().deletedCount).toBe(1);
    } finally {
      await app.close();
    }
  });
});

function multipart(
  boundary: string,
  parts: Array<{ name: string; value: string; filename?: string; contentType?: string }>,
): Buffer {
  const lines: string[] = [];
  for (const part of parts) {
    lines.push(`--${boundary}`);
    lines.push(`Content-Disposition: form-data; name="${part.name}"${part.filename ? `; filename="${part.filename}"` : ''}`);
    if (part.contentType) lines.push(`Content-Type: ${part.contentType}`);
    lines.push('', part.value);
  }
  lines.push(`--${boundary}--`, '');
  return Buffer.from(lines.join('\r\n'));
}
