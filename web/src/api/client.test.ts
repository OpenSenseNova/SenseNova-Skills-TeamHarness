import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './client';

afterEach(() => vi.unstubAllGlobals());

describe('Artifact multipart client', () => {
  it('sends metadata before the file so Fastify can read streamed upload fields', async () => {
    const requests: string[][] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(Array.from((init?.body as FormData).keys()));
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    const file = new File(['fixture'], 'fixture.txt', { type: 'text/plain' });

    await api.createFileArtifact('workspace-1', file, file.name, ['project-1']);
    await api.replaceFileArtifactCurrent('artifact-1', file, 3);

    expect(requests).toEqual([
      ['name', 'projectIds', 'file'],
      ['expectedCurrentRevision', 'file'],
    ]);
  });
});

describe('empty success responses', () => {
  it('treats logout 204 No Content as success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));

    await expect(api.logout()).resolves.toBeUndefined();
  });
});
