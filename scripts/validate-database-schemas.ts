import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

type SchemaName = 'workspace' | 'local-node';

interface SchemaDefinition {
  version: number;
  minimumSupportedVersion: number;
  applicationId: number;
}

const root = process.cwd();
const manifestPath = resolve(root, 'schema', 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<SchemaName, SchemaDefinition>;

for (const schemaName of ['workspace', 'local-node'] as const) {
  const definition = manifest[schemaName];
  const schemaSql = readFileSync(resolve(root, 'schema', `${schemaName}.sql`), 'utf8');
  const declaredVersion = Number(schemaSql.match(/PRAGMA\s+user_version\s*=\s*(\d+)\s*;/i)?.[1]);
  const declaredApplicationId = Number(schemaSql.match(/PRAGMA\s+application_id\s*=\s*(\d+)\s*;/i)?.[1]);
  if (declaredVersion !== definition.version) {
    throw new Error(`${schemaName}.sql declares v${declaredVersion}; manifest declares v${definition.version}.`);
  }
  if (declaredApplicationId !== definition.applicationId) {
    throw new Error(
      `${schemaName}.sql declares application id ${declaredApplicationId}; manifest declares ${definition.applicationId}.`,
    );
  }

  const migrationDirectory = resolve(root, 'schema', 'migrations', schemaName);
  const migrationEntries = existsSync(migrationDirectory)
    ? readdirSync(migrationDirectory, { withFileTypes: true })
    : [];
  if (migrationEntries.some((entry) => !entry.isDirectory())) {
    throw new Error(`${schemaName} migrations must use one directory per version step.`);
  }
  const actualMigrations = migrationEntries.map((entry) => entry.name).sort();
  const expectedMigrations = Array.from(
    { length: definition.version - definition.minimumSupportedVersion },
    (_, index) => {
      const from = definition.minimumSupportedVersion + index;
      return `${from}-to-${from + 1}`;
    },
  );
  if (JSON.stringify(actualMigrations) !== JSON.stringify(expectedMigrations)) {
    throw new Error(
      `${schemaName} migration chain mismatch. Expected [${expectedMigrations.join(', ')}], `
      + `found [${actualMigrations.join(', ')}].`,
    );
  }
  for (const migration of expectedMigrations) {
    const tableScripts = readdirSync(resolve(migrationDirectory, migration), { withFileTypes: true });
    if (tableScripts.length === 0 || tableScripts.some((entry) => (
      !entry.isFile() || !/^\d{3}-[a-z0-9-]+\.sql$/u.test(entry.name)
    ))) {
      throw new Error(
        `${schemaName} migration ${migration} must contain only ordered table scripts such as 001-messages.sql.`,
      );
    }
  }
}

const packagedManifestPath = resolve(root, 'local-computer', 'schema', 'manifest.json');
const packagedLocalSchemaPath = resolve(root, 'local-computer', 'schema', 'local-node.sql');
if (existsSync(packagedManifestPath) || existsSync(packagedLocalSchemaPath)) {
  if (!existsSync(packagedManifestPath) || !existsSync(packagedLocalSchemaPath)) {
    throw new Error('Local Computer packaged schema is incomplete.');
  }
  if (readFileSync(packagedManifestPath, 'utf8') !== readFileSync(manifestPath, 'utf8')) {
    throw new Error('Local Computer schema manifest is stale.');
  }
  if (readFileSync(packagedLocalSchemaPath, 'utf8')
    !== readFileSync(resolve(root, 'schema', 'local-node.sql'), 'utf8')) {
    throw new Error('Local Computer local-node schema is stale.');
  }
}

process.stdout.write(
  `Database schemas valid: workspace v${manifest.workspace.version}, local-node v${manifest['local-node'].version}.\n`,
);
