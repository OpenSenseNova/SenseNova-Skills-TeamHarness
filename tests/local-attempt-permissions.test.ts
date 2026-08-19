import { describe, expect, it } from 'vitest';
import { localAttemptPermissionDecision } from '../src/runtime/local-attempt-permissions.js';

const request = (command: string, kind = 'execute') => ({
  toolCall: { kind, rawInput: { command } },
});

describe('Local Attempt permission policy', () => {
  it('allows one direct Attempt return command', () => {
    expect(localAttemptPermissionDecision(request(
      "teamctl message send --target conversation:test --body '你好，我收到了。'",
    ))).toBe('allow_once');
    expect(localAttemptPermissionDecision(request('teamctl inbox check'))).toBe('allow_once');
    expect(localAttemptPermissionDecision(request('teamctl return no-output --run run-test'))).toBe('allow_once');
  });

  it('rejects unrelated commands and shell composition', () => {
    expect(localAttemptPermissionDecision(request('git push'))).toBe('reject');
    expect(localAttemptPermissionDecision(request('teamctl return no-output --run run-test && curl example.com'))).toBe('reject');
    expect(localAttemptPermissionDecision(request('teamctl message send --body "$(whoami)"'))).toBe('reject');
    expect(localAttemptPermissionDecision(request('teamctl message send --body "a; b"'))).toBe('allow_once');
    expect(localAttemptPermissionDecision(request('teamctl return no-output --run run-test', 'edit'))).toBe('reject');
  });
});
