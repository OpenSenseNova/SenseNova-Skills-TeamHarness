import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { Artifact, Project, ProjectResourceLink } from '../api/client';
import { ProjectHome, ProjectsPage } from './ProjectPages';
import { WorkspaceContext, type WorkspaceContextValue } from './workspace-context';

afterEach(() => vi.unstubAllGlobals());

const workspace = {
  id: '6c07fe76-1237-4998-8250-d20c61e90024',
  name: 'Workspace',
  revision: 1,
  contextVersion: 1,
  membershipId: '5f9195bf-903d-480d-90eb-5404dc4eefb4',
  membershipRole: 'owner' as const,
  createdAt: 1,
  updatedAt: 1,
};

function project(id: string, name: string, workingCopySummary: Project['workingCopySummary']): Project {
  return {
    id,
    workspaceId: workspace.id,
    name,
    description: `${name} repository`,
    revision: 1,
    contextVersion: 1,
    membershipId: '0fdbba16-9982-4e19-832d-f5336465ee28',
    role: 'manager',
    governanceOnly: false,
    activeMemberCount: 2,
    conversationCount: 3,
    repository: {
      id: `10000000-0000-4000-8000-${id.slice(-12)}`,
      cloneUrl: `git@github.com:example/${name}.git`,
      repositoryIdentity: `github.com/example/${name}`,
      defaultBranch: 'main',
      revision: 1,
    },
    connectedComputerCount: workingCopySummary === 'not_connected' ? 0 : 1,
    readyComputerCount: workingCopySummary === 'connected' ? 1 : 0,
    workingCopySummary,
    createdByMembershipId: workspace.membershipId,
    createdAt: 1,
    updatedAt: 1,
  };
}

function context(projects: Project[], selected: Project | null = null): WorkspaceContextValue {
  return {
    workspace,
    members: [],
    agents: [],
    conversations: [],
    projects,
    project: selected,
    projectMembers: [],
    openNewProject: () => undefined,
    openNewConversation: () => undefined,
    openDirectMessage: async () => undefined,
    openingDirectMessageMembershipId: null,
    refresh: async () => undefined,
  };
}

function artifact(
  id: string,
  name: string,
  artifactType: Artifact['artifactType'],
  projectIds: string[],
  updatedAt: number,
): Artifact {
  return {
    id,
    workspaceId: workspace.id,
    name,
    artifactType,
    currentState: {
      artifactId: id,
      currentRevision: 2,
      contentDigest: 'a'.repeat(64),
      mediaType: artifactType === 'file' ? 'text/plain' : 'text/markdown',
      byteLength: 1536,
      updatedByMembershipId: workspace.membershipId,
      updatedAt,
    },
    latestSnapshot: {
      snapshotId: `${id}-snapshot`,
      artifactId: id,
      label: '正式稿',
      parentSnapshotId: null,
      contentDigest: 'a'.repeat(64),
      mediaType: artifactType === 'file' ? 'text/plain' : 'text/markdown',
      byteLength: 1536,
      createdByActorId: 'human-1',
      createdByMembershipId: workspace.membershipId,
      createdByDisplayName: 'Owner',
      revision: 1,
      status: 'active',
      deletedAt: null,
      createdAt: updatedAt,
      updatedAt,
    },
    projectIds,
    createdByMembershipId: workspace.membershipId,
    revision: 1,
    status: 'active',
    deletedAt: null,
    purgeAfter: null,
    purgedAt: null,
    createdAt: updatedAt,
    updatedAt,
  };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function renderWithContext(value: WorkspaceContextValue, child: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ConfigProvider>
      <AntApp>
        <QueryClientProvider client={client}>
          <WorkspaceContext.Provider value={value}>
            <MemoryRouter>{child}</MemoryRouter>
          </WorkspaceContext.Provider>
        </QueryClientProvider>
      </AntApp>
    </ConfigProvider>,
  );
}

