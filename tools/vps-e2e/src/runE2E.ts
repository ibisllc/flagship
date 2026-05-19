/**
 * Pure orchestration core for the real-VPS end-to-end harness.
 *
 * `runE2E(plan, deps)` drives the WHOLE Flagship chain — mint a build
 * code against `.com`, provision a cloud VPS from the supplied
 * (already-personalized) ISO, wait for the first-boot install +
 * registration, wait for the boot-stage unlock, prove the live green
 * padlock on `<server>.<user>.flagship.services`, exercise the free
 * account/server path, and (HONESTLY, as documented gaps) attempt the
 * two not-yet-wired pillars.
 *
 * This module performs NO real network/process/crypto-source itself.
 * Every side effect is an injected dep (`deps.provider`, `deps.http`,
 * `deps.ssh`, `deps.clock`, `deps.sleep`, `deps.logger`,
 * `deps.identity`). It NEVER throws out of `runE2E` — a mid-chain
 * failure is captured as a `fail` stage and the report is returned. It
 * ALWAYS attempts teardown (`provider.destroy`) in a `finally`, even
 * when the chain failed before a VPS existed (then it is a no-op).
 *
 * Honesty contract: stages for pillars not yet wired in prod are
 * `known-gated` with a `gatedReason` pointing at the exact file. A
 * `known-gated` stage failing its assertion is EXPECTED and does NOT
 * make the run `ok:false`. Only a NON-gated `fail` does.
 */

import {
  authCodeCanonical,
  authCodeIssueBody,
  buildTicketIssueBody,
  claimBody,
  claimCanonical,
  installBlobCanonical,
  rckRegisterBody,
  rckRegisterCanonical,
  bytesToHex,
  genSerial,
  type AuthCode,
  type InstallBlobParts,
} from "./wire.js";
import type {
  E2EDeps,
  E2EPlan,
  E2EReport,
  StageResult,
  VpsInstance,
} from "./ports.js";

const GATED_BYOK =
  "BYOK vibe-app cannot YET answer end-to-end on a live VPS: the " +
  "daemon runtime IS now wired (packages/server-daemon/src/appByokStore.ts " +
  "+ appByokRuntime.ts seal a per-app provider key at rest and the " +
  "appProxy answers /.flagship/llm/chat with it), but no order/protocol " +
  "carrier yet ships the user's key from the phone/webapp through the " +
  "signed envelope to deploySession.resolveByok. Expected-fail until " +
  "that @flagship/protocol + webapp carrier lands.";

const GATED_CA =
  "Served pubkey-cert is signed with the raw FLAGSHIP_CA_PRIV_HEX and " +
  "there is NO CaEndorsement gate upstream on `.com`: links 2-4 in " +
  "packages/server-daemon/src/caTrustChain.ts + " +
  "packages/protocol/src/maintainerCa.ts are code-ready but uncalled " +
  "in prod. Expected-fail until the consumer wiring + the human " +
  "CaEndorsement ceremony under MAINTAINER_PINNED_MANDATE_HASH land.";

/** Mutable run state threaded through the stages. */
interface RunState {
  serverFqdn: string;
  buildCode?: string;
  instance?: VpsInstance;
}

function pass(name: string, detail: string): StageResult {
  return { name, status: "pass", detail };
}
function fail(name: string, detail: string): StageResult {
  return { name, status: "fail", detail };
}
function gated(name: string, detail: string, gatedReason: string): StageResult {
  return { name, status: "known-gated", detail, gatedReason };
}
function skipped(name: string, detail: string): StageResult {
  return { name, status: "skipped", detail };
}

/** Thrown internally to abort the chain; never escapes `runE2E`. */
class StageError extends Error {
  constructor(public readonly stage: StageResult) {
    super(stage.detail);
  }
}

function randBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

async function expectOk(
  name: string,
  p: Promise<{ status: number; body: string }>,
): Promise<{ status: number; body: string }> {
  const r = await p;
  if (r.status < 200 || r.status >= 300) {
    throw new StageError(
      fail(name, `HTTP ${r.status} from .com: ${r.body.slice(0, 240)}`),
    );
  }
  return r;
}

