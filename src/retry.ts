/**
 * Retry policy: a timeout after the server committed must never create a
 * second record, so the rules below are applied at the client's own
 * transport layer.
 *
 * Rule, stated once so both languages implement the same thing:
 *   - a 429 (`rate_limited`) is ALWAYS retryable — the server told us to
 *     slow down, and retrying is exactly the contract `Retry-After` sets up.
 *   - a 5xx or a transport-level failure (network error, timeout) is
 *     retryable ONLY when the request is safe to repeat: a GET/HEAD (no
 *     side effect), or any request that carried an `Idempotency-Key` (a
 *     POST re-sent with the same key is a no-op-if-already-done on the
 *     server, per the gateway's own idempotency store — never a second
 *     write).
 *   - a PATCH is neither: it has no `Idempotency-Key` in this API (only
 *     `POST` requires one) and is not inherently idempotent
 *     (an `If-Match` mismatch on retry is a DIFFERENT, correct 412, not a
 *     transient failure to paper over) — so a PATCH's 5xx/transport
 *     failure is never auto-retried.
 *   - a 4xx other than 429 is NEVER retried (the request is wrong; retrying
 *     an unchanged request gets the same wrong answer).
 */

export interface RetryDecision {
  shouldRetry: boolean;
  /** Milliseconds to wait before the next attempt. */
  delayMs: number;
}

export interface RetryPolicyInput {
  method: string;
  hasIdempotencyKey: boolean;
  attempt: number; // 0-indexed: this is the attempt number that just finished
  /** Present on a Response (status) failure; absent on a transport-level failure. */
  status?: number;
  /** From a `Retry-After` header, in seconds, if the server sent one. */
  retryAfterSeconds?: number;
}

export interface RetryPolicyOptions {
  maxAttempts: number; // total attempts, including the first — default 4 (1 try + 3 retries)
  baseDelayMs: number; // default 500
  maxDelayMs: number; // default 8000
}

export const DEFAULT_RETRY_OPTIONS: RetryPolicyOptions = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
};

function isRepeatable(method: string, hasIdempotencyKey: boolean): boolean {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return true;
  if (m === "PATCH") return false; // never idempotent by contract here — an If-Match retry is a different, correct 412, not a transient failure
  return hasIdempotencyKey; // POST (or DELETE) with an Idempotency-Key.
}

/** Full jitter exponential backoff, capped at `maxDelayMs`. */
function backoffDelayMs(attempt: number, opts: RetryPolicyOptions): number {
  const raw = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt);
  return Math.floor(Math.random() * raw);
}

export function decideRetry(input: RetryPolicyInput, opts: RetryPolicyOptions = DEFAULT_RETRY_OPTIONS): RetryDecision {
  if (input.attempt + 1 >= opts.maxAttempts) return { shouldRetry: false, delayMs: 0 };

  const isRateLimited = input.status === 429;
  const isServerError = typeof input.status === "number" && input.status >= 500;
  const isTransportFailure = input.status === undefined;

  if (isRateLimited) {
    const delayMs = typeof input.retryAfterSeconds === "number" ? Math.max(0, input.retryAfterSeconds * 1000) : backoffDelayMs(input.attempt, opts);
    return { shouldRetry: true, delayMs };
  }

  if ((isServerError || isTransportFailure) && isRepeatable(input.method, input.hasIdempotencyKey)) {
    return { shouldRetry: true, delayMs: backoffDelayMs(input.attempt, opts) };
  }

  return { shouldRetry: false, delayMs: 0 };
}
