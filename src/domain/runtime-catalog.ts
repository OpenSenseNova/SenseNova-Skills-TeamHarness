import type { RuntimeId } from './types.js';

export interface RuntimeCatalogDefinition {
  id: RuntimeId;
  label: string;
  protocol: 'acp-v1';
}

/**
 * Stable Workspace-facing Runtime identities. Local launch commands and paths
 * intentionally live in the Local Agent catalog, never in Workspace state.
 */
export const RUNTIME_CATALOG: readonly RuntimeCatalogDefinition[] = [
  { id: 'codex', label: 'Codex', protocol: 'acp-v1' },
  { id: 'claude', label: 'Claude Code', protocol: 'acp-v1' },
  { id: 'gemini', label: 'Gemini CLI', protocol: 'acp-v1' },
  { id: 'goose', label: 'Goose', protocol: 'acp-v1' },
  { id: 'hermes', label: 'Hermes Agent', protocol: 'acp-v1' },
] as const;

const runtimeDefinitions = new Map<RuntimeId, RuntimeCatalogDefinition>(
  RUNTIME_CATALOG.map((definition) => [definition.id, definition]),
);

export function runtimeCatalogDefinition(runtimeId: RuntimeId): RuntimeCatalogDefinition {
  const definition = runtimeDefinitions.get(runtimeId);
  return definition ?? { id: runtimeId, label: runtimeId, protocol: 'acp-v1' };
}
