import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Hocuspocus } from '@hocuspocus/server';
import { Database } from '@hocuspocus/extension-database';
import { WebSocketServer, type WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { HumanPrincipal } from '../domain/types.js';
import type { WorkspaceService } from '../domain/workspace-service.js';
import { invariant } from '../lib/errors.js';
import { MAX_ARTIFACT_BYTES } from '../storage/content-blob-store.js';

interface CollaborationContext {
  membershipId: string;
  actorId: string;
}

const COLLABORATION_PATH = '/v1/artifacts/collaboration';

export interface ArtifactCollaborationController {
  flushDocument(artifactId: string): Promise<void>;
}

export function attachArtifactCollaboration(app: FastifyInstance, service: WorkspaceService): ArtifactCollaborationController {
  const hocuspocus = new Hocuspocus<CollaborationContext>({
    quiet: true,
    debounce: 750,
    maxDebounce: 5_000,
    extensions: [
      new Database({
        fetch: async ({ documentName }) => service.artifacts.fetchDraftState(documentName),
        store: async ({ documentName, state, lastContext }) => {
          const context = lastContext as CollaborationContext | undefined;
          invariant(context?.membershipId, 'WORKSPACE_MEMBERSHIP_REQUIRED', 'An active Workspace Membership is required.', 403);
          service.artifacts.storeDraftState(documentName, context.membershipId, state);
        },
      }),
    ],
    async onAuthenticate({ token, requestHeaders, documentName }) {
      const sessionToken = token || cookieValue(requestHeaders.get('cookie'), 'anc_session');
      invariant(sessionToken, 'AUTHENTICATION_REQUIRED', 'Authentication is required.', 401);
      const principal = service.authenticate(sessionToken);
      invariant(principal.kind === 'human', 'HUMAN_PRINCIPAL_REQUIRED', 'A Human session is required.', 403);
      const authorization = service.artifacts.authorizeDraft(principal as HumanPrincipal, documentName);
      return { membershipId: authorization.membershipId, actorId: principal.actorId };
    },
  });
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_ARTIFACT_BYTES + 1024 * 1024 });

  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (requestUrl.pathname !== COLLABORATION_PATH) return;
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      connect(websocket, request, hocuspocus);
    });
  };
  app.server.on('upgrade', upgrade);
  app.addHook('onClose', async () => {
    app.server.off('upgrade', upgrade);
    hocuspocus.flushPendingStores();
    hocuspocus.closeConnections();
    await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
  });
  return {
    async flushDocument(artifactId: string) {
      const document = hocuspocus.documents.get(artifactId);
      if (!document) return;
      hocuspocus.flushPendingStores();
      await document.saveMutex.waitForUnlock();
    },
  };
}

function connect(
  websocket: WebSocket,
  request: IncomingMessage,
  hocuspocus: Hocuspocus<CollaborationContext>,
): void {
  const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  const webRequest = new Request(requestUrl, { headers });
  const connection = hocuspocus.handleConnection(websocket, webRequest);
  websocket.on('message', (data) => {
    const bytes = typeof data === 'string'
      ? Buffer.from(data)
      : Array.isArray(data)
        ? Buffer.concat(data)
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    connection.handleMessage(bytes);
  });
  websocket.on('close', (code, reason) => connection.handleClose({ code, reason: reason.toString() }));
}

function cookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
}
