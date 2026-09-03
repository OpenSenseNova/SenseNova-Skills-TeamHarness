export type LocalAgentPermissionDecision = 'allow_once' | 'reject';

const TEAMCTL_COMMAND = /^(?:teamctl(?:\.cmd)?|\.\.[\\/]bin[\\/]teamctl(?:\.cmd)?)(?:\s|$)/u;

function commandText(request: unknown): string | null {
  if (typeof request !== 'object' || request === null) return null;
  const toolCall = (request as { toolCall?: unknown }).toolCall;
  if (typeof toolCall !== 'object' || toolCall === null) return null;
  if ((toolCall as { kind?: unknown }).kind !== 'execute') return null;
  const rawInput = (toolCall as { rawInput?: unknown }).rawInput;
  if (typeof rawInput !== 'object' || rawInput === null) return null;
  const command = (rawInput as { command?: unknown }).command;
  if (typeof command !== 'string') return null;
  const trimmed = command.trim();
  if (!trimmed.startsWith('"')) return trimmed;
  if (trimmed.length < 2 || !trimmed.endsWith('"')) return null;
  for (let index = 1; index < trimmed.length - 1; index += 1) {
    if (trimmed[index] === '\\') {
      index += 1;
      continue;
    }
    if (trimmed[index] === '"') return null;
  }
  return trimmed.slice(1, -1).trim();
}

function containsUnquotedShellControl(command: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (character === '\\' && quote !== "'") {
      index += 1;
      continue;
    }
    if (character === "'" && quote !== '"') {
      quote = quote === "'" ? null : "'";
      continue;
    }
    if (character === '"' && quote !== "'") {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (character === '`' || (character === '$' && command[index + 1] === '(' && quote !== "'")) return true;
    if (quote === null && ('\r\n;&|<>'.includes(character))) return true;
  }
  return quote !== null;
}

/**
 * An unattended Local Computer may authorize only the Agent-scoped teamctl
 * bridge. Arbitrary shell composition remains rejected.
 */
export function localAgentPermissionDecision(request: unknown): LocalAgentPermissionDecision {
  const command = commandText(request);
  if (!command || !TEAMCTL_COMMAND.test(command)) return 'reject';
  return containsUnquotedShellControl(command) ? 'reject' : 'allow_once';
}