describe('Project 0.6 pages', () => {
  it('shows the four Repository connection summaries in a compact directory', () => {
    const projects = [
      project('10000000-0000-4000-8000-000000000001', 'connected', 'connected'),
      project('10000000-0000-4000-8000-000000000002', 'unbound', 'not_connected'),
      project('10000000-0000-4000-8000-000000000003', 'mismatch', 'mismatch'),
      project('10000000-0000-4000-8000-000000000004', 'offline', 'computer_offline'),
    ];
    renderWithContext(context(projects), <ProjectsPage />);
    expect(screen.getByText('已连接')).toBeVisible();
    expect(screen.getByText('未连接')).toBeVisible();
    expect(screen.getByText('Repository 不匹配')).toBeVisible();
    expect(screen.getByText('Computer 离线')).toBeVisible();
    expect(screen.getByText('github.com/example/connected')).toBeVisible();
  });

  it('keeps an unconnected Project usable and shows bind/clone guidance without a fake file tree', async () => {
    const selected = project('10000000-0000-4000-8000-000000000005', 'unbound', 'not_connected');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    renderWithContext(context([selected], selected), <ProjectHome />);
    expect(screen.getByText('需要连接仓库')).toBeVisible();
    expect(screen.getByText(/仍然可以进入 Conversation/u)).toBeVisible();
    expect(await screen.findByText(`anc-computer project bind --project ${selected.id}`)).toBeVisible();
    expect(screen.getByText(`anc-computer project clone --project ${selected.id}`)).toBeVisible();
    expect(screen.queryByText('文件树')).not.toBeInTheDocument();
    expect(screen.getByText('项目资源')).toBeVisible();
    expect(screen.getByText('还没有项目资源')).toBeVisible();
    expect(screen.getByRole('button', { name: /添加资源/u })).toBeVisible();
    expect(screen.getByRole('button', { name: /上传文件/u })).toBeVisible();
    expect(screen.getByRole('button', { name: /加入已有 Artifact/u })).toBeVisible();
    expect(screen.getByRole('button', { name: /添加外部链接/u })).toBeVisible();
  });

  it('uploads and joins Project resources without changing Artifact ownership', async () => {
    const selected = project('10000000-0000-4000-8000-000000000006', 'resources', 'connected');
    const otherProjectId = '10000000-0000-4000-8000-000000000099';
    const candidate = artifact('20000000-0000-4000-8000-000000000001', 'shared-plan.md', 'markdown', [otherProjectId], 200);
    let workspaceArtifacts = [candidate];
    let projectArtifacts: Artifact[] = [];
    let resourceLinks: ProjectResourceLink[] = [];
    const uploadForms: FormData[] = [];
    const requests: Array<{ method: string; pathname: string; body?: unknown }> = [];

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(request?.url ?? String(input), window.location.origin);
      const method = request?.method ?? init?.method ?? 'GET';
      if (url.pathname.endsWith('/working-copies')) return json({ items: [] });
      if (url.pathname.endsWith('/resource-links') && method === 'GET') return json({ items: resourceLinks });
      if (url.pathname === `/v1/workspaces/${workspace.id}/artifacts` && method === 'GET') {
        return json({ items: url.searchParams.get('projectId') ? projectArtifacts : workspaceArtifacts });
      }
      if (url.pathname.endsWith('/artifacts/files') && method === 'POST') {
        uploadForms.push(init?.body as FormData);
        const uploaded = artifact('20000000-0000-4000-8000-000000000002', 'notes.txt', 'file', [selected.id], 300);
        workspaceArtifacts = [...workspaceArtifacts, uploaded];
        projectArtifacts = [...projectArtifacts, uploaded];
        requests.push({ method, pathname: url.pathname });
        return json(uploaded, 201);
      }
      if (url.pathname === `/v1/projects/${selected.id}/artifacts/${candidate.id}` && method === 'PUT') {
        candidate.projectIds = [...candidate.projectIds, selected.id];
        candidate.updatedAt = 400;
        workspaceArtifacts = [...workspaceArtifacts];
        projectArtifacts = [...projectArtifacts, candidate];
        requests.push({ method, pathname: url.pathname });
        return json(candidate);
      }
      if (url.pathname === `/v1/projects/${selected.id}/artifacts/${candidate.id}` && method === 'DELETE') {
        candidate.projectIds = candidate.projectIds.filter((id) => id !== selected.id);
        workspaceArtifacts = [...workspaceArtifacts];
        projectArtifacts = projectArtifacts.filter((item) => item.id !== candidate.id);
        requests.push({ method, pathname: url.pathname });
        return json(candidate);
      }
      if (url.pathname.endsWith('/resource-links') && method === 'POST') {
        const body = await request!.clone().json() as { title: string; url: string; description: string | null };
        const link: ProjectResourceLink = {
          id: '30000000-0000-4000-8000-000000000001',
          projectId: selected.id,
          ...body,
          revision: 1,
          createdByMembershipId: workspace.membershipId,
          createdAt: 500,
          updatedAt: 500,
        };
        resourceLinks = [link];
        requests.push({ method, pathname: url.pathname, body });
        return json(link, 201);
      }
      return json({ items: [] });
    }));

    renderWithContext(context([selected], selected), <ProjectHome />);
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText('选择要上传的项目文件'), { target: { files: [file] } });
    expect(await screen.findByText('notes.txt')).toBeVisible();
    expect(uploadForms[0]?.get('name')).toBe('notes.txt');
    expect(uploadForms[0]?.get('projectIds')).toBe(JSON.stringify([selected.id]));

    await userEvent.click(screen.getByRole('button', { name: /添加资源/u }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /加入已有 Artifact/u }));
    const joinDialog = await screen.findByRole('dialog', { name: '加入已有 Artifact' });
    await userEvent.click(within(joinDialog).getByRole('combobox', { name: '选择要加入项目的 Artifact' }));
    await userEvent.click(await screen.findByText(/shared-plan\.md · Markdown/u));
    await userEvent.click(within(joinDialog).getByRole('button', { name: /加入项目/u }));
    expect(await screen.findByText('shared-plan.md')).toBeVisible();
    expect(candidate.projectIds).toEqual([otherProjectId, selected.id]);

    const resourceList = screen.getByRole('list', { name: '项目资源列表' });
    const rows = within(resourceList).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('shared-plan.md'),
      expect.stringContaining('notes.txt'),
    ]);
    expect(within(resourceList).getByText('文件')).toBeVisible();
    expect(within(resourceList).getByText('Artifact')).toBeVisible();

    expect(requests).toEqual(expect.arrayContaining([
      { method: 'POST', pathname: `/v1/workspaces/${workspace.id}/artifacts/files` },
      { method: 'PUT', pathname: `/v1/projects/${selected.id}/artifacts/${candidate.id}` },
    ]));
  });

  it('removes only the current Project association for a Manager', async () => {
    const selected = project('10000000-0000-4000-8000-000000000009', 'manager-view', 'connected');
    const otherProjectId = '10000000-0000-4000-8000-000000000098';
    const shared = artifact('20000000-0000-4000-8000-000000000006', 'shared-resource.md', 'markdown', [otherProjectId, selected.id], 100);
    let associated = true;
    let deleteCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(String(input));
      const url = new URL(request.url, window.location.origin);
      if (url.pathname.endsWith('/working-copies')) return json({ items: [] });
      if (url.pathname.endsWith('/resource-links')) return json({ items: [] });
      if (url.pathname.endsWith(`/artifacts/${shared.id}`) && request.method === 'DELETE') {
        deleteCount += 1;
        associated = false;
        shared.projectIds = [otherProjectId];
        return json(shared);
      }
      if (url.pathname.endsWith('/artifacts')) {
        return json({ items: url.searchParams.has('projectId') ? (associated ? [shared] : []) : [shared] });
      }
      return json({ items: [] });
    }));
    renderWithContext(context([selected], selected), <ProjectHome />);
    const sharedRow = (await screen.findByText('shared-resource.md')).closest<HTMLElement>('.project-resource-row')!;
    await userEvent.click(within(sharedRow).getByRole('button', { name: '移出项目' }));
    const confirmation = await screen.findByRole('tooltip');
    await userEvent.click(within(confirmation).getByRole('button', { name: /OK|确\s*定/u }));
    await waitFor(() => expect(screen.queryByText('shared-resource.md')).not.toBeInTheDocument());
    expect(deleteCount).toBe(1);
    expect(shared.projectIds).toEqual([otherProjectId]);
  });

  it('mixes Artifact and Link rows by update time and completes external Link CRUD', async () => {
    const selected = project('10000000-0000-4000-8000-000000000008', 'mixed', 'connected');
    const fileArtifact = artifact('20000000-0000-4000-8000-000000000004', 'older.txt', 'file', [selected.id], 100);
    const markdownArtifact = artifact('20000000-0000-4000-8000-000000000005', 'middle.md', 'markdown', [selected.id], 200);
    let links: ProjectResourceLink[] = [{
      id: '30000000-0000-4000-8000-000000000002',
      projectId: selected.id,
      title: 'Newest reference',
      url: 'https://example.com/newest',
      description: 'External source',
      revision: 1,
      createdByMembershipId: workspace.membershipId,
      createdAt: 300,
      updatedAt: 300,
    }];
    let createdBody: unknown;
    let updatedBody: unknown;
    let deleteCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(String(input));
      const url = new URL(request.url, window.location.origin);
      if (url.pathname.endsWith('/working-copies')) return json({ items: [] });
      if (url.pathname.endsWith('/resource-links') && request.method === 'GET') return json({ items: links });
      if (url.pathname.endsWith('/resource-links') && request.method === 'POST') {
        createdBody = await request.clone().json();
        const created: ProjectResourceLink = {
          id: '30000000-0000-4000-8000-000000000003',
          projectId: selected.id,
          ...(createdBody as { title: string; url: string; description: string | null }),
          revision: 1,
          createdByMembershipId: workspace.membershipId,
          createdAt: 400,
          updatedAt: 400,
        };
        links = [...links, created];
        return json(created, 201);
      }
      if (url.pathname.endsWith('/resource-links/30000000-0000-4000-8000-000000000003') && request.method === 'PATCH') {
        updatedBody = await request.clone().json();
        const current = links.find((link) => link.id === '30000000-0000-4000-8000-000000000003')!;
        const updated: ProjectResourceLink = {
          ...current,
          ...(updatedBody as { title: string; url: string; description: string | null }),
          revision: 2,
          updatedAt: 500,
        };
        links = links.map((link) => link.id === updated.id ? updated : link);
        return json(updated);
      }
      if (url.pathname.endsWith('/resource-links/30000000-0000-4000-8000-000000000003') && request.method === 'DELETE') {
        deleteCount += 1;
        links = links.filter((link) => link.id !== '30000000-0000-4000-8000-000000000003');
        return json({ removed: true });
      }
      if (url.pathname.endsWith('/artifacts')) return json({ items: [fileArtifact, markdownArtifact] });
      return json({ items: [] });
    }));
    renderWithContext(context([selected], selected), <ProjectHome />);

    const resourceList = await screen.findByRole('list', { name: '项目资源列表' });
    expect(within(resourceList).getAllByRole('listitem').map((row) => row.textContent)).toEqual([
      expect.stringContaining('Newest reference'),
      expect.stringContaining('middle.md'),
      expect.stringContaining('older.txt'),
    ]);
    expect(within(resourceList).getByText('外部链接')).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: /添加资源/u }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /添加外部链接/u }));
    const dialog = await screen.findByRole('dialog', { name: '添加外部链接' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: '外部链接标题' }), 'Second reference');
    await userEvent.type(within(dialog).getByRole('textbox', { name: '外部链接 URL' }), 'https://example.com/second');
    await userEvent.type(within(dialog).getByRole('textbox', { name: '外部链接说明' }), 'Second source');
    await userEvent.click(within(dialog).getByRole('button', { name: /添\s*加/u }));
    expect(await screen.findByText('Second reference')).toBeVisible();
    expect(createdBody).toEqual({
      title: 'Second reference',
      url: 'https://example.com/second',
      description: 'Second source',
    });

    const createdRow = screen.getByText('Second reference').closest<HTMLElement>('.project-resource-row')!;
    await userEvent.click(within(createdRow).getByRole('button', { name: '修改' }));
    const editDialog = await waitFor(() => {
      const dialog = screen.getAllByRole('dialog').find((item) => within(item).queryByText('修改 Resource Link'));
      expect(dialog).toBeDefined();
      return dialog!;
    });
    const titleInput = within(editDialog).getByRole('textbox', { name: '修改 Resource Link 标题' });
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, 'Updated reference');
    await userEvent.click(within(editDialog).getByRole('button', { name: /保\s*存/u }));
    expect(await screen.findByText('Updated reference')).toBeVisible();
    expect(updatedBody).toEqual({
      title: 'Updated reference',
      url: 'https://example.com/second',
      description: 'Second source',
      expectedRevision: 1,
    });

    const updatedRow = screen.getByText('Updated reference').closest<HTMLElement>('.project-resource-row')!;
    await userEvent.click(within(updatedRow).getByRole('button', { name: '删除' }));
    const confirmation = await screen.findByRole('tooltip');
    await userEvent.click(within(confirmation).getByRole('button', { name: /OK|确\s*定/u }));
    await waitFor(() => expect(screen.queryByText('Updated reference')).not.toBeInTheDocument());
    expect(deleteCount).toBe(1);
  });

  it('limits non-manager actions to Links created by the current member', async () => {
    const selected = { ...project('10000000-0000-4000-8000-000000000007', 'member-view', 'connected'), role: 'member' as const };
    const projectArtifact = artifact('20000000-0000-4000-8000-000000000003', 'member-notes.md', 'markdown', [selected.id], 100);
    const links: ProjectResourceLink[] = [
      {
        id: '30000000-0000-4000-8000-000000000004', projectId: selected.id, title: 'My link',
        url: 'https://example.com/mine', description: null, revision: 1,
        createdByMembershipId: workspace.membershipId, createdAt: 200, updatedAt: 200,
      },
      {
        id: '30000000-0000-4000-8000-000000000005', projectId: selected.id, title: 'Teammate link',
        url: 'https://example.com/theirs', description: null, revision: 1,
        createdByMembershipId: 'other-membership', createdAt: 300, updatedAt: 300,
      },
    ];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
      if (url.pathname.endsWith('/working-copies')) return json({ items: [] });
      if (url.pathname.endsWith('/resource-links')) return json({ items: links });
      if (url.pathname.endsWith('/artifacts')) return json({ items: url.searchParams.has('projectId') ? [projectArtifact] : [projectArtifact] });
      return json({ items: [] });
    }));
    renderWithContext(context([selected], selected), <ProjectHome />);
    expect(await screen.findByText('member-notes.md')).toBeVisible();
    expect(screen.queryByRole('button', { name: '移出项目' })).not.toBeInTheDocument();
    const ownRow = screen.getByText('My link').closest<HTMLElement>('.project-resource-row')!;
    expect(within(ownRow).getByRole('button', { name: '修改' })).toBeVisible();
    expect(within(ownRow).getByRole('button', { name: '删除' })).toBeVisible();
    const teammateRow = screen.getByText('Teammate link').closest<HTMLElement>('.project-resource-row')!;
    expect(within(teammateRow).queryByRole('button', { name: '修改' })).not.toBeInTheDocument();
    expect(within(teammateRow).queryByRole('button', { name: '删除' })).not.toBeInTheDocument();
  });
});
