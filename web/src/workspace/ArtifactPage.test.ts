import { describe, expect, it } from 'vitest';
import { artifactReturnTarget } from './ArtifactPage';

describe('Artifact return navigation', () => {
  it('uses browser history when the Artifact was opened from the app', () => {
    expect(artifactReturnTarget({ idx: 2 }, 'workspace-1', 'project-1')).toBe(-1);
  });

  it('falls back to the Project when a Project Artifact is deep-linked', () => {
    expect(artifactReturnTarget({ idx: 0 }, 'workspace-1', 'project-1'))
      .toBe('/w/workspace-1/p/project-1');
  });

  it('falls back to the Workspace when a Workspace Artifact is deep-linked', () => {
    expect(artifactReturnTarget(null, 'workspace-1')).toBe('/w/workspace-1');
  });
});
