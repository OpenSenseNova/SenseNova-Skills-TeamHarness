import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export type SchemaName = 'workspace' | 'local-node';

export interface SchemaDefinition {
  version: number;
  applicationId: number;
}

type SchemaManifest = Record<SchemaName, SchemaDefinition>;

let schemaManifest: SchemaManifest | undefined;
const schemaRequirements = new Map<SchemaName, RequiredSchema>();

interface SchemaObjectRow {
  type: string;
  name: string;
  tableName: string;
}

interface SchemaColumnRow {
  name: string;
  type: string;
  notNull: number;
  defaultValue: string | null;
  primaryKey: number;
  hidden: number;
}

interface RequiredSchema {
  objects: SchemaObjectRow[];
  columnsByTable: Map<string, SchemaColumnRow[]>;
}

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
    const schemaPath = schemaFilePath(schemaName);
    if (filePath !== ':memory:') {
      mkdirSync(dirname(filePath), { recursive: true });
    }
    const raw = new DatabaseSync(filePath);
    raw.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (filePath !== ':memory:') {
      raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    }

    try {
      const row = raw.prepare('PRAGMA user_version').get() as { user_version: number };
      const identity = raw.prepare('PRAGMA application_id').get() as { application_id: number };
      if (identity.application_id !== 0 && identity.application_id !== definition.applicationId) {
        throw new Error(
          `${schemaName} database application id ${identity.application_id} does not match ${definition.applicationId}.`,
        );
      }
      if (row.user_version === 0) {
        const existingSchema = raw.prepare(
          "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
        ).get() as { count: number };
        if (existingSchema.count > 0) {
          throw new Error(`${schemaName} database has schema objects but no supported schema version.`);
        }
        raw.exec(readFileSync(schemaPath, 'utf8'));
        const initialized = raw.prepare('PRAGMA user_version').get() as { user_version: number };
        if (initialized.user_version !== expectedVersion) {
          throw new Error(
            `Initialized ${schemaName} schema version ${initialized.user_version}; expected ${expectedVersion}.`,
          );
        }
      } else if (row.user_version !== expectedVersion) {
        throw new Error(
          `${schemaName} schema version ${row.user_version} is not the supported v${expectedVersion} baseline. `
          + 'Recreate the database from the checked-in schema before starting this build.',
        );
      }

      assertCompatibleSchema(raw, schemaName, definition, schemaPath);
      return new SqliteDatabase(raw);
    } catch (error) {
      raw.close();
      throw error;
    }
  }

  transaction<T>(operation: () => T): T {
    if (this.raw.isTransaction) return operation();
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

function loadSchemaManifest(): SchemaManifest {
  const manifestPath = fileURLToPath(new URL('../../schema/manifest.json', import.meta.url));
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<Record<SchemaName, Partial<SchemaDefinition>>>;
  const entries = Object.fromEntries((['workspace', 'local-node'] as const).map((schemaName) => {
    const definition = parsed[schemaName];
    if (!definition
      || !Number.isSafeInteger(definition.version) || Number(definition.version) <= 0
      || !Number.isSafeInteger(definition.applicationId) || Number(definition.applicationId) <= 0) {
      throw new Error(`Invalid schema manifest entry for ${schemaName}.`);
    }
    return [schemaName, {
      version: Number(definition.version),
      applicationId: Number(definition.applicationId),
    } satisfies SchemaDefinition];
  }));
  return entries as SchemaManifest;
}

function schemaFilePath(schemaName: SchemaName): string {
  return fileURLToPath(new URL(`../../schema/${schemaName}.sql`, import.meta.url));
}

function assertCompatibleSchema(
  raw: DatabaseSync,
  schemaName: SchemaName,
  definition: SchemaDefinition,
  schemaPath: string,
): void {
  const identity = raw.prepare('PRAGMA application_id').get() as { application_id: number };
  if (identity.application_id !== definition.applicationId) {
    throw new Error(
      `${schemaName} database application id ${identity.application_id} does not match ${definition.applicationId}.`,
    );
  }
  let required = schemaRequirements.get(schemaName);
  if (required === undefined) {
    const expected = new DatabaseSync(':memory:');
    try {
      expected.exec(readFileSync(schemaPath, 'utf8'));
      required = readSchemaRequirements(expected);
      schemaRequirements.set(schemaName, required);
    } finally {
      expected.close();
    }
  }
  const actualObjects = new Map(readSchemaObjects(raw).map((object) => [object.name, object]));
  for (const expectedObject of required.objects) {
    const actualObject = actualObjects.get(expectedObject.name);
    if (!actualObject
      || actualObject.type !== expectedObject.type
      || actualObject.tableName !== expectedObject.tableName) {
      throw incompatibleSchemaError(schemaName, definition.version, `missing ${expectedObject.type} ${expectedObject.name}`);
    }
  }
  for (const [tableName, expectedColumns] of required.columnsByTable) {
    const actualColumns = new Map(readTableColumns(raw, tableName).map((column) => [column.name, column]));
    for (const expectedColumn of expectedColumns) {
      const actualColumn = actualColumns.get(expectedColumn.name);
      if (!actualColumn || !compatibleColumn(actualColumn, expectedColumn)) {
        throw incompatibleSchemaError(schemaName, definition.version, `missing or incompatible ${tableName}.${expectedColumn.name}`);
      }
    }
  }
}

function readSchemaRequirements(raw: DatabaseSync): RequiredSchema {
  const objects = readSchemaObjects(raw);
  return {
    objects: objects.filter((object) => object.type !== 'index'),
    columnsByTable: new Map(objects
      .filter((object) => object.type === 'table')
      .map((object) => [object.name, readTableColumns(raw, object.name)])),
  };
}

function readSchemaObjects(raw: DatabaseSync): SchemaObjectRow[] {
  return raw.prepare(
    `SELECT type, name, tbl_name AS tableName
     FROM sqlite_schema
     WHERE name NOT LIKE 'sqlite_%'
     ORDER BY type, name`,
  ).all() as unknown as SchemaObjectRow[];
}

function readTableColumns(raw: DatabaseSync, tableName: string): SchemaColumnRow[] {
  return raw.prepare(
    `SELECT name, type, "notnull" AS "notNull", dflt_value AS "defaultValue",
            pk AS "primaryKey", hidden
     FROM pragma_table_xinfo(?)
     ORDER BY cid`,
  ).all(tableName) as unknown as SchemaColumnRow[];
}

function compatibleColumn(actual: SchemaColumnRow, expected: SchemaColumnRow): boolean {
  return actual.type.trim().toUpperCase() === expected.type.trim().toUpperCase()
    && actual.notNull === expected.notNull
    && actual.defaultValue === expected.defaultValue
    && actual.primaryKey === expected.primaryKey
    && actual.hidden === expected.hidden;
}

function incompatibleSchemaError(schemaName: SchemaName, version: number, detail: string): Error {
  return new Error(
    `${schemaName} database does not provide the stable v${version} capabilities required by this build: ${detail}.`,
  );
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
