import { dirname, resolve } from 'node:path';
import { WorkspaceService } from './domain/workspace-service.js';
import { buildApp } from './http/app.js';
import { defaultDatabasePaths, SqliteDatabase, type DatabasePaths } from './storage/database.js';
import { applicationConfig, type NodeEnvironment } from './config.js';

export interface CreateApplicationOptions {
  /** Override the process environment in embedding tools and tests. */
  environment?: NodeEnvironment;
}

export async function createApplication(
  paths?: DatabasePaths,
  options: CreateApplicationOptions = {},
) {
  const config = applicationConfig();
  const databasePaths = paths ?? defaultDatabasePaths(config.dataDirectory);
  const workspaceDatabase = SqliteDatabase.open(databasePaths.workspace, 'workspace');
  try {
    const localDatabase = SqliteDatabase.open(databasePaths.localNode, 'local-node');
    try {
      const service = new WorkspaceService(
        workspaceDatabase,
        localDatabase,
        undefined,
        resolve(dirname(databasePaths.workspace), 'content-blobs'),
        (options.environment ?? config.environment) !== 'production',
      );
      service.artifactV2.purgeExpired();
      const artifactCleanup = setInterval(() => {
        service.artifactV2.purgeExpired();
      }, 60 * 60 * 1000);
      artifactCleanup.unref();
      const app = await buildApp(service, {
        secureCookies: (options.environment ?? config.environment) === 'production',
      });
      app.addHook('onClose', async () => {
        clearInterval(artifactCleanup);
        localDatabase.close();
        workspaceDatabase.close();
      });
      return { app, service, workspaceDatabase, localDatabase };
    } catch (error) {
      localDatabase.close();
      throw error;
    }
  } catch (error) {
    workspaceDatabase.close();
    throw error;
  }
}

export function databasePathsFromEnvironment(): DatabasePaths {
  return defaultDatabasePaths(applicationConfig().dataDirectory);
}
