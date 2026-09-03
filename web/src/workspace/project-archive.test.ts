import { beforeEach, describe, expect, it } from 'vitest';
import { readArchivedProjectIds, writeArchivedProjectIds } from './project-archive';

describe('project archive storage', () => {
  beforeEach(() => window.localStorage.clear());

  it('persists a de-duplicated, sorted set per workspace', () => {
    writeArchivedProjectIds('workspace-a', ['project-2', 'project-1', 'project-2']);

    expect(window.localStorage.getItem('anc:archived-projects:workspace-a')).toBe(
      '["project-1","project-2"]',
    );
    expect([...readArchivedProjectIds('workspace-a')]).toEqual(['project-1', 'project-2']);
    expect(readArchivedProjectIds('workspace-b')).toEqual(new Set());
  });

  it('ignores malformed or non-string entries', () => {
    window.localStorage.setItem('anc:archived-projects:workspace-a', '["project-1",42,null,""]');

    expect([...readArchivedProjectIds('workspace-a')]).toEqual(['project-1']);
    window.localStorage.setItem('anc:archived-projects:workspace-a', '{"project":"project-1"}');
    expect(readArchivedProjectIds('workspace-a')).toEqual(new Set());
  });
});
