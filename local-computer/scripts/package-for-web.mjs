import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const downloadsDirectory = resolve(packageDirectory, '..', 'web', 'public', 'downloads');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

mkdirSync(downloadsDirectory, { recursive: true });
execFileSync(npmCommand, ['run', 'build'], { cwd: packageDirectory, stdio: 'inherit' });
const output = execFileSync(
  npmCommand,
  ['pack', '--ignore-scripts', '--json', '--pack-destination', downloadsDirectory],
  { cwd: packageDirectory, encoding: 'utf8' },
);
const packed = JSON.parse(output);
const generatedName = packed[0]?.filename;
if (typeof generatedName !== 'string' || generatedName.length === 0) {
  throw new Error('npm pack did not return a package filename.');
}
const packedFilePaths = new Set((packed[0]?.files ?? []).map((file) => file.path));
if (!packedFilePaths.has('schema/manifest.json')) {
  throw new Error('Local Computer package is missing schema/manifest.json');
}
const migrationRoot = resolve(packageDirectory, '..', 'schema', 'migrations', 'local-node');
const requiredMigrationPaths = readdirSync(migrationRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => readdirSync(resolve(migrationRoot, entry.name))
    .filter((name) => name.endsWith('.sql'))
    .map((name) => `schema/migrations/local-node/${entry.name}/${name}`));
const missingMigrationPaths = requiredMigrationPaths.filter((path) => !packedFilePaths.has(path));
if (missingMigrationPaths.length > 0) {
  throw new Error(`Local Computer package is missing schema migrations: ${missingMigrationPaths.join(', ')}`);
}
const stablePackagePath = resolve(downloadsDirectory, 'anc-local-computer.tgz');
rmSync(stablePackagePath, { force: true });
renameSync(resolve(downloadsDirectory, generatedName), stablePackagePath);
