const PROJECT_ARCHIVE_KEY_PREFIX = 'anc:archived-projects:';

function storageKey(workspaceId: string): string {
  return `${PROJECT_ARCHIVE_KEY_PREFIX}${workspaceId}`;
}

export function readArchivedProjectIds(workspaceId: string): Set<string> {
  if (!workspaceId || typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(storageKey(workspaceId));
    const value: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(value)) return new Set();
    return new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0));
  } catch {
    return new Set();
  }
}

export function writeArchivedProjectIds(workspaceId: string, ids: Iterable<string>): void {
  if (!workspaceId || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey(workspaceId), JSON.stringify([...new Set(ids)].sort()));
  } catch {
    // Local-only archive state is best effort when browser storage is unavailable.
  }
}
