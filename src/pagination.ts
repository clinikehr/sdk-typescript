/**
 * Cursor pagination: `{ data: [], has_more: true, next_cursor: "…" }`,
 * cursors opaque and signed, no offset, no total count.
 */

export interface CursorPage<T> {
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

/**
 * Wraps a page-fetching function into an async iterator over every row,
 * across every page, fetching lazily (one page ahead is never buffered —
 * a caller that `break`s out of a `for await` after page one never triggers
 * page two).
 */
export async function* paginate<T>(fetchPage: (cursor: string | null) => Promise<CursorPage<T>>): AsyncGenerator<T, void, undefined> {
  let cursor: string | null = null;
  for (;;) {
    const page = await fetchPage(cursor);
    for (const row of page.data) yield row;
    if (!page.has_more || !page.next_cursor) return;
    cursor = page.next_cursor;
  }
}
