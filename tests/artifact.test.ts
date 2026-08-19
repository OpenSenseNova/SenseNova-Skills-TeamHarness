import { readFileSync } from 'node:fs';
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { createTestService, reportReadyRuntime } from './helpers.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

describe('Workspace Artifact current state and snapshots', () => {
  it('deduplicates Markdown snapshots by hash and preserves UUID identity across history operations', async () => {
    const { service, workspaceDatabase } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Product', 'artifact-workspace');
    const conversation = service.createConversation(
      principal,
      workspace.id,
      { kind: 'channel', title: 'Artifact review' },
      'artifact-conversation',
    );
    const artifact = service.artifacts.createMarkdown(
      principal,
      workspace.id,
      { name: 'Plan.md' },
      'artifact-markdown',
    );

    expect(artifact.currentState.currentRevision).toBe(0);
    expect(artifact.latestSnapshot).toBeNull();
    expect(service.artifacts.listSnapshots(principal, artifact.id)).toEqual([]);

    const document = new Y.Doc();
    Y.applyUpdate(document, service.artifacts.fetchDraftState(artifact.id));
    document.getText('content').insert(0, '# Plan\n\nFirst state.');
    service.artifacts.storeDraftState(artifact.id, workspace.membershipId, Y.encodeStateAsUpdate(document));
    expect(service.artifacts.listSnapshots(principal, artifact.id)).toEqual([]);

    const firstSave = await service.artifacts.saveCurrentSnapshot(
      principal,
      artifact.id,
      { expectedCurrentRevision: 1, label: null },
      'artifact-save-1',
    );
    expect(firstSave.created).toBe(true);
    expect(firstSave.snapshot.snapshotId).toMatch(UUID_PATTERN);
    expect(firstSave.snapshot.label).toBeNull();
    expect(readFileSync(
      service.artifacts.snapshotBlob(principal, artifact.id, firstSave.snapshot.snapshotId).storagePath,
      'utf8',
    )).toBe('# Plan\n\nFirst state.');

    const duplicate = await service.artifacts.saveCurrentSnapshot(
      principal,
      artifact.id,
      { expectedCurrentRevision: 1, label: null },
      'artifact-save-duplicate',
    );
    expect(duplicate).toMatchObject({ created: false, labelChanged: false });
    expect(duplicate.snapshot.snapshotId).toBe(firstSave.snapshot.snapshotId);
    expect(service.artifacts.listSnapshots(principal, artifact.id)).toHaveLength(1);

    const labeled = await service.artifacts.saveCurrentSnapshot(
      principal,
      artifact.id,
      { expectedCurrentRevision: 1, label: 'First checkpoint' },
      'artifact-save-label',
    );
    expect(labeled).toMatchObject({ created: false, labelChanged: true });
    expect(labeled.snapshot.snapshotId).toBe(firstSave.snapshot.snapshotId);
    const cleared = service.artifacts.renameSnapshot(
      principal,
      artifact.id,
      labeled.snapshot.snapshotId,
      { label: null, expectedRevision: labeled.snapshot.revision },
      'artifact-clear-label',
    );
    expect(cleared).toMatchObject({ snapshotId: firstSave.snapshot.snapshotId, label: null });

    const referenced = service.postMessage(principal, conversation.id, {
      body: 'Review this snapshot.',
      artifactSelections: [{ artifactId: artifact.id, snapshotId: firstSave.snapshot.snapshotId }],
    }, 'artifact-message');
    expect(referenced.artifactReferences[0]).toMatchObject({
      artifactSnapshotId: firstSave.snapshot.snapshotId,
      snapshotLabel: null,
      contentAvailable: true,
    });

    document.getText('content').insert(document.getText('content').length, '\n\nSecond state.');
    service.artifacts.storeDraftState(artifact.id, workspace.membershipId, Y.encodeStateAsUpdate(document));
    const secondSave = await service.artifacts.saveCurrentSnapshot(
      principal,
      artifact.id,
      { expectedCurrentRevision: 2, label: 'Second checkpoint' },
      'artifact-save-2',
    );
    expect(secondSave.created).toBe(true);
    expect(secondSave.snapshot.snapshotId).not.toBe(firstSave.snapshot.snapshotId);
    expect(secondSave.snapshot.parentSnapshotId).toBe(firstSave.snapshot.snapshotId);

    const restored = service.artifacts.restoreSnapshot(
      principal,
      artifact.id,
      firstSave.snapshot.snapshotId,
      2,
      'artifact-restore-snapshot',
    );
    expect(restored.currentState.currentRevision).toBe(3);
    expect(restored.latestSnapshot?.snapshotId).toBe(firstSave.snapshot.snapshotId);
    expect(readFileSync(service.artifacts.currentBlob(principal, artifact.id).storagePath, 'utf8'))
      .toBe('# Plan\n\nFirst state.');
    expect(service.artifacts.getSnapshot(principal, artifact.id, firstSave.snapshot.snapshotId).snapshotId)
      .toBe(firstSave.snapshot.snapshotId);

    const relabeledAfterRestore = await service.artifacts.saveCurrentSnapshot(
      principal,
      artifact.id,
      { expectedCurrentRevision: 3, label: 'Restored checkpoint' },
      'artifact-save-after-restore',
    );
    expect(relabeledAfterRestore).toMatchObject({ created: false, labelChanged: true });
    expect(relabeledAfterRestore.snapshot.snapshotId).toBe(firstSave.snapshot.snapshotId);
    expect(relabeledAfterRestore.artifact.latestSnapshot?.snapshotId).toBe(firstSave.snapshot.snapshotId);

    service.artifacts.deleteSnapshot(
      principal,
      artifact.id,
      firstSave.snapshot.snapshotId,
      relabeledAfterRestore.snapshot.revision,
      'artifact-delete-snapshot',
    );
    expect(service.artifacts.listSnapshots(principal, artifact.id).map((item) => item.snapshotId))
      .toEqual([secondSave.snapshot.snapshotId]);
    expect(service.listMessages(principal, conversation.id)[0]!.artifactReferences[0]).toMatchObject({
      artifactSnapshotId: firstSave.snapshot.snapshotId,
      contentAvailable: false,
    });

    workspaceDatabase.raw.prepare(
      'UPDATE artifact_snapshots SET purge_after = 0 WHERE id = ?',
    ).run(firstSave.snapshot.snapshotId);
    service.artifacts.purgeExpired();
    expect(workspaceDatabase.raw.prepare(
      'SELECT id, label, blob_hash, content_purged_at FROM artifact_snapshots WHERE id = ?',
    ).get(firstSave.snapshot.snapshotId)).toMatchObject({
      id: firstSave.snapshot.snapshotId,
      label: 'Restored checkpoint',
      blob_hash: null,
      content_purged_at: expect.any(Number),
    });
  });

  it('replaces File current state without creating history and rejects stale or unchanged writes', async () => {
    const { service, workspaceDatabase } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Product', 'file-workspace');
    const firstBlob = await service.artifacts.blobs.writeBuffer(Buffer.from('shared bytes'), 'application/octet-stream');
    const artifact = service.artifacts.createFile(principal, workspace.id, { name: 'one.bin' }, firstBlob, 'file-one');

    expect(artifact.currentState).toMatchObject({ currentRevision: 1, contentDigest: firstBlob.hash });
    expect(artifact.latestSnapshot).toBeNull();
    expect(service.artifacts.listSnapshots(principal, artifact.id)).toEqual([]);
    expect(() => service.artifacts.replaceFileCurrent(
      principal,
      artifact.id,
      { expectedCurrentRevision: 1 },
      firstBlob,
      'file-unchanged',
    )).toThrowError(expect.objectContaining({ code: 'ARTIFACT_CONTENT_UNCHANGED' }));

    const replacement = await service.artifacts.blobs.writeBuffer(Buffer.from('replacement'), 'application/octet-stream');
    const replaced = service.artifacts.replaceFileCurrent(
      principal,
      artifact.id,
      { expectedCurrentRevision: 1 },
      replacement,
      'file-replace',
    );
    expect(replaced.currentState).toMatchObject({ currentRevision: 2, contentDigest: replacement.hash });
    expect(service.artifacts.listSnapshots(principal, artifact.id)).toEqual([]);
    expect(readFileSync(service.artifacts.currentBlob(principal, artifact.id).storagePath)).toEqual(Buffer.from('replacement'));

    const thirdBlob = await service.artifacts.blobs.writeBuffer(Buffer.from('third'), 'application/octet-stream');
    expect(() => service.artifacts.replaceFileCurrent(
      principal,
      artifact.id,
      { expectedCurrentRevision: 1 },
      thirdBlob,
      'file-stale',
    )).toThrowError(expect.objectContaining({ code: 'ARTIFACT_CURRENT_CONFLICT' }));

    const saved = await service.artifacts.saveCurrentSnapshot(
      principal,
      artifact.id,
      { expectedCurrentRevision: 2, label: 'Release candidate' },
      'file-save-history',
    );
    expect(saved.snapshot).toMatchObject({ label: 'Release candidate', contentDigest: replacement.hash });
    expect(saved.snapshot.snapshotId).toMatch(UUID_PATTERN);
    expect(workspaceDatabase.raw.prepare('SELECT COUNT(*) AS count FROM artifact_snapshots').get()).toEqual({ count: 1 });
  });

  it('publishes Agent output with the same snapshot model and rejects a changed current-state baseline', async () => {
    const { service, workspaceDatabase } = createTestService();
    const alice = service.bootstrapHuman('Alice', 'alice@example.com');
    const principal = { kind: 'human' as const, actorId: alice.humanId };
    const workspace = service.createWorkspace(principal, 'Product', 'agent-artifact-workspace');
    const computer = service.registerComputer(principal, { name: 'Alice Mac' }, 'agent-artifact-computer');
    reportReadyRuntime(service, computer.computerId, alice.humanId);
    const agent = service.createAgent(principal, workspace.id, {
      name: 'Writer',
      runtimeBinding: { computerId: computer.computerId, runtimeId: 'generic-acp' },
    }, 'agent-artifact-agent');
    const conversation = service.createConversation(principal, workspace.id, {
      kind: 'channel',
      title: 'Writing',
    }, 'agent-artifact-conversation');

    const firstRequest = service.postMessage(principal, conversation.id, {
      body: '@Writer publish a report',
      mentionedActorIds: [agent.id],
    }, 'agent-artifact-request-1').mentionOutcomes[0]!.agentRequestId!;
    const firstRun = service.acceptAgentRequest(computer.computerId, firstRequest, { expectedVersion: 1 }, 'agent-artifact-accept-1');
    const firstAttempt = service.createAttempt(computer.computerId, firstRun.id, 'agent-artifact-attempt-1');
    const firstInput = service.getAttemptExecutionInput(computer.computerId, firstAttempt.id);
    service.localExecutions.start(firstAttempt.id, firstInput.workspaceId, firstInput.runId);
    const firstBlob = await service.artifacts.blobs.writeBuffer(Buffer.from('# Agent report'), 'text/markdown; charset=utf-8');
    const firstStage = service.stageAttemptBlob(computer.computerId, firstAttempt.id, firstBlob);
    const published = service.returnAttempt(computer.computerId, firstAttempt.id, {
      disposition: 'publish',
      messages: [{ body: 'The report is ready.' }],
      artifactPublications: [{
        stagedBlobId: firstStage.id,
        name: 'Agent report.md',
        artifactType: 'markdown',
        attachToMessageIndexes: [0],
      }],
    }, 'agent-artifact-return-1');
    const publishedArtifact = published.publishedArtifacts[0]!;
    expect(publishedArtifact.latestSnapshot?.snapshotId).toMatch(UUID_PATTERN);
    expect(publishedArtifact.latestSnapshot).not.toHaveProperty('producingRunId');
    expect(published.publishedMessages[0]!.artifactReferences[0]).toMatchObject({
      artifactSnapshotId: publishedArtifact.latestSnapshot!.snapshotId,
      contentAvailable: true,
    });
    expect(workspaceDatabase.raw.prepare('SELECT id FROM staged_blobs WHERE id = ?').get(firstStage.id)).toBeUndefined();

    const shared = service.artifacts.createMarkdown(principal, workspace.id, { name: 'Shared baseline.md' }, 'agent-baseline-artifact');
    const sharedDocument = new Y.Doc();
    Y.applyUpdate(sharedDocument, service.artifacts.fetchDraftState(shared.id));
    sharedDocument.getText('content').insert(0, '# Baseline');
    service.artifacts.storeDraftState(shared.id, workspace.membershipId, Y.encodeStateAsUpdate(sharedDocument));
    const secondRequest = service.postMessage(principal, conversation.id, {
      body: '@Writer update the shared baseline',
      mentionedActorIds: [agent.id],
    }, 'agent-artifact-request-2').mentionOutcomes[0]!.agentRequestId!;
    const secondRun = service.acceptAgentRequest(computer.computerId, secondRequest, { expectedVersion: 1 }, 'agent-artifact-accept-2');
    const secondAttempt = service.createAttempt(computer.computerId, secondRun.id, 'agent-artifact-attempt-2');
    const secondInput = service.getAttemptExecutionInput(computer.computerId, secondAttempt.id);
    service.localExecutions.start(secondAttempt.id, secondInput.workspaceId, secondInput.runId);
    const baseline = service.artifacts.get(principal, shared.id).currentState;
    const baselineRevision = baseline.currentRevision;

    sharedDocument.getText('content').insert(sharedDocument.getText('content').length, '\nHuman edit');
    service.artifacts.storeDraftState(shared.id, workspace.membershipId, Y.encodeStateAsUpdate(sharedDocument));
    const secondBlob = await service.artifacts.blobs.writeBuffer(Buffer.from('# Agent replacement'), 'text/markdown; charset=utf-8');
    const secondStage = service.stageAttemptBlob(computer.computerId, secondAttempt.id, secondBlob);
    expect(() => service.returnAttempt(computer.computerId, secondAttempt.id, {
      disposition: 'publish',
      messages: [{ body: 'This must roll back.' }],
      artifactPublications: [{
        stagedBlobId: secondStage.id,
        artifactId: shared.id,
        name: shared.name,
        artifactType: 'markdown',
        expectedCurrentRevision: baselineRevision,
        expectedContentDigest: baseline.contentDigest,
        attachToMessageIndexes: [0],
      }],
    }, 'agent-artifact-return-stale')).toThrowError(expect.objectContaining({ code: 'ARTIFACT_CURRENT_CONFLICT' }));
    expect(service.artifacts.listSnapshots(principal, shared.id)).toHaveLength(0);
    expect(workspaceDatabase.raw.prepare('SELECT id FROM staged_blobs WHERE id = ?').get(secondStage.id))
      .toEqual({ id: secondStage.id });
    expect(service.listMessages(principal, conversation.id).some((item) => item.body === 'This must roll back.')).toBe(false);
    service.failAttempt(computer.computerId, secondAttempt.id, 'stale publication rejected', 'agent-artifact-fail-2');
  });
});
