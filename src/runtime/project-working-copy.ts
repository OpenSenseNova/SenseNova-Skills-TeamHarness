import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { AttemptExecutionInputView, ProjectWorkingCopyReport } from '../domain/types.js';
import { DomainError, invariant } from '../lib/errors.js';
import { normalizeGitCloneUrl } from '../lib/git-repository.js';
import { nowMs } from '../lib/values.js';
import { SqliteDatabase } from '../storage/database.js';

function git(args: string[], cwd?: string): string {
  try {
    return execFileSync('git', cwd ? ['-C', cwd, ...args] : args, {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    throw new DomainError(
      'GIT_COMMAND_FAILED',
      `Git command failed: git ${args.join(' ')}`,
      409,
      error instanceof Error ? { cause: error.message } : undefined,
    );
  }
}

export interface InspectedWorkingCopy {
  absolutePath: string;
  cloneUrl: string;
  repositoryIdentity: string;
  defaultBranch: string;
  branch: string;
  headCommit: string;
  dirty: boolean;
}

export function inspectGitWorkingCopy(inputPath: string): InspectedWorkingCopy {
  const requestedPath = realpathSync(resolve(inputPath));
  invariant(git(['rev-parse', '--is-inside-work-tree'], requestedPath) === 'true',
    'GIT_CHECKOUT_REQUIRED', 'The selected directory is not a Git working tree.', 409);
  const absolutePath = realpathSync(git(['rev-parse', '--show-toplevel'], requestedPath));
  const normalized = normalizeGitCloneUrl(git(['remote', 'get-url', 'origin'], absolutePath));
  const branch = git(['branch', '--show-current'], absolutePath);
  invariant(branch.length > 0, 'GIT_BRANCH_REQUIRED', 'A detached checkout cannot be bound as a Project Working Copy.', 409);
  const headCommit = git(['rev-parse', 'HEAD'], absolutePath).toLowerCase();
  invariant(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(headCommit),
    'INVALID_GIT_HEAD', 'Git did not return a valid HEAD commit.', 409);
  let defaultBranch = branch;
  try {
    const symbolic = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], absolutePath);
    defaultBranch = symbolic.startsWith('origin/') ? symbolic.slice('origin/'.length) : symbolic;
  } catch {
    // origin/HEAD is optional; the current branch remains the explicit default.
  }
  return {
    absolutePath,
    cloneUrl: normalized.cloneUrl,
    repositoryIdentity: normalized.repositoryIdentity,
    defaultBranch,
    branch,
    headCommit,
    dirty: git(['status', '--porcelain=v1', '--untracked-files=normal'], absolutePath).length > 0,
  };
}

export function cloneGitRepository(cloneUrl: string, defaultBranch: string, destination: string): InspectedWorkingCopy {
  const normalized = normalizeGitCloneUrl(cloneUrl);
  const target = resolve(destination);
  invariant(!existsSync(target), 'CLONE_DESTINATION_EXISTS', 'The clone destination already exists.', 409);
  git(['clone', '--branch', defaultBranch, '--', normalized.cloneUrl, target]);
  return inspectGitWorkingCopy(target);
}

export interface LocalProjectWorkingCopyRow {
  project_id: string;
  workspace_id: string;
  repository_id: string;
  repository_identity: string;
  absolute_path: string;
  bound_at: number;
  checked_at: number;
}

export class ProjectWorkingCopyStore {
  constructor(readonly database: SqliteDatabase) {}

  bind(input: Omit<LocalProjectWorkingCopyRow, 'bound_at' | 'checked_at'>): LocalProjectWorkingCopyRow {
    const timestamp = nowMs();
    this.database.raw.prepare(
      `INSERT INTO local_project_working_copies (
         project_id, workspace_id, repository_id, repository_identity, absolute_path, bound_at, checked_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         repository_id = excluded.repository_id,
         repository_identity = excluded.repository_identity,
         absolute_path = excluded.absolute_path,
         checked_at = excluded.checked_at`,
    ).run(
      input.project_id,
      input.workspace_id,
      input.repository_id,
      input.repository_identity,
      realpathSync(input.absolute_path),
      timestamp,
      timestamp,
    );
    return this.require(input.project_id);
  }

