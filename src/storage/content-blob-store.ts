import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import { DomainError } from '../lib/errors.js';

export const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;

export interface StoredContentBlob {
  hash: string;
  byteLength: number;
  mediaType: string;
  storagePath: string;
}

export class ContentBlobStore {
  constructor(readonly rootDirectory: string) {}

  async write(stream: Readable, mediaType: string): Promise<StoredContentBlob> {
    const normalizedMediaType = mediaType.trim() || 'application/octet-stream';
    const temporaryPath = resolve(this.rootDirectory, '.staging', randomUUID());
    await mkdir(dirname(temporaryPath), { recursive: true });
    const digest = createHash('sha256');
    let byteLength = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        byteLength += chunk.byteLength;
        if (byteLength > MAX_ARTIFACT_BYTES) {
          callback(new DomainError(
            'ARTIFACT_FILE_TOO_LARGE',
            'Artifact files may not exceed 100 MiB.',
            413,
          ));
          return;
        }
        digest.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(stream, meter, createWriteStream(temporaryPath, { flags: 'wx' }));
      const hash = digest.digest('hex');
      const storagePath = resolve(this.rootDirectory, hash.slice(0, 2), hash);
      await mkdir(dirname(storagePath), { recursive: true });
      await rename(temporaryPath, storagePath).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
        await rm(temporaryPath, { force: true });
      });
      return { hash, byteLength, mediaType: normalizedMediaType, storagePath };
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async writeBuffer(content: Buffer, mediaType: string): Promise<StoredContentBlob> {
    const { Readable } = await import('node:stream');
    return this.write(Readable.from(content), mediaType);
  }

  writeBufferSync(content: Buffer, mediaType: string): StoredContentBlob {
    if (content.byteLength > MAX_ARTIFACT_BYTES) {
      throw new DomainError('ARTIFACT_FILE_TOO_LARGE', 'Artifact files may not exceed 100 MiB.', 413);
    }
    const normalizedMediaType = mediaType.trim() || 'application/octet-stream';
    const hash = createHash('sha256').update(content).digest('hex');
    const storagePath = resolve(this.rootDirectory, hash.slice(0, 2), hash);
    mkdirSync(dirname(storagePath), { recursive: true });
    const temporaryPath = resolve(this.rootDirectory, '.staging', randomUUID());
    mkdirSync(dirname(temporaryPath), { recursive: true });
    try {
      writeFileSync(temporaryPath, content, { flag: 'wx' });
      try {
        renameSync(temporaryPath, storagePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        rmSync(temporaryPath, { force: true });
      }
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      throw error;
    }
    return { hash, byteLength: content.byteLength, mediaType: normalizedMediaType, storagePath };
  }

  read(storagePath: string): Readable {
    return createReadStream(storagePath);
  }
}
