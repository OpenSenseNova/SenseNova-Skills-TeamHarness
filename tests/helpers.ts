import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach } from 'vitest';
import { WorkspaceService } from '../src/domain/workspace-service.js';
import type { VerificationCodeNotice } from '../src/domain/auth-service.js';
import type {
  ConversationView,
  HumanPrincipal,
  RuntimeConfigurationCapabilities,
  RuntimeId,
} from '../src/domain/types.js';
import { SqliteDatabase } from '../src/storage/database.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

export function createTestService(options: { exposeDevelopmentVerificationCode?: boolean } = {}): {
  service: WorkspaceService;
  workspaceDatabase: SqliteDatabase;
  localDatabase: SqliteDatabase;
  verificationNotices: VerificationCodeNotice[];
  close: () => void;
} {
  const directory = mkdtempSync(resolve(tmpdir(), 'anc-test-'));
  const workspaceDatabase = SqliteDatabase.open(resolve(directory, 'workspace.sqlite'), 'workspace');
  const localDatabase = SqliteDatabase.open(resolve(directory, 'local-node.sqlite'), 'local-node');
  const verificationNotices: VerificationCodeNotice[] = [];
  const service = new WorkspaceService(
    workspaceDatabase,
    localDatabase,
    (notice) => verificationNotices.push(notice),
    resolve(directory, 'content-blobs'),
    options.exposeDevelopmentVerificationCode ?? false,
  );
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    localDatabase.close();
    workspaceDatabase.close();
    rmSync(directory, { recursive: true, force: true });
  };
  cleanups.push(close);
  return { service, workspaceDatabase, localDatabase, verificationNotices, close };
}

export function reportReadyRuntime(
  service: WorkspaceService,
  computerId: string,
  ownerHumanId: string,
  readyRuntimeId: RuntimeId = 'generic-acp',
): void {
  service.reportComputerRuntimeCatalog(
    { kind: 'computer', computerId, ownerHumanId },
    {
      runtimes: (['generic-acp', 'codex', 'claude', 'gemini', 'goose', 'hermes'] as const).map((runtimeId) => ({
        runtimeId,
        availability: runtimeId === readyRuntimeId ? 'ready' as const : 'not_installed' as const,
        skills: { global: [], workspace: [] },
        ...(runtimeId === readyRuntimeId
          ? { configuration: testRuntimeConfigurationCapabilities() }
          : {
              unavailableReason: {
                code: 'not_installed' as const,
                message: 'The Runtime is not installed in this test fixture.',
              },
            }),
      })),
    },
  );
}

export function testRuntimeConfigurationCapabilities(): RuntimeConfigurationCapabilities {
  return {
    models: [
      {
        id: 'runtime-default', label: 'Runtime default', description: null,
        supportedReasoningEfforts: null,
      },
      {
        id: 'gpt-5.6-codex', label: 'GPT-5.6 Codex', description: null,
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      },
      {
        id: 'fake-pro', label: 'Fake Pro', description: null,
        supportedReasoningEfforts: ['high'],
      },
    ],
    defaultModelId: 'runtime-default',
    reasoningEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
      .map((id) => ({ id, label: id, description: null })),
    defaultReasoningEffort: 'medium',
    modes: [
      { id: 'default', label: 'Default', description: null },
      { id: 'autonomous', label: 'Autonomous', description: null },
    ],
    defaultModeId: 'default',
  } as RuntimeConfigurationCapabilities;
}

export function workspaceGeneral(
  service: WorkspaceService,
  principal: HumanPrincipal,
  workspaceId: string,
): ConversationView {
  const conversation = service.listConversations(principal, workspaceId).items.find(
    (item) => item.scope.type === 'workspace_general',
  );
  if (!conversation) throw new Error('Workspace general group is missing.');
  return conversation;
}

export function projectMain(
  service: WorkspaceService,
  principal: HumanPrincipal,
  projectId: string,
): ConversationView {
  const conversation = service.listProjectConversations(principal, projectId).items.find(
    (item) => item.scope.type === 'project_group' && item.scope.membershipMode === 'project_all',
  );
  if (!conversation) throw new Error('Project main group is missing.');
  return conversation;
}

export function authorizeAgentInConversation(
  service: WorkspaceService,
  principal: HumanPrincipal,
  conversation: ConversationView,
  workspaceMembershipId: string,
  idempotencyKey: string,
): ConversationView {
  const scopeMembershipId = conversation.scope.type === 'project_group'
    ? service.listProjectMembers(principal, conversation.scope.projectId).items.find(
      (item) => item.workspaceMembershipId === workspaceMembershipId,
    )?.projectMembershipId
    : workspaceMembershipId;
  if (!scopeMembershipId) throw new Error('Conversation participant has no active scope membership.');
  service.addConversationParticipant(
    principal,
    conversation.id,
    scopeMembershipId,
    conversation.revision,
    idempotencyKey,
  );
  return service.getConversation(principal, conversation.id);
}
