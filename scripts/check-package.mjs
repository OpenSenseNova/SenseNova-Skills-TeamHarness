import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const archive = resolve(root, 'web', 'public', 'downloads', 'anc-local-computer.tgz');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

execFileSync(npm, ['run', 'package:local-computer'], { cwd: root, stdio: 'inherit' });
if (!existsSync(archive)) throw new Error(`Missing Local Computer archive: ${archive}`);

const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })
  .split('\n').map((entry) => entry.trim()).filter(Boolean);
const required = ['package/README.md', 'package/LICENSE', 'package/package.json', 'package/dist/', 'package/schema/'];
for (const entry of required) {
  if (!listing.some((path) => path === entry || path.startsWith(entry))) {
    throw new Error(`Local Computer archive is missing ${entry}`);
  }
}
const banned = listing.filter((path) => /(^|\/)(?:\.env|.*\.db(?:-wal|-shm)?|logs?|work(?:dir|space)?|token)(?:\/|$|\.)/iu.test(path));
if (banned.length > 0) throw new Error(`Local Computer archive contains private runtime data: ${banned.join(', ')}`);

const packageJson = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }));
const localPackage = JSON.parse(readFileSync(resolve(root, 'local-computer', 'package.json'), 'utf8'));
if (packageJson.version !== localPackage.version) throw new Error('Packed Local Computer version is stale.');
if (packageJson.license !== 'MIT') throw new Error('Packed Local Computer must declare MIT license.');
process.stdout.write(`Local Computer package valid: ${listing.length} entries, v${packageJson.version}.\n`);
