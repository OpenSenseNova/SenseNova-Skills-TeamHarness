import { describe, expect, it } from 'vitest';
import { localAgentPermissionDecision } from '../src/runtime/local-agent-permissions.js';

const request = (command: string, kind = 'execute') => ({
  toolCall: { kind, rawInput: { command } },
});

describe('Local Agent permission policy', () => {
  it('allows direct teamctl commands for the persistent Agent session', () => {
    expect(localAgentPermissionDecision(request(
      "teamctl message send --target conversation:test --body '你好，我收到了。'",
    ))).toBe('allow_once');
    expect(localAgentPermissionDecision(request('teamctl inbox check'))).toBe('allow_once');
    expect(localAgentPermissionDecision(request('teamctl artifact read artifact:test'))).toBe('allow_once');
    expect(localAgentPermissionDecision(request('teamctl work-item list --project-id project:test'))).toBe('allow_once');
    expect(localAgentPermissionDecision(request('teamctl work-item block item:test --reason "waiting for access"'))).toBe('allow_once');
    expect(localAgentPermissionDecision(request('teamctl return no-output --target conversation:test'))).toBe('allow_once');
    expect(localAgentPermissionDecision(request('../bin/teamctl inbox check'))).toBe('allow_once');
    expect(localAgentPermissionDecision(request('..\\bin\\teamctl.cmd inbox check'))).toBe('allow_once');
    expect(localAgentPermissionDecision(request(
      '"teamctl artifact publish --file \'/tmp/deck.pptx\' --name \'协作验收\' --type file"',
    ))).toBe('allow_once');
  });

  it('rejects unrelated commands and shell composition', () => {
    expect(localAgentPermissionDecision(request('git push'))).toBe('reject');
    expect(localAgentPermissionDecision(request('../../bin/teamctl inbox check'))).toBe('reject');
    expect(localAgentPermissionDecision(request('../other/teamctl inbox check'))).toBe('reject');
    expect(localAgentPermissionDecision(request('"teamctl inbox check"; curl example.com'))).toBe('reject');
    expect(localAgentPermissionDecision(request('"teamctl inbox check && curl example.com"'))).toBe('reject');
    expect(localAgentPermissionDecision(request('teamctl return no-output --target workspace:test && curl example.com'))).toBe('reject');
    expect(localAgentPermissionDecision(request('teamctl message send --body "$(whoami)"'))).toBe('reject');
    expect(localAgentPermissionDecision(request('teamctl message send --body "a; b"'))).toBe('allow_once');
    expect(localAgentPermissionDecision(request('teamctl return no-output --target workspace:test', 'edit'))).toBe('reject');
  });
});