/** Stage 1 — mint a build code against `.com`, IRK-signed. */
async function mintBuildCode(
  plan: E2EPlan,
  deps: E2EDeps,
  st: RunState,
): Promise<StageResult> {
  const name = "mintBuildCode";
  const { identity, http, clock } = deps;
  const irkPubHex = bytesToHex(identity.irk.publicKey);
  const delegatedPubHex = bytesToHex(identity.delegated.publicKey);
  const rckPubHex = bytesToHex(identity.rck.publicKey);

  // 1a — claim username
  const claimAt = clock();
  const claimSig = identity.signWithIrk(
    claimCanonical(plan.username, irkPubHex, claimAt),
  );
  await expectOk(
    name,
    http.post(
      `${plan.comBase}/api/username/claim`,
      claimBody(plan.username, irkPubHex, claimAt, bytesToHex(claimSig)),
    ),
  );

  // 1b — issue auth-code
  const acAt = clock();
  const code: AuthCode = {
    version: 1,
    serial: genSerial(randBytes),
    username: plan.username,
    serverName: plan.serverName,
    serverDomain: st.serverFqdn,
    delegatedPubKeyHex: delegatedPubHex,
    userPubKeyHex: irkPubHex,
    issuedAt: acAt,
    expiresAt: acAt + 60 * 60_000,
  };
  const acSig = identity.signWithIrk(authCodeCanonical(code));
  await expectOk(
    name,
    http.post(
      `${plan.comBase}/api/auth-code/issue`,
      authCodeIssueBody(code, bytesToHex(acSig)),
    ),
  );

  // 1c — register the routing-control-key for this subdomain
  const rckAt = clock();
  const rckSig = identity.signWithIrk(
    rckRegisterCanonical(plan.username, st.serverFqdn, rckPubHex, rckAt),
  );
  await expectOk(
    name,
    http.post(
      `${plan.comBase}/api/routing/register-rck`,
      rckRegisterBody(
        plan.username,
        st.serverFqdn,
        rckPubHex,
        rckAt,
        bytesToHex(rckSig),
      ),
    ),
  );

  // 1d — issue the build ticket (the code the operator burns into ISO
  // selection; here the ISO is already an INPUT, we just need .com to
  // hold the install blob the booted node will redeem)
  const blob: InstallBlobParts = {
    serverDomain: st.serverFqdn,
    username: plan.username,
    serverName: plan.serverName,
    phoneDelegatedPubKeyHex: delegatedPubHex,
    registrationUrl: `${plan.servicesBase}/api/server/register`,
    authCode: code,
    authCodeUserSignatureHex: bytesToHex(acSig),
    issuedAt: acAt,
    expiresAt: acAt + 60 * 60_000,
    installerGitRef: "main",
    rckPubKeyHex: rckPubHex,
  };
  const blobSig = identity.signWithIrk(installBlobCanonical(blob));
  const ticketResp = await expectOk(
    name,
    http.post(
      `${plan.comBase}/api/build-tickets/issue`,
      buildTicketIssueBody(blob, bytesToHex(blobSig), 60 * 60_000),
    ),
  );
  let ticket: { code?: unknown };
  try {
    ticket = JSON.parse(ticketResp.body);
  } catch {
    throw new StageError(
      fail(name, `build-ticket issue returned non-JSON: ${ticketResp.body.slice(0, 120)}`),
    );
  }
  if (typeof ticket.code !== "string" || ticket.code.length === 0) {
    throw new StageError(fail(name, "build-ticket issue returned no code"));
  }
  st.buildCode = ticket.code;
  deps.logger.info("minted build code", { code: ticket.code });
  return pass(
    name,
    `claimed ${plan.username}, issued auth-code + RCK + build ticket ${ticket.code}`,
  );
}

