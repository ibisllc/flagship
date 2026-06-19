/**
 * LIVE gating e2e — drives the WHOLE service-access + web-experience (QR-login)
 * gating flow against a REAL gym box + the REAL gym control plane.
 *
 * Unlike the mocked Tier-1, this provisions (or reuses) an actual full-platform
 * Hetzner box, vibe-deploys a real served service, then exercises the gating
 * mechanism end-to-end with the SAME signed envelopes the apps send (it derives
 * the demo owner IRK from GYM_DEMO_IRK_KEK + uses @flagship/protocol to sign):
 *
 *   open→restricted (owner set-mode) → the WEBSITE now serves the knock page
 *   → mint invite on .com (owner-signed) → friend redeems (AID-signed) → box
 *   adds the friend's AID → QR-login: knock pageId → friend AID-signs the
 *   authorize → holder poll gets the session cookie → the cookie reaches the
 *   restricted site → holder-race (no holder, no cookie) → session status/close
 *   → owner prunes the AID (the wired revoke) → the friend is denied. Plus the
 *   AID-anchoring assertion (the auth identity is the AID, not the rotatable IRK).
 *
 * Usage (env from .gym-secrets.env):
 *   set -a; . ./.gym-secrets.env; set +a
 *   npx tsx tools/live-e2e/gating-drive.ts
 *   LIVE_E2E_REUSE_USER=<user> npx tsx tools/live-e2e/gating-drive.ts   # reuse a box
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deriveDemoUserIrk, deriveDemoDelegatedKey } from "@flagship/control-plane";
import {
  deriveAccountId,
  deriveIRK,
  deriveHouseholdKey,
  serviceInviteId,
  serviceInviteSecretHash,
  sealInviteBundle,
  signCreateServiceInvite,
  signRedeemServiceInvite,
  signRevokeServiceInvite,
  signSetServiceAccessMode,
  signKnockAuthorization,
  signRemoveServiceAllow,
  signPhoneOrder,
  type CreateServiceInvite,
  type RedeemServiceInvite,
  type RevokeServiceInvite,
  type SetServiceAccessMode,
  type KnockAuthorization,
  type RemoveServiceAllow,
  type PhoneOrder,
} from "@flagship/protocol";

const CONTROL = process.env.LIVE_E2E_CONTROL || "gym.flagshipserver.com";
// The gym DATA-plane apex is gym.flagship.services (NOT flagship.services — that's
// prod). Boxes register + serve under <server>.<user>.gym.flagship.services. Match
// run.ts's GYM_LIVE_SERVICES_APEX so the bring-up poll checks the domain the box
// actually serves.
const SERVICES = process.env.GYM_LIVE_SERVICES_APEX || process.env.LIVE_E2E_SERVICES || "gym.flagship.services";
const ADMIN = process.env.GYM_ADMIN_SECRET || process.env.FLAGSHIP_ADMIN_SECRET || "";
const KEK = process.env.GYM_DEMO_IRK_KEK || "";
const AI_KEY = process.env.GYM_AI_API_KEY || "";
const AI_MODEL = process.env.GYM_AI_MODEL || "gpt-4o-mini";
const REUSE_USER = process.env.LIVE_E2E_REUSE_USER || "";

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function log(s: string): void {
  process.stdout.write(s + "\n");
}
async function step(name: string, fn: () => Promise<string> | string): Promise<boolean> {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
    return true;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    results.push({ name, ok: false, detail });
    log(`  ✗ ${name} — ${detail}`);
    return false;
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
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
interface Resp { status: number; text: string; json: any; setCookies: string[] }
async function http(url: string, init: RequestInit = {}, timeoutMs = 20000): Promise<Resp> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal, redirect: "manual" });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    const setCookies = typeof (r.headers as any).getSetCookie === "function" ? (r.headers as any).getSetCookie() : [r.headers.get("set-cookie")].filter(Boolean) as string[];
    return { status: r.status, text, json, setCookies };
  } finally {
    clearTimeout(t);
  }
}
function cookieVal(setCookies: string[], name: string): string | null {
  for (const c of setCookies) {
    const m = new RegExp(`${name}=([^;]+)`).exec(c);
    if (m) return m[1]!;
  }
  return null;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  assert(ADMIN, "GYM_ADMIN_SECRET required");
  assert(KEK, "GYM_DEMO_IRK_KEK required (owner-signed envelopes)");
  const startedAt = new Date();
  const tsLabel = startedAt.toISOString().replace(/[:.]/g, "-");
  const user = REUSE_USER || "gt" + Date.now().toString(36).slice(-7);
  const fqdn = `home.${user}.${SERVICES}`;
  const provEnv = { ...process.env, FLAGSHIP_ADMIN_SECRET: ADMIN, FLAGSHIP_BASE_URL: `https://${CONTROL}` };
  log(`\nLIVE gating e2e`);
  log(`  control = ${CONTROL}`);
  log(`  box     = ${fqdn} (${REUSE_USER ? "REUSE" : "PROVISION cpx31"})`);
  log(`  ai      = ${AI_KEY ? `yes (${AI_MODEL})` : "NO KEY — vibe-deploy will be skipped"}\n`);

  // Identities — owner = the demo box owner IRK (== the .com-registered IRK for
  // `user`); author/friend are stable AIDs from fixed UMKs (the friend is ANY
  // account — only their AID matters to the gating allow-list).
  const ownerIrk = deriveDemoUserIrk(hexToBytes(KEK), user);
  const delegated = deriveDemoDelegatedKey(hexToBytes(KEK), user);
  const authorUmk = { seed: new Uint8Array(32).fill(0xa1) };
  const authorAid = deriveAccountId(authorUmk);
  const authorDevice = deriveIRK(authorUmk);
  const householdKey = deriveHouseholdKey(authorUmk);
  const friendUmk = { seed: new Uint8Array(32).fill(0xf2) };
  const friendAid = deriveAccountId(friendUmk);
  const friendIrk = deriveIRK(friendUmk);

  // ── 1. provision + bring-up ───────────────────────────────────────────────
  if (!REUSE_USER) {
    log("[provision cpx31 + bring-up]");
    await step("provision a full-platform box", () => {
      try {
        execFileSync("node", ["scripts/sample-user.mjs", "create", user, "--size", "cpx31"], { env: provEnv, encoding: "utf8", timeout: 240000 });
        return `provisioned ${user}`;
      } catch (e: any) {
        return `kicked off ${user}; CLI: ${String(e?.message ?? e).split("\n")[0].slice(0, 80)} — bring-up poll confirms`;
      }
    });
    await step("box online + serving verified TLS (≤16 min)", async () => {
      const deadline = Date.now() + 16 * 60_000;
      let last = "";
      while (Date.now() < deadline) {
        const pods = await http(`https://${CONTROL}/api/users/${user}/pods`).catch(() => ({ json: null }) as any);
        const p = pods.json?.pods?.find((x: any) => x.serverDomain === fqdn);
        const serve = await http(`https://${fqdn}/`, {}, 12000).catch(() => ({ status: 0 }) as any);
        last = `registered=${p ? "y" : "n"} http=${serve.status}`;
        if (p && serve.status === 200) return last;
        await sleep(20000);
      }
      throw new Error(`not online in 16 min (${last})`);
    });
  }

  // Everything after provision runs in a try so teardown ALWAYS happens (a
  // crash mid-flow must never leave a box billing).
  try {
  // ── 2. paired session ─────────────────────────────────────────────────────
  log("[paired session]");
  const token = bytesToHex(randomBytes(24));
  let paired = false;
  await step("mint a paired session (add-paired-session, delegated-signed)", async () => {
    const order: PhoneOrder = { type: "add-paired-session", serverId: fqdn, token, label: "gating-e2e", issuedAt: Date.now() };
    const sig = bytesToHex(signPhoneOrder(order, delegated));
    const r = await http(`https://${fqdn}/api/orders-from-user`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: order, signature: sig }) });
    assert(r.status === 200 || r.status === 204, `got ${r.status}: ${r.text.slice(0, 120)}`);
    paired = true;
    return `token accepted (${r.status})`;
  });

  // ── 3. vibe-deploy a real served service ──────────────────────────────────
  log("[install a service to gate (vibe-deploy)]");
  let serviceRef = "";
  let serviceUrl = "";
  let label = "";
  const sessionHdr = { "content-type": "application/json", "x-flagship-session": token };
  if (paired && AI_KEY) {
    let sid = "";
    await step("vibe-code start → model runs (BYOK)", async () => {
      const r = await http(`https://${fqdn}/api/screens/vibe-code/start`, {
        method: "POST", headers: sessionHdr,
        body: JSON.stringify({ prompt: "Build a minimal static website that serves the text 'hello gate'. Produce an index.html AND a Dockerfile that SERVES it over HTTP — use `FROM nginx:alpine`, COPY index.html into /usr/share/nginx/html/, and the container listens on port 80. The flagship.app.json runtime.port MUST be 80. The site must return HTTP 200 with 'hello gate' in the body at '/'.", model: AI_MODEL, credential: { provider: "openai", apiKey: AI_KEY } }),
      });
      assert(r.status === 200, `start ${r.status}: ${r.text.slice(0, 120)}`);
      sid = r.json?.sessionId;
      assert(sid && r.json?.needsCredential !== true, `no session: ${JSON.stringify(r.json).slice(0, 80)}`);
      // poll until the model has emitted a manifest/file (deployable)
      for (let i = 0; i < 30; i++) {
        await sleep(4000);
        const s = await http(`https://${fqdn}/api/screens/vibe-code/${encodeURIComponent(sid)}`, { headers: { "x-flagship-session": token } });
        const txt = JSON.stringify(s.json ?? {});
        if (/manifest|"done"|complete|index\.html|"file/i.test(txt)) return `session ${sid.slice(0, 8)} emitted`;
      }
      throw new Error("model produced no deployable output in 120s");
    });
    if (sid) {
      await step("deploy the built service → installed + served", async () => {
        const r = await http(`https://${fqdn}/api/llm/sessions/${encodeURIComponent(sid)}/deploy`, { method: "POST", headers: sessionHdr, body: "{}" }, 180_000);
        assert(r.status === 200, `deploy ${r.status}: ${r.text.slice(0, 160)}`);
        assert(r.json?.ok === true && r.json?.serviceId && r.json?.url, `no serviceId/url: ${JSON.stringify(r.json).slice(0, 120)}`);
        serviceRef = r.json.serviceId;
        serviceUrl = r.json.url.replace(/\/$/, "");
        const m = /^https:\/\/([^.]+)\./.exec(serviceUrl);
        label = m ? m[1]! : "";
        return `serviceId=${serviceRef} url=${serviceUrl}`;
      });
      await step("the deployed service serves 200 (open baseline)", async () => {
        // containers take a moment to become healthy after install
        for (let i = 0; i < 20; i++) {
          const r = await http(`${serviceUrl}/`, { headers: { accept: "text/html" } }, 12000).catch(() => ({ status: 0, text: "" }) as any);
          if (r.status === 200) return `200 (${r.text.slice(0, 30).replace(/\s+/g, " ")})`;
          await sleep(6000);
        }
        throw new Error("service did not serve 200 within 120s");
      });
    }
  } else {
    await step("vibe-deploy", () => { throw new Error(paired ? "no GYM_AI_API_KEY" : "no paired session"); });
  }

  // The gating chain needs an installed, served service.
  const haveService = !!serviceRef && !!serviceUrl && !!label;
  if (!haveService) {
    log("\n[gating chain] SKIPPED — no installed service to gate (see vibe-deploy failures above)");
  } else {
    const svcGet = (cookie?: string) => http(`${serviceUrl}/`, { headers: { accept: "text/html", ...(cookie ? { cookie } : {}) } }, 12000);

    // ── 4. restrict → the website serves the knock page ─────────────────────
    log("\n[restrict → knock page]");
    await step("owner set-mode restricted (IRK-signed) accepted", async () => {
      const order: SetServiceAccessMode = { serverId: fqdn, serviceRef, mode: "restricted", issuedAt: Date.now() };
      const sig = bytesToHex(signSetServiceAccessMode(order, ownerIrk));
      const r = await http(`https://${fqdn}/api/service-access`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: order, signature: sig }) });
      assert(r.status === 200, `got ${r.status}: ${r.text.slice(0, 140)}`);
      return `mode=${r.json?.mode}`;
    });
    await step("a browser nav to the restricted site now gets the KNOCK PAGE", async () => {
      const r = await svcGet();
      assert(r.status === 200, `got ${r.status}`);
      assert(/Access is restricted/i.test(r.text) && /flagship:\/\/access\?/.test(r.text), `not the knock page: ${r.text.slice(0, 80)}`);
      const holder = cookieVal(r.setCookies, "Flagship-Knock");
      assert(holder, "no Flagship-Knock holder cookie");
      return "knock page + holder cookie";
    });
    await step("a non-browser request to the restricted site is 403 (not the knock page)", async () => {
      const r = await http(`${serviceUrl}/`, { headers: { accept: "application/json" } }, 12000);
      assert(r.status === 403, `expected 403, got ${r.status}`);
      return "403 JSON";
    });

    // ── 5. invite on .com + friend redeem against the box ───────────────────
    log("\n[invite (.com) + redeem (box→.com bind)]");
    const secret = randomBytes(32);
    const secretHashHex = serviceInviteSecretHash(secret);
    const inviteId = serviceInviteId(authorAid.publicKey, authorDevice.publicKey, Date.now() % 1_000_000);
    await step("mint an invite on .com (owner-IRK-signed create)", async () => {
      const bundle = sealInviteBundle({ name: "E2E Friend" }, householdKey, inviteId);
      const create: CreateServiceInvite = { inviteId, authorAID: authorAid.publicKey, serviceRef, secretHash: secretHashHex, encryptedBundle: bundle, issuedAt: Date.now() };
      const sig = bytesToHex(signCreateServiceInvite(create, ownerIrk));
      const r = await http(`https://${CONTROL}/api/users/${user}/service-invites`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ request: { ...create, authorAID: bytesToHex(create.authorAID) }, signature: sig }),
      });
      assert(r.status === 200, `got ${r.status}: ${r.text.slice(0, 140)}`);
      return `inviteId=${inviteId.slice(0, 12)}…`;
    });
    await step("friend redeems against the box (AID-signed → box relays to .com → bind)", async () => {
      const redeemedAt = Date.now();
      const redeem: RedeemServiceInvite = { secretHash: secretHashHex, visitorAID: friendAid.publicKey, redeemedAt };
      const aidSig = bytesToHex(signRedeemServiceInvite(redeem, friendAid));
      const r = await http(`https://${fqdn}/api/service-invites/redeem`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: bytesToHex(secret), visitorAID: bytesToHex(friendAid.publicKey), aidSig, redeemedAt }),
      });
      assert(r.status === 200, `got ${r.status}: ${r.text.slice(0, 140)}`);
      assert(r.json?.boundAID === bytesToHex(friendAid.publicKey), `bound the wrong AID: ${JSON.stringify(r.json).slice(0, 100)}`);
      return `firstBind=${r.json?.firstBind} boundAID=${r.json.boundAID.slice(0, 12)}…`;
    });

    // ── 6. QR-login: knock → AID-authorize → holder poll → cookie → access ──
    log("\n[QR-login: knock → authorize → cookie → access]");
    let secretId = "";
    let sessionCookie = "";
    await step("QR-login end-to-end: friend AID-authorizes, holder poll gets the cookie, cookie reaches the site", async () => {
      const k = await svcGet();
      const pageId = (/[?&]page=([0-9a-f]+)/.exec(k.text) || [])[1];
      const holder = cookieVal(k.setCookies, "Flagship-Knock");
      assert(pageId && holder, "no pageId/holder from the knock page");
      // friend phone authorizes (AID-signed; the pageId is in the signature)
      const knock: KnockAuthorization = { serverId: fqdn, serviceRef, pageId, visitorAID: friendAid.publicKey, issuedAt: Date.now() };
      const sig = bytesToHex(signKnockAuthorization(knock, friendAid));
      const auth = await http(`https://${fqdn}/api/service-access/knock/authorize`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ authorization: { ...knock, visitorAID: bytesToHex(knock.visitorAID) }, sig }),
      });
      assert(auth.status === 200 && auth.json?.secretId, `authorize ${auth.status}: ${auth.text.slice(0, 120)}`);
      secretId = auth.json.secretId;
      // holder browser polls → gets the session cookie
      const poll = await http(`https://${fqdn}/__flagship/knock/${pageId}/status`, { headers: { accept: "application/json", cookie: `Flagship-Knock=${holder}` } });
      assert(poll.json?.status === "authorized", `poll status ${poll.json?.status}`);
      sessionCookie = cookieVal(poll.setCookies, "Flagship-App-Session") || "";
      assert(sessionCookie, "no session cookie delivered to the holder");
      // the cookie reaches the restricted site → real content (not the knock page)
      const access = await svcGet(`Flagship-App-Session=${sessionCookie}`);
      assert(access.status === 200 && /hello gate/i.test(access.text) && !/Access is restricted/i.test(access.text), `access not granted: ${access.status} ${access.text.slice(0, 60)}`);
      return `authorized → cookie → site served the content`;
    });
    await step("holder-race: a poll WITHOUT the holder cookie never gets the session cookie", async () => {
      const k = await svcGet();
      const pageId = (/[?&]page=([0-9a-f]+)/.exec(k.text) || [])[1];
      assert(pageId, "no pageId");
      const knock: KnockAuthorization = { serverId: fqdn, serviceRef, pageId, visitorAID: friendAid.publicKey, issuedAt: Date.now() };
      const sig = bytesToHex(signKnockAuthorization(knock, friendAid));
      await http(`https://${fqdn}/api/service-access/knock/authorize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ authorization: { ...knock, visitorAID: bytesToHex(knock.visitorAID) }, sig }) });
      const poll = await http(`https://${fqdn}/__flagship/knock/${pageId}/status`, { headers: { accept: "application/json" } }); // no holder cookie
      assert(poll.json?.status === "pending", `expected pending, got ${poll.json?.status}`);
      assert(!cookieVal(poll.setCookies, "Flagship-App-Session"), "a non-holder got the session cookie!");
      return "pending, no cookie (race-fix holds)";
    });

    // ── 7. session management (phone holds the secretId) ────────────────────
    log("\n[session status + close]");
    await step("session status (secretId) → online", async () => {
      const r = await http(`https://${fqdn}/api/service-access/session/status`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secretId }) });
      assert(r.json?.status === "online", `status ${r.json?.status} (${r.status})`);
      return "online";
    });
    await step("close kills the browser session (cookie no longer reaches the site; status offline)", async () => {
      const c = await http(`https://${fqdn}/api/service-access/session/close`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secretId }) });
      assert(c.json?.closed === true, `close ${c.status}: ${c.text.slice(0, 80)}`);
      const access = await svcGet(`Flagship-App-Session=${sessionCookie}`);
      assert(/Access is restricted/i.test(access.text), "closed cookie still served content");
      await sleep(61_000); // status is rate-limited ~1/min/secretId
      const st = await http(`https://${fqdn}/api/service-access/session/status`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secretId }) });
      assert(st.json?.status === "offline", `expected offline, got ${st.json?.status}`);
      return "cookie dead + status offline";
    });

    // ── 8. AID-anchoring (the identity is the AID, not the rotatable IRK) ────
    log("\n[AID-anchoring]");
    await step("the auth identity is the AID, NOT the device IRK (distinct keys); a 2nd authorize with the same AID still works", async () => {
      assert(bytesToHex(friendAid.publicKey) !== bytesToHex(friendIrk.publicKey), "AID == IRK?! the anchoring premise is wrong");
      const k = await svcGet();
      const pageId = (/[?&]page=([0-9a-f]+)/.exec(k.text) || [])[1];
      const holder = cookieVal(k.setCookies, "Flagship-Knock");
      assert(pageId && holder, "no pageId/holder");
      const knock: KnockAuthorization = { serverId: fqdn, serviceRef, pageId, visitorAID: friendAid.publicKey, issuedAt: Date.now() };
      const sig = bytesToHex(signKnockAuthorization(knock, friendAid));
      const auth = await http(`https://${fqdn}/api/service-access/knock/authorize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ authorization: { ...knock, visitorAID: bytesToHex(knock.visitorAID) }, sig }) });
      assert(auth.status === 200, `re-authorize ${auth.status}`);
      return `AID ${bytesToHex(friendAid.publicKey).slice(0, 10)}… ≠ IRK ${bytesToHex(friendIrk.publicKey).slice(0, 10)}…; re-auth ok`;
    });

    // ── 9. revoke → denied (the newly-wired box prune) ──────────────────────
    log("\n[revoke → denied]");
    await step("owner prunes the friend's AID (allow-remove, IRK-signed) → the friend is DENIED", async () => {
      const order: RemoveServiceAllow = { serverId: fqdn, serviceRef, aid: bytesToHex(friendAid.publicKey), issuedAt: Date.now() };
      const sig = bytesToHex(signRemoveServiceAllow(order, ownerIrk));
      const r = await http(`https://${fqdn}/api/service-access/allow-remove`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: order, signature: sig }) });
      assert(r.status === 200 && r.json?.removed === true, `allow-remove ${r.status}: ${r.text.slice(0, 100)}`);
      // a fresh AID-authorize now fails — the AID is no longer allow-listed
      const k = await svcGet();
      const pageId = (/[?&]page=([0-9a-f]+)/.exec(k.text) || [])[1];
      assert(pageId, `no knock page to re-authorize against (service serving? status=${k.status}) — the prune itself returned removed:true`);
      const knock: KnockAuthorization = { serverId: fqdn, serviceRef, pageId, visitorAID: friendAid.publicKey, issuedAt: Date.now() };
      const sig2 = bytesToHex(signKnockAuthorization(knock, friendAid));
      const auth = await http(`https://${fqdn}/api/service-access/knock/authorize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ authorization: { ...knock, visitorAID: bytesToHex(knock.visitorAID) }, sig: sig2 }) });
      assert(auth.status === 401, `expected 401 (not allow-listed), got ${auth.status}`);
      return "pruned → re-authorize 401 (revocation reaches the box)";
    });
    await step("for the record: .com invite revoke (owner-IRK-signed) accepted", async () => {
      const revoke: RevokeServiceInvite = { inviteId, issuedAt: Date.now() };
      const sig = bytesToHex(signRevokeServiceInvite(revoke, ownerIrk));
      const r = await http(`https://${CONTROL}/api/users/${user}/service-invites/revoke`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: revoke, signature: sig }) });
      assert(r.status === 200, `got ${r.status}: ${r.text.slice(0, 100)}`);
      return ".com row revoked";
    });
  }

  } finally {
    // ── teardown (ALWAYS, even on a crash) ──────────────────────────────────
    if (!REUSE_USER) {
      log("\n[teardown]");
      await step("delete the box (stop billing)", () => {
        execFileSync("node", ["scripts/sample-user.mjs", "delete", user], { env: provEnv, encoding: "utf8", timeout: 180000 });
        return `deleted ${user}`;
      });
    }
  }

  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  const dir = join("gym-results", "gating-live-" + tsLabel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "results.json"), JSON.stringify({ control: CONTROL, box: fqdn, startedAt, pass, fail, results }, null, 2));
  log(`\n=== LIVE gating e2e: ${pass} passed, ${fail} failed of ${results.length} ===`);
  log(`verdict: ${fail === 0 ? "OK" : "FAILED"}  ·  artifact: ${dir}/results.json`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  log("gating-drive crashed: " + (e instanceof Error ? (e.stack ?? e.message) : String(e)));
  process.exit(2);
});
