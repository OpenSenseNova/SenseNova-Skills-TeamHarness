import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createApplication } from '../app.js';

const temporaryDirectory = await mkdtemp(resolve(tmpdir(), 'anc-openapi-'));
const temporaryPaths = {
  workspace: resolve(temporaryDirectory, 'workspace.sqlite'),
  localNode: resolve(temporaryDirectory, 'local-node.sqlite'),
};
const { app } = await createApplication(temporaryPaths);
try {
  await app.ready();
  const destination = resolve(process.cwd(), 'docs', 'contracts', 'openapi.json');
  await mkdir(resolve(destination, '..'), { recursive: true });
  await writeFile(destination, `${JSON.stringify(app.swagger(), null, 2)}\n`, 'utf8');
  process.stdout.write(`${destination}\n`);
} finally {
  await app.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
}
