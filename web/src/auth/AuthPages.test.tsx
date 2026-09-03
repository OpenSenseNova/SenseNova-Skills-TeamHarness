import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App, ConfigProvider } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LoginPage, RegisterPage, VerifyEmailPage, WorkspaceJoinPage } from './AuthPages';

afterEach(() => vi.unstubAllGlobals());

describe('LoginPage', () => {
  it('submits credentials and restores the requested route', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      id: 'f37845d6-44ac-4e0a-a00b-85e56a8a7849',
      displayName: 'Alice',
      verifiedEmail: 'alice@example.com',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    render(
      <ConfigProvider>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/login?returnTo=%2Fdone']}>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/done" element={<div>已进入 Workspace</div>} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </ConfigProvider>,
    );
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('邮箱'), 'alice@example.com');
    await user.type(screen.getByLabelText('密码'), 'correct-password');
    fireEvent.click(screen.getByRole('button', { name: /登\s*录/ }));
    await screen.findByText('已进入 Workspace');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const request = fetchMock.mock.calls[0]![0] as Request;
    expect(request.url).toContain('/v1/auth/login');
    expect(await request.clone().json()).toEqual({ email: 'alice@example.com', password: 'correct-password' });
  });
});

describe('development email verification', () => {
  it('shows the server-provided code and replaces it after resend', async () => {
    let registrationRequestCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      const url = new URL(request.url);
      if (url.pathname === '/v1/auth/register') {
        registrationRequestCount += 1;
        return new Response(JSON.stringify({
          registrationId: '6c07fe76-1237-4998-8250-d20c61e90024',
          verifiedEmail: 'alice@example.com',
          verificationExpiresAt: Date.now() + 600_000,
          developmentVerificationCode: '123456',
        }), { status: 202, headers: { 'content-type': 'application/json' } });
      }
      if (url.pathname === '/v1/auth/resend-verification') {
        return new Response(JSON.stringify({
          registrationId: '8101135d-2a4a-480e-b14e-5d3f58d217b4',
          verifiedEmail: 'alice@example.com',
          verificationExpiresAt: Date.now() + 600_000,
          developmentVerificationCode: '654321',
        }), { status: 202, headers: { 'content-type': 'application/json' } });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    render(
      <ConfigProvider>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/register']}>
            <Routes>
              <Route path="/register" element={<RegisterPage />} />
              <Route path="/verify-email" element={<VerifyEmailPage />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </ConfigProvider>,
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('显示名称'), 'Alice');
    await user.type(screen.getByLabelText('邮箱'), 'alice@example.com');
    await user.type(screen.getByLabelText('密码'), 'correct-password');
    await user.click(screen.getByRole('button', { name: '注册并发送验证码' }));

    expect(await screen.findByText('开发环境验证码')).toBeVisible();
    expect(screen.getByText('123456')).toBeVisible();
    expect(registrationRequestCount).toBe(1);

    await user.click(screen.getByRole('button', { name: '重新发送验证码' }));
    expect(await screen.findByText('654321')).toBeVisible();
    expect(screen.queryByText('123456')).not.toBeInTheDocument();
  });
});

describe('WorkspaceJoinPage', () => {
  it('lets any signed-in user confirm a shared Workspace link and enter directly', async () => {
    const workspaceId = '7f53df4b-b987-4caa-b14d-13529ff6593f';
    const token = `anc_${'a'.repeat(43)}`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === `/v1/workspace-join-links/${token}`) {
        return new Response(JSON.stringify({
          workspaceId,
          workspaceName: 'Launch Team',
          status: 'active',
          alreadyMember: false,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (request.method === 'POST' && url.pathname === `/v1/workspace-join-links/${token}/accept`) {
        return new Response(JSON.stringify({
          membershipId: '710fc34d-3142-4ed2-a5cd-a234398a5a57',
          actorId: '3d93162a-97fa-449e-836d-091eaf1da6e7',
          actorType: 'human',
          displayName: 'Bob',
          membershipRole: 'member',
          revision: 1,
          joinedAt: Date.now(),
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <ConfigProvider>
        <App>
          <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={[`/join/${token}`]}>
              <Routes>
                <Route path="/join/:token" element={<WorkspaceJoinPage />} />
                <Route path="/w/:workspaceId" element={<div>Workspace 已打开</div>} />
              </Routes>
            </MemoryRouter>
          </QueryClientProvider>
        </App>
      </ConfigProvider>,
    );

    expect(await screen.findByText('加入 Launch Team')).toBeVisible();
    expect(screen.getByText(/不会向 Owner 暴露你的注册邮箱/)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '确认加入' }));
    expect(await screen.findByText('Workspace 已打开')).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
