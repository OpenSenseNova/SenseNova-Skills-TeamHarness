import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export type SchemaName = 'workspace' | 'local-node';

export interface SchemaDefinition {
  version: number;
  minimumSupportedVersion: number;
  applicationId: number;
}

type SchemaManifest = Record<SchemaName, SchemaDefinition>;

let schemaManifest: SchemaManifest | undefined;

export function schemaDefinition(schemaName: SchemaName): SchemaDefinition {
  schemaManifest ??= loadSchemaManifest();
  return schemaManifest[schemaName];
}

export class SqliteDatabase {
  readonly raw: DatabaseSync;

  private constructor(raw: DatabaseSync) {
    this.raw = raw;
  }

  static open(filePath: string, schemaName: SchemaName): SqliteDatabase {
    const definition = schemaDefinition(schemaName);
    const expectedVersion = definition.version;
    if (filePath !== ':memory:') {
      mkdirSync(dirname(filePath), { recursive: true });
    }
    const raw = new DatabaseSync(filePath);
    raw.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (filePath !== ':memory:') {
      raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    }

    const row = raw.prepare('PRAGMA user_version').get() as { user_version: number };
    const identity = raw.prepare('PRAGMA application_id').get() as { application_id: number };
    if (identity.application_id !== 0 && identity.application_id !== definition.applicationId) {
      raw.close();
      throw new Error(
        `${schemaName} database application id ${identity.application_id} does not match ${definition.applicationId}.`,
      );
    }
    if (row.user_version === 0) {
      const existingSchema = raw.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
      ).get() as { count: number };
      if (existingSchema.count > 0) {
        raw.close();
        throw new Error(`${schemaName} database has schema objects but no supported schema version.`);
      }
      const schemaPath = fileURLToPath(new URL(`../../schema/${schemaName}.sql`, import.meta.url));
      try {
        raw.exec(readFileSync(schemaPath, 'utf8'));
        const initialized = raw.prepare('PRAGMA user_version').get() as { user_version: number };
        if (initialized.user_version !== expectedVersion) {
          throw new Error(
            `Initialized ${schemaName} schema version ${initialized.user_version}; expected ${expectedVersion}.`,
          );
        }
        assertSchemaIdentity(raw, schemaName, definition);
      } catch (error) {
        raw.close();
        throw error;
      }
    } else if (row.user_version < definition.minimumSupportedVersion) {
      raw.close();
      throw new Error(
        `${schemaName} schema version ${row.user_version} is older than the supported migration baseline `
        + `${definition.minimumSupportedVersion}.`,
      );
    } else if (row.user_version < expectedVersion) {
      try {
        migrate(raw, schemaName, row.user_version, expectedVersion);
        assertSchemaIdentity(raw, schemaName, definition);
      } catch (error) {
        raw.close();
        throw error;
      }
    } else if (row.user_version > expectedVersion) {
      raw.close();
      throw new Error(
        `${schemaName} schema version ${row.user_version} is newer than supported version ${expectedVersion}.`,
      );
    } else {
      assertSchemaIdentity(raw, schemaName, definition);
    }

    return new SqliteDatabase(raw);
  }

  transaction<T>(operation: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.raw.close();
  }
}

function migrate(
  raw: DatabaseSync,
  schemaName: SchemaName,
  currentVersion: number,
  expectedVersion: number,
): void {
  raw.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;');
  try {
    for (let version = currentVersion; version < expectedVersion; version += 1) {
      const nextVersion = version + 1;
      const migrationDirectory = fileURLToPath(
        new URL(`../../schema/migrations/${schemaName}/${version}-to-${nextVersion}/`, import.meta.url),
      );
      let migrationFiles: string[];
      try {
        migrationFiles = readdirSync(migrationDirectory)
          .filter((name) => name.endsWith('.sql'))
          .sort();
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          throw new Error(
            `No ${schemaName} schema migration exists from version ${version} to ${nextVersion}.`,
          );
        }
        throw error;
      }
      if (migrationFiles.length === 0) {
        throw new Error(`The ${schemaName} migration from version ${version} to ${nextVersion} has no table scripts.`);
      }
      for (const migrationFile of migrationFiles) {
        raw.exec(readFileSync(resolve(migrationDirectory, migrationFile), 'utf8'));
      }
      raw.exec(`PRAGMA user_version = ${nextVersion};`);
    }

    const violations = raw.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) {
      throw new Error(
        `${schemaName} schema migration produced ${violations.length} foreign-key violation(s).`,
      );
    }
    raw.exec('COMMIT;');
  } catch (error) {
    try {
      raw.exec('ROLLBACK;');
    } catch {
      // The original migration error is more useful than a redundant rollback error.
    }
    throw error;
  } finally {
    raw.exec('PRAGMA foreign_keys = ON;');
  }

  const migrated = raw.prepare('PRAGMA user_version').get() as { user_version: number };
  if (migrated.user_version !== expectedVersion) {
    throw new Error(
      `Migrated ${schemaName} schema version ${migrated.user_version}; expected ${expectedVersion}.`,
    );
  }
}

function loadSchemaManifest(): SchemaManifest {
  const manifestPath = fileURLToPath(new URL('../../schema/manifest.json', import.meta.url));
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<Record<SchemaName, Partial<SchemaDefinition>>>;
  const entries = Object.fromEntries((['workspace', 'local-node'] as const).map((schemaName) => {
    const definition = parsed[schemaName];
    if (!definition
      || !Number.isSafeInteger(definition.version) || Number(definition.version) <= 0
      || !Number.isSafeInteger(definition.minimumSupportedVersion) || Number(definition.minimumSupportedVersion) <= 0
      || Number(definition.minimumSupportedVersion) > Number(definition.version)
      || !Number.isSafeInteger(definition.applicationId) || Number(definition.applicationId) <= 0) {
      throw new Error(`Invalid schema manifest entry for ${schemaName}.`);
    }
    return [schemaName, {
      version: Number(definition.version),
      minimumSupportedVersion: Number(definition.minimumSupportedVersion),
      applicationId: Number(definition.applicationId),
    } satisfies SchemaDefinition];
  }));
  return entries as SchemaManifest;
}

function assertSchemaIdentity(raw: DatabaseSync, schemaName: SchemaName, definition: SchemaDefinition): void {
  const identity = raw.prepare('PRAGMA application_id').get() as { application_id: number };
  if (identity.application_id !== definition.applicationId) {
    throw new Error(
      `${schemaName} database application id ${identity.application_id} does not match ${definition.applicationId}.`,
    );
  }
}

export interface DatabasePaths {
  workspace: string;
  localNode: string;
}

export function defaultDatabasePaths(dataDirectory = resolve(process.cwd(), '.data')): DatabasePaths {
  return {
    workspace: resolve(dataDirectory, 'workspace.sqlite'),
    localNode: resolve(dataDirectory, 'local-node.sqlite'),
  };
}
