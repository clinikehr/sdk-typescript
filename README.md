# @clinikehr/api

Official TypeScript client for the [ClinikEHR API](https://docs.clinikehr.com) —
a server-to-server REST API over a clinic's own inventory, appointments,
CRM and patient data, reached with an API key.

Base URL: `https://api.clinikehr.com/v1`

## What's generated, what's hand-written

- **Generated, never hand-edited:** `src/generated/schema.ts` — full
  TypeScript types for every path, operation and schema in the ClinikEHR API
  description, produced by [`openapi-typescript`](https://openapi-ts.dev). The
  actual HTTP calls run through
  [`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/) — a generic, typed
  runtime client driven entirely by those generated types, so no individual
  endpoint function is hand-written anywhere in this package.
- **Hand-written, small, and tested** (`src/*.ts`, `tests/*.test.ts`):
  authentication, automatic `Idempotency-Key` generation and reuse across
  retries, the retry policy, cursor pagination, typed errors, the FHIR
  `Accept`/`Content-Type` opt-in, the webhook signature verifier, and the
  browser guard.

## Install

```bash
npm install @clinikehr/api
```

Requires Node.js 18 or later.

## Quickstart

```ts
import { createClient } from "@clinikehr/api";

const client = createClient({
  apiKey: process.env.CLINIKEHR_API_KEY!, // ehr_test_… for the sandbox, ehr_live_… for production
});

const me = await client.GET("/v1/me");
console.log(me);

const items = await client.GET("/v1/clinics/{clinic_id}/inventory/items", {
  params: { path: { clinic_id: "YOUR_CLINIC_ID" }, query: { limit: 25 } },
});
console.log(items);
```

A **live** key (`ehr_live_…`) must never run in a browser — `createClient`
throws `BrowserEnvironmentError` if it detects one (`typeof window !== "undefined"`).
Call this package from your own backend.

## Error handling

Every non-2xx response throws `ClinikEHRApiError`, built from the API's
`application/problem+json` body:

```ts
import { ClinikEHRApiError } from "@clinikehr/api";

try {
  await client.GET("/v1/clinics/{clinic_id}/patients/{id}", { params: { path: { clinic_id, id } } });
} catch (err) {
  if (err instanceof ClinikEHRApiError) {
    console.error(err.status, err.code, err.requestId, err.problem.detail);
    if (err.code === "rate_limited") {
      // err.retryAfterSeconds is set from the Retry-After header
    }
  } else {
    // a TransportError — the request never got a response at all
  }
}
```

A 429 is retried automatically (honouring `Retry-After`); a 5xx or a
transport failure is retried automatically only for a GET/HEAD or a request
that carried an `Idempotency-Key` (every POST gets one automatically —
generated once per call and reused across this client's own internal
retries, never regenerated). A PATCH is never auto-retried on a 5xx: this API
gives PATCH no `Idempotency-Key`, and an `If-Match` mismatch on retry is a
different, correct `412`, not a transient failure to paper over.

## Pagination

```ts
import { paginate } from "@clinikehr/api";

for await (const item of paginate((cursor) =>
  client.GET("/v1/clinics/{clinic_id}/inventory/items", {
    params: { path: { clinic_id }, query: { starting_after: cursor ?? undefined } },
  }),
)) {
  console.log(item);
}
```

## FHIR

```ts
const client = createClient({ apiKey, fhir: true }); // every call now sends Accept: application/fhir+json
// or per call:
await client.GET("/v1/clinics/{clinic_id}/patients/{id}", { params: {...}, fhir: true });
```

## Verifying a webhook notification

```ts
import { verifyWebhook } from "@clinikehr/api";

// In your webhook route handler, with the RAW request body (before JSON.parse):
await verifyWebhook(
  {
    "webhook-id": req.headers["webhook-id"],
    "webhook-timestamp": req.headers["webhook-timestamp"],
    "webhook-signature": req.headers["webhook-signature"],
  },
  rawBody,
  { secrets: [process.env.CLINIKEHR_WEBHOOK_SECRET!] }, // pass BOTH secrets during a rotation's overlap window
);
// Throws WebhookVerificationError if the signature or timestamp does not check out.
```

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
```

## License

MIT, Copyright (c) 2026-present Bettar Platforms, Inc. See `LICENSE`.

© Bettar Platforms, Inc. ClinikEHR is a product of Bettar Platforms, Inc.

## How this repository works

This code is generated from ClinikEHR's API description and published from a
private source. Issues are welcome here. Pull requests cannot be merged
directly, because every change is made in the private source and mirrored
here: describe the change you need in an issue and we will make it there.

Questions about the API itself belong at [docs.clinikehr.com](https://docs.clinikehr.com);
to report a vulnerability, see [SECURITY.md](SECURITY.md).
