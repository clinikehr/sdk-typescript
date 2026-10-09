/**
 * Typed errors from the API's RFC 9457 `application/problem+json` shape.
 * Mirrors the API's error body field-for-field — this file does not invent a
 * shape, it types the one the API actually returns.
 */

export interface ProblemFieldError {
  /** A JSON Pointer into the request body, e.g. "/entries/0/item_id". */
  pointer: string;
  message: string;
}

export interface ProblemBody {
  /** A docs URL keyed on the stable code — https://developer.clinikehr.com/errors/<code>. */
  type: string;
  title: string;
  status: number;
  /** Stable machine string, e.g. "invalid_key", "scope_missing", "rate_limited". */
  code: string;
  request_id: string;
  detail?: string;
  errors?: ProblemFieldError[];
  /** A handful of refusals attach extra named fields (e.g. notes' unknown_field ships unknown_keys/valid_keys) — never PHI, per the gateway's own rule. */
  [extra: string]: unknown;
}

/**
 * Thrown by every request the client makes that did not succeed. Never
 * thrown for a network/transport failure — see `TransportError` for that;
 * this is specifically "the server answered, and the answer was an error."
 */
export class ClinikEHRApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
  readonly problem: ProblemBody;

  constructor(problem: ProblemBody) {
    super(problem.detail ?? problem.title);
    this.name = "ClinikEHRApiError";
    this.status = problem.status;
    this.code = problem.code;
    this.requestId = problem.request_id;
    this.problem = problem;
  }

  /** `true` for 429 (rate_limited) or 429-shaped quota errors — the caller may retry after `retryAfterSeconds`. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }

  /** From the `Retry-After` header, when the server sent one (rate_limited, quota_exceeded). */
  retryAfterSeconds?: number;
}

/** A network-level failure (DNS, TCP, TLS, an abort) — the request never got a response to parse. */
export class TransportError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "TransportError";
    this.cause = cause;
  }
}

/** Thrown by `assertServerEnvironment()` — see browser-guard.ts. */
export class BrowserEnvironmentError extends Error {
  constructor() {
    super(
      "@clinikehr/api refuses to run in a browser. A live or test API key in " +
        "browser-reachable code is a leak — call this SDK from your own server " +
        "and have your frontend call YOUR backend instead. ",
    );
    this.name = "BrowserEnvironmentError";
  }
}

export function isProblemBody(value: unknown): value is ProblemBody {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.type === "string" &&
    typeof v.title === "string" &&
    typeof v.status === "number" &&
    typeof v.code === "string" &&
    typeof v.request_id === "string"
  );
}
