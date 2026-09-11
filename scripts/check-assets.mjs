import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean);
const binaryExtensions = /\.(?:png|jpe?g|gif|webp|svg|woff2?|ttf|otf|mp3|mp4|mov|avi|pdf|pptx?)$/iu;
const binaries = tracked.filter((path) => binaryExtensions.test(path) && existsSync(resolve(root, path)));
const notices = readFileSync(resolve(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
const undocumented = binaries.filter((filePath) => !notices.includes(filePath));
if (undocumented.length > 0) {
  throw new Error(`Tracked binary assets need a license review in THIRD_PARTY_NOTICES.md: ${undocumented.join(', ')}`);
}

const secretPattern = '(BEGIN (RSA|OPENSSH) PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,})';
function checkSecretsWithGitGrep() {
  try {
    execFileSync('git', ['grep', '-n', '-I', '-E', secretPattern], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    });
    throw new Error('Potential secret material found in tracked files.');
  } catch (error) {
    if (error?.status !== 1) throw error;
  }
}

try {
  execFileSync('rg', ['-n', '-I', '--hidden', '--glob', '!.git/**', '--glob', '!node_modules/**', '--glob', '!dist/**', '--glob', '!web/dist/**', '--glob', '!local-computer/dist/**', secretPattern, '.'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  });
  throw new Error('Potential secret material found in tracked files.');
} catch (error) {
  if (error?.code === 'ENOENT') checkSecretsWithGitGrep();
  else if (error?.status !== 1) throw error;
}
process.stdout.write(`Public asset and secret checks valid: ${binaries.length} tracked binary assets reviewed.\n`);
