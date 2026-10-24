// Settings → Quantum-safe protection on the webapp (architecture v2 milestone 4,
// docs/architecture-v2/pq-suites.md §13.6). VIEW ONLY: a browser holds no post-quantum key
// (the keyless-web rule), so it can show where each server stands but cannot turn strict on
// or off; the owner does that from the Flagship app on an admin phone or tablet.
//
// Each server's chain is replayed here with the gate under the admin root this browser holds
// (lib/assurancePolicy.js, lib/pqBinding.js); a state the browser could not verify is shown as
// flagshipserver.com's report, labelled as such. On a strict server each app's own browser
// answer (its `<server>:<service id>` scope) is shown the same way; it is set from the app.

import { $, registerView, show } from "../lib/router.js";
import { getSession } from "../lib/state.js";
import { escapeHtml } from "../lib/util.js";
import { controlApex } from "../lib/apex.js";
import { accountReadFetch } from "../lib/accountRead.js";
import { replayPolicyChain, strictInForce, TAG_ASSURANCE_POLICY } from "../lib/assurancePolicy.js";
import { verifyCriticalSignature, verifyPqKeyBinding } from "../lib/pqBinding.js";
import { adminRootPubHex } from "../keystore.js";

registerView("view-quantum-safety");

export const BROWSER_LOSS = "browser-without-pq-authentication";
export const WEB_CANNOT_CHANGE =
  "This browser holds no post-quantum key, so it can't turn strict protection on or off. Use the Flagship app on an admin phone or tablet.";

/** What a row says about one server's policy. Exported for tests. */
export function describePolicy(state, headLoss, verified) {
  const strict = !!state && strictInForce(state);
  const source = verified ? "Checked on this browser." : "As reported by flagshipserver.com; this browser could not check it.";
  if (!strict) return { strict, line: `Compatibility. ${source}` };
  const browsers = (headLoss ?? []).includes(BROWSER_LOSS)
    ? "Browsers can still reach it (post-quantum key exchange, classical certificate)."
    : "Only the Flagship app reaches it; this browser is refused.";
  return { strict, line: `Strict. ${browsers} ${source}` };
}

/** Replays a served chain under the admin root's verified binding (null when none). */
export function replayServed(scope, chain, adminRootHex, adminBinding) {
  let headLoss = [];
  const state = replayPolicyChain(scope, chain, {
    prepared: () => true,
    check: (msg, c, sig, before) => {
      const signerActive = c.signerKind === "admin-root" && c.signerKeyId === adminRootHex;
      try {
        const v = verifyCriticalSignature({ message: msg, expectedPurpose: TAG_ASSURANCE_POLICY, envelope: sig, signerEd25519PubHex: c.signerKeyId, binding: signerActive ? adminBinding : null, policy: before });
        if (v.suite === c.suite) headLoss = c.acknowledgedLoss ?? [];
        return { suiteVerified: v.suite === c.suite, signerActive };
      } catch {
        return { suiteVerified: false, signerActive };
      }
    },
  });
  return { state, headLoss };
}

/** The apps a server reports for itself on /pods (it runs or leads them). Exported for tests. */
export function appIdsOf(pod) {
  const ids = Array.isArray(pod?.runsServices) ? pod.runsServices : Array.isArray(pod?.leadsServices) ? pod.leadsServices : [];
  return [...new Set(ids.filter((x) => typeof x === "string" && /^[a-z0-9-]{1,80}$/.test(x)))].sort();
}

/** One app's own scope (`<server>:<service id>`): strict there means browsers are refused. Exported for tests. */
export function describeApp(state, verified) {
  const source = verified ? "" : " (as reported by flagshipserver.com)";
  return state && strictInForce(state) ? `only the Flagship app; browsers are refused${source}` : `browsers may reach it${source}`;
}

