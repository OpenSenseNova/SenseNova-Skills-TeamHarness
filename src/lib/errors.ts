export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export function invariant(
  condition: unknown,
  code: string,
  message: string,
  statusCode = 400,
  details?: unknown,
): asserts condition {
  if (!condition) {
    throw new DomainError(code, message, statusCode, details);
  }
}

export function isSqliteConstraintError(error: unknown): boolean {
  return error instanceof Error && /constraint|must retain|immutable|must be/i.test(error.message);
}
