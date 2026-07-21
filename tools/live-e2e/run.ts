#!/usr/bin/env -S npx tsx
/**
 * LIVE real-server e2e against the gym test env (docs/ui-test-gym.md §6.5).
 *
 * Unlike the gym's Tier-1 (entirely backendless mocks), this provisions — or
 * reuses — an ACTUAL gym Hetzner box and exercises the real backend end-to-end:
 * lifecycle (provision → register → tunnel → ACME cert → serve), real
 * browser-trusted TLS, the control-plane directory, the box daemon's
 * unauthenticated API, and its owner-IRK-SIGNED API (we derive the deterministic
 * demo owner IRK from DEMO_IRK_KEK and sign the same envelopes the phone would).
 *
 *   GYM_ADMIN_SECRET=… GYM_DEMO_IRK_KEK=… npx tsx tools/live-e2e/run.ts
 *   LIVE_E2E_REUSE_USER=gymbox … npx tsx tools/live-e2e/run.ts   # reuse a live box (fast)
 *
 * Env: GYM_LIVE_CONTROL_APEX (default gym.flagshipserver.com),
 *      GYM_LIVE_SERVICES_APEX (default gym.flagship.services),
 *      GYM_ADMIN_SECRET | FLAGSHIP_ADMIN_SECRET (required to provision/delete),
 *      GYM_DEMO_IRK_KEK (hex; enables the signed-endpoint checks),
 *      LIVE_E2E_REUSE_USER (skip provision+teardown, exercise this user's box).
 *
 * Exit 0 = every check passed; 1 = a check failed; 2 = the harness crashed.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { deriveDemoUserIrk, deriveDemoDelegatedKey } from "@flagship/control-plane";
import {
  signJournalRequest,
  signPhoneOrder,
  signInstallService,
  signUninstallService,
  signSetServiceEnv,
  signSetDeadManPolicy,
  type JournalRequest,
  type PhoneOrder,
  type InstallServiceRequest,
  type UninstallServiceRequest,
  type SetServiceEnvRequest,
  type SetDeadManPolicy,
} from "@flagship/protocol";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

const CONTROL = process.env.GYM_LIVE_CONTROL_APEX || "gym.flagshipserver.com";
const SERVICES = process.env.GYM_LIVE_SERVICES_APEX || "gym.flagship.services";
const ADMIN = process.env.GYM_ADMIN_SECRET || process.env.FLAGSHIP_ADMIN_SECRET || "";
const KEK = process.env.GYM_DEMO_IRK_KEK || "";
const REUSE_USER = process.env.LIVE_E2E_REUSE_USER || "";

interface Res {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}
const results: Res[] = [];
function log(s: string): void {
  process.stdout.write(s + "\n");
}
async function check(name: string, fn: () => Promise<string> | string): Promise<boolean> {
  const t = Date.now();
  try {
    const detail = (await fn()) || "";
    results.push({ name, ok: true, detail, ms: Date.now() - t });
    log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
    return true;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    results.push({ name, ok: false, detail, ms: Date.now() - t });
    log(`  ✗ ${name} — ${detail}`);
    return false;
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function http(
  url: string,
  opts: RequestInit = {},
  timeoutMs = 15000,
): Promise<{ status: number; text: string; json: any }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal });
    const text = await r.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: r.status, text, json };
  } finally {
    clearTimeout(timer);
  }
}

/** issuer / subject / SAN list for a live host's served cert (openssl s_client). */
function certInfo(fqdn: string): { issuer: string; subject: string; sans: string[] } {
  const out = spawnSync(
    "bash",
    [
      "-c",
      `echo | openssl s_client -connect ${fqdn}:443 -servername ${fqdn} 2>/dev/null | ` +
        `openssl x509 -noout -issuer -subject -text 2>/dev/null`,
    ],
    { encoding: "utf8", timeout: 25000 },
  );
  const t = out.stdout || "";
  const issuer = (/issuer=(.*)/.exec(t) || [])[1]?.trim() || "";
  const subject = (/subject=(.*)/.exec(t) || [])[1]?.trim() || "";
  const sanLine = (/DNS:[^\n]*/.exec(t) || [])[0] || "";
  const sans = sanLine.split(",").map((s) => s.trim().replace(/^DNS:/, "")).filter(Boolean);
  return { issuer, subject, sans };
}

/** Raw HTTP/1.1 GET over openssl s_client — shows what the server writes after
 *  the TLS handshake even when fetch() dies at the socket layer (undici hides
 *  the real cause behind a generic "fetch failed"). Diagnostic only. */
function rawHttpsGet(fqdn: string): string {
  const out = spawnSync(
    "bash",
    [
      "-c",
      `printf 'GET / HTTP/1.1\\r\\nHost: ${fqdn}\\r\\nConnection: close\\r\\n\\r\\n' | ` +
        `openssl s_client -quiet -connect ${fqdn}:443 -servername ${fqdn} 2>/dev/null | head -c 400`,
    ],
    { encoding: "utf8", timeout: 25000 },
  );
  return (out.stdout || "").replace(/\s+/g, " ").trim();
}

