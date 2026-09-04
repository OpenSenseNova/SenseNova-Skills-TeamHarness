import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const reportPath = resolve(root, 'THIRD_PARTY_NOTICES.md');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function dependencyTree(cwd) {
  const output = execFileSync(npm, ['ls', '--all', '--json', '--omit=dev'], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(output);
}

const packages = new Map();
function packageJsonPath(name, cwd) {
  const packagePath = name.startsWith('@')
    ? name.split('/').slice(0, 2).join('/')
    : name;
  for (const base of [cwd, root, resolve(root, 'local-computer')]) {
    const candidate = resolve(base, 'node_modules', packagePath, 'package.json');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
function packageLicense(name, cwd, fallback) {
  const path = packageJsonPath(name, cwd);
  if (!path) return fallback;
  try {
    const metadata = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof metadata.license === 'string') return metadata.license;
    if (Array.isArray(metadata.licenses)) return metadata.licenses.map((item) => item.type ?? item).join(', ');
    const packageDirectory = resolve(path, '..');
    if (['LICENSE', 'LICENSE.md', 'license', 'license.md'].some((name) => existsSync(resolve(packageDirectory, name)))) {
      return 'SEE LICENSE FILE';
    }
  } catch {
    // Keep the audit report deterministic even when a package metadata file is malformed.
  }
  return fallback;
}
function visit(node, fallbackName = '', cwd = root) {
  if (!node || typeof node !== 'object') return;
  const name = typeof node.name === 'string' && node.name ? node.name : fallbackName;
  if (name && name !== 'ai-native-collaboration' && name !== '@ai-native-collaboration/local-computer') {
    if (typeof node.version !== 'string') return;
    const version = node.version;
    const key = `${name}@${version}`;
    packages.set(key, { name, version, license: packageLicense(name, cwd, node.license ?? 'UNKNOWN') });
  }
  for (const [childName, child] of Object.entries(node.dependencies ?? {})) visit(child, childName, cwd);
}
visit(dependencyTree(root), '', root);
visit(dependencyTree(resolve(root, 'local-computer')), '', resolve(root, 'local-computer'));

const lines = [...packages.values()]
  .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))
  .map((pkg) => `- \`${pkg.name}@${pkg.version}\` — License: ${pkg.license}`);
const report = `# Third-party notices\n\nThis file is generated from the production dependency trees with:\n\n\`\`\`bash\nnode scripts/check-licenses.mjs --write\n\`\`\`\n\nRun \`npm run license:check\` before a release. It audits the root server and Local Computer production dependency trees and checks that this notice is deterministic. Dependencies retain their upstream licenses; see the package metadata recorded below.\n\n## Project assets\n\nThe public repository contains project-authored source and documentation assets. No external image, font, audio, video, or presentation fixture is distributed by the release package. New third-party assets must be documented here with their source, license, and redistribution permission before merge.\n\n## Production dependencies\n\n<!-- BEGIN GENERATED DEPENDENCIES -->\n${lines.length > 0 ? lines.join('\n') : 'No production dependencies found.'}\n<!-- END GENERATED DEPENDENCIES -->\n`;

if (process.argv.includes('--write')) {
  writeFileSync(reportPath, report, 'utf8');
  process.stdout.write(`Wrote ${lines.length} production dependency notices.\n`);
} else {
  const current = readFileSync(reportPath, 'utf8');
  if (current !== report) throw new Error('THIRD_PARTY_NOTICES.md is stale; run node scripts/check-licenses.mjs --write.');
  const unknown = lines.filter((line) => line.endsWith('UNKNOWN'));
  if (unknown.length > 0) process.stdout.write(`License audit: ${unknown.length} packages have no SPDX metadata.\n`);
  process.stdout.write(`License audit valid: ${lines.length} production dependency entries.\n`);
}
