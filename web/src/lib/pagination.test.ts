import { describe, expect, it } from 'vitest';
import { loadAllPages } from './pagination';

describe('loadAllPages', () => {
  it('flattens all cursor pages in order', async () => {
    const calls: Array<string | undefined> = [];
    await expect(loadAllPages(async (cursor) => {
      calls.push(cursor);
      return cursor === undefined
        ? { items: ['a', 'b'], nextCursor: 'next' }
        : { items: ['c'], nextCursor: null };
    })).resolves.toEqual(['a', 'b', 'c']);
    expect(calls).toEqual([undefined, 'next']);
  });

  it('returns an empty result without making a second request', async () => {
    const loadPage = async () => ({ items: [], nextCursor: null });
    await expect(loadAllPages(loadPage)).resolves.toEqual([]);
  });

  it('fails fast when the server repeats a cursor', async () => {
    await expect(loadAllPages(async () => ({ items: [], nextCursor: 'same' })))
      .rejects.toThrow('分页游标未推进');
  });
});
