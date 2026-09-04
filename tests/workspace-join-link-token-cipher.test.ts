import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceJoinLinkTokenCipher } from '../src/security/workspace-join-link-token-cipher.js';

describe('WorkspaceJoinLinkTokenCipher', () => {
  it('encrypts tokens with Workspace and link identity as authenticated data', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'anc-join-link-key-'));
    try {
      const keyPath = resolve(directory, 'workspace-join-link.key');
      const cipher = WorkspaceJoinLinkTokenCipher.open(keyPath, false);
      const token = `anc_${'a'.repeat(43)}`;
      const workspaceId = '6c07fe76-1237-4998-8250-d20c61e90024';
      const joinLinkId = 'a95ccf75-0805-4b3c-95cb-206c7d90db17';
      const encrypted = cipher.encrypt(token, workspaceId, joinLinkId);

      expect(encrypted).not.toContain(token);
      expect(cipher.decrypt(encrypted, workspaceId, joinLinkId)).toBe(token);
      expect(() => cipher.decrypt(encrypted, workspaceId, '4e5de535-5ec4-4cc5-aeb4-cb9fdaf52108')).toThrow();
      if (process.platform !== 'win32') expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses to replace a missing or incorrect key when encrypted tokens exist', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'anc-join-link-key-'));
    try {
      const missingKeyPath = resolve(directory, 'missing.key');
      expect(() => WorkspaceJoinLinkTokenCipher.open(missingKeyPath, true)).toThrow(/restore the key file/);

      const first = WorkspaceJoinLinkTokenCipher.open(resolve(directory, 'first.key'), false);
      const second = WorkspaceJoinLinkTokenCipher.open(resolve(directory, 'second.key'), false);
      const encrypted = first.encrypt('anc_example', 'workspace-a', 'join-link-a');
      expect(() => second.decrypt(encrypted, 'workspace-a', 'join-link-a')).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
