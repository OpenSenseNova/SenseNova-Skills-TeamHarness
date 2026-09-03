import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { createTestService, testRuntimeConfigurationCapabilities } from './helpers.js';

describe('HTTP API', () => {
  it('exposes Project Resource, Artifact v2 and Link areas with project-scoped CAS', async () => {
    const { service } = createTestService();
    const bootstrap = service.bootstrapHuman('Alice', 'alice@example.com');
    const headers = { authorization: `Bearer ${bootstrap.token}` };
    const app = await buildApp(service);
    try {
      const workspace = (await app.inject({ method: 'POST', url: '/v1/workspaces', headers: { ...headers, 'idempotency-key': 'v2-http-workspace' }, payload: { name: 'V2' } })).json<{ id: string }>();
      const project = (await app.inject({ method: 'POST', url: `/v1/workspaces/${workspace.id}/projects`, headers: { ...headers, 'idempotency-key': 'v2-http-project' }, payload: { name: 'Project' } })).json<{ id: string }>();
      const boundary = 'anc-v2-boundary';
      const createdResource = await app.inject({ method: 'POST', url: `/v1/projects/${project.id}/resources`, headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: multipart(boundary, [{ name: 'file', filename: 'input.txt', contentType: 'text/plain', value: 'input' }]) });
      expect(createdResource.statusCode).toBe(201);
      const resource = createdResource.json<{ resourceId: string; revision: number; digest: string }>();
      const artifactResponse = await app.inject({ method: 'POST', url: `/v1/projects/${project.id}/artifacts`, headers: { ...headers, 'idempotency-key': 'v2-http-artifact', 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: multipart(boundary, [{ name: 'file', filename: 'output.txt', contentType: 'text/plain', value: 'output' }, { name: 'sourceResourceRefs', value: JSON.stringify([{ resourceId: resource.resourceId, revision: resource.revision, digest: resource.digest }]) }]) });
      expect(artifactResponse.statusCode).toBe(201);
      const published = artifactResponse.json<{ artifact: { artifactId: string }; version: { versionId: string; version: number } }>();
      expect(published.version.version).toBe(1);
      const listed = await app.inject({ method: 'GET', url: `/v1/projects/${project.id}/artifacts`, headers });
      expect(listed.json<{ items: unknown[] }>().items).toHaveLength(1);
      const linked = await app.inject({ method: 'POST', url: `/v1/projects/${project.id}/links`, headers, payload: { locator: 'https://example.com', name: 'Example' } });
      expect(linked.statusCode).toBe(201);
      expect(linked.json<{ locator: string }>().locator).toBe('https://example.com');
    } finally {
      await app.close();
    }
  });

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
      expect(project).toMatchObject({ role: 'owner' });

      const projectDmResponse = await app.inject({
        method: 'POST', url: `/v1/projects/${project.id}/conversations`,
        headers: { ...headers, 'idempotency-key': 'project-http-dm' },
        payload: { kind: 'dm' },
      });
      expect(projectDmResponse.statusCode).toBe(400);

      const conversationResponse = await app.inject({
        method: 'POST', url: `/v1/projects/${project.id}/conversations`,
        headers: { ...headers, 'idempotency-key': 'project-http-conversation' },
        payload: { kind: 'channel', title: 'Launch room', participantProjectMembershipIds: [] },
      });
      expect(conversationResponse.statusCode).toBe(201);
      expect(conversationResponse.json()).toMatchObject({ projectId: project.id });

      const projectList = await app.inject({
        method: 'GET', url: `/v1/projects/${project.id}/conversations`, headers,
      });
      expect(projectList.json<{ items: unknown[] }>().items).toHaveLength(2);
      const workspaceList = await app.inject({
        method: 'GET', url: `/v1/workspaces/${workspace.id}/conversations`, headers,
      });
      expect(workspaceList.json<{ items: Array<{ scope: { type: string } }> }>().items).toEqual([
        expect.objectContaining({ scope: { type: 'workspace_general' } }),
      ]);
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
      method: 'GET',
      url: `/v1/workspaces/${workspace.id}/conversations`,
      headers: { authorization: `Bearer ${bootstrap.token}` },
    });
    expect(conversationResponse.statusCode, conversationResponse.body).toBe(200);
    const conversation = conversationResponse.json<{ items: Array<{ id: string }> }>().items[0]!;

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
    const sourceMessage = sourceResponse.json<{
      mentionOutcomes: Array<{ agentRequestId: string | null }>;
    }>();
    const agentRequestId = sourceMessage.mentionOutcomes[0]!.agentRequestId!;
    const computerHeaders = { authorization: `Bearer ${computer.token}` };

    const denied = await app.inject({
      method: 'GET', url: `/v1/computers/self/agents/${agent.id}/inbox`, headers: humanHeaders,
    });
    expect(denied.statusCode).toBe(403);

    const inboxResponse = await app.inject({
      method: 'GET', url: `/v1/computers/self/agents/${agent.id}/inbox`, headers: computerHeaders,
    });
    expect(inboxResponse.statusCode).toBe(200);
    expect(inboxResponse.json<{ targets: Array<{ target: string; pendingCount: number }> }>().targets
      .find((item) => item.target === `conversation:${conversation.id}`)?.pendingCount).toBe(1);

    const receipt = 'http-inbox-receipt';
    const target = `conversation:${conversation.id}`;
    const claimResponse = await app.inject({
      method: 'POST', url: `/v1/computers/self/agents/${agent.id}/inbox/claim`,
      headers: { ...computerHeaders, 'idempotency-key': 'ctx-claim' },
      payload: { target, receipt, agentRequestId },
    });
    expect(claimResponse.statusCode, claimResponse.body).toBe(200);
    const claimed = claimResponse.json<{
      discussion: { throughPosition: number; messages: Array<{ body: string }> };
    }>();
    expect(claimed.discussion.messages
      .map((item) => item.body)).toEqual(['@Researcher 请直接查一下 xxx']);
    const sendResponse = await app.inject({
      method: 'POST', url: `/v1/computers/self/agents/${agent.id}/messages`,
      headers: { ...computerHeaders, 'idempotency-key': 'ctx-send' },
      payload: {
        conversationId: conversation.id,
        threadId: null,
        receipt,
        draftId: agent.id,
        expectedDiscussionFrontier: claimed.discussion.throughPosition,
        body: '收到，已停止查询。',
        mode: 'check',
      },
    });
    expect(sendResponse.statusCode, sendResponse.body).toBe(200);
    expect(sendResponse.json()).toMatchObject({
      status: 'published',
      message: { body: '收到，已停止查询。' },
    });
    await app.inject({
      method: 'POST', url: `/v1/conversations/${conversation.id}/messages`,
      headers: { ...humanHeaders, 'idempotency-key': 'ctx-update' }, payload: { body: '不用查了' },
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
      method: 'GET', url: `/v1/workspaces/${workspace.id}/conversations`, headers,
    });
    const conversation = conversationResponse.json<{ items: Array<{ id: string; revision: number }> }>().items[0]!;
    const authorized = await app.inject({
      method: 'PUT', url: `/v1/conversations/${conversation.id}/participants/${agent.membershipId}`,
      headers: { ...headers, 'idempotency-key': 'collab-conversation-agent' },
      payload: { expectedRevision: conversation.revision },
    });
    expect(authorized.statusCode, authorized.body).toBe(200);

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

  it.skip('exposes one multipart upload, version download, recycle and cleanup Artifact contract', async () => {
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

      const boundary = 'anc-artifact-boundary';
      const fileResponse = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspace.id}/artifacts`,
        headers: {
          ...headers,
          'idempotency-key': 'artifact-http-file',
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: multipart(boundary, [
          { name: 'projectIds', value: JSON.stringify([project.id]) },
          {
            name: 'file', filename: 'deck.pptx',
            contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            value: 'streamed payload',
          },
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
      expect(download.headers['content-type'])
        .toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
      expect(download.headers['content-disposition'])
        .toBe(`attachment; filename*=UTF-8''${encodeURIComponent('deck.pptx')}`);

      expect((await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspace.id}/artifacts/markdown`,
        headers: { ...headers, 'idempotency-key': 'artifact-http-obsolete-markdown' },
        payload: { name: 'Obsolete.md' },
      })).statusCode).toBe(404);
      expect((await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspace.id}/artifacts/urls`,
        headers: { ...headers, 'idempotency-key': 'artifact-http-obsolete-url' },
        payload: { name: 'Obsolete', url: 'https://example.com' },
      })).statusCode).toBe(404);
      expect((await app.inject({
        method: 'GET', url: `/v1/projects/${project.id}/resource-links`, headers,
      })).statusCode).toBe(404);

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