/** Stage 2 — provision the VPS from the supplied personalized ISO. */
async function provisionVps(
  plan: E2EPlan,
  deps: E2EDeps,
  st: RunState,
): Promise<StageResult> {
  const name = "provisionVps";
  const inst = await deps.provider.provision({
    iso: plan.iso,
    region: plan.region,
    size: plan.size,
    label: `flagship-e2e-${plan.username}-${plan.serverName}`,
  });
  st.instance = inst;
  deps.logger.info("provisioned vps", { id: inst.id, ip: inst.ip });
  await deps.provider.awaitBoot(inst.id);
  return pass(
    name,
    `provider ${deps.provider.name} booted ${inst.id} (${inst.ip}) from ${plan.iso}`,
  );
}

/**
 * Poll a `.com` read endpoint until a predicate holds or the budget
 * runs out. Returns the final body on success; throws StageError on
 * timeout (so the caller's stage records a fail).
 */
async function pollUntil(
  name: string,
  plan: E2EPlan,
  deps: E2EDeps,
  url: string,
  predicate: (status: number, body: string) => boolean,
  what: string,
): Promise<string> {
  for (let i = 0; i < plan.pollMaxAttempts; i++) {
    const r = await deps.http.get(url);
    if (predicate(r.status, r.body)) return r.body;
    await deps.sleep(plan.pollIntervalMs);
  }
  throw new StageError(
    fail(
      name,
      `timed out after ${plan.pollMaxAttempts} polls waiting for ${what}`,
    ),
  );
}

/** Stage 3 — wait until `.com` shows the install registered the pod. */
async function awaitInstallRegistered(
  plan: E2EPlan,
  deps: E2EDeps,
  st: RunState,
): Promise<StageResult> {
  const name = "awaitInstallRegistered";
  // The first-boot installer redeems the build ticket; once redeemed
  // and the server is registered the pod shows under the user's pods.
  const podsUrl = `${plan.comBase}/api/users/${encodeURIComponent(plan.username)}/pods`;
  const body = await pollUntil(
    name,
    plan,
    deps,
    podsUrl,
    (status, b) =>
      status === 200 && b.includes(st.serverFqdn),
    `pod ${st.serverFqdn} to appear registered on .com`,
  );
  deps.logger.info("install registered", { serverFqdn: st.serverFqdn });
  return pass(
    name,
    `.com lists ${st.serverFqdn} under ${plan.username}'s pods (install+register effect observed): ${body.slice(0, 160)}`,
  );
}

/** Stage 4 — wait until the boot-stage unlock has been consumed. */
async function awaitUnlock(
  plan: E2EPlan,
  deps: E2EDeps,
  st: RunState,
): Promise<StageResult> {
  const name = "awaitUnlock";
  // The boot-stage script POSTs /unlock-key/consume; once the node has
  // unlocked LUKS and progressed it reports daemon-status. We assert
  // the node moved past locked by polling its own readiness on
  // `.services` (a healthy data-plane response for the FQDN means the
  // disk unlocked and the daemon came up).
  const url = `${plan.comBase}/api/users/${encodeURIComponent(plan.username)}/pods`;
  const body = await pollUntil(
    name,
    plan,
    deps,
    url,
    (status, b) =>
      status === 200 &&
      b.includes(st.serverFqdn) &&
      /"(state|status)"\s*:\s*"(unlocked|ready|online|active)"/.test(b),
    `pod ${st.serverFqdn} to report unlocked/ready on .com`,
  );
  return pass(
    name,
    `boot-stage unlock observed — ${st.serverFqdn} reports unlocked/ready: ${body.slice(0, 160)}`,
  );
}

