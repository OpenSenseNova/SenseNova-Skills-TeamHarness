import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  acquireLocalComputerDaemonLock,
  LOCAL_COMPUTER_SERVICE_LABEL,
  renderMacOSLaunchAgent,
} from '../src/cli/local-computer-service.js';

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
      expect(result.stdout).toContain('service install');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('renders a user launch agent with explicit executable paths and crash-only restart', () => {
    const plist = renderMacOSLaunchAgent({
      nodePath: '/Users/test/Node & Tools/node',
      entryPath: '/Users/test/Agent <Team>/run-local-computer.js',
      workingDirectory: '/Users/test/Library/Application Support/Agent Team',
      stdoutPath: '/Users/test/Library/Logs/agent.out.log',
      stderrPath: '/Users/test/Library/Logs/agent.err.log',
      pathEnvironment: '/Users/test/.local/bin:/usr/bin:/bin',
    });

    expect(plist).toContain(`<string>${LOCAL_COMPUTER_SERVICE_LABEL}</string>`);
    expect(plist).toContain('/Users/test/Node &amp; Tools/node');
    expect(plist).toContain('/Users/test/Agent &lt;Team&gt;/run-local-computer.js');
    expect(plist).toContain('<string>__service</string>');
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(plist).toContain('<key>SuccessfulExit</key>\n    <false/>');
    expect(plist).not.toContain('computerToken');
  });

  it('prevents two Local Computer daemons from owning the same local state', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'anc-computer-lock-'));
    try {
      const release = acquireLocalComputerDaemonLock(root);
      expect(() => acquireLocalComputerDaemonLock(root)).toThrow(`PID ${process.pid}`);
      release();
      const releaseAgain = acquireLocalComputerDaemonLock(root);
      releaseAgain();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
