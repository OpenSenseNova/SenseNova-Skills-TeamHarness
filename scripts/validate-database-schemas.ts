import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type SchemaName = 'workspace' | 'local-node';

interface SchemaDefinition {
  version: number;
  applicationId: number;
}

// Resolve from this script so validation is deterministic from any cwd.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
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
