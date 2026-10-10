import createOpenapiFetchClient, { type Client as OpenapiFetchClient } from "openapi-fetch";

import { assertServerEnvironment } from "./browser-guard.js";
import { ClinikEHRApiError, TransportError, isProblemBody, type ProblemBody } from "./errors.js";
import { DEFAULT_RETRY_OPTIONS, decideRetry, type RetryPolicyOptions } from "./retry.js";
import type { paths } from "./generated/schema.js";

export type { paths } from "./generated/schema.js";

export interface ClinikEHRClientConfig {
  /** `ehr_live_…` or `ehr_test_…`. Never hardcode a live key — read it from your own server's secret store. */
  apiKey: string;
  /** Default `https://api.clinikehr.com`. A trailing `/v1` is accepted and ignored (paths already carry it). Override only to point at a proxy or a test double. */
  baseUrl?: string;
  /** When true, sends `Accept: application/fhir+json` (and, on write calls, `Content-Type: application/fhir+json`) by default. Can still be overridden per call via `fhir` in the call options. */
  fhir?: boolean;
  /** Injectable for tests — never provide this in real use. */
  fetch?: typeof fetch;
  retry?: Partial<RetryPolicyOptions>;
  /** Skips the browser check. NEVER set this to make the SDK work in a browser — it exists solely so this package's own test suite (which runs under a DOM-less Node environment already, but future test environments may not be) can construct a client without the check depending on the runner. */
  _dangerouslySkipServerCheck?: boolean;
}

export interface CallOptions {
  params?: Record<string, unknown>;
  body?: unknown;
  /** Overrides the client-level `fhir` setting for this one call. */
  fhir?: boolean;
  /** Supply your own idempotency key (e.g. to guarantee two logical retries of YOUR OWN, at a higher level, share one) — otherwise one is generated per call and reused across THIS client's own internal retries automatically. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface ClinikEHRClient {
  /** The generated, fully-typed openapi-fetch client, for anything this wrapper does not cover (full path/param/body type-checking against the OpenAPI document). Auth and FHIR headers are already wired via middleware; NOT retried or idempotency-tagged automatically — use the top-level GET/POST/PATCH/DELETE below for that. */
  raw: OpenapiFetchClient<paths>;
  GET<Path extends keyof paths>(path: Path, options?: CallOptions): Promise<unknown>;
  POST<Path extends keyof paths>(path: Path, options?: CallOptions): Promise<unknown>;
  PATCH<Path extends keyof paths>(path: Path, options?: CallOptions): Promise<unknown>;
  DELETE<Path extends keyof paths>(path: Path, options?: CallOptions): Promise<unknown>;
}

/**
 * The API ORIGIN. Every path in the API description already starts with `/v1` (`/v1/me`,
 * `/v1/clinics/{clinic_id}/…`), so the base must not repeat it: `https://api.clinikehr.com/v1` + `/v1/me` was
 * `/v1/v1/me` and every call answered 404 route_not_found (0.1.0 and 0.1.1).
 */
const DEFAULT_BASE_URL = "https://api.clinikehr.com";

/**
 * People are told the API lives at `https://api.clinikehr.com/v1`, so a configured base may end in `/v1`. Strip a
 * trailing `/v1` (and trailing slashes) instead of doubling it.
 */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function createClient(config: ClinikEHRClientConfig): ClinikEHRClient {
  if (!config._dangerouslySkipServerCheck) assertServerEnvironment();
  if (!config.apiKey) throw new Error("createClient({ apiKey }) — apiKey is required.");

  const retryOptions: RetryPolicyOptions = { ...DEFAULT_RETRY_OPTIONS, ...config.retry };

  const raw = createOpenapiFetchClient<paths>({
    baseUrl: normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL),
    fetch: config.fetch,
  });

  raw.use({
    onRequest({ request }) {
      request.headers.set("Authorization", `Bearer ${config.apiKey}`);
      return request;
    },
  });

  async function call(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, options: CallOptions = {}): Promise<unknown> {
    const wantsFhir = options.fhir ?? config.fhir ?? false;
    const idempotencyKey = method === "POST" ? options.idempotencyKey ?? crypto.randomUUID() : undefined;

    const headers: Record<string, string> = {};
    if (wantsFhir) {
      headers["Accept"] = "application/fhir+json";
      if (options.body !== undefined) headers["Content-Type"] = "application/fhir+json";
    }
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

    let attempt = 0;
    for (;;) {
      let response: Response;
      let data: unknown;
      let errorBody: unknown;
      try {
        // openapi-fetch's typed methods key on the literal HTTP verb; `method`
        // here is already narrowed to one of the four this client exposes.
        const verb = (raw as unknown as Record<string, (...args: unknown[]) => Promise<{ data: unknown; error: unknown; response: Response }>>)[method];
        if (!verb) throw new Error(`Unsupported method ${method}`);
        const result = await verb(path, {
          params: options.params,
          body: options.body,
          headers,
          signal: options.signal,
        });
        response = result.response as Response;
        data = result.data;
        errorBody = result.error;
      } catch (err) {
        const decision = decideRetry({ method, hasIdempotencyKey: Boolean(idempotencyKey), attempt }, retryOptions);
        if (!decision.shouldRetry) throw new TransportError(err instanceof Error ? err.message : "Network request failed.", err);
        await sleep(decision.delayMs);
        attempt++;
        continue;
      }

      if (response.ok) return data;

      const problem: ProblemBody = isProblemBody(errorBody)
        ? errorBody
        : { type: "about:blank", title: response.statusText || "Error", status: response.status, code: "unknown_error", request_id: response.headers.get("x-request-id") ?? "" };

      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterSeconds = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : undefined;

      const decision = decideRetry(
        { method, hasIdempotencyKey: Boolean(idempotencyKey), attempt, status: response.status, retryAfterSeconds },
        retryOptions,
      );
      if (decision.shouldRetry) {
        await sleep(decision.delayMs);
        attempt++;
        continue;
      }

      const error = new ClinikEHRApiError(problem);
      if (typeof retryAfterSeconds === "number") error.retryAfterSeconds = retryAfterSeconds;
      throw error;
    }
  }

  return {
    raw,
    GET: (path, options) => call("GET", path as string, options),
    POST: (path, options) => call("POST", path as string, options),
    PATCH: (path, options) => call("PATCH", path as string, options),
    DELETE: (path, options) => call("DELETE", path as string, options),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
