import { resolve } from 'node:path';

export type NodeEnvironment = 'development' | 'test' | 'production';

export interface ApplicationConfig {
  environment: NodeEnvironment;
  host: string;
  port: number;
  dataDirectory: string;
}

/**
 * Read the small set of process-level settings used by the server.
 * Keeping this in one place makes the deployment contract explicit and keeps
 * invalid values from failing later with an opaque SQLite or Fastify error.
 */
export function applicationConfig(environment: NodeJS.ProcessEnv = process.env): ApplicationConfig {
  const nodeEnvironment = normalizeEnvironment(environment.NODE_ENV);
  const port = parsePort(environment.PORT);
  const dataDirectory = resolve(environment.APP_DATA_DIR?.trim() || resolve(process.cwd(), '.data'));
  return {
    environment: nodeEnvironment,
    host: environment.HOST?.trim() || (nodeEnvironment === 'production' ? '0.0.0.0' : '127.0.0.1'),
    port,
    dataDirectory,
  };
}

function normalizeEnvironment(value: string | undefined): NodeEnvironment {
  if (value === undefined || value === '') return 'development';
  if (value === 'development' || value === 'test' || value === 'production') return value;
  throw new Error(`NODE_ENV must be development, test, or production; received ${JSON.stringify(value)}.`);
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 3000;
  if (!/^\d+$/u.test(value.trim())) throw new Error(`PORT must be an integer between 1 and 65535; received ${JSON.stringify(value)}.`);
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT must be an integer between 1 and 65535; received ${JSON.stringify(value)}.`);
  }
  return port;
}
