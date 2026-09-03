import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, resolve } from 'node:path';

export const LOCAL_COMPUTER_SERVICE_LABEL = 'com.ai-native-collaboration.local-computer';

interface LaunchAgentDefinition {
  nodePath: string;
  entryPath: string;
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
  pathEnvironment: string;
}

interface ServiceManagerOptions extends LaunchAgentDefinition {
  launchAgentsDirectory?: string;
}

interface LaunchctlResult {
  status: number;
  stdout: string;
  stderr: string;
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function renderMacOSLaunchAgent(definition: LaunchAgentDefinition): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${LOCAL_COMPUTER_SERVICE_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${xml(definition.nodePath)}</string>`,
    `    <string>${xml(definition.entryPath)}</string>`,
    '    <string>__service</string>',
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>PATH</key>',
    `    <string>${xml(definition.pathEnvironment)}</string>`,
    '  </dict>',
    '  <key>WorkingDirectory</key>',
    `  <string>${xml(definition.workingDirectory)}</string>`,
    '  <key>StandardOutPath</key>',
    `  <string>${xml(definition.stdoutPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xml(definition.stderrPath)}</string>`,
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    '  <key>ThrottleInterval</key>',
    '  <integer>10</integer>',
    '  <key>Umask</key>',
    '  <integer>63</integer>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export class LocalComputerServiceManager {
  readonly plistPath: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  private readonly serviceTarget: string;
  private readonly userDomain: string;

  constructor(private readonly options: ServiceManagerOptions) {
    this.requireMacOS();
    const uid = process.getuid!();
    this.userDomain = `gui/${uid}`;
    this.serviceTarget = `${this.userDomain}/${LOCAL_COMPUTER_SERVICE_LABEL}`;
    const launchAgentsDirectory = options.launchAgentsDirectory
      ?? resolve(homedir(), 'Library', 'LaunchAgents');
    this.plistPath = resolve(launchAgentsDirectory, `${LOCAL_COMPUTER_SERVICE_LABEL}.plist`);
    this.stdoutPath = options.stdoutPath;
    this.stderrPath = options.stderrPath;
  }

  install(): void {
    if (!this.options.entryPath.endsWith('.js')) {
      throw new Error('Install the packaged anc-computer CLI before enabling its background service.');
    }
    mkdirSync(dirname(this.plistPath), { recursive: true, mode: 0o755 });
    mkdirSync(this.options.workingDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(dirname(this.stdoutPath), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(this.stderrPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.plistPath}.tmp-${process.pid}`;
    writeFileSync(temporaryPath, renderMacOSLaunchAgent(this.options), {
      encoding: 'utf8',
      mode: 0o644,
      flag: 'wx',
    });
    try {
      execFileSync('/usr/bin/plutil', ['-lint', temporaryPath], { encoding: 'utf8', stdio: 'pipe' });
      if (this.isLoaded()) this.bootout();
      renameSync(temporaryPath, this.plistPath);
      chmodSync(this.plistPath, 0o644);
      this.bootstrap();
      process.stdout.write(`Installed and started ${LOCAL_COMPUTER_SERVICE_LABEL}.\n`);
      this.printStatus();
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }

  start(): void {
    this.requireInstalled();
    if (this.isLoaded()) {
      this.requireLaunchctl(['kickstart', this.serviceTarget]);
    } else {
      this.bootstrap();
    }
    process.stdout.write(`Started ${LOCAL_COMPUTER_SERVICE_LABEL}.\n`);
    this.printStatus();
  }

  stop(): void {
    if (!this.isLoaded()) {
      process.stdout.write(`${LOCAL_COMPUTER_SERVICE_LABEL} is already stopped.\n`);
      return;
    }
    this.bootout();
    process.stdout.write(`Stopped ${LOCAL_COMPUTER_SERVICE_LABEL}; it remains installed for the next login.\n`);
  }

  restart(): void {
    this.requireInstalled();
    if (this.isLoaded()) this.bootout();
    this.bootstrap();
    process.stdout.write(`Restarted ${LOCAL_COMPUTER_SERVICE_LABEL}.\n`);
    this.printStatus();
  }

  status(): void {
    process.stdout.write(`Installed: ${existsSync(this.plistPath) ? 'yes' : 'no'}\n`);
    this.printStatus();
    process.stdout.write(`stdout: ${this.stdoutPath}\n`);
    process.stdout.write(`stderr: ${this.stderrPath}\n`);
  }

  logs(): void {
    this.printLog('stdout', this.stdoutPath);
    this.printLog('stderr', this.stderrPath);
  }

  uninstall(): void {
    if (this.isLoaded()) this.bootout();
    rmSync(this.plistPath, { force: true });
    process.stdout.write(`Uninstalled ${LOCAL_COMPUTER_SERVICE_LABEL}; Local Computer data was preserved.\n`);
  }

  private bootstrap(): void {
    let lastResult: LaunchctlResult | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = this.launchctl(['bootstrap', this.userDomain, this.plistPath]);
      if (result.status === 0) return;
      lastResult = result;
      if (!result.stderr.includes('Input/output error')) break;
      waitSynchronously(250);
    }
    throw new Error(
      `launchctl bootstrap failed: ${lastResult?.stderr.trim() || lastResult?.stdout.trim() || 'unknown error'}`,
    );
  }

  private bootout(): void {
    this.requireLaunchctl(['bootout', this.serviceTarget]);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (!this.isLoaded()) return;
      waitSynchronously(100);
    }
    throw new Error(`launchctl bootout did not unload ${LOCAL_COMPUTER_SERVICE_LABEL}.`);
  }