/** Unwrap undici's "fetch failed" to the underlying cause for diagnostics. */
function fetchErr(e: unknown): string {
  const cause = (e as any)?.cause;
  const inner = cause?.code ?? cause?.message ?? cause ?? (e as any)?.message ?? e;
  return String(inner).slice(0, 120);
}

async function main(): Promise<void> {
  assert(ADMIN, "GYM_ADMIN_SECRET (or FLAGSHIP_ADMIN_SECRET) is required");
  const startedAt = new Date();
  const tsLabel = startedAt.toISOString().replace(/[:.]/g, "-");
  const user = REUSE_USER || "lv" + Date.now().toString(36).slice(-7);
  const fqdn = `home.${user}.${SERVICES}`;
  const provEnv = { ...process.env, FLAGSHIP_ADMIN_SECRET: ADMIN, FLAGSHIP_BASE_URL: `https://${CONTROL}` };
  log(`\nLIVE real-server e2e`);
  log(`  control = ${CONTROL}`);
  log(`  services= ${SERVICES}`);
  log(`  box     = ${fqdn}  (${REUSE_USER ? "REUSE existing" : "PROVISION fresh"})`);
  log(`  signed  = ${KEK ? "yes (demo IRK derived)" : "SKIP (no GYM_DEMO_IRK_KEK)"}\n`);

  // ── 1. Both planes reachable ──────────────────────────────────────────────
  log("[control + data plane]");
  await check("control plane health 200", async () => {
    const r = await http(`https://${CONTROL}/api/health`);
    assert(r.status === 200, `got ${r.status}`);
    return `service=${r.json?.service ?? "?"} surface=${r.json?.surface ?? "?"}`;
  });
  // (The data plane is proven below by the box SERVING through it — the bare
  // `<apex>:8443` hub port has no apex A record to probe directly; only per-box
  // names resolve into the Fly app, by design.)

  // ── 2. Provision + bring-up (unless reusing) ──────────────────────────────
  if (!REUSE_USER) {
    log("[provision]");
    const boxSize = process.env.GYM_BOX_SIZE || "cpx31"; // full-platform default (docker + a real container)
    await check(`provision a fresh ${boxSize} box via the admin flow`, () => {
      try {
        execFileSync("node", ["scripts/sample-user.mjs", "create", user, "--size", boxSize], {
          env: provEnv,
          encoding: "utf8",
          timeout: 240000,
        });
        return `provisioned ${user} (${boxSize})`;
      } catch (e: any) {
        // The `create` CLI kicks off async Worker-side provisioning, THEN blocks
        // polling state=provisioning. A real box takes longer than that window to
        // come up, so a CLI-side error here — a poll TIMEOUT *or* a transient
        // `fetch failed` network blip — does NOT mean the box failed. The
        // bring-up poll below is the real gate, so we never treat a CLI poll
        // error as fatal; we just record how the CLI ended.
        const msg = String(e?.message ?? e).split("\n")[0].slice(0, 100);
        return `kicked off ${user} (${boxSize}); CLI poll ended: ${msg} — bring-up poll confirms`;
      }
    });
    // ALWAYS wait for bring-up when not reusing — provisioning runs async on the
    // Worker, so a CLI-side poll error never means the box isn't coming.
    log("[bring-up — polling registered → online → cert → serving, up to 16 min]");
    await check("box comes online and serves verified TLS", async () => {
      const deadline = Date.now() + 16 * 60 * 1000;
      let last = "";
      while (Date.now() < deadline) {
        const pods = await http(`https://${CONTROL}/api/users/${user}/pods`).catch(() => ({ json: null }) as any);
        const p = pods.json?.pods?.find((x: any) => x.serverDomain === fqdn);
        const serve = await http(`https://${fqdn}/`, {}, 12000).catch(() => ({ status: 0 }) as any);
        last = `registered=${p ? "y" : "n"} cert=${p?.currentCert ? "y" : "n"} hb=${p?.lastReported ? "y" : "n"} http=${serve.status}`;
        if (p && serve.status === 200) return last;
        await new Promise((r) => setTimeout(r, 20000));
      }
      throw new Error(`not online+serving in 16 min (last: ${last})`);
    });
  }

  // ── 3. Box: real TLS + serving ────────────────────────────────────────────
  log("[box: TLS + serving]");
  await check("box serves HTTP 200 (the daemon apex page)", async () => {
    const r = await http(`https://${fqdn}/`);
    assert(r.status === 200, `got ${r.status}`);
    assert(/Flagship/i.test(r.text), "apex html missing the Flagship brand");
    return `${r.text.length}B html`;
  });
  await check("box presents a real Let's Encrypt cert for its own FQDN", () => {
    const c = certInfo(fqdn);
    assert(/Let's Encrypt/i.test(c.issuer), `issuer=${c.issuer || "<none>"}`);
    assert(c.subject.includes(fqdn), `subject=${c.subject || "<none>"}`);
    return c.issuer.replace(/.*CN ?= ?/i, "");
  });
  await check("cert SANs cover the box apex AND its per-box wildcard", () => {
    const c = certInfo(fqdn);
    assert(c.sans.includes(fqdn), `apex SAN missing (sans=${c.sans.join(",") || "<none>"})`);
    assert(c.sans.includes(`*.${fqdn}`), `wildcard SAN missing (sans=${c.sans.join(",")})`);
    return c.sans.join(", ");
  });

  // ── 4. Box: unauthenticated API ───────────────────────────────────────────
  log("[box: unauthenticated API]");
  await check("GET /api/services responds (list, or 503 when the platform is off)", async () => {
    const r = await http(`https://${fqdn}/api/services`);
    assert(r.status === 200 || r.status === 503, `got ${r.status}`);
    if (r.status === 503) return "503 — service platform disabled (cert+serve-only box)";
    const list = Array.isArray(r.json) ? r.json : (r.json?.apps ?? r.json?.services);
    assert(Array.isArray(list), `200 but not a list: ${r.text.slice(0, 80)}`);
    return `${list.length} services (platform up)`;
  });
  await check("GET /api/front-page returns the apex assignment", async () => {
    const r = await http(`https://${fqdn}/api/front-page`);
    assert(r.status === 200, `got ${r.status}`);
    return JSON.stringify(r.json).slice(0, 70);
  });

  // ── 5. Control plane: directory reflects the live box ─────────────────────
  log("[control plane: directory]");
  await check("GET /api/users/:u/pods shows the box ONLINE with a verified cert", async () => {
    const r = await http(`https://${CONTROL}/api/users/${user}/pods`);
    assert(r.status === 200, `got ${r.status}`);
    const p = r.json?.pods?.find((x: any) => x.serverDomain === fqdn);
    assert(p, `box ${fqdn} not in /pods`);
    assert(p.state === "online", `state=${p.state}`);
    return `state=${p.state} cert=${p.currentCert ? "set" : "-"} hb=${p.lastReported ? "set" : "-"}`;
  });

  // ── 5.5 Slice-D admin-authority posture: this driver signs every sensitive
  // op (journal / power / env-set / deadman / install / uninstall) with the
  // DEMO OWNER IRK. That is only authoritative while the Slice-D transition
  // gate is CLOSED for this account: demo/sample-user accounts are claimed by
  // `admin-claim-and-issue` (packages/control-plane/src/demoUsersAdmin.ts —
  // `usernames.put` with NO `adminRootPubHex`), so
  // `authorizeSensitiveComOp` / `authorizeSensitiveOrder`
  // (packages/control-plane/src/adminAuthorityGate.ts,
  // packages/server-daemon/src/adminAuthorityLocal.ts) fall back to the legacy
  // owner-IRK path. If demo provisioning ever starts pinning an admin master
  // root, every owner-IRK-signed check below turns into a silent 403 — so
  // fail FAST and LOUD here instead, with the fix spelled out.
  await check("Slice-D gate is CLOSED for the gym user (no admin root pinned)", async () => {
    const r = await http(`https://${CONTROL}/api/username/${user}`);
    assert(r.status === 200, `username lookup got ${r.status}`);
    assert(
      r.json?.adminRootPub == null,
      `account '${user}' has a PINNED admin master root (${String(r.json?.adminRootPub).slice(0, 12)}…) — ` +
        `the Slice-D authority gate is OPEN, so the owner-IRK envelopes this driver signs are no longer ` +
        `authoritative for sensitive ops. Implement admin-root signing in tools/live-e2e/run.ts ` +
        `(derive/load the demo admin root and sign sensitive orders with it) before trusting these checks.`,
    );
    return "adminRootPub=null → legacy owner-IRK auth applies";
  });

  // ── 6. Box: owner-IRK SIGNED API (derive demo IRK, sign real envelopes) ───
  if (KEK) {
    log("[box: owner-IRK signed API]");
    const irk = deriveDemoUserIrk(hexToBytes(KEK), user);
    await check("POST /api/journal (owner-IRK signed) returns real daemon log lines", async () => {
      const req: JournalRequest = { serverId: fqdn, unit: "flagship-daemon", lines: 25, issuedAt: Date.now() };
      const sig = bytesToHex(signJournalRequest(req, irk));
      const r = await http(`https://${fqdn}/api/journal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request: req, signature: sig }),
      });
      assert(r.status === 200, `got ${r.status}: ${r.text.slice(0, 140)}`);
      const lines = r.json?.lines ?? r.json?.log ?? [];
      assert(Array.isArray(lines) && lines.length > 0, `no lines (${JSON.stringify(r.json).slice(0, 80)})`);
      return `${lines.length} lines`;
    });
    await check("POST /api/journal REJECTS a forged signature (auth is enforced)", async () => {
      const req: JournalRequest = { serverId: fqdn, unit: "flagship-daemon", lines: 5, issuedAt: Date.now() };
      const r = await http(`https://${fqdn}/api/journal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request: req, signature: "00".repeat(64) }),
      });
      assert(r.status === 401 || r.status === 403, `expected 401/403, got ${r.status}`);
      return `rejected ${r.status}`;
    });
  } else {
    log("[box: owner-IRK signed API] — SKIPPED (set GYM_DEMO_IRK_KEK to enable)");
  }

  // ── 6.5 Full-platform features (services + paired session + build) ─────────
  // Only on a FULL-platform box (SWK + config → ServicePlatform). A
  // cert+serve-only box returns 503 at /api/services; we detect + report that
  // rather than failing, so this stays green on a minimal box too.
  if (KEK) {
    log("[box: full-platform features]");
    // Guarded: a not-yet-serving box must fail THIS check, not crash the harness.
    const svc = await http(`https://${fqdn}/api/services`).catch(() => ({ status: 0, text: "fetch failed", json: null }) as any);
    const platformUp = svc.status === 200;
    await check("ServicePlatform constructed (GET /api/services 200, not 503)", () => {
      assert(svc.status === 200 || svc.status === 503, `unexpected ${svc.status} (${svc.text?.slice(0, 60)})`);
      if (svc.status === 503) {
        log("    (platform OFF — this box is cert+serve-only; build/vibe/mcp not available)");
        return "503 — platform off (minimal box)";
      }
      const list = Array.isArray(svc.json) ? svc.json : (svc.json?.apps ?? svc.json?.services);
      return `platform UP — ${(list?.length ?? 0)} services`;
    });
    if (platformUp) {
      // Mint a paired session: sign an add-paired-session order with the demo
      // DELEGATED key (the box pins it as pskPub via FLAGSHIP_PSK_PUB_HEX), POST
      // to /api/orders-from-user, then use the token on a paired-gated call.
      const delegated = deriveDemoDelegatedKey(hexToBytes(KEK), user);
      const token = bytesToHex(randomBytes(24));
      let sessionOk = false;
      await check("mint a paired session (add-paired-session, delegated-key signed)", async () => {
        const order: PhoneOrder = {
          type: "add-paired-session",
          serverId: fqdn,
          token,
          label: "live-e2e",
          issuedAt: Date.now(),
        };
        const sig = bytesToHex(signPhoneOrder(order, delegated));
        const r = await http(`https://${fqdn}/api/orders-from-user`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ request: order, signature: sig }),
        });
        assert(r.status === 200 || r.status === 204, `got ${r.status}: ${r.text.slice(0, 140)}`);
        sessionOk = true;
        return `token accepted (${r.status})`;
      });
      if (sessionOk) {
        // git-import — a REAL build-modes feature over the paired session: the
        // box clones a public repo and returns a Flagship-fitness verdict (no
        // LLM needed). Proves the paired session works AND git-import runs e2e.
        await check("git-import returns a fitness verdict (paired session, real clone)", async () => {
          const r = await http(
            `https://${fqdn}/api/build/git`,
            {
              method: "POST",
              headers: { "content-type": "application/json", "x-flagship-session": token },
              body: JSON.stringify({ gitUrl: "https://github.com/octocat/Hello-World", ref: "master" }),
            },
            60_000,
          );
          assert(r.status === 200, `got ${r.status}: ${r.text.slice(0, 160)}`);
          const v = r.json?.fit !== undefined ? `fit=${r.json.fit}` : JSON.stringify(r.json).slice(0, 80);
          return v;
        });

        // MCP connect (IDE): mint a build + bearer key, then drive the MCP
        // Streamable-HTTP transport (JSON-RPC tools/list) — the IDE-coding path.
        await check("MCP connect mints a key + lists tools (JSON-RPC)", async () => {
          const mint = await http(`https://${fqdn}/api/build/mcp`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-flagship-session": token },
            body: JSON.stringify({ label: "live-e2e-ide" }),
          });
          assert(mint.status === 200, `mint ${mint.status}: ${mint.text.slice(0, 120)}`);
          const conn = mint.json?.connection ?? mint.json;
          assert(conn?.url && conn?.key, `no url/key: ${JSON.stringify(mint.json).slice(0, 120)}`);
          const rpc = await http(
            conn.url,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                authorization: `Bearer ${conn.key}`,
              },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
            },
            30_000,
          );
          assert(rpc.status === 200, `tools/list ${rpc.status}: ${rpc.text.slice(0, 160)}`);
          // Streamable-HTTP may answer as JSON or an SSE frame; parse either.
          const parseRpc = (t: string, j: any) => j ?? JSON.parse((t.match(/\{[\s\S]*\}/) || ["{}"])[0]);
          const tools = parseRpc(rpc.text, rpc.json)?.result?.tools ?? [];
          assert(Array.isArray(tools) && tools.length > 0, `no tools: ${rpc.text.slice(0, 160)}`);
          // EXECUTE a tool (not just list): get_contract is read-only and proves
          // the MCP server actually services tool calls, not merely advertises.
          const call = await http(
            conn.url,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                authorization: `Bearer ${conn.key}`,
              },
              body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_contract", arguments: {} } }),
            },
            30_000,
          );
          assert(call.status === 200, `tools/call ${call.status}: ${call.text.slice(0, 160)}`);
          const result = parseRpc(call.text, call.json)?.result;
          const content = JSON.stringify(result?.content ?? result ?? "");
          assert(content.length > 20 && !parseRpc(call.text, call.json)?.error, `get_contract empty/err: ${call.text.slice(0, 160)}`);
          return `${tools.length} tools; get_contract returned ${content.length}B`;
        });

        // vibe-code: no key → needsCredential (the surface gates); WITH a BYOK
        // key → the model actually runs on the box.
        await check("vibe-code start without a key → needsCredential (gated)", async () => {
          const r = await http(`https://${fqdn}/api/screens/vibe-code/start`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-flagship-session": token },
            body: JSON.stringify({ prompt: "build a hello world note app" }),
          });
          assert(r.status === 200, `got ${r.status}: ${r.text.slice(0, 120)}`);
          assert(r.json?.needsCredential === true, `expected needsCredential: ${JSON.stringify(r.json).slice(0, 80)}`);
          return "needsCredential";
        });
        const aiKey = process.env.GYM_AI_API_KEY;
        const aiModel = process.env.GYM_AI_MODEL || "gpt-4o-mini";
        if (aiKey) {
          // ⭐ The LIVE BYOK model-run: the box opens the per-session credential
          // and actually invokes the model. We pass an OpenAI model explicitly
          // (the start API threads body.model into the session); the credential
          // never leaves the box. HARD assert the model produced real output.
          await check("vibe-code with a BYOK key RUNS the model on the box (real emit)", async () => {
            const start = await http(`https://${fqdn}/api/screens/vibe-code/start`, {
              method: "POST",
              headers: { "content-type": "application/json", "x-flagship-session": token },
              body: JSON.stringify({
                prompt: "Build the smallest possible static site: a single index.html whose body contains exactly the text 'Hello Flagship'. Keep it minimal.",
                model: aiModel,
                credential: { provider: "openai", apiKey: aiKey },
              }),
            });
            assert(start.status === 200, `start ${start.status}: ${start.text.slice(0, 120)}`);
            const sid = start.json?.sessionId;
            assert(sid && start.json?.needsCredential !== true, `no streaming session: ${JSON.stringify(start.json).slice(0, 80)}`);
            // Poll the session for real model output: assistant text, an
            // emitted file, a manifest, a talkToUser turn, or a terminal state.
            // No output in the window = the model did NOT run → hard fail.
            let emitted = "";
            for (let i = 0; i < 15; i++) {
              await new Promise((r) => setTimeout(r, 4000));
              const s = await http(`https://${fqdn}/api/screens/vibe-code/${encodeURIComponent(sid)}`, {
                headers: { "x-flagship-session": token },
              });
              const txt = JSON.stringify(s.json ?? {});
              if (/assistant|hello flagship|index\.html|"emit"|manifest|"done"|complete|talkToUser|building|"file/i.test(txt)) {
                emitted = txt.replace(/\s+/g, " ").slice(0, 90);
                break;
              }
            }
            assert(emitted, `model produced no output in 60s (key delivered but no emit) — model=${aiModel}`);
            return `model (${aiModel}) ran + emitted: ${emitted}`;
          });

          // ⭐ git-ADAPT: clone a non-fit repo, then run the AI adapt pass — the
          // box invokes the model to rewrite it to the Flagship contract. The
          // box default model is OpenAI (cloud-init FLAGSHIP_LLM_DEFAULT_MODEL),
          // so the adapt path (which takes no model param) uses the BYOK key.
          await check("git-adapt RUNS the model to rewrite a non-fit repo (real files)", async () => {
            const create = await http(
              `https://${fqdn}/api/build/git`,
              {
                method: "POST",
                headers: { "content-type": "application/json", "x-flagship-session": token },
                body: JSON.stringify({
                  gitUrl: "https://github.com/octocat/Hello-World",
                  ref: "master",
                  credential: { provider: "openai", apiKey: aiKey },
                }),
              },
              60_000,
            );
            assert(create.status === 200, `git-create ${create.status}: ${create.text.slice(0, 140)}`);
            const buildId = create.json?.buildId;
            assert(buildId, `no buildId: ${JSON.stringify(create.json).slice(0, 100)}`);
            const adapt = await http(
              `https://${fqdn}/api/build/sessions/${encodeURIComponent(buildId)}/adapt`,
              {
                method: "POST",
                headers: { "content-type": "application/json", "x-flagship-session": token },
                body: JSON.stringify({ instructions: "Make this a minimal Flagship static site." }),
              },
              180_000,
            );
            assert(adapt.status === 200, `adapt ${adapt.status}: ${adapt.text.slice(0, 160)}`);
            assert(adapt.json?.ok === true && (adapt.json?.fileCount ?? 0) > 0, `no files written: ${JSON.stringify(adapt.json).slice(0, 100)}`);
            return `adapt model run → ${adapt.json.fileCount} files written`;
          });
        }

        // Owner-IRK server management (USER IRK): front-page + the power gate.
        const userIrk = deriveDemoUserIrk(hexToBytes(KEK), user);
        await check("front-page set (owner-IRK signed) accepted + reads back", async () => {
          const order: PhoneOrder = { type: "set-front-page", serverId: fqdn, label: "", issuedAt: Date.now() };
          const sig = bytesToHex(signPhoneOrder(order, userIrk));
          const r = await http(`https://${fqdn}/api/front-page`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ request: order, signature: sig }),
          });
          assert(r.status === 200, `got ${r.status}: ${r.text.slice(0, 120)}`);
          const g = await http(`https://${fqdn}/api/front-page`);
          return `set ok → ${JSON.stringify(g.json).slice(0, 50)}`;
        });
        await check("POST /api/power REJECTS a forged signature (owner-gate enforced)", async () => {
          const req = { type: "power-off", serverId: fqdn, mode: "restart", issuedAt: Date.now() };
          const r = await http(`https://${fqdn}/api/power`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ request: req, signature: "00".repeat(64) }),
          });
          assert(r.status >= 400 && r.status < 500, `expected a 4xx rejection, got ${r.status}`);
          return `rejected ${r.status}`;
        });

        // DEAD-MAN server control (owner-IRK). We exercise the signed control
        // path WITHOUT ever arming the kill-switch: a forged policy must be
        // rejected, and a VALID policy with enabled:false must be accepted (it
        // disarms — a live box must never be left with a lapsing lockout).
        await check("dead-man policy REJECTS a forged signature", async () => {
          const req: SetDeadManPolicy = {
            serverId: fqdn,
            enabled: false,
            windowMs: 24 * 60 * 60 * 1000,
            graceMs: 60 * 60 * 1000,
            lockoutMode: "off",
            issuedAt: Date.now(),
          };
          const r = await http(`https://${fqdn}/api/deadman/policy`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ request: req, signature: "00".repeat(64) }),
          });
          assert(r.status === 401 || r.status === 403, `expected 401/403, got ${r.status}`);
          return `rejected ${r.status}`;
        });
        await check("dead-man policy set (owner-IRK signed, DISABLED — never arms) → 200", async () => {
          const req: SetDeadManPolicy = {
            serverId: fqdn,
            enabled: false, // deliberately disabled — proves the control path, leaves no lockout
            windowMs: 24 * 60 * 60 * 1000,
            graceMs: 60 * 60 * 1000,
            lockoutMode: "off",
            issuedAt: Date.now(),
          };
          const sig = bytesToHex(signSetDeadManPolicy(req, userIrk));
          const r = await http(`https://${fqdn}/api/deadman/policy`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ request: req, signature: sig }),
          });
          assert(r.status === 200, `got ${r.status}: ${r.text.slice(0, 120)}`);
          assert(r.json?.enabled === false, `expected enabled:false echo, got ${JSON.stringify(r.json)}`);
          return "accepted (disarmed)";
        });

        // SERVICE LIFECYCLE — create / run / delete a real service (owner-IRK).
        // An image-only app (no data.stores) so it needs only docker, not the
        // full data stack.
        const slug = "livetest";
        const svcManifest = JSON.stringify({
          schema_version: 1,
          name: slug, // must be a DNS label
          version: "0.1.0",
          description: "live-e2e image probe",
          runtime: { image: "traefik/whoami", port: 80 },
          data: {}, // image-only — no stores, so no data stack needed
          network: { subdomain: slug },
          // enabled:true (apps can't opt out of platform identity); public_routes
          // opens "/" to anonymous traffic so an external GET reaches the
          // container (serviceProxy: a public-route match returns "allow"). This
          // lets us PROVE the container actually serves, not just that the gate
          // 403s anonymous (private-by-default, which we also assert below).
          access: { enabled: true, public_routes: ["/"] },
          migration: { verification: "standard" },
        });
        let installed = false;
        await check("install a service (owner-IRK signed) → appears in /api/services", async () => {
          const req: InstallServiceRequest = {
            serverId: fqdn,
            creator: user,
            slug,
            manifestJson: svcManifest,
            addOwnerToMembership: true,
            issuedAt: Date.now(),
          };
          const sig = bytesToHex(signInstallService(req, userIrk));
          const r = await http(
            `https://${fqdn}/api/services`,
            { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: req, signature: sig }) },
            90_000,
          );
          assert(r.status === 200, `install ${r.status}: ${r.text.slice(0, 180)}`);
          installed = true;
          const list = await http(`https://${fqdn}/api/services`);
          const apps = (Array.isArray(list.json) ? list.json : (list.json?.apps ?? list.json?.services)) ?? [];
          assert(apps.some((a: any) => JSON.stringify(a).includes(slug)), `not listed: ${JSON.stringify(apps).slice(0, 140)}`);
          return `installed + listed (${apps.length} services)`;
        });
        if (installed) {
          // MANAGE the service: set its environment (owner-IRK signed). This is
          // the "managing services" path — values are secret, never echoed.
          await check("manage service env (SetServiceEnv, owner-IRK signed) → ok", async () => {
            const req: SetServiceEnvRequest = {
              serverId: fqdn,
              creator: user,
              slug,
              env: { LIVE_E2E_PROBE: "ok", GREETING: "hello-from-live-e2e" },
              issuedAt: Date.now(),
            };
            const sig = bytesToHex(signSetServiceEnv(req, userIrk));
            // serviceId is the immutable composite `<creator>--<slug>` (DOUBLE
            // dash — packages/protocol/src/serviceId.ts; the daemon 400s
            // "serviceId / (creator,slug) mismatch" on anything else).
            const serviceId = `${user}--${slug}`;
            const r = await http(
              `https://${fqdn}/api/services/${encodeURIComponent(serviceId)}/env`,
              { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: req, signature: sig }) },
              60_000,
            );
            assert(r.status === 200, `set-env ${r.status}: ${r.text.slice(0, 160)}`);
            return "env applied (2 vars)";
          });
          await check("manage service env REJECTS a forged signature", async () => {
            const req: SetServiceEnvRequest = { serverId: fqdn, creator: user, slug, env: { X: "y" }, issuedAt: Date.now() };
            const serviceId = `${user}--${slug}`;
            const r = await http(`https://${fqdn}/api/services/${encodeURIComponent(serviceId)}/env`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ request: req, signature: "00".repeat(64) }),
            });
            assert(r.status >= 400 && r.status < 500, `expected a 4xx rejection, got ${r.status}`);
            return `rejected ${r.status}`;
          });
          await check("installed container actually SERVES 200 at its subdomain (full app-proxy path)", async () => {
            // The deepest runtime proof: the container ANSWERS at its per-service
            // subdomain. This exercises the whole path — Fly-hub SNI routing of
            // `<slug>.<fqdn>` → the box's per-box wildcard cert → the daemon's
            // app-proxy `byLabel()` → the access gate (public_routes:["/"] → allow)
            // → the whoami container. A 200 here proves all of it. (A bare
            // service with no public route correctly 403s anonymous — that's the
            // private-by-default gate, verified by in-process serviceAccessGate
            // tests.) The image (traefik/whoami) may need a few seconds to pull
            // + start, so we poll up to 120s, then HARD-FAIL with a diagnosis.
            const url = `https://${slug}.${fqdn}/`;
            let last = { status: 0, snippet: "" };
            for (let i = 0; i < 24; i++) {
              const c = await http(url, {}, 12000).catch(
                (e) => ({ status: 0, text: `fetch failed: ${fetchErr(e)}`, json: null }) as any,
              );
              if (c.status === 200) {
                const whoami = /Hostname|GET \/|RemoteAddr/i.test(String(c.text ?? "")) ? " (whoami body)" : "";
                return `container serving 200 at ${slug}.${fqdn}${whoami} — full app-proxy path proven`;
              }
              last = { status: c.status, snippet: String(c.text ?? "").replace(/\s+/g, " ").slice(0, 120) };
              await new Promise((r) => setTimeout(r, 5000));
            }
            // No 200 in 120s — diagnose before failing (SSH-free): does the
            // subdomain present the box's wildcard cert? If yes, routing+cert are
            // fine and the issue is the container/proxy hop; if no, it's routing.
            // Then show what the daemon actually WRITES after the handshake (raw
            // openssl GET — survives whatever kills fetch()) and grep the daemon
            // journal (owner-IRK signed) for deploy/proxy errors.
            const c = certInfo(`${slug}.${fqdn}`);
            const tlsOk = /Let's Encrypt/i.test(c.issuer) || c.sans.includes(`*.${fqdn}`);
            const raw = rawHttpsGet(`${slug}.${fqdn}`);
            let journalHint = "";
            try {
              const jr: JournalRequest = { serverId: fqdn, unit: "flagship-daemon", lines: 150, issuedAt: Date.now() };
              const js = bytesToHex(signJournalRequest(jr, userIrk));
              const j = await http(`https://${fqdn}/api/journal`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ request: jr, signature: js }),
              });
              const lines: string[] = j.json?.lines ?? j.json?.log ?? [];
              const hits = lines
                .filter((l) => new RegExp(`docker|proxy|deploy|502|error|${slug}`, "i").test(l))
                .slice(-5);
              if (hits.length) journalHint = ` | journal: ${hits.join(" ⏎ ").slice(0, 400)}`;
            } catch {
              /* diagnostic only */
            }
            const diag = tlsOk
              ? `TLS+routing OK (cert ${c.issuer || c.sans.join(",")}) but HTTP ${last.status || "no-response"} ${last.snippet}`
              : `TLS/routing did NOT complete (issuer=${c.issuer || "<none>"})`;
            throw new Error(
              `container not serving 200 in 120s — ${diag} | raw GET: ${raw.slice(0, 200) || "<no bytes>"}${journalHint}`,
            );
          });
          await check("uninstall the service (owner-IRK signed) → 200", async () => {
            const req: UninstallServiceRequest = { serverId: fqdn, creator: user, slug, issuedAt: Date.now() };
            const sig = bytesToHex(signUninstallService(req, userIrk));
            const serviceId = `${user}--${slug}`;
            const r = await http(
              `https://${fqdn}/api/services/${encodeURIComponent(serviceId)}`,
              { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: req, signature: sig }) },
              60_000,
            );
            assert(r.status === 200, `uninstall ${r.status}: ${r.text.slice(0, 160)}`);
            return "uninstalled";
          });
        }
      }
    }
  }

  // ── 6.6 Control-plane: maintainer-trust (pass path) + marketplace ─────────
  log("[control plane: trust + marketplace]");
  await check("maintainer-trust chain served + well-formed (mandate verdict present)", async () => {
    const r = await http(`https://${CONTROL}/api/maintainer-blessing`);
    assert(r.status === 200, `got ${r.status}`);
    assert(r.json?.pinnedMandateHash || r.json?.caPubkey || r.json?.mandates, `unexpected: ${r.text.slice(0, 80)}`);
    // The chain is served + well-formed (the deterministic live proof a client
    // needs to verify `pin → authorizedCaKeys(now) ∋ servedKey`). The
    // authorization VERDICT is environment-dependent:
    //   • prod ENFORCES (CA_ENDORSEMENT_ENFORCE=true + a live backdated lease) → true
    //   • the gym runs OBSERVE-mode with NO CaEndorsement bundle (deliberate —
    //     wrangler.gym.toml §6.5), so false here is BY DESIGN, not a lapsed lease.
    // The expired-mandate ENFORCEMENT path (refuse-to-sign when the lease has
    // lapsed) is tested in-process where `now` can be injected: caGate /
    // caLeaseWarning / serviceBlessing.
    assert(typeof r.json?.caPubkeyAuthorizedNow === "boolean", `no authorization verdict: ${r.text.slice(0, 80)}`);
    const mode = r.json.caPubkeyAuthorizedNow ? "ENFORCE+live" : "OBSERVE (no endorsement — gym default; clients halt)";
    return `chain served, verdict=${r.json.caPubkeyAuthorizedNow} [${mode}], pin=${String(r.json?.pinnedMandateHash).slice(0, 12)}…`;
  });
  await check("marketplace browse (GET /api/marketplace/search) — 200, or 404 when branch-gated", async () => {
    const r = await http(`https://${CONTROL}/api/marketplace/search?limit=5`);
    // The marketplace ships ONLY on feat/marketplace; a main-deployed gym Worker
    // 404s it (branch-gate). Both are correct — note which.
    assert(r.status === 200 || r.status === 404, `got ${r.status}`);
    if (r.status === 404) return "404 — marketplace is feat/marketplace-gated (not on the main gym Worker)";
    const list = r.json?.listings ?? r.json?.results ?? r.json;
    return `${Array.isArray(list) ? list.length : "?"} listings`;
  });

  // ── 7. Teardown (unless reusing) ──────────────────────────────────────────
  if (!REUSE_USER) {
    log("[teardown]");
    await check("delete the box (stop billing)", () => {
      execFileSync("node", ["scripts/sample-user.mjs", "delete", user], {
        env: provEnv,
        encoding: "utf8",
        timeout: 180000,
      });
      return `deleted ${user}`;
    });
  }

  // ── results ───────────────────────────────────────────────────────────────
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  const dir = join("gym-results", "live-e2e-" + tsLabel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "results.json"),
    JSON.stringify(
      { control: CONTROL, services: SERVICES, box: fqdn, reuse: !!REUSE_USER, startedAt, pass, fail, results },
      null,
      2,
    ),
  );
  log(`\n=== LIVE real-server e2e: ${pass} passed, ${fail} failed of ${results.length} ===`);
  log(`verdict: ${fail === 0 ? "OK" : "FAILED"}`);
  log(`artifact: ${dir}/results.json`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  log("live-e2e harness crashed: " + (e instanceof Error ? (e.stack ?? e.message) : String(e)));
  process.exit(2);
});
