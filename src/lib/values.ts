import { createHash, randomBytes, randomUUID } from 'node:crypto';

export function newId(): string {
  return randomUUID();
}

export function nowMs(): number {
  return Date.now();
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function issueToken(): { raw: string; hash: string } {
  const raw = `anc_${randomBytes(32).toString('base64url')}`;
  return { raw, hash: sha256(raw) };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function encodePageCursor(createdAt: number, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id]), 'utf8').toString('base64url');
}

export function decodePageCursor(cursor: string | undefined): { createdAt: number; id: string } | null {
  if (!cursor) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      !Array.isArray(value)
      || value.length !== 2
      || !Number.isSafeInteger(value[0])
      || Number(value[0]) < 0
      || typeof value[1] !== 'string'
      || value[1].length === 0
    ) {
      return null;
    }
    return { createdAt: Number(value[0]), id: value[1] };
  } catch {
    return null;
  }
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortValue(nested)]),
    );
  }
  return value;
}