  touch(projectId: string): void {
    this.database.raw.prepare('UPDATE local_project_working_copies SET checked_at = ? WHERE project_id = ?')
      .run(nowMs(), projectId);
  }

  get(projectId: string): LocalProjectWorkingCopyRow | undefined {
    return this.database.raw.prepare('SELECT * FROM local_project_working_copies WHERE project_id = ?')
      .get(projectId) as LocalProjectWorkingCopyRow | undefined;
  }

  require(projectId: string): LocalProjectWorkingCopyRow {
    const row = this.get(projectId);
    invariant(row, 'LOCAL_PROJECT_WORKING_COPY_NOT_FOUND', 'This Computer has no local checkout bound to the Project.', 409);
    return row;
  }

  list(): LocalProjectWorkingCopyRow[] {
    return this.database.raw.prepare('SELECT * FROM local_project_working_copies ORDER BY bound_at, project_id')
      .all() as unknown as LocalProjectWorkingCopyRow[];
  }

  remove(projectId: string): void {
    this.database.raw.prepare('DELETE FROM local_project_working_copies WHERE project_id = ?').run(projectId);
  }
}

export function workingCopyReport(
  repositoryId: string,
  expectedIdentity: string,
  inspected: InspectedWorkingCopy,
): ProjectWorkingCopyReport {
  const matches = inspected.repositoryIdentity === expectedIdentity;
  return {
    repositoryId,
    repositoryIdentity: inspected.repositoryIdentity,
    availability: matches ? 'ready' : 'mismatch',
    branch: matches ? inspected.branch : null,
    headCommit: matches ? inspected.headCommit : null,
    dirty: matches ? inspected.dirty : null,
  };
}

export class AttemptWorkspaceManager {
  constructor(private readonly workingCopies: ProjectWorkingCopyStore) {}

  prepare(executionScope: AttemptExecutionInputView['executionScope'], attemptRoot: string): string {
    const canonicalAttemptRoot = resolve(attemptRoot);
    mkdirSync(canonicalAttemptRoot, { recursive: true });
    const workingDirectory = resolve(canonicalAttemptRoot, 'work');
    if (executionScope.kind === 'workspace_scratch') {
      mkdirSync(workingDirectory, { recursive: true });
      return realpathSync(workingDirectory);
    }

    const binding = this.workingCopies.require(executionScope.projectId);
    const inspected = inspectGitWorkingCopy(binding.absolute_path);
    invariant(
      binding.repository_id === executionScope.repositoryId
      && binding.repository_identity === executionScope.repositoryIdentity
      && inspected.repositoryIdentity === executionScope.repositoryIdentity,
      'PROJECT_REPOSITORY_MISMATCH',
      'The bound local checkout does not match the Attempt Repository.',
      409,
    );
    if (existsSync(workingDirectory)) {
      invariant(git(['rev-parse', 'HEAD'], workingDirectory).toLowerCase() === executionScope.baseCommit,
        'ATTEMPT_WORKTREE_CONFLICT', 'The retained Attempt worktree is pinned to a different commit.', 409);
      return realpathSync(workingDirectory);
    }
    git(['cat-file', '-e', `${executionScope.baseCommit}^{commit}`], inspected.absolutePath);
    git(['worktree', 'add', '--detach', workingDirectory, executionScope.baseCommit], inspected.absolutePath);
    return realpathSync(workingDirectory);
  }

  cleanup(projectId: string, attemptRoot: string): void {
    const canonicalAttemptRoot = resolve(attemptRoot);
    const workingDirectory = resolve(canonicalAttemptRoot, 'work');
    invariant(relative(canonicalAttemptRoot, workingDirectory) === 'work',
      'INVALID_ATTEMPT_PATH', 'Attempt worktree path is invalid.', 409);
    if (!existsSync(workingDirectory)) return;
    const binding = this.workingCopies.require(projectId);
    git(['worktree', 'remove', '--force', workingDirectory], binding.absolute_path);
    if (existsSync(workingDirectory)) rmSync(workingDirectory, { recursive: true, force: true });
  }
}
