import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const FORMAT_VERSION = 'v1';

function additionalData(workspaceId: string, joinLinkId: string): Buffer {
  return Buffer.from(`workspace-join-link:${FORMAT_VERSION}:${workspaceId}:${joinLinkId}`, 'utf8');
}

function readKey(keyPath: string): Buffer {
  const key = readFileSync(keyPath);
  if (key.byteLength !== KEY_BYTES) {
    throw new Error(`Workspace join-link encryption key at ${keyPath} must contain exactly ${KEY_BYTES} bytes.`);
  }
  if (process.platform !== 'win32') chmodSync(keyPath, 0o600);
  return key;
}

function createKey(keyPath: string): Buffer {
  mkdirSync(dirname(keyPath), { recursive: true });
  const key = randomBytes(KEY_BYTES);
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = openSync(keyPath, 'wx', 0o600);
    writeFileSync(fileDescriptor, key);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return readKey(keyPath);
    throw error;
  } finally {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
  }
  if (process.platform !== 'win32') chmodSync(keyPath, 0o600);
  return key;
}

export class WorkspaceJoinLinkTokenCipher {
  private constructor(private readonly key: Buffer) {}

  static open(keyPath: string, encryptedTokensExist: boolean): WorkspaceJoinLinkTokenCipher {
    if (!existsSync(keyPath) && encryptedTokensExist) {
      throw new Error(
        `Workspace join-link encryption key is missing at ${keyPath}; restore the key file before starting the service.`,
      );
    }
    return new WorkspaceJoinLinkTokenCipher(existsSync(keyPath) ? readKey(keyPath) : createKey(keyPath));
  }

  encrypt(token: string, workspaceId: string, joinLinkId: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv, { authTagLength: AUTH_TAG_BYTES });
    cipher.setAAD(additionalData(workspaceId, joinLinkId));
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [
      FORMAT_VERSION,
      iv.toString('base64url'),
      authTag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  decrypt(value: string, workspaceId: string, joinLinkId: string): string {
    const [version, encodedIv, encodedAuthTag, encodedCiphertext, ...extra] = value.split('.');
    if (
      version !== FORMAT_VERSION
      || !encodedIv
      || !encodedAuthTag
      || !encodedCiphertext
      || extra.length > 0
    ) {
      throw new Error(`Workspace join-link ${joinLinkId} has an unsupported encrypted token format.`);
    }
    const iv = Buffer.from(encodedIv, 'base64url');
    const authTag = Buffer.from(encodedAuthTag, 'base64url');
    if (iv.byteLength !== IV_BYTES || authTag.byteLength !== AUTH_TAG_BYTES) {
      throw new Error(`Workspace join-link ${joinLinkId} has invalid encrypted token parameters.`);
    }
    const decipher = createDecipheriv(ALGORITHM, this.key, iv, { authTagLength: AUTH_TAG_BYTES });
    decipher.setAAD(additionalData(workspaceId, joinLinkId));
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(Buffer.from(encodedCiphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}