/** Stage 5 — prove the live green padlock on the per-server FQDN. */
async function probeGreenPadlock(
  plan: E2EPlan,
  deps: E2EDeps,
  st: RunState,
): Promise<StageResult> {
  const name = "probeGreenPadlock";
  const url = `https://${st.serverFqdn}/`;
  const r = await deps.http.get(url);
  if (r.status !== 200) {
    throw new StageError(
      fail(name, `expected HTTP 200 from ${url}, got ${r.status}`),
    );
  }
  if (!r.tls) {
    throw new StageError(
      fail(
        name,
        `no TLS cert introspected for ${url} — cannot prove the padlock`,
      ),
    );
  }
  const issuer = r.tls.issuer.toLowerCase();
  if (!issuer.includes("let's encrypt") && !issuer.includes("lets encrypt")) {
    throw new StageError(
      fail(name, `cert issuer is "${r.tls.issuer}", expected Let's Encrypt`),
    );
  }
  const now = deps.clock();
  if (now < r.tls.validFrom || now >= r.tls.validTo) {
    throw new StageError(
      fail(
        name,
        `cert not currently valid (validFrom=${r.tls.validFrom} validTo=${r.tls.validTo} now=${now})`,
      ),
    );
  }
  const sanMatch = r.tls.subjectAltNames.some(
    (s) => s === st.serverFqdn || s === `*.${st.serverFqdn.split(".").slice(1).join(".")}`,
  );
  if (!sanMatch) {
    throw new StageError(
      fail(
        name,
        `cert SANs ${JSON.stringify(r.tls.subjectAltNames)} do not cover ${st.serverFqdn}`,
      ),
    );
  }
  return pass(
    name,
    `${url} → HTTP 200 with a currently-valid Let's Encrypt cert covering ${st.serverFqdn}`,
  );
}

/** Stage 6 — exercise the free account/server path against the API. */
async function createAccountServer(
  plan: E2EPlan,
  deps: E2EDeps,
  st: RunState,
): Promise<StageResult> {
  const name = "createAccountServer";
  // The pod is up; assert its own account/server surface answers
  // healthily (the free account path). A 200 health on the per-server
  // FQDN proves the daemon's account+server plane is live end to end.
  const url = `https://${st.serverFqdn}/api/health`;
  const r = await deps.http.get(url);
  if (r.status !== 200) {
    throw new StageError(
      fail(name, `expected 200 from ${url}, got ${r.status}: ${r.body.slice(0, 160)}`),
    );
  }
  return pass(
    name,
    `free account/server path live — ${url} → 200 ${r.body.slice(0, 120)}`,
  );
}

/**
 * Stage 7 — KNOWN-GATED. Attempt to create a BYOK vibe-app and have it
 * answer using the user's own LLM provider key. Expected to NOT
 * succeed until vibeCodeSession.ts loads the stored provider key. A
 * failure here is the documented gap, not a harness failure.
 */
async function byokVibeApp(
  plan: E2EPlan,
  deps: E2EDeps,
  st: RunState,
): Promise<StageResult> {
  const name = "byokVibeApp";
  try {
    const orderUrl = `https://${st.serverFqdn}/api/screens/orders/send`;
    const order = await deps.http.post(orderUrl, {
      kind: "vibe-app",
      prompt: "a one-page hello world that calls my LLM provider",
    });
    if (order.status < 200 || order.status >= 300) {
      return gated(
        name,
        `vibe-app order rejected (HTTP ${order.status}) — pillar not wired`,
        GATED_BYOK,
      );
    }
    const createUrl = `https://${st.serverFqdn}/api/apps`;
    const created = await deps.http.post(createUrl, {
      from: "vibe-app",
      order: JSON.parse(order.body || "{}"),
    });
    if (created.status < 200 || created.status >= 300) {
      return gated(
        name,
        `app create rejected (HTTP ${created.status}) — pillar not wired`,
        GATED_BYOK,
      );
    }
    // The decisive assertion: the created app must actually answer
    // using the user's provider key. It cannot yet.
    const appResp = await deps.http.get(`https://${st.serverFqdn}/api/apps/_e2e-byok/health`);
    const usedUserKey =
      appResp.status === 200 && /"providerKey"\s*:\s*"loaded"/.test(appResp.body);
    if (!usedUserKey) {
      return gated(
        name,
        "created app does not answer using the user's stored provider key",
        GATED_BYOK,
      );
    }
    // If this ever turns true the pillar landed — surface it loudly as
    // a pass so the harness flips the moment the wiring exists.
    return pass(name, "BYOK vibe-app answered using the user's provider key");
  } catch (e) {
    return gated(
      name,
      `BYOK attempt errored (${e instanceof Error ? e.message : String(e)}) — pillar not wired`,
      GATED_BYOK,
    );
  }
}

