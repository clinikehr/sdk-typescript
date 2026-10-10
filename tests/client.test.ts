import { afterEach, describe, expect, it, vi } from "vitest";

import { createClient } from "../src/client.js";
import { ClinikEHRApiError, BrowserEnvironmentError, TransportError } from "../src/errors.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function problemResponse(status: number, code: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ type: `https://developer.clinikehr.com/errors/${code}`, title: code, status, code, request_id: "req-test-1" }), {
    status,
    headers: { "content-type": "application/problem+json", ...extraHeaders },
  });
}

describe("createClient — authentication and headers", () => {
  it("sends Authorization: Bearer <apiKey> on every call", async () => {
    let seenAuth: string | null = null;
    const fetchSpy = vi.fn(async (input: Request) => {
      seenAuth = input.headers.get("authorization");
      return jsonResponse({ key_id: "k1", environment: "test", scopes: [] });
    });
    const client = createClient({ apiKey: "ehr_test_fakekey", fetch: fetchSpy as unknown as typeof fetch });
    await client.GET("/v1/me");
    expect(seenAuth).toBe("Bearer ehr_test_fakekey");
  });

  it("sends Accept: application/fhir+json when fhir is enabled at the client level", async () => {
    let seenAccept: string | null = null;
    const fetchSpy = vi.fn(async (input: Request) => {
      seenAccept = input.headers.get("accept");
      return jsonResponse({});
    });
    const client = createClient({ apiKey: "ehr_test_fakekey", fhir: true, fetch: fetchSpy as unknown as typeof fetch });
    await client.GET("/v1/me");
    expect(seenAccept).toBe("application/fhir+json");
  });

  it("a per-call fhir:false overrides a client-level fhir:true", async () => {
    let seenAccept: string | null = null;
    const fetchSpy = vi.fn(async (input: Request) => {
      seenAccept = input.headers.get("accept");
      return jsonResponse({});
    });
    const client = createClient({ apiKey: "ehr_test_fakekey", fhir: true, fetch: fetchSpy as unknown as typeof fetch });
    await client.GET("/v1/me", { fhir: false });
    expect(seenAccept).not.toBe("application/fhir+json");
  });

  it("throws without an apiKey", () => {
    expect(() => createClient({ apiKey: "" })).toThrow(/apiKey is required/);
  });
});

describe("createClient — automatic Idempotency-Key on POST", () => {
  it("generates one UUID per logical call, and REUSES it across this client's own internal retries", async () => {
    const seenKeys: (string | null)[] = [];
    let calls = 0;
    const fetchSpy = vi.fn(async (input: Request) => {
      calls++;
      seenKeys.push(input.headers.get("idempotency-key"));
      if (calls < 3) return problemResponse(503, "internal_error");
      return jsonResponse({ id: "created-1" }, { status: 201 });
    });
    const client = createClient({ apiKey: "ehr_test_fakekey", fetch: fetchSpy as unknown as typeof fetch, retry: { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 2 } });
    await client.POST("/v1/clinics/{clinic_id}/inventory/items", { params: { path: { clinic_id: "45715198-88e4-498c-8271-57e652c60246" } }, body: {} });
    expect(calls).toBe(3);
    expect(new Set(seenKeys).size).toBe(1); // same key every attempt
    expect(seenKeys[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("never generates an Idempotency-Key for a GET", async () => {
    const fetchSpy = vi.fn(async (input: Request) => {
      expect(input.headers.get("idempotency-key")).toBeNull();
      return jsonResponse({});
    });
    const client = createClient({ apiKey: "ehr_test_fakekey", fetch: fetchSpy as unknown as typeof fetch });
    await client.GET("/v1/me");
  });

  it("honours a caller-supplied idempotencyKey instead of generating one", async () => {
    let seen: string | null = null;
    const fetchSpy = vi.fn(async (input: Request) => {
      seen = input.headers.get("idempotency-key");
      return jsonResponse({}, { status: 201 });
    });
    const client = createClient({ apiKey: "ehr_test_fakekey", fetch: fetchSpy as unknown as typeof fetch });
    await client.POST("/v1/clinics/{clinic_id}/inventory/items", {
      params: { path: { clinic_id: "45715198-88e4-498c-8271-57e652c60246" } },
      body: {},
      idempotencyKey: "caller-chosen-key",
    });
    expect(seen).toBe("caller-chosen-key");
  });

  // 0.1.2 sent the header on POST only, so a PATCH route that requires it
  // (PATCH /appointments/{id}) answered 400 whatever the caller passed.
  it("sends a generated key on PATCH, and the caller's when given", async () => {
    const seen: (string | null)[] = [];
    const fetchSpy = vi.fn(async (input: Request) => {
      seen.push(input.headers.get("idempotency-key"));
      return jsonResponse({});
    });
    const client = createClient({ apiKey: "ehr_test_fakekey", fetch: fetchSpy as unknown as typeof fetch });
    const opts = { params: { path: { clinic_id: "c", appointment_id: "a" } }, body: {} };
    await client.PATCH("/v1/clinics/{clinic_id}/appointments/{appointment_id}" as never, opts);
    await client.PATCH("/v1/clinics/{clinic_id}/appointments/{appointment_id}" as never, { ...opts, idempotencyKey: "mine" });
    expect(seen[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[1]).toBe("mine");
  });

  it("sends a key on DELETE only when the caller passes one", async () => {
    const seen: (string | null)[] = [];
    const fetchSpy = vi.fn(async (input: Request) => {
      seen.push(input.headers.get("idempotency-key"));
      return new Response(null, { status: 204 });
    });
    const client = createClient({ apiKey: "ehr_test_fakekey", fetch: fetchSpy as unknown as typeof fetch });
    await client.DELETE("/v1/me" as never);
    await client.DELETE("/v1/me" as never, { idempotencyKey: "del-1" });
    expect(seen).toEqual([null, "del-1"]);
  });
});

describe("createClient — retry and error typing", () => {
  it("retries a GET on 503 and returns the eventual success", async () => {
    let calls = 0;
    const fetchSpy = vi.fn(async () => {
      calls++;
      if (calls === 1) return problemResponse(503, "internal_error");
      return jsonResponse({ key_id: "k1" });
    });
    const client = createClient({ apiKey: "ehr_test_fakekey", fetch: fetchSpy as unknown as typeof fetch, retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 } });
    const data = await client.GET("/v1/me");
    expect(calls).toBe(2);
    expect(data).toEqual({ key_id: "k1" });
  });

  it("throws ClinikEHRApiError with the parsed problem fields on a final, non-retried 403", async () => {
    const fetchSpy = vi.fn(async () => problemResponse(403, "scope_missing"));
    const client = createClient({ apiKey: "ehr_test_fakekey", fetch: fetchSpy as unknown as typeof fetch });
    await expect(client.GET("/v1/me")).rejects.toMatchObject({ name: "ClinikEHRApiError", status: 403, code: "scope_missing", requestId: "req-test-1" });
  });

  it("a ClinikEHRApiError instance is thrown (not just a matching shape)", async () => {
    const fetchSpy = vi.fn(async () => problemResponse(404, "not_found"));
    const client = createClient({ apiKey: "ehr_test_fakekey", fetch: fetchSpy as unknown as typeof fetch });
    await expect(client.GET("/v1/me")).rejects.toBeInstanceOf(ClinikEHRApiError);
  });

  it("carries retryAfterSeconds from the Retry-After header on a 429 that exhausts retries", async () => {
    const fetchSpy = vi.fn(async () => problemResponse(429, "rate_limited", { "retry-after": "7" }));
    const client = createClient({ apiKey: "ehr_test_fakekey", fetch: fetchSpy as unknown as typeof fetch, retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 2 } });
    try {
      await client.GET("/v1/me");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ClinikEHRApiError);
      expect((err as ClinikEHRApiError).retryAfterSeconds).toBe(7);
      expect((err as ClinikEHRApiError).isRetryable).toBe(true);
    }
  });

  it("wraps a network-level failure as TransportError, never a raw fetch exception", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const client = createClient({ apiKey: "ehr_test_fakekey", fetch: fetchSpy as unknown as typeof fetch, retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 2 } });
    await expect(client.GET("/v1/me")).rejects.toBeInstanceOf(TransportError);
  });
});

