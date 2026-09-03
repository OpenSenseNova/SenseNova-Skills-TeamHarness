import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { resolve } from 'node:path';
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

let promptCount = 0;
let finishCancelledPrompt: (() => void) | undefined;
const config = new Map<string, string>([
  ['model', 'fake-default'],
  ['reasoning_effort', 'medium'],
]);
let mode = 'default';
let legacyModel = 'fake-legacy-default';
let initialObjective = '';
let initialArtifact: {
  id: string;
  path: string;
  artifactType: string;
  stateHash: string;
  name: string;
} | null = null;
let heldArtifactDraftId: string | null = null;

function promptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return '';
  return prompt.map((part) => (
    typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text'
      ? String((part as { text?: unknown }).text ?? '')
      : ''
  )).join('\n');
}

function triggerMessage(prompt: string): string {
  const lines = prompt.split('\n');
  const triggerIndex = lines.findIndex((line) => (
    line.startsWith('[event="message.created"') && line.includes(' trigger=true')
  ));
  if (triggerIndex === -1) return '';
  const body: string[] = [];
  for (let index = triggerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith('[event=')) break;
    body.push(line);
  }
  return body.join('\n').trim();
}

function runTeamctl(args: string[]): Record<string, unknown> {
  const output = execFileSync(
    process.platform === 'win32' ? 'teamctl.cmd' : 'teamctl',
    args,
    { encoding: 'utf8' },
  );
  return JSON.parse(output.trim()) as Record<string, unknown>;
}