  private isLoaded(): boolean {
    return this.launchctl(['print', this.serviceTarget]).status === 0;
  }

  private printStatus(): void {
    const result = this.launchctl(['print', this.serviceTarget]);
    if (result.status !== 0) {
      process.stdout.write('Loaded: no\nState: stopped\n');
      return;
    }
    const state = /^\s*state = (.+)$/mu.exec(result.stdout)?.[1]?.trim() ?? 'unknown';
    const pid = /^\s*pid = (\d+)$/mu.exec(result.stdout)?.[1];
    process.stdout.write(`Loaded: yes\nState: ${state}\n${pid ? `PID: ${pid}\n` : ''}`);
  }

  private printLog(label: string, path: string): void {
    process.stdout.write(`== ${label}: ${path} ==\n`);
    if (!existsSync(path)) {
      process.stdout.write('(no log file)\n');
      return;
    }
    const lines = readFileSync(path, 'utf8').split(/\r?\n/u);
    process.stdout.write(`${lines.slice(-200).join('\n').trimEnd()}\n`);
  }

  private requireInstalled(): void {
    if (!existsSync(this.plistPath)) {
      throw new Error('Local Computer service is not installed. Run anc-computer service install first.');
    }
  }

  private requireLaunchctl(args: string[]): void {
    const result = this.launchctl(args);
    if (result.status !== 0) {
      throw new Error(`launchctl ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
  }

  private launchctl(args: string[]): LaunchctlResult {
    const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
    if (result.error) throw result.error;
    return {
      status: result.status ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  private requireMacOS(): void {
    if (platform() !== 'darwin' || process.getuid === undefined) {
      throw new Error('Local Computer background service management currently supports macOS only.');
    }
  }
}

export function acquireLocalComputerDaemonLock(localDataDirectory: string): () => void {
  mkdirSync(localDataDirectory, { recursive: true, mode: 0o700 });
  const lockPath = resolve(localDataDirectory, 'daemon.lock');
  const content = `${process.pid}\n`;
  const create = (): void => writeFileSync(lockPath, content, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  try {
    create();
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    const existingPid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
    if (Number.isInteger(existingPid) && processExists(existingPid)) {
      throw new Error(`Local Computer is already running with PID ${existingPid}.`);
    }
    rmSync(lockPath, { force: true });
    create();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      if (readFileSync(lockPath, 'utf8') === content) rmSync(lockPath, { force: true });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

function waitSynchronously(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