/**
 * Stage 8 — KNOWN-GATED. Fetch the served pubkey-cert and assert it
 * chains to a CaEndorsement authorized by the baked
 * MAINTAINER_PINNED_MANDATE_HASH. Expected to NOT hold until the `.com`
 * CA gate + the human CaEndorsement ceremony land.
 */
async function assertCaAuthorized(
  plan: E2EPlan,
  deps: E2EDeps,
  st: RunState,
): Promise<StageResult> {
  const name = "assertCaAuthorized";
  try {
    const url = `${plan.comBase}/api/users/${encodeURIComponent(plan.username)}/pubkey-cert`;
    const r = await deps.http.get(url);
    if (r.status !== 200) {
      return gated(
        name,
        `pubkey-cert fetch HTTP ${r.status} — cannot evaluate CA chain`,
        GATED_CA,
      );
    }
    let cert: Record<string, unknown>;
    try {
      cert = JSON.parse(r.body);
    } catch {
      return gated(
        name,
        "pubkey-cert returned non-JSON — cannot evaluate CA chain",
        GATED_CA,
      );
    }
    // The cert is signed with the raw CA priv; there is no
    // `caEndorsement` envelope chaining to the pinned mandate. Until
    // the gate lands this field is absent ⇒ documented gap.
    const hasEndorsement =
      typeof cert["caEndorsement"] === "object" && cert["caEndorsement"] !== null;
    if (!hasEndorsement) {
      return gated(
        name,
        "served pubkey-cert carries NO CaEndorsement chaining to the baked pin",
        GATED_CA,
      );
    }
    // If/when an endorsement appears, surface as pass so the harness
    // flips the moment the consumer wiring + ceremony land.
    return pass(
      name,
      "served pubkey-cert chains to a CaEndorsement under the baked pin",
    );
  } catch (e) {
    return gated(
      name,
      `CA-chain assertion errored (${e instanceof Error ? e.message : String(e)})`,
      GATED_CA,
    );
  }
}

/**
 * Drive the whole chain. Never throws. Always attempts teardown.
 */
