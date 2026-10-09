import { BrowserEnvironmentError } from "./errors.js";

/**
 * Refuses to proceed when this code is running in a browser. Checked once,
 * at client construction — never per-request (cheap, and a client built
 * once at server startup should fail loudly at startup, not on the first
 * call a user happens to trigger).
 *
 * `window` existing is the check every browser environment shares (a
 * Service Worker has no `window` either, and is not the browser context
 * this guards against — a key belongs on a trusted server, full stop).
 */
export function assertServerEnvironment(): void {
  if (typeof window !== "undefined" && typeof window.document !== "undefined") {
    throw new BrowserEnvironmentError();
  }
}
