import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { AttemptExecutionInputView } from '../domain/types.js';
import { invariant } from '../lib/errors.js';

/**
 * Creates the disposable local directory for one Runtime Attempt.
 *
 * Project repositories and shared Working Copies are intentionally outside
 * the current scope. Every attempt receives an isolated scratch directory and cleanup
 * is fenced to that directory.
 */
export class AttemptWorkspaceManager {
  prepare(_executionScope: AttemptExecutionInputView['executionScope'], attemptRoot: string): string {
    const canonicalAttemptRoot = resolve(attemptRoot);
    mkdirSync(canonicalAttemptRoot, { recursive: true });
    const workingDirectory = resolve(canonicalAttemptRoot, 'work');
    mkdirSync(workingDirectory, { recursive: true });
    return realpathSync(workingDirectory);
  }

  cleanup(attemptRoot: string): void {
    const canonicalAttemptRoot = resolve(attemptRoot);
    const workingDirectory = resolve(canonicalAttemptRoot, 'work');
    invariant(relative(canonicalAttemptRoot, workingDirectory) === 'work',
      'INVALID_ATTEMPT_PATH', 'Attempt worktree path is invalid.', 409);
    if (!existsSync(workingDirectory)) return;
    rmSync(workingDirectory, { recursive: true, force: true });
  }
}
