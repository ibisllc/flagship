// W10 — per-app environment-variable KV editor.
//
// Mirrors the iOS/Android ServiceEnvScreen. Routes:
//   GET    /api/screens/services/<appId>/env         → list NAMES (no values)
//   POST   /api/screens/services/<appId>/env/set     → set { name, value }
//   POST   /api/screens/services/<appId>/env/unset   → unset { name }
//
// The value is typed in the form, signed under the owner's IRK, and
// POSTed once over the daemon's TLS. The browser does NOT save the
// value (no localStorage, no in-flight echo) — the value field is
// cleared as soon as the POST resolves.

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError } from "../lib/api.js";
import { getSession } from "../lib/state.js";
import { signWithIrk, bytesToHex } from "../keystore.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";

registerView("view-service-env");

let currentAppId = null;
let currentCreator = null;
let currentSlug = null;
let currentServerFqdn = null;

export async function enterServiceEnv(appId, creator, slug, serverFqdn, prefillName) {
  currentAppId = appId;
  currentCreator = creator;
  currentSlug = slug;
  currentServerFqdn = serverFqdn;
  show("view-service-env");
  await reload();
  // Prefill the NAME field (never a value) when a caller knows which env var
  // is needed — e.g. a marketplace install of an app that requires an LLM key
  // sends the owner here with the expected name ready so they just paste the
  // key. The value field stays empty; the owner types the secret.
  if (prefillName) {
    const nameEl = $("service-env-name");
    if (nameEl) {
      nameEl.value = prefillName;
      $("service-env-value")?.focus();
    }
  }
}

export function initServiceEnvView() {
  $("service-env-back")?.addEventListener("click", () => {
    // Drop any typed value before returning so a back-navigation
    // doesn't strand a secret in the DOM.
    const valueEl = $("service-env-value");
    if (valueEl) valueEl.value = "";
    show("view-service-detail");
  });
  $("service-env-save")?.addEventListener("click", submit);
}

async function reload() {
  const root = $("service-env-list");
  if (!root) return;
  root.innerHTML = '<div class="card placeholder">Loading…</div>';
  try {
    const body = await screensFetch(
      `/api/screens/services/${encodeURIComponent(currentAppId)}/env`,
    );
    renderList(body.names ?? []);
  } catch (e) {
    if (e instanceof ScreensError) {
      root.innerHTML = `<div class="card err-text">${escapeHtml(e.message)}</div>`;
    } else {
      root.innerHTML = `<div class="card err-text">${escapeHtml(String(e))}</div>`;
    }
  }
}

function renderList(names) {
  const root = $("service-env-list");
  if (!root) return;
  if (names.length === 0) {
    root.innerHTML = '<div class="card placeholder">No env vars set yet.</div>';
    return;
  }
  root.innerHTML = names
    .map(
      (n) => `
      <div class="card service-env-row" data-name="${escapeHtml(n)}">
        <div class="row">
          <span class="value mono">${escapeHtml(n)}</span>
          <button class="secondary danger service-env-remove" data-name="${escapeHtml(n)}">Remove</button>
        </div>
      </div>
    `,
    )
    .join("");
  for (const btn of root.querySelectorAll(".service-env-remove")) {
    btn.addEventListener("click", () => unset(btn.dataset.name));
  }
}

/**
 * Canonical-bytes for SetServiceEnvRequest. Mirrors
 * `canonicalSetServiceEnv` in @flagship/protocol/auth.ts:
 *
 *   "flagship/set-service-env/v1"
 *      | serverId | creator | slug | <pairCount>
 *      | <sortedKey>=<value>... | issuedAt
 */
function canonicalSetServiceEnv(serverId, creator, slug, env, issuedAt) {
  const pairs = Object.keys(env)
    .sort()
    .map((k) => `${k}=${env[k]}`);
  const s = [
    "flagship/set-service-env/v1",
    serverId,
    creator,
    slug,
    String(pairs.length),
    ...pairs,
    String(issuedAt),
  ].join("|");
  return new TextEncoder().encode(s);
}

async function submit() {
  const nameEl = $("service-env-name");
  const valueEl = $("service-env-value");
  const name = nameEl.value.trim();
  const value = valueEl.value;
  if (!name) return toast("name required", "err");
  if (!value) return toast("value required", "err");
  const session = getSession();
  if (!session?.umk) return toast("Sign in first.", "err");

  const issuedAt = Date.now();
  const envelope = {
    serverId: currentServerFqdn,
    creator: currentCreator,
    slug: currentSlug,
    env: { [name]: value },
    issuedAt,
  };
  let signature;
  try {
    const canon = canonicalSetServiceEnv(
      envelope.serverId,
      envelope.creator,
      envelope.slug,
      envelope.env,
      envelope.issuedAt,
    );
    const sig = await signWithIrk(session.umk, canon);
    signature = bytesToHex(sig);
  } catch (e) {
    return toast(`Sign failed: ${e.message ?? e}`, "err");
  }

  try {
    await screensFetch(
      `/api/screens/services/${encodeURIComponent(currentAppId)}/env/set`,
      {
        method: "POST",
        body: JSON.stringify({ name, value, request: envelope, signature }),
      },
    );
  } catch (e) {
    return toast(
      e instanceof ScreensError ? e.message : String(e),
      "err",
    );
  }
  // Drop the value from the DOM immediately on success — a screenshot
  // / dev-tools inspection of the form post-submit shouldn't leak it.
  nameEl.value = "";
  valueEl.value = "";
  toast("Saved");
  await reload();
}

async function unset(name) {
  if (!name) return;
  if (!confirm(`Remove "${name}"?`)) return;
  const session = getSession();
  if (!session?.umk) return toast("Sign in first.", "err");

  const issuedAt = Date.now();
  // Owner's intent: env becomes empty (full-replace semantics on
  // setEnv mean the daemon will accept this as "drop everything we
  // had"). The user is asserting the new state lacks the named key.
  const envelope = {
    serverId: currentServerFqdn,
    creator: currentCreator,
    slug: currentSlug,
    env: {},
    issuedAt,
  };
  let signature;
  try {
    const canon = canonicalSetServiceEnv(
      envelope.serverId,
      envelope.creator,
      envelope.slug,
      envelope.env,
      envelope.issuedAt,
    );
    const sig = await signWithIrk(session.umk, canon);
    signature = bytesToHex(sig);
  } catch (e) {
    return toast(`Sign failed: ${e.message ?? e}`, "err");
  }
  try {
    await screensFetch(
      `/api/screens/services/${encodeURIComponent(currentAppId)}/env/unset`,
      {
        method: "POST",
        body: JSON.stringify({ name, request: envelope, signature }),
      },
    );
  } catch (e) {
    return toast(
      e instanceof ScreensError ? e.message : String(e),
      "err",
    );
  }
  toast(`Removed ${name}`);
  await reload();
}

// Exposed so service-detail.js can drive this from the per-app
// detail view's "Configure environment" entry point.
export { canonicalSetServiceEnv };
