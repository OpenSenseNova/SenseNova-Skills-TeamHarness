import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('anc-computer CLI custody', () => {
  it('persists a 0600 user-level connection from an unrelated current directory', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'anc-computer-cli-'));
    const dataDirectory = resolve(root, 'user-state');
    const unrelatedDirectory = resolve(root, 'unrelated');
    const script = resolve(process.cwd(), 'src/cli/run-local-computer.ts');
    try {
      mkdirSync(unrelatedDirectory);
      const result = spawnSync(process.execPath, [
        '--import', import.meta.resolve('tsx'),
        script,
        'connect',
        '--server', 'http://127.0.0.1:5173',
        '--token', 'anc_test-token',
      ], {
        cwd: unrelatedDirectory,
        env: { ...process.env, ANC_LOCAL_DATA_DIR: dataDirectory },
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      const configPath = resolve(dataDirectory, 'connection.json');
      expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
        serverUrl: 'http://127.0.0.1:5173',
        computerToken: 'anc_test-token',
      });
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
      expect(result.stdout).toContain('from any directory');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
