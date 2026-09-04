import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './client';

afterEach(() => vi.unstubAllGlobals());

describe('Artifact v2 multipart client', () => {
  it('sends the uploaded file to the project-scoped Artifact endpoint', async () => {
    const requests: Array<{ url: string; fields: string[] }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(_input),
        fields: Array.from((init?.body as FormData).keys()),
      });
      return new Response(JSON.stringify({ artifact: {}, version: {}, created: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    const file = new File(['fixture'], 'fixture.txt', { type: 'text/plain' });

    await api.publishArtifactV2('project-1', file);

    expect(requests).toEqual([{ url: '/v1/projects/project-1/artifacts', fields: ['file'] }]);
  });
});

describe('empty success responses', () => {
  it('treats logout 204 No Content as success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));

    await expect(api.logout()).resolves.toBeUndefined();
  });
});

describe('JSON transport for project resources', () => {
  it('maps structured API errors to ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'PROJECT_ACCESS_DENIED', message: '没有权限访问这个项目。', details: { projectId: 'project-1' } },
    }), { status: 403, headers: { 'content-type': 'application/json' } })));

    await expect(api.listProjectResources('project-1')).rejects.toMatchObject({
      status: 403,
      code: 'PROJECT_ACCESS_DENIED',
      message: '没有权限访问这个项目。',
      details: { projectId: 'project-1' },
    });
  });
});

describe('idempotency keys', () => {
  it('generates a UUID when randomUUID is unavailable in a LAN HTTP context', async () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.set(Array.from({ length: 16 }, (_, index) => index));
        return bytes;
      },
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      id: '6c07fe76-1237-4998-8250-d20c61e90024',
      name: 'test',
      revision: 1,
      contextVersion: 1,
      membershipId: '5f9195bf-903d-480d-90eb-5404dc4eefb4',
      membershipRole: 'owner',
      createdAt: 1,
      updatedAt: 1,
    }), { status: 201, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await api.createWorkspace('test');

    const request = fetchMock.mock.calls[0]![0] as Request;
    expect(request.headers.get('idempotency-key')).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
  });
});