async function appLines(base, user, fqdn, ids, rootHex, adminBinding) {
  const out = [];
  for (const id of ids) {
    const scope = { kind: "service", id: `${fqdn}:${id}` };
    const served = await getJson(`${base}/api/accounts/${encodeURIComponent(user)}/assurance-policy/service/${encodeURIComponent(scope.id)}`).catch(() => null);
    const chain = Array.isArray(served?.chain) ? served.chain : [];
    const mine = replayServed(scope, chain, rootHex, adminBinding);
    const verified = chain.length === 0 || mine.state.generation === chain.length;
    out.push({ id, line: describeApp(verified ? mine.state : served?.state, verified) });
  }
  return out;
}

async function getJson(url) {
  const r = await accountReadFetch(url, { cache: "no-store" });
  return r.ok ? r.json() : null;
}

async function render() {
  const host = $("quantum-safety-content");
  if (!host) return;
  const s = getSession();
  const user = (s?.username ?? "").toLowerCase();
  if (!user) {
    host.innerHTML = `<p class="note">Sign in first.</p>`;
    return;
  }
  host.innerHTML = `<p class="note">${escapeHtml(WEB_CANNOT_CHANGE)}</p><p class="note">These protections are new and pending an external review.</p><div id="qs-rows"><p class="note">Loading…</p></div>`;
  const base = controlApex();
  const rootHex = s?.adminRootSeed ? (await adminRootPubHex(s.adminRootSeed)).toLowerCase() : null;
  const grants = await getJson(`${base}/api/users/${encodeURIComponent(user)}/device-grants`).catch(() => null);
  let adminBinding = null;
  if (rootHex && grants?.pqKeyBindings?.adminRoot) {
    try {
      adminBinding = verifyPqKeyBinding(grants.pqKeyBindings.adminRoot, { role: "admin-root", subjectId: user, ed25519PubHex: rootHex, now: Date.now() });
    } catch {
      adminBinding = null;
    }
  }
  const pods = (await getJson(`${base}/api/users/${encodeURIComponent(user)}/pods`).catch(() => null))?.pods ?? [];
  const rows = [];
  for (const p of pods) {
    const fqdn = String(p.serverDomain ?? "").toLowerCase();
    if (!fqdn || p.revokedAt) continue;
    const scope = { kind: "installation", id: fqdn };
    const served = await getJson(`${base}/api/accounts/${encodeURIComponent(user)}/assurance-policy/installation/${encodeURIComponent(fqdn)}`).catch(() => null);
    const chain = Array.isArray(served?.chain) ? served.chain : [];
    const mine = replayServed(scope, chain, rootHex, adminBinding);
    const verified = chain.length === 0 || mine.state.generation === chain.length;
    const d = verified ? describePolicy(mine.state, mine.headLoss, true) : describePolicy(served?.state, chain.at(-1)?.change?.acknowledgedLoss, false);
    const apps = d.strict ? await appLines(base, user, fqdn, appIdsOf(p), rootHex, adminBinding) : [];
    const appHtml = apps.length
      ? `<p class="note">Apps on this server (set from the Flagship app):</p><ul class="qs-apps">${apps.map((a) => `<li data-service="${escapeHtml(a.id)}">${escapeHtml(a.id)}: ${escapeHtml(a.line)}</li>`).join("")}</ul>`
      : "";
    rows.push(`<div class="fs-card qs-row" data-fqdn="${escapeHtml(fqdn)}"><p class="fs-row-title">${escapeHtml(p.name ?? fqdn)}</p><p class="note">${escapeHtml(d.line)}</p>${appHtml}</div>`);
  }
  $("qs-rows").innerHTML = rows.length ? rows.join("") : `<p class="note">You have no servers yet.</p>`;
}

export function initQuantumSafetyView() {
  document.addEventListener("flagship:view-shown", (ev) => {
    if (ev.detail?.id === "view-quantum-safety") render().catch(() => {});
  });
  $("quantum-safety-back")?.addEventListener("click", () => show("view-settings-tab"));
}

export { render as renderQuantumSafety };