describe("createClient — browser guard", () => {
  const originalWindow = (globalThis as Record<string, unknown>).window;

  afterEach(() => {
    if (originalWindow === undefined) delete (globalThis as Record<string, unknown>).window;
    else (globalThis as Record<string, unknown>).window = originalWindow;
  });

  it("refuses to construct a client when `window.document` exists", () => {
    (globalThis as Record<string, unknown>).window = { document: {} };
    expect(() => createClient({ apiKey: "ehr_test_fakekey" })).toThrow(BrowserEnvironmentError);
  });

  it("the escape hatch is explicit and named _dangerously*", () => {
    (globalThis as Record<string, unknown>).window = { document: {} };
    expect(() => createClient({ apiKey: "ehr_test_fakekey", _dangerouslySkipServerCheck: true })).not.toThrow();
  });
});

describe("createClient — the URL actually requested (0.1.2: 0.1.0/0.1.1 requested /v1/v1/… and every call was a 404)", () => {
  async function urlFor(baseUrl: string | undefined, path: "/v1/me" | "/v1/clinics/{clinic_id}/inventory/items"): Promise<string> {
    let seen = "";
    const fetchSpy = vi.fn(async (input: Request) => {
      seen = input.url;
      return jsonResponse({ data: [], has_more: false, next_cursor: null });
    });
    const client = createClient({ apiKey: "ehr_test_fakekey", fetch: fetchSpy as unknown as typeof fetch, ...(baseUrl === undefined ? {} : { baseUrl }) });
    if (path === "/v1/me") await client.GET("/v1/me");
    else await client.GET(path, { params: { path: { clinic_id: "c1" }, query: { limit: 5 } } });
    return seen;
  }

  it("the default reaches https://api.clinikehr.com/v1/<route> — exactly one /v1", async () => {
    expect(await urlFor(undefined, "/v1/me")).toBe("https://api.clinikehr.com/v1/me");
    expect(await urlFor(undefined, "/v1/clinics/{clinic_id}/inventory/items")).toBe("https://api.clinikehr.com/v1/clinics/c1/inventory/items?limit=5");
  });

  it("a configured base ending in /v1 (as the docs name the API) is not doubled", async () => {
    expect(await urlFor("https://api.clinikehr.com/v1", "/v1/me")).toBe("https://api.clinikehr.com/v1/me");
    expect(await urlFor("https://api.clinikehr.com/v1/", "/v1/me")).toBe("https://api.clinikehr.com/v1/me");
    expect(await urlFor("https://proxy.example.com", "/v1/me")).toBe("https://proxy.example.com/v1/me");
  });

  it("the raw client uses the same base", async () => {
    let seen = "";
    const fetchSpy = vi.fn(async (input: Request) => { seen = input.url; return jsonResponse({}); });
    const client = createClient({ apiKey: "ehr_test_fakekey", fetch: fetchSpy as unknown as typeof fetch });
    await client.raw.GET("/v1/me", {});
    expect(seen).toBe("https://api.clinikehr.com/v1/me");
  });
});
