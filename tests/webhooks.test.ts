import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { verifyWebhook, WebhookVerificationError } from "../src/webhooks.js";

/**
 * Vectors produced by running the API's own webhook signer under Deno — not
 * re-derived by this test file. If this verifier disagrees with these
 * vectors, the verifier is wrong; the signer is the source of truth.
 */
const vectorsPath = fileURLToPath(new URL("./fixtures/webhook-signing-vectors.json", import.meta.url));
const { vectors } = JSON.parse(readFileSync(vectorsPath, "utf8")) as {
  vectors: Array<{ name: string; secrets: string[]; body: string; headers: { "webhook-id": string; "webhook-timestamp": string; "webhook-signature": string } }>;
};

const FIXED_NOW = () => 1614265330_000 + 30_000; // 30s after the first vector's timestamp — inside any reasonable tolerance

describe("verifyWebhook — against vectors from the API's own signer", () => {
  it.each(vectors)("$name verifies with its own secret(s)", async (v) => {
    await expect(
      verifyWebhook(v.headers, v.body, { secrets: v.secrets, toleranceSeconds: 10 * 365 * 24 * 3600, now: FIXED_NOW }),
    ).resolves.toBeUndefined();
  });

  it("the rotation-overlap vector verifies against EITHER secret alone", async () => {
    const v = vectors.find((x) => x.name === "two_secrets_rotation_overlap")!;
    await expect(verifyWebhook(v.headers, v.body, { secrets: [v.secrets[0]], toleranceSeconds: 10 * 365 * 24 * 3600, now: FIXED_NOW })).resolves.toBeUndefined();
    await expect(verifyWebhook(v.headers, v.body, { secrets: [v.secrets[1]], toleranceSeconds: 10 * 365 * 24 * 3600, now: FIXED_NOW })).resolves.toBeUndefined();
  });

  it("fails with the WRONG secret", async () => {
    const v = vectors.find((x) => x.name === "single_secret_simple_body")!;
    await expect(
      verifyWebhook(v.headers, v.body, { secrets: ["whsec_" + "ff".repeat(24)], toleranceSeconds: 10 * 365 * 24 * 3600, now: FIXED_NOW }),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it("fails if the body was tampered with (even one byte)", async () => {
    const v = vectors.find((x) => x.name === "single_secret_simple_body")!;
    const tampered = v.body.replace("stock_changed", "stock_change_");
    await expect(
      verifyWebhook(v.headers, tampered, { secrets: v.secrets, toleranceSeconds: 10 * 365 * 24 * 3600, now: FIXED_NOW }),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it("fails outside the timestamp tolerance", async () => {
    const v = vectors.find((x) => x.name === "single_secret_simple_body")!;
    await expect(verifyWebhook(v.headers, v.body, { secrets: v.secrets, toleranceSeconds: 300, now: () => Date.now() })).rejects.toBeInstanceOf(
      WebhookVerificationError,
    );
  });

  it("passes within the default 5-minute tolerance", async () => {
    const v = vectors.find((x) => x.name === "single_secret_simple_body")!;
    const now = () => (Number(v.headers["webhook-timestamp"]) + 60) * 1000; // 60s later
    await expect(verifyWebhook(v.headers, v.body, { secrets: v.secrets, now })).resolves.toBeUndefined();
  });

  it("throws (never returns false) on a missing webhook-signature header", async () => {
    const v = vectors.find((x) => x.name === "single_secret_simple_body")!;
    await expect(
      verifyWebhook({ ...v.headers, "webhook-signature": "" }, v.body, { secrets: v.secrets, now: FIXED_NOW }),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
  });
});
