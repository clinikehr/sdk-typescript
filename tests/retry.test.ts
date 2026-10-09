import { describe, expect, it } from "vitest";

import { decideRetry, DEFAULT_RETRY_OPTIONS } from "../src/retry.js";

describe("decideRetry", () => {
  it("429 is ALWAYS retryable, regardless of method or idempotency key", () => {
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      const d = decideRetry({ method, hasIdempotencyKey: false, attempt: 0, status: 429 });
      expect(d.shouldRetry).toBe(true);
    }
  });

  it("429 honours Retry-After exactly, in milliseconds", () => {
    const d = decideRetry({ method: "GET", hasIdempotencyKey: false, attempt: 0, status: 429, retryAfterSeconds: 3 });
    expect(d.delayMs).toBe(3000);
  });

  it("a 5xx on GET is retryable (safe to repeat, no side effect)", () => {
    const d = decideRetry({ method: "GET", hasIdempotencyKey: false, attempt: 0, status: 503 });
    expect(d.shouldRetry).toBe(true);
  });

  it("a 5xx on POST WITHOUT an idempotency key is never retried", () => {
    const d = decideRetry({ method: "POST", hasIdempotencyKey: false, attempt: 0, status: 503 });
    expect(d.shouldRetry).toBe(false);
  });

  it("a 5xx on POST WITH an idempotency key is retried", () => {
    const d = decideRetry({ method: "POST", hasIdempotencyKey: true, attempt: 0, status: 503 });
    expect(d.shouldRetry).toBe(true);
  });

  it("a 5xx on PATCH is never retried, even with an idempotency key claimed (PATCH never carries one in this API)", () => {
    const d = decideRetry({ method: "PATCH", hasIdempotencyKey: true, attempt: 0, status: 503 });
    expect(d.shouldRetry).toBe(false);
  });

  it("a transport failure (no status) follows the same repeatability rule as a 5xx", () => {
    expect(decideRetry({ method: "GET", hasIdempotencyKey: false, attempt: 0 }).shouldRetry).toBe(true);
    expect(decideRetry({ method: "POST", hasIdempotencyKey: false, attempt: 0 }).shouldRetry).toBe(false);
  });

  it("a plain 4xx (not 429) is never retried", () => {
    for (const status of [400, 401, 403, 404, 409, 412, 422]) {
      expect(decideRetry({ method: "GET", hasIdempotencyKey: false, attempt: 0, status }).shouldRetry).toBe(false);
    }
  });

  it("stops after maxAttempts, even for an otherwise-retryable case", () => {
    const opts = { ...DEFAULT_RETRY_OPTIONS, maxAttempts: 2 };
    expect(decideRetry({ method: "GET", hasIdempotencyKey: false, attempt: 0, status: 429 }, opts).shouldRetry).toBe(true);
    expect(decideRetry({ method: "GET", hasIdempotencyKey: false, attempt: 1, status: 429 }, opts).shouldRetry).toBe(false);
  });

  it("backoff delay never exceeds maxDelayMs", () => {
    const opts = { maxAttempts: 10, baseDelayMs: 500, maxDelayMs: 1000 };
    for (let attempt = 0; attempt < 8; attempt++) {
      const d = decideRetry({ method: "GET", hasIdempotencyKey: false, attempt, status: 503 }, opts);
      expect(d.delayMs).toBeLessThanOrEqual(1000);
      expect(d.delayMs).toBeGreaterThanOrEqual(0);
    }
  });
});
