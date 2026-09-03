import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { BrowserRouter } from 'react-router-dom';
import { Application } from './app';
import './styles.css';
import { ThemeProvider } from './theme';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: 10_000 },
    mutations: { retry: false },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <AntApp>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <Application />
          </BrowserRouter>
        </QueryClientProvider>
      </AntApp>
    </ThemeProvider>
  </React.StrictMode>,
);
