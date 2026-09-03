import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTestService, projectMain } from './helpers.js';
import { newId } from '../src/lib/values.js';

describe('Artifact v2 and Project resources', () => {
  it('maintains a mutable Resource tree with per-file CAS and immutable link locators', async () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Workspace', 'resource-v2-workspace');
    const project = service.createProject(principal, workspace.id, { name: 'Project' }, 'resource-v2-project');
    const folder = service.projectResources.createFolder(principal, project.id, { name: 'briefs' });
    const firstBlob = service.projectResources.blobs.writeBufferSync(Buffer.from('one'), 'text/plain');
    const file = await service.projectResources.upload(principal, project.id, { name: 'brief.txt', parentResourceId: folder.resourceId }, firstBlob);
    expect(file).toMatchObject({ path: 'briefs/brief.txt', revision: 1, digest: firstBlob.hash });
    const secondBlob = service.projectResources.blobs.writeBufferSync(Buffer.from('two'), 'text/plain');
    const replaced = await service.projectResources.replace(principal, file.resourceId, 1, secondBlob);
    expect(replaced).toMatchObject({ revision: 2, digest: secondBlob.hash });
    await expect(service.projectResources.replace(principal, file.resourceId, 1, firstBlob)).rejects.toThrow(/changed since it was read/);
    expect(readFileSync(service.projectResources.read(principal, file.resourceId).storagePath, 'utf8')).toBe('two');

    const link = service.projectResources.createLink(principal, project.id, { locator: 'https://example.com/spec', name: 'Spec', description: 'Keep this' });
    expect(service.projectResources.updateLink(principal, link.linkId, { name: 'Specification' })).toMatchObject({ locator: link.locator, name: 'Specification', description: 'Keep this', revision: 2 });
  });

  it('publishes UUID versions with CAS, explicit multi-parent derivation and tombstone fallback', async () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Workspace', 'artifact-v2-workspace');
    const project = service.createProject(principal, workspace.id, { name: 'Project' }, 'artifact-v2-project');
    const first = await service.artifactV2.publish(principal, project.id, { fileName: 'result.txt', artifactName: 'Result' }, service.artifactV2.blobs.writeBufferSync(Buffer.from('v1'), 'text/plain'));
    expect(first).toMatchObject({ created: true, version: { version: 1, parentVersionId: null } });
    const second = await service.artifactV2.publish(principal, project.id, { artifactId: first.artifact.artifactId, expectedLatestVersionId: first.version.versionId, fileName: 'result.txt' }, service.artifactV2.blobs.writeBufferSync(Buffer.from('v2'), 'text/plain'));
    expect(second.version).toMatchObject({ version: 2, parentVersionId: first.version.versionId });
    await expect(service.artifactV2.publish(principal, project.id, { artifactId: first.artifact.artifactId, expectedLatestVersionId: first.version.versionId, fileName: 'stale.txt' }, service.artifactV2.blobs.writeBufferSync(Buffer.from('stale'), 'text/plain'))).rejects.toThrow(/changed since it was read/);

    const derived = await service.artifactV2.publish(principal, project.id, { fileName: 'derived.txt', parentVersionIds: [first.version.versionId, second.version.versionId] }, service.artifactV2.blobs.writeBufferSync(Buffer.from('derived'), 'text/plain'));
    expect(derived.artifact.derivationParentVersionIds).toEqual([first.version.versionId, second.version.versionId]);
    service.artifactV2.deleteVersion(principal, second.version.versionId);
    expect(service.artifactV2.getVersion(principal, second.version.versionId).preview.status).toBe('failed');
    expect(service.artifactV2.getArtifact(principal, first.artifact.artifactId).latestVersion?.versionId).toBe(first.version.versionId);
    const third = await service.artifactV2.publish(principal, project.id, { artifactId: first.artifact.artifactId, expectedLatestVersionId: first.version.versionId, fileName: 'result.txt' }, service.artifactV2.blobs.writeBufferSync(Buffer.from('v3'), 'text/plain'));
    expect(third.version.version).toBe(3);

    // Purging a deleted Artifact must also tombstone any still-active versions
    // while preserving their identities and historical relationships.
    service.artifactV2.deleteArtifact(principal, first.artifact.artifactId);
    expect(() => service.artifactV2.purgeExpired(Date.now() + 8 * 24 * 60 * 60 * 1000)).not.toThrow();
    expect(service.artifactV2.getArtifact(principal, first.artifact.artifactId, true).status).toBe('purged');
    expect(service.artifactV2.getVersion(principal, third.version.versionId, true).status).toBe('purged');
  });

  it('replays an idempotent publication after a response loss without appending a duplicate version', async () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Workspace', 'artifact-v2-idempotency-workspace');
    const project = service.createProject(principal, workspace.id, { name: 'Project' }, 'artifact-v2-idempotency-project');
    const input = { draftId: 'draft-publish-once', fileName: 'result.txt', artifactName: 'Result' };
    const first = await service.artifactV2.publish(
      principal,
      project.id,
      input,
      service.artifactV2.blobs.writeBufferSync(Buffer.from('stable'), 'text/plain'),
      'publish-once',
    );
    const replay = await service.artifactV2.publish(
      principal,
      project.id,
      input,
      service.artifactV2.blobs.writeBufferSync(Buffer.from('stable'), 'text/plain'),
      'publish-once',
    );
    expect(replay).toEqual(first);
    expect(service.artifactV2.listVersions(principal, first.artifact.artifactId)).toHaveLength(1);
    await expect(service.artifactV2.publish(
      principal,
      project.id,
      input,
      service.artifactV2.blobs.writeBufferSync(Buffer.from('different'), 'text/plain'),
      'publish-once',
    )).rejects.toThrow(/different publication/);
  });

  it('pins Message references to a version and reflects later tombstone state', async () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Workspace', 'artifact-v2-message-workspace');
    const project = service.createProject(principal, workspace.id, { name: 'Project' }, 'artifact-v2-message-project');
    const version = await service.artifactV2.publish(principal, project.id, { fileName: 'report.txt' }, service.artifactV2.blobs.writeBufferSync(Buffer.from('report'), 'text/plain'));
    const conversation = projectMain(service, principal, project.id);
    const message = service.postMessage(principal, conversation.id, {
      body: '请查看结果', artifactSelections: [{ artifactId: version.artifact.artifactId, artifactVersionId: version.version.versionId }],
    }, 'artifact-v2-message');
    expect(message.artifactReferences).toEqual([expect.objectContaining({ artifactVersionId: version.version.versionId, version: 1, contentAvailable: true })]);
    service.artifactV2.deleteVersion(principal, version.version.versionId);
    const reread = service.listMessages(principal, conversation.id)[0];
    expect(reread?.artifactReferences).toEqual([expect.objectContaining({ artifactVersionId: version.version.versionId, artifactStatus: 'deleted', contentAvailable: false })]);
  });

  it('scopes Agent runtime access to its sponsored Project membership and preserves Agent provenance', async () => {
    const { service } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const human = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(human, 'Workspace', 'artifact-v2-agent-workspace');
    const project = service.createProject(human, workspace.id, { name: 'Project' }, 'artifact-v2-agent-project');
    const agent = service.createAgent(human, workspace.id, { name: 'Writer' }, 'artifact-v2-agent');
    service.addProjectMember(human, project.id, { workspaceMembershipId: agent.membershipId, role: 'member' }, 'artifact-v2-agent-project-member');
    const computer = { kind: 'computer' as const, computerId: newId(), ownerHumanId: alice.humanId, agentId: agent.id };
    const published = await service.artifactV2.publish(computer, project.id, { fileName: 'agent.txt' }, service.artifactV2.blobs.writeBufferSync(Buffer.from('agent'), 'text/plain'));
    expect(published.version.createdByActorId).toBe(agent.id);
    const anotherAgent = service.createAgent(human, workspace.id, { name: 'Reviewer' }, 'artifact-v2-agent-2');
    const wrong = { ...computer, agentId: anotherAgent.id };
    await expect(service.artifactV2.publish(wrong, project.id, { fileName: 'wrong.txt' }, service.artifactV2.blobs.writeBufferSync(Buffer.from('wrong'), 'text/plain'))).rejects.toThrow(/not accessible/);
  });
});