function publishThroughTeamctl(): void {
  const mode = process.env.FAKE_ACP_USE_TEAMCTL;
  if (!mode) return;
  const firstPublicationPrompt = Number(process.env.FAKE_ACP_TEAMCTL_AFTER_PROMPT ?? '1');
  if (promptCount < firstPublicationPrompt) return;
  const inbox = runTeamctl(['inbox', 'check']);
  const targets = ((inbox.result as { targets?: Array<{ kind?: string; target: string }> } | undefined)?.targets ?? []);
  const target = targets[0]?.target;
  if (!target) return;
  const checked = runTeamctl(['message', 'check', '--target', target]);
  const checkedResult = checked.result as {
    discussion?: { messages?: Array<{
      id: string;
      body: string;
      artifactReferences?: Array<{ artifactId?: string }>;
    }> };
    attention?: Array<{ messageId: string }>;
  } | undefined;
  const discussionMessages = checkedResult?.discussion?.messages ?? [];
  const attentionMessageIds = new Set((checkedResult?.attention ?? []).map((item) => item.messageId));
  const attentionObjective = discussionMessages
    .filter((message) => attentionMessageIds.has(message.id))
    .map((message) => message.body)
    .join('\n');
  initialObjective = discussionMessages.map((message) => message.body).join('\n');
  if (mode === 'message') {
    runTeamctl(['message', 'check', '--target', target]);
    runTeamctl(['message', 'send', '--target', target, '--body', `prompt-${promptCount}`]);
    return;
  }
  if (mode === 'artifact-review') {
    if (promptCount === 1) {
      const artifactId = process.env.FAKE_ACP_ARTIFACT_ID;
      const baseHash = process.env.FAKE_ACP_ARTIFACT_STATE_HASH;
      if (!artifactId || !baseHash) throw new Error('Artifact review fixture requires a baseline Artifact.');
      const publication = runTeamctl([
        'artifact', 'update', artifactId, '--base-hash', baseHash,
        '--name', 'Reviewed after hold',
      ]);
      if ((publication.result as { status?: string } | undefined)?.status !== 'held') {
        throw new Error('Artifact review fixture expected the first publication to be held.');
      }
      heldArtifactDraftId = String((publication.result as { draftId?: unknown }).draftId ?? '');
      return;
    }
    const artifactId = process.env.FAKE_ACP_ARTIFACT_ID!;
    runTeamctl(['artifact', 'read', artifactId]);
    const publication = runTeamctl([
      'artifact', 'publish', '--send-draft', '--draft-id', heldArtifactDraftId!,
    ]);
    if ((publication.result as { status?: string } | undefined)?.status !== 'published') {
      throw new Error('Artifact review fixture expected the reviewed draft to publish.');
    }
    runTeamctl(['return', 'no-output', '--target', target]);
    return;
  }
  if (mode === 'multi-ppt') {
    const writerFixture = process.env.FAKE_ACP_PPT_WRITER_PATH;
    const reviewedFixture = process.env.FAKE_ACP_PPT_REVIEWED_PATH;
    if (!writerFixture || !reviewedFixture) {
      throw new Error('Multi-PPT fixture paths are required.');
    }
    const artifactPath = resolve(process.cwd(), 'multi-agent-ppt-e2e.pptx');
    if (/\[role=deck-builder\]/iu.test(attentionObjective)) {
      copyFileSync(writerFixture, artifactPath);
      const publication = runTeamctl([
        'artifact', 'publish', '--file', artifactPath, '--name', 'multi-agent-ppt-e2e.pptx',
        '--type', 'file',
      ]);
      if ((publication.result as { status?: string } | undefined)?.status !== 'published') {
        throw new Error('Deck Builder did not publish the initial PowerPoint.');
      }
      const artifactId = String((publication.result as { artifact?: { id?: unknown } }).artifact?.id ?? '');
      if (!artifactId) throw new Error('Deck Builder publication did not return an Artifact id.');
      runTeamctl(['message', 'check', '--target', target]);
      runTeamctl([
        'message', 'send', '--target', target,
        '--body', 'Deck Builder published the initial PowerPoint.',
        '--artifact-id', artifactId,
      ]);
      return;
    }

    const referencedArtifactId = discussionMessages.flatMap((message) => message.artifactReferences ?? [])
      .map((reference) => reference.artifactId).find(Boolean);
    if (!referencedArtifactId) throw new Error('Deck Reviewer did not receive a PowerPoint Artifact reference.');
    const read = runTeamctl(['artifact', 'read', referencedArtifactId]);
    const materialized = read.result as {
      artifact?: { id?: string; name?: string; artifactType?: string; stateHash?: string };
      filePath?: string;
    } | undefined;
    if (
      !materialized?.artifact?.id
      || materialized.artifact.name !== 'multi-agent-ppt-e2e.pptx'
      || materialized.artifact.artifactType !== 'file'
      || !materialized.artifact.stateHash
      || !materialized.filePath
      || readFileSync(materialized.filePath).subarray(0, 2).toString('utf8') !== 'PK'
    ) {
      throw new Error('Deck Reviewer did not materialize a valid PowerPoint baseline.');
    }
    copyFileSync(reviewedFixture, artifactPath);
    const publication = runTeamctl([
      'artifact', 'publish', '--file', artifactPath,
      '--name', materialized.artifact.name, '--type', 'file',
      '--artifact-id', materialized.artifact.id,
      '--base-hash', materialized.artifact.stateHash,
    ]);
    if ((publication.result as { status?: string } | undefined)?.status !== 'published') {
      throw new Error('Deck Reviewer did not publish the reviewed PowerPoint.');
    }
    runTeamctl(['message', 'check', '--target', target]);
    runTeamctl([
      'message', 'send', '--target', target,
      '--body', 'Deck Reviewer published the approved PowerPoint.',
      '--artifact-id', materialized.artifact.id,
    ]);
    return;
  }
  if (mode !== 'multi-artifact') throw new Error(`Unsupported FAKE_ACP_USE_TEAMCTL mode ${mode}.`);
  const artifactPath = resolve(process.cwd(), 'multi-agent-artifact.md');
  if (/@writer\b/iu.test(attentionObjective)) {
    writeFileSync(artifactPath, '# Multi-Agent Artifact\n\nWriter draft.\n', 'utf8');
    const publication = runTeamctl([
      'artifact', 'publish', '--file', artifactPath, '--name', 'multi-agent-artifact.md',
      '--type', 'markdown',
    ]);
    const artifactId = String((publication.result as { artifact?: { id?: unknown } }).artifact?.id ?? '');
    runTeamctl(['message', 'check', '--target', target]);
    runTeamctl([
      'message', 'send', '--target', target, '--body', 'Writer published the first Artifact version.',
      '--artifact-id', artifactId,
    ]);
    return;
  }
  const referencedArtifactId = discussionMessages.flatMap((message) => message.artifactReferences ?? [])
    .map((reference) => reference.artifactId).find(Boolean);
  if (referencedArtifactId) {
    const read = runTeamctl(['artifact', 'read', referencedArtifactId]);
    const materialized = read.result as {
      artifact?: { id?: string; name?: string; artifactType?: string; stateHash?: string };
      filePath?: string;
    } | undefined;
    if (materialized?.artifact?.id && materialized.filePath) {
      initialArtifact = {
        id: materialized.artifact.id,
        path: materialized.filePath,
        artifactType: materialized.artifact.artifactType ?? 'markdown',
        stateHash: materialized.artifact.stateHash ?? '',
        name: materialized.artifact.name ?? 'artifact.md',
      };
    }
  }
  const artifact = initialArtifact;
  if (!artifact || artifact.name !== 'multi-agent-artifact.md') {
    throw new Error('Reviewer did not receive an Artifact baseline event.');
  }
  const original = readFileSync(artifact.path, 'utf8');
  writeFileSync(artifactPath, `${original.trim()}\n\nReviewer revision.\n`, 'utf8');
  runTeamctl([
    'artifact', 'publish', '--file', artifactPath,
    '--name', artifact.name, '--type', artifact.artifactType,
    '--artifact-id', artifact.id,
    '--base-hash', artifact.stateHash,
  ]);
  runTeamctl(['message', 'check', '--target', target]);
  runTeamctl(['message', 'send', '--target', target, '--body', 'Reviewer published the second Artifact version.']);
}
const reasoningEffortsForModel = (model: string) => (
  model === 'fake-pro' ? ['high'] : ['low', 'medium']
);
const configOptions = () => {
  const reasoningEfforts = reasoningEffortsForModel(config.get('model')!);
  return [
    {
      id: 'model', name: 'Model', category: 'model', type: 'select' as const,
      currentValue: config.get('model')!,
      options: [
        { value: 'fake-default', name: 'Fake default' },
        { value: 'fake-pro', name: 'Fake pro' },
      ],
    },
    {
      id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select' as const,
      currentValue: config.get('reasoning_effort')!,
      options: reasoningEfforts.map((value) => ({ value, name: value })),
    },
  ];
};
const app = agent({ name: 'fake-acp-agent' })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { loadSession: true },
    agentInfo: { name: 'fake-acp-agent', version: '1.0.0' },
  }))
  .onRequest(methods.agent.session.new, () => ({
    sessionId: 'fake-session-1',
    configOptions: process.env.FAKE_ACP_LEGACY_MODELS === '1'
      ? configOptions().filter((option) => option.category !== 'model')
      : configOptions(),
    ...(process.env.FAKE_ACP_LEGACY_MODELS === '1' ? {
      models: {
        currentModelId: legacyModel,
        availableModels: [
          { modelId: 'fake-legacy-default', name: 'Fake legacy default' },
          { modelId: 'fake-legacy-pro', name: 'Fake legacy pro' },
        ],
      },
    } : {}),
    modes: {
      currentModeId: mode,
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'autonomous', name: 'Autonomous' },
      ],
    },
  }))
  .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
    const value = String(params.value);
    if (params.configId === 'model') {
      config.set(params.configId, value);
      const supportedEfforts = reasoningEffortsForModel(value);
      if (!supportedEfforts.includes(config.get('reasoning_effort')!)) {
        config.set('reasoning_effort', supportedEfforts[0]!);
      }
    } else if (params.configId === 'reasoning_effort') {
      if (!reasoningEffortsForModel(config.get('model')!).includes(value)) {
        throw new Error(`Unsupported reasoning effort ${value} for ${config.get('model')}.`);
      }
      config.set(params.configId, value);
    } else {
      config.set(params.configId, value);
    }
    return { configOptions: configOptions() };
  })
  .onRequest('session/set_model', (params) => params as { modelId: string }, ({ params }) => {
    legacyModel = params.modelId;
    return {};
  })
  .onRequest(methods.agent.session.setMode, ({ params }) => {
    mode = params.modeId;
    return {};
  })
  .onRequest(methods.agent.session.load, async ({ params, client }) => {
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'replayed local view' },
      },
    });
  })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    promptCount += 1;
    const currentPrompt = promptText(params.prompt);
    if (/context-manifest|context-feed|addendum cursor|additional workspace information/iu.test(currentPrompt)) {
      throw new Error('Runtime prompt contains a removed push-context instruction.');
    }
    if (/stable agent id|agent workspace gateway|identify yourself as/iu.test(currentPrompt)) {
      throw new Error('Runtime prompt contains removed Agent identity or gateway instructions.');
    }
    const forbiddenPromptText = process.env.FAKE_ACP_FORBID_PROMPT_TEXT;
    if (forbiddenPromptText && currentPrompt.includes(forbiddenPromptText)) {
      throw new Error('Runtime wake embedded a user Message body.');
    }
    if (
      process.env.FAKE_ACP_REQUIRE_FRESHNESS_REVIEW === '1'
      && promptCount === 2
      && !currentPrompt.includes('Freshness review required.')
    ) {
      throw new Error('Runtime did not receive an explicit freshness review turn.');
    }
    if (promptCount === 1) {
      initialObjective = triggerMessage(currentPrompt);
      const artifactHeader = currentPrompt.split('\n').find((line) => (
        line.includes('source="artifact"') && line.includes('path=')
      ));
      if (artifactHeader) {
        const field = (name: string): string => {
          const match = artifactHeader.match(
            new RegExp(`(?:^| )${name}=("(?:\\\\.|[^"\\\\])*"|[^\\s\\]]+)`, 'u'),
          );
          if (!match?.[1]) return '';
          return match[1].startsWith('"') ? String(JSON.parse(match[1])) : match[1];
        };
        initialArtifact = {
          id: field('id'), path: field('path'), artifactType: field('artifactType'),
          stateHash: field('stateHash'), name: field('name'),
        };
      }
    }
    if (process.env.FAKE_ACP_REQUEST_TEAMCTL_PERMISSION === '1' && process.env.FAKE_ACP_USE_TEAMCTL) {
      const permission = await client.request(methods.client.session.requestPermission, {
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: 'fake-teamctl-return',
          kind: 'execute',
          status: 'pending',
            rawInput: { command: `teamctl message send --target conversation:test --body 'prompt-${promptCount}'`, cwd: process.cwd() },
        },
        options: [
          { optionId: 'allow-once', name: 'Allow Once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      });
      if (permission.outcome.outcome !== 'selected' || permission.outcome.optionId !== 'allow-once') {
        throw new Error('Agent-scoped teamctl permission was not granted once.');
      }
    }
    if (process.env.FAKE_ACP_EMIT_ACTIVITY === '1') {
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'plan',
          entries: [{ content: '检查项目文件', priority: 'high', status: 'in_progress' }],
        },
      });
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'private reasoning must not be published' },
        },
      });
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: `fake-read-${promptCount}`,
          title: '读取项目文件',
          kind: 'read',
          status: 'in_progress',
          rawInput: { path: '/private/example.txt' },
        },
      });
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: `fake-read-${promptCount}`,
          status: 'completed',
          rawOutput: 'private tool output must not be published',
        },
      });
    }
    publishThroughTeamctl();
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: process.env.FAKE_ACP_ECHO_CONFIG === '1'
            ? JSON.stringify({
                model: process.env.FAKE_ACP_LEGACY_MODELS === '1' ? legacyModel : config.get('model'),
                reasoningEffort: config.get('reasoning_effort'),
                mode,
              })
            : `prompt-${promptCount}`,
        },
      },
    });
    if (promptCount === 2 && process.env.FAKE_ACP_WAIT_FOR_CANCEL === '1') {
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'usage_update', used: 2, size: 100 },
      });
      await new Promise<void>((resolvePrompt) => { finishCancelledPrompt = resolvePrompt; });
      return { stopReason: 'cancelled' };
    }
    return { stopReason: 'end_turn' };
  })
  .onNotification(methods.agent.session.cancel, () => {
    finishCancelledPrompt?.();
    finishCancelledPrompt = undefined;
  });

const stream = ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);
const connection = app.connect(stream);
await connection.closed;