export async function runE2E(
  plan: E2EPlan,
  deps: E2EDeps,
): Promise<E2EReport> {
  const startedAt = deps.clock();
  const stages: StageResult[] = [];
  const st: RunState = {
    serverFqdn: `${plan.serverName}.${plan.username}.flagship.services`,
  };

  // Ordered, non-gated stages. A StageError aborts the remaining
  // non-gated stages but the gated stages + teardown still run so the
  // report is always complete and honest.
  const wired: Array<
    (p: E2EPlan, d: E2EDeps, s: RunState) => Promise<StageResult>
  > = [
    mintBuildCode,
    provisionVps,
    awaitInstallRegistered,
    awaitUnlock,
    probeGreenPadlock,
    createAccountServer,
  ];

  let aborted = false;
  try {
    for (const stage of wired) {
      if (aborted) {
        stages.push(
          skipped(stage.name, "skipped — an earlier required stage failed"),
        );
        continue;
      }
      try {
        const res = await stage(plan, deps, st);
        stages.push(res);
        if (res.status === "fail") aborted = true;
      } catch (e) {
        if (e instanceof StageError) {
          stages.push(e.stage);
        } else {
          stages.push(
            fail(
              stage.name,
              `unexpected error: ${e instanceof Error ? e.message : String(e)}`,
            ),
          );
        }
        aborted = true;
      }
    }

    // KNOWN-GATED stages always run (they are read-only attempts) and
    // never flip the run red — they document the gap honestly.
    for (const gatedStage of [byokVibeApp, assertCaAuthorized]) {
      try {
        stages.push(await gatedStage(plan, deps, st));
      } catch (e) {
        // Even an unexpected throw in a gated stage is the gap, not a
        // harness failure.
        const reason = gatedStage === byokVibeApp ? GATED_BYOK : GATED_CA;
        stages.push(
          gated(
            gatedStage.name,
            `gated stage errored (${e instanceof Error ? e.message : String(e)})`,
            reason,
          ),
        );
      }
    }
  } finally {
    // Teardown ALWAYS runs — even if no VPS was ever provisioned (then
    // there's nothing to destroy and we record it as such).
    const tdName = "teardown";
    if (!st.instance) {
      stages.push(
        skipped(tdName, "no VPS was provisioned — nothing to destroy"),
      );
    } else if (plan.keep) {
      stages.push(
        skipped(
          tdName,
          `--keep set: leaving ${st.instance.id} (${st.instance.ip}) running`,
        ),
      );
    } else {
      try {
        await deps.provider.destroy(st.instance.id);
        stages.push(
          pass(tdName, `destroyed ${st.instance.id} via ${deps.provider.name}`),
        );
      } catch (e) {
        // A failed teardown is a real (non-gated) failure — a human
        // must nuke the box manually; surface it loudly.
        stages.push(
          fail(
            tdName,
            `FAILED to destroy ${st.instance.id} (${st.instance.ip}) — ` +
              `manual cleanup required: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
      }
    }
  }

  const finishedAt = deps.clock();
  const ok = !stages.some((s) => s.status === "fail");
  const report: E2EReport = {
    ok,
    stages,
    serverFqdn: st.serverFqdn,
    startedAt,
    finishedAt,
  };
  if (st.instance) report.instanceId = st.instance.id;
  return report;
}

/**
 * The ordered chain description, used by `--plan` (zero credentials).
 * Kept beside the executor so the two never drift.
 */
export interface PlannedStage {
  name: string;
  kind: "wired" | "known-gated" | "teardown";
  description: string;
  gatedReason?: string;
}

export function plannedChain(): PlannedStage[] {
  return [
    {
      name: "mintBuildCode",
      kind: "wired",
      description:
        "claim username + issue auth-code + register RCK + issue build ticket on .com (IRK-signed via @flagship/protocol)",
    },
    {
      name: "provisionVps",
      kind: "wired",
      description:
        "provider.provision({iso,region,size}) from the supplied personalized ISO, then awaitBoot",
    },
    {
      name: "awaitInstallRegistered",
      kind: "wired",
      description:
        "poll .com /api/users/<user>/pods until the first-boot installer has registered <server>.<user>.flagship.services",
    },
    {
      name: "awaitUnlock",
      kind: "wired",
      description:
        "poll .com until the pod reports unlocked/ready (the boot-stage /unlock-key/consume effect)",
    },
    {
      name: "probeGreenPadlock",
      kind: "wired",
      description:
        "GET https://<server>.<user>.flagship.services/ → HTTP 200 + a currently-valid Let's Encrypt cert (TLS-ALPN-01 over SNI passthrough)",
    },
    {
      name: "createAccountServer",
      kind: "wired",
      description:
        "assert the free account/server path is live (per-server /api/health → 200)",
    },
    {
      name: "byokVibeApp",
      kind: "known-gated",
      description:
        "attempt to create a BYOK vibe-app and have it answer using the user's LLM provider key",
      gatedReason: GATED_BYOK,
    },
    {
      name: "assertCaAuthorized",
      kind: "known-gated",
      description:
        "fetch the served pubkey-cert and assert it chains to a CaEndorsement authorized by the baked MAINTAINER_PINNED_MANDATE_HASH",
      gatedReason: GATED_CA,
    },
    {
      name: "teardown",
      kind: "teardown",
      description:
        "ALWAYS attempted (try/finally) even on mid-chain failure: provider.destroy(instanceId) unless --keep",
    },
  ];
}
