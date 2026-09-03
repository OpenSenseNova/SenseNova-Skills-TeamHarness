import { createApplication, databasePathsFromEnvironment } from './app.js';
import staticFiles from '@fastify/static';
import { resolve } from 'node:path';
import { applicationConfig } from './config.js';

const config = applicationConfig();
const { app } = await createApplication(databasePathsFromEnvironment(), { environment: config.environment });

if (config.environment === 'production') {
  await app.register(staticFiles, { root: resolve(process.cwd(), 'web/dist') });
  app.setNotFoundHandler((request, reply) => {
    if (request.method === 'GET' && !request.url.startsWith('/v1/') && request.url !== '/openapi.json') {
      return reply.sendFile('index.html');
    }
    return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Resource not found.', details: null } });
  });
}

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`Received ${signal}; shutting down…\n`);
  await app.close();
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  await app.close();
  throw error;
}
