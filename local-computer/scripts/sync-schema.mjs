import { copyFileSync, cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schemaDirectory = resolve(packageDirectory, 'schema');
const localNodeMigrationsDirectory = resolve(schemaDirectory, 'migrations', 'local-node');

mkdirSync(schemaDirectory, { recursive: true });
copyFileSync(resolve(packageDirectory, '..', 'schema', 'local-node.sql'), resolve(schemaDirectory, 'local-node.sql'));
copyFileSync(resolve(packageDirectory, '..', 'schema', 'manifest.json'), resolve(schemaDirectory, 'manifest.json'));
rmSync(localNodeMigrationsDirectory, { recursive: true, force: true });
cpSync(
  resolve(packageDirectory, '..', 'schema', 'migrations', 'local-node'),
  localNodeMigrationsDirectory,
  { recursive: true },
);
