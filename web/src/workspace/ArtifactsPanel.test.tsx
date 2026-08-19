import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { Artifact } from '../api/client';
import { ArtifactsPanel } from './ArtifactsPanel';

afterEach(() => vi.unstubAllGlobals());

const workspaceId = '6c07fe76-1237-4998-8250-d20c61e90024';
const projectId = '11111111-1237-4998-8250-d20c61e90024';
const projectArtifact = artifact('22222222-1237-4998-8250-d20c61e90024', 'Project plan.md', [projectId]);
const workspaceArtifact = artifact('33333333-1237-4998-8250-d20c61e90024', 'Workspace guide.md', []);
const deletedArtifact = {
  ...artifact('44444444-1237-4998-8250-d20c61e90024', 'Deleted.md', [projectId]),
  status: 'deleted' as const,
  deletedAt: 10,
  purgeAfter: Date.now() + 60_000,
};

describe('Artifacts panel', () => {
  it('filters by Project, associates Workspace Artifacts, and exposes recycle status and restore', async () => {
    const user = userEvent.setup();
    let restored = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname.endsWith('/artifacts/trash')) return json({ items: restored ? [] : [deletedArtifact] });
      if (request.method === 'GET' && url.pathname.endsWith('/artifacts/cleanup-status')) return json({
        deletedCount: restored ? 0 : 1,
        expiredDeletedCount: 0,
        stagedBlobCount: 0,
        expiredStagedBlobCount: 0,
        nextPurgeAt: deletedArtifact.purgeAfter,
        checkedAt: Date.now(),
      });
      if (request.method === 'GET' && url.pathname.endsWith('/artifacts')) {
        return json({ items: url.searchParams.get('projectId') ? [projectArtifact] : [projectArtifact, workspaceArtifact] });
      }
      if (request.method === 'PUT' && url.pathname === `/v1/projects/${projectId}/artifacts/${workspaceArtifact.id}`) {
        return json({ ...workspaceArtifact, projectIds: [projectId] });
      }
      if (request.method === 'POST' && url.pathname === `/v1/artifacts/${deletedArtifact.id}/restore`) {
        restored = true;
        return json({ ...deletedArtifact, status: 'active', deletedAt: null, purgeAfter: null, revision: 3 });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ConfigProvider>
        <AntApp>
          <QueryClientProvider client={queryClient}>
            <MemoryRouter><ArtifactsPanel workspaceId={workspaceId} projectId={projectId} /></MemoryRouter>
          </QueryClientProvider>
        </AntApp>
      </ConfigProvider>,
    );

    expect(await screen.findByText('Project plan.md')).toBeVisible();
    expect(screen.queryByText('Workspace guide.md')).not.toBeInTheDocument();
    await user.click(screen.getByText('Workspace'));
    expect(await screen.findByText('Workspace guide.md')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '关联 Workspace guide.md' }));
    await waitFor(() => expect(fetchMock.mock.calls.some((call) => {
      const request = call[0] as Request;
      return request.method === 'PUT' && new URL(request.url).pathname.endsWith(`/artifacts/${workspaceArtifact.id}`);
    })).toBe(true));

    await user.click(screen.getByRole('button', { name: /回收站/u }));
    const trashDialog = await screen.findByRole('dialog');
    expect(within(trashDialog).getByText('Artifacts 回收站')).toBeInTheDocument();
    expect(await within(trashDialog).findByText('Deleted.md')).toBeInTheDocument();
    expect(await within(trashDialog).findByText(/1 个待清理/u)).toBeInTheDocument();
    expect(within(trashDialog).getByText('当前状态 · 将在', { exact: false })).toHaveTextContent('当前状态 · 将在');
    fireEvent.click(within(trashDialog).getByRole('button', { name: '恢复 Deleted.md' }));
    await waitFor(() => expect(fetchMock.mock.calls.some((call) => {
      const request = call[0] as Request;
      return request.method === 'POST' && new URL(request.url).pathname.endsWith(`/${deletedArtifact.id}/restore`);
    })).toBe(true));
    expect(await within(trashDialog).findByText(/0 个待清理/u)).toHaveTextContent('0 个待清理');
  });

  it('creates a Markdown Artifact with the current Project association', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname.endsWith('/artifacts')) return json({ items: [] });
      if (request.method === 'POST' && url.pathname.endsWith('/artifacts/markdown')) {
        return json(artifact('55555555-1237-4998-8250-d20c61e90024', 'Notes.md', [projectId]), 201);
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ConfigProvider>
        <AntApp>
          <QueryClientProvider client={queryClient}>
            <MemoryRouter><ArtifactsPanel workspaceId={workspaceId} projectId={projectId} /></MemoryRouter>
          </QueryClientProvider>
        </AntApp>
      </ConfigProvider>,
    );
    await user.click(await screen.findByRole('button', { name: '新建 Markdown' }));
    const dialog = await screen.findByRole('dialog', { name: '新建 Markdown Artifact' });
    fireEvent.change(screen.getByRole('textbox', { name: '名称' }), { target: { value: 'Notes.md' } });
    await user.click(screen.getByRole('button', { name: /创建并打开/u }));
    await waitFor(async () => {
      const request = fetchMock.mock.calls.map((call) => call[0] as Request).find((candidate) => (
        candidate.method === 'POST' && new URL(candidate.url).pathname.endsWith('/artifacts/markdown')
      ));
      expect(request).toBeDefined();
      expect(await request!.clone().json()).toEqual({ name: 'Notes.md', projectIds: [projectId] });
    });
    expect(dialog).toBeInTheDocument();
  });
});

function artifact(id: string, name: string, projectIds: string[]): Artifact {
  return {
    id,
    workspaceId,
    name,
    artifactType: 'markdown',
    currentState: {
      artifactId: id,
      currentRevision: 0,
      contentDigest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      mediaType: 'text/markdown; charset=utf-8',
      byteLength: 0,
      updatedByMembershipId: '66666666-1237-4998-8250-d20c61e90024',
      updatedAt: 1,
    },
    latestSnapshot: null,
    projectIds,
    createdByMembershipId: '66666666-1237-4998-8250-d20c61e90024',
    revision: 1,
    status: 'active',
    deletedAt: null,
    purgeAfter: null,
    purgedAt: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
