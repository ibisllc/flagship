/**
 * Debug driver for the gating-live vibe-deploy 502.
 * Reuses a live gym box: mints a paired session, runs the SAME vibe prompt
 * gating-drive.ts uses, dumps the session's emitted files, deploys, and on
 * failure pulls the owner-IRK-signed journal to capture the ACTUAL
 * `docker build` stderr (the daemon runs docker with stdio:"inherit", so
 * the build error lands in journald, not the HTTP response).
 *
 * Usage:
 *   set -a; . ./.gym-secrets.env; set +a
 *   LIVE_E2E_REUSE_USER=<user> npx tsx tools/live-e2e/vibe-deploy-debug.ts
 */
import { randomBytes } from "node:crypto";
import { deriveDemoUserIrk, deriveDemoDelegatedKey } from "@flagship/control-plane";
import { signPhoneOrder, signJournalRequest, type PhoneOrder, type JournalRequest } from "@flagship/protocol";

const CONTROL = process.env.LIVE_E2E_CONTROL || "gym.flagshipserver.com";
const SERVICES = process.env.GYM_LIVE_SERVICES_APEX || "gym.flagship.services";
const KEK = process.env.GYM_DEMO_IRK_KEK || "";
const AI_KEY = process.env.GYM_AI_API_KEY || "";
const AI_MODEL = process.env.GYM_AI_MODEL || "gpt-4o-mini";
const user = process.env.LIVE_E2E_REUSE_USER || "";
if (!user || !KEK || !AI_KEY) throw new Error("need LIVE_E2E_REUSE_USER + GYM_DEMO_IRK_KEK + GYM_AI_API_KEY");

const fqdn = `home.${user}.${SERVICES}`;
function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
async function http(url: string, init: RequestInit = {}, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* */ }
    return { status: r.status, text, json };
  } finally { clearTimeout(t); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function journalGrep(re: RegExp, lines = 250): Promise<string[]> {
  const irk = deriveDemoUserIrk(hexToBytes(KEK), user);
  const jr: JournalRequest = { serverId: fqdn, unit: "flagship-daemon", lines, issuedAt: Date.now() };
  const js = bytesToHex(signJournalRequest(jr, irk));
  const j = await http(`https://${fqdn}/api/journal`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ request: jr, signature: js }),
  });
  const all: string[] = j.json?.lines ?? j.json?.log ?? [];
  return all.filter((l) => re.test(l));
}

async function main() {
  console.log(`box = ${fqdn}`);
  const delegated = deriveDemoDelegatedKey(hexToBytes(KEK), user);
  const token = bytesToHex(randomBytes(24));
  const order: PhoneOrder = { type: "add-paired-session", serverId: fqdn, token, issuedAt: Date.now() };
  const sig = bytesToHex(signPhoneOrder(order, delegated));
  const p = await http(`https://${fqdn}/api/orders-from-user`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ request: order, signature: sig }),
  });
  if (p.status !== 200 && p.status !== 204) throw new Error(`pair ${p.status}: ${p.text.slice(0, 200)}`);
  console.log("paired");

  const hdr = { "content-type": "application/json", "x-flagship-session": token };
  const start = await http(`https://${fqdn}/api/screens/vibe-code/start`, {
    method: "POST", headers: hdr,
    body: JSON.stringify({
      prompt: "Build a minimal static website that serves the text 'hello gate'. Produce an index.html AND a Dockerfile that SERVES it over HTTP — use `FROM nginx:alpine`, COPY index.html into /usr/share/nginx/html/, and the container listens on port 80. The flagship.app.json runtime.port MUST be 80. The site must return HTTP 200 with 'hello gate' in the body at '/'.",
      model: AI_MODEL, credential: { provider: "openai", apiKey: AI_KEY },
    }),
  });
  if (start.status !== 200) throw new Error(`start ${start.status}: ${start.text.slice(0, 200)}`);
  const sid = start.json?.sessionId;
  console.log(`session ${sid}`);

  let status = "";
  for (let i = 0; i < 40; i++) {
    await sleep(4000);
    const s = await http(`https://${fqdn}/api/screens/vibe-code/${encodeURIComponent(sid)}`, { headers: { "x-flagship-session": token } });
    status = s.json?.status ?? s.json?.meta?.status ?? "";
    const files = s.json?.files ?? {};
    process.stdout.write(`  poll ${i}: status=${status} files=[${Object.keys(files).join(", ")}]\n`);
    if (status === "ready-to-deploy" || status === "failed") {
      console.log("=== FILES ===");
      console.log(JSON.stringify(files, null, 2).slice(0, 8000));
      break;
    }
  }

  console.log("=== DEPLOY ===");
  const d = await http(`https://${fqdn}/api/llm/sessions/${encodeURIComponent(sid)}/deploy`, { method: "POST", headers: hdr, body: "{}" }, 240_000);
  console.log(`deploy ${d.status}: ${d.text.slice(0, 400)}`);

  console.log("=== JOURNAL (docker/build/error) ===");
  const hits = await journalGrep(/docker|build|error|Error|vibe|deploy/i, 400);
  for (const l of hits.slice(-80)) console.log(l);
}

main().catch((e) => { console.error(e); process.exit(1); });
