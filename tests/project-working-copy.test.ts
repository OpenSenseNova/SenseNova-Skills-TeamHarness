import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeGitCloneUrl } from '../src/lib/git-repository.js';
import {
  AttemptWorkspaceManager,
  inspectGitWorkingCopy,
  ProjectWorkingCopyStore,
} from '../src/runtime/project-working-copy.js';
import { SqliteDatabase } from '../src/storage/database.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function createRepository(root: string): { checkout: string; headCommit: string } {
  const checkout = resolve(root, 'checkout');
  execFileSync('git', ['init', '--initial-branch=main', checkout]);
  git(checkout, 'config', 'user.name', 'Test');
  git(checkout, 'config', 'user.email', 'test@example.com');
  git(checkout, 'remote', 'add', 'origin', 'git@github.com:Example/Project.git');
  writeFileSync(resolve(checkout, 'tracked.txt'), 'committed\n');
  git(checkout, 'add', 'tracked.txt');
  git(checkout, 'commit', '-m', 'initial');
  return { checkout, headCommit: git(checkout, 'rev-parse', 'HEAD') };
}

describe('Repository identity and isolated Attempt worktrees', () => {
  it('normalizes HTTPS, SSH, and SCP-style clone URLs to one stable identity', () => {
    const urls = [
      'https://GitHub.com/Example/Project.git',
      'ssh://git@github.com/Example/Project.git',
      'git@GITHUB.com:Example/Project.git',
    ];
    expect(urls.map((url) => normalizeGitCloneUrl(url).repositoryIdentity))
      .toEqual(urls.map(() => 'github.com/Example/Project'));
    for (const invalid of [
      '/tmp/project',
      'file:///tmp/project',
      'https://user:secret@github.com/Example/Project.git',
      'https://github.com/Example/Project.git?token=secret',
      'https://github.com/Example/Project.git#main',
    ]) {
      expect(() => normalizeGitCloneUrl(invalid)).toThrow();
    }
  });

  it('pins each Attempt to a separate detached worktree and excludes dirty main-checkout changes', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'anc-project-worktree-'));
    const database = SqliteDatabase.open(':memory:', 'local-node');
    try {
      const { checkout, headCommit } = createRepository(root);
      writeFileSync(resolve(checkout, 'tracked.txt'), 'dirty main checkout\n');
      writeFileSync(resolve(checkout, 'untracked.txt'), 'local only\n');
      const inspected = inspectGitWorkingCopy(checkout);
      expect(inspected).toMatchObject({
        repositoryIdentity: 'github.com/Example/Project',
        branch: 'main',
        headCommit,
        dirty: true,
      });

      const copies = new ProjectWorkingCopyStore(database);
      copies.bind({
        project_id: 'project-1',
        workspace_id: 'workspace-1',
        repository_id: 'repository-1',
        repository_identity: inspected.repositoryIdentity,
        absolute_path: checkout,
      });
      const manager = new AttemptWorkspaceManager(copies);
      const scope = {
        kind: 'project_repository' as const,
        projectId: 'project-1',
        repositoryId: 'repository-1',
        repositoryIdentity: inspected.repositoryIdentity,
        baseCommit: headCommit,
      };
      const first = manager.prepare(scope, resolve(root, 'attempt-1'));
      const second = manager.prepare(scope, resolve(root, 'attempt-2'));

      expect(first).not.toBe(second);
      expect(readFileSync(resolve(first, 'tracked.txt'), 'utf8')).toBe('committed\n');
      expect(readFileSync(resolve(second, 'tracked.txt'), 'utf8')).toBe('committed\n');
      expect(existsSync(resolve(first, 'untracked.txt'))).toBe(false);
      expect(git(first, 'rev-parse', 'HEAD')).toBe(headCommit);
      expect(git(second, 'rev-parse', 'HEAD')).toBe(headCommit);
      expect(git(first, 'branch', '--show-current')).toBe('');
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed for a mismatched or missing local checkout', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'anc-project-mismatch-'));
    const database = SqliteDatabase.open(':memory:', 'local-node');
    try {
      const { checkout, headCommit } = createRepository(root);
      const copies = new ProjectWorkingCopyStore(database);
      copies.bind({
        project_id: 'project-1',
        workspace_id: 'workspace-1',
        repository_id: 'repository-1',
        repository_identity: 'github.com/Other/Repository',
        absolute_path: checkout,
      });
      expect(() => new AttemptWorkspaceManager(copies).prepare({
        kind: 'project_repository',
        projectId: 'project-1',
        repositoryId: 'repository-1',
        repositoryIdentity: 'github.com/Other/Repository',
        baseCommit: headCommit,
      }, resolve(root, 'attempt'))).toThrow(/does not match/i);
      rmSync(checkout, { recursive: true, force: true });
      expect(() => inspectGitWorkingCopy(checkout)).toThrow();
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
