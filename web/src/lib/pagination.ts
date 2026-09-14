/** A cursor page returned by the Workspace API. */
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Read every page from a cursor-based endpoint.
 *
 * Keeping pagination in one place prevents screens from subtly disagreeing on
 * cursor handling. The repeated-cursor guard also turns a malformed response
 * into a visible query error instead of an infinite request loop.
 */
export async function loadAllPages<T>(
  loadPage: (cursor?: string) => Promise<CursorPage<T>>,
): Promise<T[]> {
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  do {
    const page = await loadPage(cursor);
    items.push(...page.items);

    const nextCursor = page.nextCursor ?? undefined;
    if (nextCursor === undefined) return items;
    if (seenCursors.has(nextCursor)) {
      throw new Error('Pagination cursor did not advance; the server returned a duplicate cursor.');
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);

  return items;
}
