import { dirname, resolve } from 'node:path';
import { WorkspaceService } from './domain/workspace-service.js';
import { buildApp } from './http/app.js';
import { defaultDatabasePaths, SqliteDatabase, type DatabasePaths } from './storage/database.js';

export async function createApplication(paths: DatabasePaths = defaultDatabasePaths()) {
  const workspaceDatabase = SqliteDatabase.open(paths.workspace, 'workspace');
  const localDatabase = SqliteDatabase.open(paths.localNode, 'local-node');
  const service = new WorkspaceService(
    workspaceDatabase,
    localDatabase,
    undefined,
    resolve(dirname(paths.workspace), 'content-blobs'),
    process.env.NODE_ENV !== 'production',
  );
  service.artifacts.purgeExpired();
  const artifactCleanup = setInterval(() => service.artifacts.purgeExpired(), 60 * 60 * 1000);
  artifactCleanup.unref();
  const app = await buildApp(service);
  app.addHook('onClose', async () => {
    clearInterval(artifactCleanup);
    localDatabase.close();
    workspaceDatabase.close();
  });
  return { app, service, workspaceDatabase, localDatabase };
}

export function databasePathsFromEnvironment(): DatabasePaths {
  const dataDirectory = process.env.APP_DATA_DIR
    ? resolve(process.env.APP_DATA_DIR)
    : resolve(process.cwd(), '.data');
  return defaultDatabasePaths(dataDirectory);
}
