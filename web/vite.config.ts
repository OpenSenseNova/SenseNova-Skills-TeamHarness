import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/v1': {
        target: 'http://127.0.0.1:3000',
        ws: true,
      },
      '/health': 'http://127.0.0.1:3000',
      '/openapi.json': 'http://127.0.0.1:3000',
    },
  },
});
