import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComputerSetupModal } from './ComputerSetupModal';

afterEach(() => vi.unstubAllGlobals());

describe('Computer setup', () => {
  it('installs and starts the independent Local Computer from any directory', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      computerId: '5a1e821f-b694-4be5-a2fc-188c79f7beaf',
      token: 'anc_test-token',
      name: 'My Mac',
      createdAt: 1,
    }), { status: 201, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <ConfigProvider>
        <AntApp>
          <QueryClientProvider client={queryClient}>
            <ComputerSetupModal open onClose={() => undefined} />
          </QueryClientProvider>
        </AntApp>
      </ConfigProvider>,
    );

    await userEvent.type(screen.getByRole('textbox', { name: '本地计算机名称' }), 'My Mac');
    await userEvent.click(screen.getByRole('button', { name: '继 续' }));

    expect(await screen.findByText(/npm install --global 'http:\/\/localhost:3000\/downloads\/anc-local-computer\.tgz'/u))
      .toBeInTheDocument();
    expect(screen.getByText(/anc-computer connect --server 'http:\/\/localhost:3000' --token 'anc_test-token'.*anc-computer run/su))
      .toBeInTheDocument();
    expect(screen.queryByText(/npm run local-computer/u)).not.toBeInTheDocument();
  });
});
