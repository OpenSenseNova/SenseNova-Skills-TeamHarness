import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfigProvider } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LoginPage, RegisterPage, VerifyEmailPage } from './AuthPages';

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
