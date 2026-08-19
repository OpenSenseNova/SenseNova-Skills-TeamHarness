import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createApplication } from '../app.js';

const temporaryPaths = { workspace: ':memory:', localNode: ':memory:' };
const { app } = await createApplication(temporaryPaths);
await app.ready();
const destination = resolve(process.cwd(), 'docs', 'contracts', 'openapi.json');
await mkdir(resolve(destination, '..'), { recursive: true });
await writeFile(destination, `${JSON.stringify(app.swagger(), null, 2)}\n`, 'utf8');
await app.close();
process.stdout.write(`${destination}\n`);
