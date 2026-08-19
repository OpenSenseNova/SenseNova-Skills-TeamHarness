export type LocalAttemptPermissionDecision = 'allow_once' | 'reject';

function commandText(request: unknown): string | null {
  if (typeof request !== 'object' || request === null) return null;
  const toolCall = (request as { toolCall?: unknown }).toolCall;
  if (typeof toolCall !== 'object' || toolCall === null) return null;
  if ((toolCall as { kind?: unknown }).kind !== 'execute') return null;
  const rawInput = (toolCall as { rawInput?: unknown }).rawInput;
  if (typeof rawInput !== 'object' || rawInput === null) return null;
  const command = (rawInput as { command?: unknown }).command;
  return typeof command === 'string' ? command.trim() : null;
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
 * An unattended Local Computer may authorize only the Attempt-scoped return
 * bridge. Repository commands, network access, and writes outside the Runtime
 * sandbox remain rejected until a Human-facing permission flow exists.
 */
export function localAttemptPermissionDecision(request: unknown): LocalAttemptPermissionDecision {
  const command = commandText(request);
  if (!command || !/^teamctl(?:\.cmd)?(?:\s|$)/u.test(command)) return 'reject';
  return containsUnquotedShellControl(command) ? 'reject' : 'allow_once';
}
