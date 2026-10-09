/**
 * Standard Webhooks verifier. It mirrors the API's webhook signing scheme
 * exactly (same secret-decoding rule, same signed string, same header
 * shape); the test vectors in `tests/fixtures/webhook-signing-vectors.json`
 * were produced by the API's own signer, not re-derived here.
 *
 * During a secret rotation the API sends two signatures for an overlap
 * window. Consumers should reject timestamps older than 5 minutes and dedupe
 * on `webhook-id`. This verifier checks the signature and the timestamp
 * tolerance; deduping on `webhook-id` is the caller's own idempotent-handler
 * job (this SDK does not persist state).
 */

export interface WebhookHeaders {
  "webhook-id": string;
  "webhook-timestamp": string;
  "webhook-signature": string;
}

export interface VerifyWebhookOptions {
  /**
   * One or two `whsec_…` secrets. Pass BOTH during a rotation's overlap
   * window (current, previous) — verification succeeds if EITHER matches
   * ANY signature in the header (a sender may present more than one `v1,`
   * term, space-separated, during ITS OWN rotation window too).
   */
   secrets: readonly string[];
  /** Default 300 (5 minutes) — matches the plan's own stated tolerance. */
  toleranceSeconds?: number;
  /** Injectable for tests; defaults to `Date.now()`. */
  now?: () => number;
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

const encoder = new TextEncoder();

/** Byte-for-byte the same rule as signing.ts's secretKeyBytes: hex-decode an even-length hex remainder, else treat as literal UTF-8 key material. */
function secretKeyBytes(whsec: string): Uint8Array {
  const raw = whsec.startsWith("whsec_") ? whsec.slice("whsec_".length) : whsec;
  if (/^[0-9a-f]+$/i.test(raw) && raw.length % 2 === 0) {
    const out = new Uint8Array(raw.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(raw.substr(i * 2, 2), 16);
    return out;
  }
  return encoder.encode(raw);
}

async function hmacSha256Base64(key: Uint8Array, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
  const bytes = new Uint8Array(sig);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  if (typeof btoa === "function") return btoa(binary);
  // Node >= 18 always has btoa; this fallback reaches Buffer through globalThis so the package needs no
  // Node type definitions (a clean `npm ci` in sdk/typescript has none - CI failed TS2580 on `Buffer`).
  const nodeBuffer = (globalThis as { Buffer?: { from(data: Uint8Array): { toString(encoding: string): string } } }).Buffer;
  if (!nodeBuffer) throw new Error("No base64 encoder available in this runtime");
  return nodeBuffer.from(bytes).toString("base64");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verifies a webhook delivery. Throws `WebhookVerificationError` (never
 * returns `false` — a caller that forgets to check a boolean is the exact
 * shape of bug a signature verifier exists to prevent) when:
 *   - the timestamp is missing, unparseable, or outside `toleranceSeconds`;
 *   - the signature header has no `v1,…` term that matches any secret.
 *
 * Returns nothing on success — call it, and if it doesn't throw, the
 * delivery is genuine and fresh.
 */
export async function verifyWebhook(headers: WebhookHeaders, rawBody: string, options: VerifyWebhookOptions): Promise<void> {
  const tolerance = options.toleranceSeconds ?? 300;
  const now = options.now ?? Date.now;

  const timestampRaw = headers["webhook-timestamp"];
  const timestamp = Number.parseInt(timestampRaw, 10);
  if (!Number.isFinite(timestamp)) {
    throw new WebhookVerificationError("webhook-timestamp is missing or not a valid integer.");
  }
  const ageSeconds = Math.abs(now() / 1000 - timestamp);
  if (ageSeconds > tolerance) {
    throw new WebhookVerificationError(`webhook-timestamp is outside the ${tolerance}s tolerance (age ${Math.round(ageSeconds)}s).`);
  }

  const id = headers["webhook-id"];
  if (!id) throw new WebhookVerificationError("webhook-id is missing.");

  const presented = (headers["webhook-signature"] ?? "")
    .split(" ")
    .map((s) => s.trim())
    .filter(Boolean);
  if (presented.length === 0) throw new WebhookVerificationError("webhook-signature is missing.");

  const toSign = `${id}.${timestampRaw}.${rawBody}`;
  const expectedPerSecret = await Promise.all(
    options.secrets.filter(Boolean).map(async (secret) => `v1,${await hmacSha256Base64(secretKeyBytes(secret), toSign)}`),
  );

  const matched = presented.some((term) => expectedPerSecret.some((expected) => constantTimeEqual(term, expected)));
  if (!matched) throw new WebhookVerificationError("No signature in webhook-signature matched any provided secret.");
}
