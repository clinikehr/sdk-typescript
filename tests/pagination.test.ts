import { describe, expect, it } from "vitest";

import { paginate, type CursorPage } from "../src/pagination.js";

describe("paginate", () => {
  it("yields every row across every page, in order", async () => {
    const pages: Record<string, CursorPage<number>> = {
      root: { data: [1, 2], has_more: true, next_cursor: "p2" },
      p2: { data: [3, 4], has_more: true, next_cursor: "p3" },
      p3: { data: [5], has_more: false, next_cursor: null },
    };
    const seen: number[] = [];
    for await (const row of paginate<number>(async (cursor) => pages[cursor ?? "root"])) seen.push(row);
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });

  it("fetches lazily — breaking early never triggers a later page", async () => {
    const calls: (string | null)[] = [];
    const iterator = paginate<number>(async (cursor) => {
      calls.push(cursor);
      if (cursor === null) return { data: [1, 2], has_more: true, next_cursor: "p2" };
      return { data: [3, 4], has_more: false, next_cursor: null };
    });
    const first: number[] = [];
    for await (const row of iterator) {
      first.push(row);
      if (first.length === 1) break;
    }
    expect(first).toEqual([1]);
    expect(calls).toEqual([null]); // page 2 never fetched
  });

  it("a single, non-paginated page (has_more: false) yields its rows and stops", async () => {
    const seen: string[] = [];
    for await (const row of paginate<string>(async () => ({ data: ["a", "b"], has_more: false, next_cursor: null }))) seen.push(row);
    expect(seen).toEqual(["a", "b"]);
  });

  it("an empty first page yields nothing", async () => {
    const seen: unknown[] = [];
    for await (const row of paginate(async () => ({ data: [], has_more: false, next_cursor: null }))) seen.push(row);
    expect(seen).toEqual([]);
  });

  it("has_more true but a null next_cursor stops rather than looping forever", async () => {
    const seen: number[] = [];
    for await (const row of paginate<number>(async () => ({ data: [1], has_more: true, next_cursor: null }))) seen.push(row);
    expect(seen).toEqual([1]);
  });
});
