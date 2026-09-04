import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
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
if (!packedFilePaths.has('schema/local-node.sql')) {
  throw new Error('Local Computer package is missing schema/local-node.sql');
}
const stablePackagePath = resolve(downloadsDirectory, 'anc-local-computer.tgz');
rmSync(stablePackagePath, { force: true });
renameSync(resolve(downloadsDirectory, generatedName), stablePackagePath);
