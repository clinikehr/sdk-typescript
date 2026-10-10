// Runs BOTH built entry points the way a user loads them — `require` and `import` — and makes one call
// through a stub fetch. 0.1.0-0.1.2 passed every source test while the CommonJS bundle could not create a
// client at all; only loading the built file catches that. Run after `npm run build` (publish.yml does).
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const stubFetch = async (input) =>
  new Response(JSON.stringify({ key_id: "k", url: typeof input === "string" ? input : input.url }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

async function check(label, mod) {
  const client = mod.createClient({ apiKey: "ehr_test_smoke", fetch: stubFetch });
  const me = await client.GET("/v1/me");
  if (me?.key_id !== "k") throw new Error(`${label}: unexpected response`);
  if (!String(me.url).startsWith("https://api.clinikehr.com/v1/me")) throw new Error(`${label}: wrong URL ${me.url}`);
  for (const name of ["ClinikEHRApiError", "TransportError", "paginate", "verifyWebhook"]) {
    if (!(name in mod)) throw new Error(`${label}: missing export ${name}`);
  }
  console.log(`ok  ${label}`);
}

await check("require (CommonJS)", require("../dist/index.cjs"));
await check("import (ESM)", await import("../dist/index.js"));
