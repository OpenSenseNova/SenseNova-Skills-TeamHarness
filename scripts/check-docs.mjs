import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const publicDocs = [
  'README.md', 'README_CN.md', 'INSTALL.md', 'INSTALL_CN.md',
  'CONTRIBUTING.md', 'CONTRIBUTING_CN.md', 'SECURITY.md', 'SECURITY_CN.md',
  'CHANGELOG.md', 'LICENSE', '.env.example', 'THIRD_PARTY_NOTICES.md',
  'docs/MVP.md', 'docs/PRODUCT_OVERVIEW.md', 'docs/contracts/openapi.json',
  'local-computer/README.md', 'local-computer/LICENSE',
];
const publicSet = new Set(publicDocs);
const missing = publicDocs.filter((path) => !existsSync(resolve(root, path)));
if (missing.length > 0) throw new Error(`Missing public document(s): ${missing.join(', ')}`);

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
const docsFiles = [
  ...walk(resolve(root, 'docs')),
  resolve(root, 'local-computer', 'README.md'),
  resolve(root, 'local-computer', 'LICENSE'),
].map((path) => relative(root, path));
const extra = docsFiles.filter((path) => !publicSet.has(path));
if (extra.length > 0) throw new Error(`Non-public documentation remains: ${extra.join(', ')}`);

const markdownFiles = publicDocs.filter((path) => extname(path).toLowerCase() === '.md');
const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
const broken = [];
for (const file of markdownFiles) {
  const source = readFileSync(resolve(root, file), 'utf8');
  for (const match of source.matchAll(linkPattern)) {
    const target = match[1].trim().split(/[?#]/, 1)[0];
    if (!target || target.startsWith('http://') || target.startsWith('https://') || target.startsWith('mailto:')) continue;
    if (!existsSync(resolve(root, dirname(file), target))) broken.push(`${file} -> ${target}`);
  }
}
if (broken.length > 0) throw new Error(`Broken documentation link(s): ${broken.join(', ')}`);
process.stdout.write(`Public documentation valid: ${publicDocs.length} files, ${markdownFiles.length} Markdown entrypoints.\n`);
