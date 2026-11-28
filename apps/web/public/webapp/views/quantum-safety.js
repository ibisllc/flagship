// Settings → Quantum-safe protection on the webapp (architecture v2 milestone 4,
// docs/architecture-v2/pq-suites.md §13.6). A browser whose admin key's ML-DSA half is the one on
// record (lib/keyCustody.js) turns strict on or off for a server, signed hybrid
// (lib/policySigning.js); any other browser only shows where each server stands. Returning to
// strict after a compatibility period stays on the phone (it needs re-entry evidence).
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

import { tr } from "../lib/i18n.js";
import { inlineConfirm } from "../lib/modal.js";
import { toast } from "../lib/toast.js";
import { LEAVING_STRICT_LOSS, compatibilityChange, policyRefusalText, policySignerProblem, signAndPostPolicyChange, strictChange } from "../lib/policySigning.js";
registerView("view-quantum-safety");

export const BROWSER_LOSS = "browser-without-pq-authentication";
export const BROWSER_CLASSICAL = tr("A browser reaches your servers with classical protection: quantum-safe servers allow browsers as a labelled exception. The Flagship app is quantum-safe.");
export const WEB_CAN_CHANGE = tr("This browser's admin key has its quantum-safe half on record, so it can turn strict protection on or off. Each change asks for your passkey.");
export const WEB_CANNOT_CHANGE =
  tr("This browser signs admin orders quantum-safe when its admin key's quantum-safe half is the one on record, but it can't turn strict protection on or off. Use the Flagship app on an admin phone or tablet.");

/** What a row says about one server's policy. Exported for tests. */
export function describePolicy(state, headLoss, verified) {
  const strict = !!state && strictInForce(state);
  const source = verified ? tr("Checked on this browser.") : tr("As reported by flagshipserver.com; this browser could not check it.");
  if (!strict) return { strict, line: tr("Compatibility. {0}", source) };
  const browsers = (headLoss ?? []).includes(BROWSER_LOSS)
    ? tr("Browsers can still reach it (post-quantum key exchange, classical certificate).")
    : tr("Only the Flagship app reaches it; this browser is refused.");
  return { strict, line: tr("Strict. {0} {1}", browsers, source) };
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
  const source = verified ? "" : tr(" (as reported by flagshipserver.com)");
  return state && strictInForce(state) ? tr("only the Flagship app; browsers are refused{0}", source) : tr("browsers may reach it{0}", source);
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
    host.innerHTML = `<p class="note">${tr("Sign in first.")}</p>`;
    return;
  }
  const canSign = policySignerProblem(s?.adminRootSeed) === null;
  host.innerHTML = `<p class="note">${escapeHtml(canSign ? WEB_CAN_CHANGE : WEB_CANNOT_CHANGE)}</p><p class="note">${tr("Every server is quantum-safe by default: it turns strict on the next time an admin phone or tablet opens the Flagship app, once every device and your recovery are ready.")}</p><p class="note">${escapeHtml(BROWSER_CLASSICAL)}</p><p class="note">${tr("These protections are new and pending an external review.")}</p><div id="qs-rows"><p class="note">${tr("Loading…")}</p></div>`;
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
  const signs = canSign && adminBinding && adminBinding.mldsaPubHex === s.adminRootSeed.mldsaPubHex;
  const states = new Map();
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
      ? `<p class="note">${tr("Apps on this server (set from the Flagship app):")}</p><ul class="qs-apps">${apps.map((a) => `<li data-service="${escapeHtml(a.id)}">${escapeHtml(a.id)}: ${escapeHtml(a.line)}</li>`).join("")}</ul>`
      : "";
    states.set(fqdn, { state: mine.state, name: p.name ?? fqdn });
    rows.push(`<div class="fs-card qs-row" data-fqdn="${escapeHtml(fqdn)}"><p class="fs-row-title">${escapeHtml(p.name ?? fqdn)}</p><p class="note">${escapeHtml(d.line)}</p>${appHtml}${signs && verified ? controlsFor(mine.state) : ""}</div>`);
  }
  $("qs-rows").innerHTML = rows.length ? rows.join("") : `<p class="note">${tr("You have no servers yet.")}</p>`;
  if (signs) bindControls(user, rootHex, states, s.adminRootSeed);
}

/** The buttons for one server's state. Exported for tests. */
export function controlsFor(state) {
  if (strictInForce(state)) return `<button class="secondary" data-qs-off>${tr("Turn off quantum-safe protection")}</button>`;
  if (state.enforcedEver) return `<p class="note">${tr("Turning strict on again needs a fresh check of every device, a rekey and a tested recovery. Do it from the Flagship app on an admin phone.")}</p>`;
  return `<p class="note">${tr("Can browsers still reach this server once it's strict?")}</p>
    <button data-qs-on="browsers">${tr("Turn on, browsers may reach it")}</button>
    <button data-qs-on="app-only">${tr("Turn on, only the Flagship app")}</button>`;
}

function bindControls(user, rootHex, states, key) {
  for (const row of document.querySelectorAll(".qs-row")) {
    const fqdn = row.dataset.fqdn;
    const held = states.get(fqdn);
    if (!held) continue;
    const scope = { kind: "installation", id: fqdn };
    const run = async (build, done) => {
      try {
        const code = await signAndPostPolicyChange(await build(), key);
        if (code === null) toast(done, "ok");
        else toast(policyRefusalText(code), "err");
      } catch (e) {
        toast(e?.userMessage ?? policyRefusalText(e?.code ?? "failed"), "err");
      }
      await render();
    };
    for (const b of row.querySelectorAll("[data-qs-on]")) {
      b.addEventListener("click", async () => {
        const browsersAllowed = b.dataset.qsOn === "browsers";
        const ok = await inlineConfirm({
          title: tr("Turn on quantum-safe protection for {0}?", held.name),
          message: browsersAllowed
            ? tr("Browsers can still reach it: a browser's connection uses post-quantum key exchange, but the server's identity is still proven with a classical certificate.")
            : tr("Only the Flagship app will reach it. This browser will be refused by this server."),
          okLabel: tr("Turn on"),
        });
        if (!ok) return;
        await run(
          () => strictChange({ account: user, scope, state: held.state, browsersAllowed, peers: [fqdn], signerKeyId: rootHex }),
          tr("Quantum-safe protection is on for {0}. It takes effect when the server next checks in, within 15 minutes.", held.name),
        );
      });
    }
    row.querySelector("[data-qs-off]")?.addEventListener("click", async () => {
      const ok = await inlineConfirm({
        title: tr("Turn off quantum-safe protection for {0}?", held.name),
        message: tr("Classical signatures and classical key exchange will be accepted again, and browsers can reach it. Turning strict on again later needs a fresh check of every device and your recovery."),
        okLabel: tr("Turn off"),
        danger: true,
      });
      if (!ok) return;
      await run(
        () => compatibilityChange({ account: user, scope, state: held.state, loss: LEAVING_STRICT_LOSS, peers: [fqdn], signerKeyId: rootHex }),
        tr("{0} is back to compatibility.", held.name),
      );
    });
  }
}

export function initQuantumSafetyView() {
  document.addEventListener("flagship:view-shown", (ev) => {
    if (ev.detail?.id === "view-quantum-safety") render().catch(() => {});
  });
  $("quantum-safety-back")?.addEventListener("click", () => show("view-settings-tab"));
}

export { render as renderQuantumSafety };
