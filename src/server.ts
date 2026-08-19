import { createApplication, databasePathsFromEnvironment } from './app.js';
import staticFiles from '@fastify/static';
import { resolve } from 'node:path';

const { app } = await createApplication(databasePathsFromEnvironment());
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

if (process.env.NODE_ENV === 'production') {
  await app.register(staticFiles, { root: resolve(process.cwd(), 'web/dist') });
  app.setNotFoundHandler((request, reply) => {
    if (request.method === 'GET' && !request.url.startsWith('/v1/') && request.url !== '/openapi.json') {
      return reply.sendFile('index.html');
    }
    return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Resource not found.', details: null } });
  });
}

await app.listen({ host, port });
