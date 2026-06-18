#!/usr/bin/env -S npx tsx
/**
 * LIVE proof of the AI-AGENTIC git-import adapt path against a real gym box.
 *
 * Reads the held box (gym-results/feature-screenshots/box.json — written by
 * provision-for-webapp.ts; carries the UMK seed → owner IRK), then:
 *   1. mints a paired session by signing an `add-paired-session` order with
 *      the OWNER IRK (the box pins it as pskPub via FLAGSHIP_PSK_PUB_HEX);
 *   2. POST /api/build/git for a NON-FIT public repo, delivering the BYOK
 *      credential (the box opens it just-in-time; .com is never in the path);
 *   3. POST .../adapt — the box's AI agentically drives the build TOOLS
 *      (read_file → write_file → validate → deploy) until the app deploys;
 *   4. reads the build JOURNAL to print the AI's tool-call transcript +
 *      the files it wrote;
 *   5. fetches the deployed service's subdomain and asserts a 200.
 *
 * Run:  set -a; source .gym-secrets.env; set +a
 *       npx tsx tools/live-e2e/adapt-drive.ts
 *
 * Env: GYM_AI_API_KEY (BYOK), GYM_AI_PROVIDER (default openai),
 *      GYM_AI_MODEL (default gpt-4o-mini), ADAPT_GIT_URL (the non-fit repo).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { deriveIRK, signPhoneOrder, type PhoneOrder } from "@flagship/protocol";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

const BOX_FILE = join("gym-results", "feature-screenshots", "box.json");
const GIT_URL = process.env.ADAPT_GIT_URL || "https://github.com/harrywinner2/flagship-adapt-demo";
const GIT_REF = process.env.ADAPT_GIT_REF || "main";
const AI_PROVIDER = process.env.GYM_AI_PROVIDER || "openai";
const AI_MODEL = process.env.GYM_AI_MODEL || "gpt-4o-mini";
const AI_KEY = process.env.GYM_AI_API_KEY || "";

function log(s: string): void {
  process.stdout.write(s + "\n");
}
function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(m);
}

async function http(
  url: string,
  opts: RequestInit = {},
  timeoutMs = 30_000,
): Promise<{ status: number; text: string; json: any }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
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
    clearTimeout(t);
  }
}

async function main(): Promise<void> {
  assert(AI_KEY, "GYM_AI_API_KEY is required (BYOK)");
  const box = JSON.parse(readFileSync(BOX_FILE, "utf8")) as {
    fqdn: string;
    user: string;
    umkSeedHex: string;
    irkPubHex: string;
  };
  const fqdn = box.fqdn;
  // Owner IRK from the UMK seed — the SAME derivation the webapp keystore +
  // provision-for-webapp use. The box pinned its public half as pskPub.
  const irk = deriveIRK({ seed: hexToBytes(box.umkSeedHex) });
  assert(
    bytesToHex(irk.publicKey) === box.irkPubHex,
    `IRK mismatch: derived ${bytesToHex(irk.publicKey).slice(0, 16)} != box ${box.irkPubHex.slice(0, 16)}`,
  );

  log(`\n=== LIVE AI-agentic adapt against ${fqdn} ===`);
  log(`  repo (non-fit) = ${GIT_URL} @ ${GIT_REF}`);
  log(`  BYOK = ${AI_PROVIDER} / ${AI_MODEL}\n`);

  // 0. Sanity: box serves + platform up.
  const health = await http(`https://${fqdn}/`, {}, 15_000).catch(() => ({ status: 0 }) as any);
  assert(health.status === 200, `box not serving (got ${health.status})`);
  const svc = await http(`https://${fqdn}/api/services`).catch(() => ({ status: 0 }) as any);
  assert(svc.status === 200, `/api/services ${svc.status} — full platform not up (need docker/host-IRK)`);
  log(`  ✓ box serving (200) + ServicePlatform up (/api/services 200)`);

  // 1. Paired session: owner-IRK-signed add-paired-session order.
  const token = bytesToHex(randomBytes(24));
  {
    const order: PhoneOrder = {
      type: "add-paired-session",
      serverId: fqdn,
      token,
      label: "adapt-drive",
      issuedAt: Date.now(),
    };
    const sig = bytesToHex(signPhoneOrder(order, irk));
    const r = await http(`https://${fqdn}/api/orders-from-user`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: order, signature: sig }),
    });
    assert(r.status === 200 || r.status === 204, `paired session ${r.status}: ${r.text.slice(0, 160)}`);
    log(`  ✓ paired session minted (owner-IRK signed, ${r.status})`);
  }
  const sessionHeaders = { "content-type": "application/json", "x-flagship-session": token };

  // 2. git-create the NON-FIT repo + deliver the BYOK credential.
  let buildId = "";
  {
    const r = await http(
      `https://${fqdn}/api/build/git`,
      {
        method: "POST",
        headers: sessionHeaders,
        body: JSON.stringify({
          gitUrl: GIT_URL,
          ref: GIT_REF,
          credential: { provider: AI_PROVIDER, apiKey: AI_KEY },
        }),
      },
      90_000,
    );
    assert(r.status === 200, `git-create ${r.status}: ${r.text.slice(0, 200)}`);
    buildId = r.json?.buildId;
    assert(buildId, `no buildId: ${JSON.stringify(r.json).slice(0, 160)}`);
    log(`  ✓ git-create buildId=${buildId} fit=${r.json?.fit} (reason: ${String(r.json?.reason).slice(0, 70)})`);
    assert(r.json?.fit === false, `expected a NON-FIT repo but fit=${r.json?.fit} — pick a repo with no flagship.app.json`);
  }

  // 3. ⭐ The AGENTIC adapt: the AI drives the tools until it deploys.
  log(`\n  → running AGENTIC adapt (the AI drives read_file→write_file→validate→deploy)…`);
  const adaptStart = Date.now();
  const adapt = await http(
    `https://${fqdn}/api/build/sessions/${encodeURIComponent(buildId)}/adapt`,
    {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({
        instructions:
          "Adapt this tiny Node greeter into a minimal Flagship app. Listen on runtime.port from the environment, remove the basic-auth gate, and keep the greeting page. No data stores needed.",
      }),
    },
    300_000,
  );
  const adaptSecs = Math.round((Date.now() - adaptStart) / 1000);
  log(`  adapt responded ${adapt.status} in ${adaptSecs}s: ${JSON.stringify(adapt.json).slice(0, 220)}`);
  assert(adapt.status === 200, `adapt ${adapt.status}: ${adapt.text.slice(0, 240)}`);
  assert(adapt.json?.ok === true, `adapt not ok: ${JSON.stringify(adapt.json).slice(0, 200)}`);

  // 4. The build JOURNAL — the AI's tool-call transcript (value-free).
  log(`\n  === AI tool-call transcript (build journal) ===`);
  const jr = await http(`https://${fqdn}/api/build/sessions/${encodeURIComponent(buildId)}/journal`, {
    headers: sessionHeaders,
  });
  const entries: Array<{ kind: string; actor: string; summary: string; detail?: string }> = jr.json?.entries ?? [];
  for (const e of entries) {
    log(`    [${e.actor}/${e.kind}] ${e.summary}${e.detail ? `  (${e.detail})` : ""}`);
  }
  const wrote = entries.filter((e) => /^wrote /.test(e.summary)).map((e) => e.summary.replace(/^wrote /, ""));
  const validated = entries.some((e) => /validate: ok/.test(e.summary));
  const deployedEntry = entries.find((e) => /^deployed →/.test(e.summary));
  log(`\n  files the AI wrote: ${wrote.join(", ") || "(none in journal)"}`);
  log(`  validate ok seen: ${validated}`);

  // 5. The deployed service must serve a 200 at its subdomain.
  let deployedUrl: string | undefined = adapt.json?.deployedUrl;
  if (!deployedUrl && deployedEntry) {
    deployedUrl = deployedEntry.summary.replace(/^deployed →\s*/, "").trim();
  }
  // Fall back to the build state's deployedUrl.
  if (!deployedUrl) {
    const st = await http(`https://${fqdn}/api/build/sessions/${encodeURIComponent(buildId)}`, { headers: sessionHeaders });
    deployedUrl = st.json?.state?.deployedUrl;
  }

  if (adapt.json?.deployed === true && deployedUrl) {
    log(`\n  ✓ the AI DEPLOYED the app itself → ${deployedUrl}`);
    log(`  → verifying the served response (allow ~60s for the container to come up)…`);
    let served = 0;
    let body = "";
    for (let i = 0; i < 20; i++) {
      const r = await http(deployedUrl, {}, 12_000).catch(() => ({ status: 0, text: "" }) as any);
      served = r.status;
      body = r.text;
      if (served === 200) break;
      await new Promise((res) => setTimeout(res, 6_000));
    }
    log(`\n=== RESULT ===`);
    log(`  served status: ${served}`);
    log(`  served body (first 200): ${body.replace(/\s+/g, " ").slice(0, 200)}`);
    assert(served === 200, `deployed app did not serve 200 (got ${served})`);
    log(`\n  ⭐ PROVEN: AI agentically adapted a non-fit repo into a Flagship app that SERVES 200 at ${deployedUrl}`);
  } else {
    // The AI wrote a valid manifest but did not call deploy itself — finish
    // the deploy via the explicit endpoint, then verify the served 200.
    log(`\n  (the AI wrote a manifest but did not deploy itself; deploying via .../deploy)`);
    const dep = await http(
      `https://${fqdn}/api/build/sessions/${encodeURIComponent(buildId)}/deploy`,
      { method: "POST", headers: sessionHeaders },
      300_000,
    );
    assert(dep.status === 200 && dep.json?.ok === true, `deploy ${dep.status}: ${dep.text.slice(0, 200)}`);
    deployedUrl = dep.json?.url;
    log(`  ✓ deployed → ${deployedUrl}`);
    let served = 0;
    let body = "";
    for (let i = 0; i < 20; i++) {
      const r = await http(deployedUrl!, {}, 12_000).catch(() => ({ status: 0, text: "" }) as any);
      served = r.status;
      body = r.text;
      if (served === 200) break;
      await new Promise((res) => setTimeout(res, 6_000));
    }
    log(`\n=== RESULT ===`);
    log(`  served status: ${served}`);
    log(`  served body (first 200): ${body.replace(/\s+/g, " ").slice(0, 200)}`);
    assert(served === 200, `deployed app did not serve 200 (got ${served})`);
    log(`\n  ⭐ PROVEN: AI agentically shaped a non-fit repo into a Flagship app that SERVES 200 at ${deployedUrl}`);
  }
}

main().catch((e) => {
  log("\nadapt-drive FAILED: " + (e instanceof Error ? (e.stack ?? e.message) : String(e)));
  process.exit(1);
});
