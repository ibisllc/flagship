#!/usr/bin/env -S npx tsx
/**
 * LIVE proof of the FROM-SCRATCH (vibe-code) build path against a real gym box.
 *
 * Mirrors adapt-drive.ts's session-minting + BYOK credential delivery, but for
 * the scratch path: there is no git repo — the owner gives a prose prompt and
 * the box's AI AUTHORS the whole app (manifest + Dockerfile + source) by
 * streaming the emit-format the VibeCodeStreamParser reads, then the result is
 * deployed and must serve HTTP 200.
 *
 * Reads the held box (gym-results/feature-screenshots/box.json — written by
 * provision-for-webapp.ts; carries the UMK seed → owner IRK), then:
 *   1. mints a paired session by signing an `add-paired-session` order with
 *      the OWNER IRK (the box pins it as pskPub via FLAGSHIP_PSK_PUB_HEX);
 *   2. POST /api/screens/vibe-code/start with a from-scratch prompt + the BYOK
 *      credential → the box opens the credential just-in-time and STREAMS the
 *      model (the box's AI), parsing out the emitted files;
 *   3. polls GET /api/screens/vibe-code/:id until the session is
 *      ready-to-deploy, resolving any talkToUser / requestEnvVar pause it hits
 *      (via the legacy /api/llm/sessions/:id surface — same registry);
 *   4. deploys via POST /api/llm/sessions/:id/deploy (Forgejo push → docker
 *      build → signed ServicePlatform install);
 *   5. reads the build JOURNAL (buildId == sessionId) for the AI's transcript;
 *   6. fetches the deployed service's subdomain and asserts a 200.
 *
 * The AI genuinely authors the service — this driver writes NO app code; it
 * only mints the session, delivers the prompt + key, resolves pauses, and
 * deploys + verifies.
 *
 * Run:  set -a; source .gym-secrets.env; set +a
 *       npx tsx tools/live-e2e/vibe-drive.ts
 *
 * Env: GYM_AI_API_KEY (BYOK), GYM_AI_PROVIDER (default openai),
 *      GYM_AI_MODEL (default gpt-4o-mini), VIBE_PROMPT (override the prompt).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { deriveIRK, signPhoneOrder, type PhoneOrder } from "@flagship/protocol";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

const BOX_FILE = join("gym-results", "feature-screenshots", "box.json");
const AI_PROVIDER = process.env.GYM_AI_PROVIDER || "openai";
const AI_MODEL = process.env.GYM_AI_MODEL || "gpt-4o-mini";
const AI_KEY = process.env.GYM_AI_API_KEY || "";
const DEFAULT_PROMPT =
  "Build a minimal HTTP web service that returns HTTP 200 with the body " +
  "'hello from flagship gym' on GET /. It needs no data stores and no " +
  "authentication — make GET / a public route (access.public_routes: [\"/\"]). " +
  "The app must read the PORT environment variable the platform injects and " +
  "bind 0.0.0.0:$PORT (do NOT hardcode a port). Set runtime.port in the " +
  "manifest to the same value you EXPOSE. " +
  "CRITICAL build-consistency rules: your file set must be SELF-CONTAINED — " +
  "the Dockerfile may ONLY `COPY` files you actually emit in this same " +
  "response. Use plain `node:20-alpine`, a SINGLE source file, NO third-party " +
  "npm packages (use only Node's built-in `node:http`), and therefore NO " +
  "package.json and NO `npm install` step — copy just your one source file and " +
  "run it directly. Keep it tiny.";
const PROMPT = process.env.VIBE_PROMPT || DEFAULT_PROMPT;

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  assert(AI_KEY, "GYM_AI_API_KEY is required (BYOK)");
  const box = JSON.parse(readFileSync(BOX_FILE, "utf8")) as {
    fqdn: string;
    user: string;
    umkSeedHex: string;
    irkPubHex: string;
  };
  const fqdn = box.fqdn;
  // Owner IRK from the UMK seed — the SAME derivation provision-for-webapp +
  // the webapp keystore use. The box pinned its public half as pskPub.
  const irk = deriveIRK({ seed: hexToBytes(box.umkSeedHex) });
  assert(
    bytesToHex(irk.publicKey) === box.irkPubHex,
    `IRK mismatch: derived ${bytesToHex(irk.publicKey).slice(0, 16)} != box ${box.irkPubHex.slice(0, 16)}`,
  );

  log(`\n=== LIVE AI from-scratch (vibe-code) against ${fqdn} ===`);
  log(`  BYOK = ${AI_PROVIDER} / ${AI_MODEL}`);
  log(`  prompt = ${PROMPT.slice(0, 110)}…\n`);

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
      label: "vibe-drive",
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

  // 2. Start the from-scratch vibe session + deliver the BYOK credential. The
  //    box opens the credential just-in-time and STREAMS the model — the AI
  //    authors the files. flagshipserver.com is never in the credential path.
  let sessionId = "";
  {
    const r = await http(
      `https://${fqdn}/api/screens/vibe-code/start`,
      {
        method: "POST",
        headers: sessionHeaders,
        body: JSON.stringify({
          prompt: PROMPT,
          model: AI_MODEL,
          credential: { provider: AI_PROVIDER, apiKey: AI_KEY },
        }),
      },
      60_000,
    );
    assert(r.status === 200, `vibe start ${r.status}: ${r.text.slice(0, 200)}`);
    sessionId = r.json?.sessionId;
    assert(sessionId, `no sessionId: ${JSON.stringify(r.json).slice(0, 160)}`);
    assert(
      r.json?.needsCredential !== true,
      `box reported needsCredential — the BYOK key was not accepted / no model wired`,
    );
    log(`  ✓ vibe session started: ${sessionId} (the box AI is now authoring)`);
  }

  // 3. Poll the session to terminal. The model streams server-side; we poll
  //    P1.7 for status + files, and resolve any mid-build pause it hits.
  log(`\n  → driving the from-scratch build (the AI streams manifest + Dockerfile + source)…`);
  const start = Date.now();
  const deadline = start + 5 * 60 * 1000;
  let status = "streaming";
  let files: Record<string, string> = {};
  let lastLog = 0;
  let resolvedPauses = 0;
  while (Date.now() < deadline) {
    const st = await http(`https://${fqdn}/api/screens/vibe-code/${encodeURIComponent(sessionId)}`, {
      headers: sessionHeaders,
    });
    assert(st.status === 200, `vibe status ${st.status}: ${st.text.slice(0, 160)}`);
    status = st.json?.status ?? "?";
    files = (st.json?.files ?? {}) as Record<string, string>;
    const now = Date.now();
    if (now - lastLog > 8_000) {
      log(
        `    ${new Date().toISOString().slice(11, 19)} status=${status} files=[${Object.keys(files).join(", ") || "-"}]`,
      );
      lastLog = now;
    }

    if (status === "ready-to-deploy" || status === "deployed") break;
    if (status === "failed") {
      // Surface the transcript so the failure is auditable, then bail.
      const jr = await http(`https://${fqdn}/api/build/sessions/${encodeURIComponent(sessionId)}/journal`, {
        headers: sessionHeaders,
      });
      log(`\n  ✗ session FAILED. journal:`);
      for (const e of (jr.json?.entries ?? []) as any[]) {
        log(`    [${e.actor}/${e.kind}] ${e.summary}${e.detail ? `  (${e.detail})` : ""}`);
      }
      throw new Error(`vibe session failed (status=failed)`);
    }

    // Mid-build pause: the model asked the owner something. Resolve it via the
    // W10 public surface (GET exposes the pending tool; POST /reply resolves
    // it). A tiny self-contained hello service rarely pauses, but handle it.
    if (status === "awaiting-tool-response") {
      const pub = await http(`https://${fqdn}/api/screens/llm/sessions/${encodeURIComponent(sessionId)}`, {
        headers: sessionHeaders,
      });
      const pending = pub.json?.pendingRequest as
        | { kind: string; toolUseId: string; payload?: { name?: string; message?: string } }
        | undefined;
      if (pending) {
        if (pending.kind === "requestEnvVar") {
          // We provide no secrets headlessly — tell the model to proceed
          // without it (declined). A tiny hello service needs none.
          await http(`https://${fqdn}/api/screens/llm/sessions/${encodeURIComponent(sessionId)}/reply`, {
            method: "POST",
            headers: sessionHeaders,
            body: JSON.stringify({ envVarStatus: "declined" }),
          });
          log(`    · resolved requestEnvVar(${pending.payload?.name ?? "?"}) → declined (proceed without it)`);
        } else {
          // talkToUser — answer with a steer to finish the tiny service.
          await http(`https://${fqdn}/api/screens/llm/sessions/${encodeURIComponent(sessionId)}/reply`, {
            method: "POST",
            headers: sessionHeaders,
            body: JSON.stringify({
              text:
                "Yes — keep it minimal. Return 'hello from flagship gym' on GET /, make GET / public, " +
                "listen on $PORT, and emit the manifest + Dockerfile + source now, then finish with === END ===.",
            }),
          });
          log(`    · resolved talkToUser → steered to finish`);
        }
        resolvedPauses++;
        await sleep(2_000);
        continue;
      }
    }
    await sleep(3_000);
  }

  const secs = Math.round((Date.now() - start) / 1000);
  log(`\n  build reached status=${status} in ${secs}s (resolved ${resolvedPauses} pause(s))`);
  log(`  files the AI authored: [${Object.keys(files).join(", ") || "(none)"}]`);
  assert(
    status === "ready-to-deploy" || status === "deployed",
    `build did not reach ready-to-deploy (status=${status} after ${secs}s)`,
  );
  assert(files["flagship.app.json"], `the AI emitted no flagship.app.json (files: ${Object.keys(files).join(", ")})`);
  assert(files["Dockerfile"], `the AI emitted no Dockerfile (files: ${Object.keys(files).join(", ")})`);

  // 4. The build JOURNAL — the AI's transcript (value-free).
  log(`\n  === AI build transcript (build journal) ===`);
  const jr = await http(`https://${fqdn}/api/build/sessions/${encodeURIComponent(sessionId)}/journal`, {
    headers: sessionHeaders,
  });
  for (const e of (jr.json?.entries ?? []) as any[]) {
    log(`    [${e.actor}/${e.kind}] ${e.summary}${e.detail ? `  (${e.detail})` : ""}`);
  }

  // 5. Deploy the authored app (legacy deploy endpoint, same registry, has the
  //    real ServicePlatform install wired).
  let deployedUrl = "";
  if (status !== "deployed") {
    log(`\n  → deploying the AI-authored app (Forgejo push → docker build → signed install)…`);
    const dep = await http(
      `https://${fqdn}/api/llm/sessions/${encodeURIComponent(sessionId)}/deploy`,
      { method: "POST", headers: sessionHeaders },
      300_000,
    );
    if (!(dep.status === 200 && dep.json?.ok === true)) {
      // Auditable failure: dump the files the AI authored + the build journal
      // so the cause (e.g. a Dockerfile referencing a file it didn't emit) is
      // visible, not just an assert message.
      log(`\n  ✗ deploy FAILED (${dep.status}): ${dep.text.slice(0, 240)}`);
      log(`  --- files the AI authored ---`);
      for (const [p, c] of Object.entries(files)) {
        log(`  ### ${p} (${Buffer.byteLength(c, "utf8")} bytes)\n${c.split("\n").slice(0, 40).map((l) => "    " + l).join("\n")}`);
      }
      log(`  --- build journal ---`);
      const jr2 = await http(`https://${fqdn}/api/build/sessions/${encodeURIComponent(sessionId)}/journal`, {
        headers: sessionHeaders,
      });
      for (const e of (jr2.json?.entries ?? []) as any[]) {
        log(`    [${e.actor}/${e.kind}] ${e.summary}${e.detail ? `  (${e.detail})` : ""}`);
      }
      assert(false, `deploy ${dep.status}: ${dep.text.slice(0, 240)}`);
    }
    deployedUrl = dep.json?.url;
    log(`  ✓ deployed → ${deployedUrl} (serviceId=${dep.json?.serviceId})`);
  } else {
    const st = await http(`https://${fqdn}/api/screens/vibe-code/${encodeURIComponent(sessionId)}`, {
      headers: sessionHeaders,
    });
    deployedUrl = st.json?.deployedUrl;
    log(`\n  ✓ the AI already deployed → ${deployedUrl}`);
  }
  assert(deployedUrl, `no deployed URL`);

  // 6. The deployed service must serve a 200 at its subdomain.
  log(`  → verifying the served response (allow ~90s for the container to come up)…`);
  let served = 0;
  let body = "";
  for (let i = 0; i < 30; i++) {
    const r = await http(deployedUrl, {}, 12_000).catch(() => ({ status: 0, text: "" }) as any);
    served = r.status;
    body = r.text;
    if (served === 200) break;
    await sleep(6_000);
  }
  log(`\n=== RESULT ===`);
  log(`  served status: ${served}`);
  log(`  served body (first 200): ${body.replace(/\s+/g, " ").slice(0, 200)}`);
  assert(served === 200, `deployed app did not serve 200 (got ${served})`);
  log(`\n  ⭐ PROVEN: the box AI authored an app from scratch that SERVES 200 at ${deployedUrl}`);
  log(`DEPLOYED_URL=${deployedUrl}`);
}

main().catch((e) => {
  log("\nvibe-drive FAILED: " + (e instanceof Error ? (e.stack ?? e.message) : String(e)));
  process.exit(1);
});
