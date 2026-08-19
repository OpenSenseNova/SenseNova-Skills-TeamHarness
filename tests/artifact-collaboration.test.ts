import { HocuspocusProvider, type HocuspocusProviderConfiguration } from '@hocuspocus/provider';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { createTestService } from './helpers.js';

describe('Artifact collaboration WebSocket', () => {
  it('synchronizes two clients and restores the raw Yjs document after a server restart', async () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Product', 'collaboration-workspace');
    const artifact = service.artifacts.createMarkdown(principal, workspace.id, { name: 'Shared.md' }, 'collaboration-artifact');

    const firstApp = await buildApp(service);
    await firstApp.listen({ host: '127.0.0.1', port: 0 });
    const firstAddress = firstApp.server.address();
    if (!firstAddress || typeof firstAddress === 'string') throw new Error('Expected a TCP listener.');
    const firstUrl = `ws://127.0.0.1:${firstAddress.port}/v1/artifacts/collaboration`;
    const firstDocument = new Y.Doc();
    const secondDocument = new Y.Doc();
    const firstProvider = provider(firstUrl, artifact.id, alice.token, firstDocument);
    const secondProvider = provider(firstUrl, artifact.id, alice.token, secondDocument);
    await waitUntil(() => firstProvider.isSynced && secondProvider.isSynced);

    firstDocument.getText('content').insert(0, '# Shared\n\nHello collaborators.');
    await waitUntil(() => secondDocument.getText('content').toString() === '# Shared\n\nHello collaborators.');
    const flushed = await firstApp.inject({
      method: 'POST',
      url: `/v1/artifacts/${artifact.id}/draft/flush`,
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(flushed.statusCode).toBe(200);
    expect(flushed.json<{ currentState: { currentRevision: number } }>().currentState.currentRevision).toBeGreaterThanOrEqual(1);
    firstProvider.destroy();
    secondProvider.destroy();
    await firstApp.close();

    const secondApp = await buildApp(service);
    await secondApp.listen({ host: '127.0.0.1', port: 0 });
    const secondAddress = secondApp.server.address();
    if (!secondAddress || typeof secondAddress === 'string') throw new Error('Expected a TCP listener.');
    const restoredDocument = new Y.Doc();
    const restoredProvider = provider(
      `ws://127.0.0.1:${secondAddress.port}/v1/artifacts/collaboration`,
      artifact.id,
      alice.token,
      restoredDocument,
    );
    await waitUntil(() => restoredProvider.isSynced);
    expect(restoredDocument.getText('content').toString()).toBe('# Shared\n\nHello collaborators.');
    restoredProvider.destroy();
    await secondApp.close();
  }, 15_000);
});

function provider(url: string, name: string, token: string, document: Y.Doc): HocuspocusProvider {
  return new HocuspocusProvider({
    url,
    name,
    token,
    document,
    WebSocketPolyfill: WebSocket,
  } as unknown as HocuspocusProviderConfiguration);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for collaboration state.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
