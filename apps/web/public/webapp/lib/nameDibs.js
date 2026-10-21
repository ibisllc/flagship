// Name dibs — claim the account name matching a .com you control
// (docs/naming-recovery-and-name-change.md §7).
//
// While the one-year window is open (GET /api/name-dibs/window), a name whose
// `<name>.com` is registered is held for that domain's holder. The holder
// proves control by publishing a challenge `.com` returns (DNS TXT at
// `_flagship-claim.<name>.com`, or a file at
// `https://<name>.com/.well-known/flagship-claim`), then asks `.com` to verify.
// Both requests are IRK-signed; the challenge is bound to this account's IRK so
// nobody else can reuse a published record.
//
// Canonical bytes mirror packages/protocol/src/nameDibs.ts byte-for-byte and are
// pinned by the shared vectors (apps/web/tests/canonicalBytesVectors.test.ts).

import { controlApex } from "./apex.js";
import { announcementCard } from "./uikit.js";
import { flagIcon } from "./icons.js";
import { get as profileGet, set as profileSet } from "./profilesStore.js";

const TAG_INITIATE = "flagship/name-dibs-initiate/v1";
const TAG_VERIFY = "flagship/name-dibs-verify/v1";
const enc = (s) => new TextEncoder().encode(s);

export const DIBS_BANNER_ID = "home-dibs-banner";
export const DIBS_PAGE_URL = "https://flagshipserver.com/dibs";

/** @param {{username:string,name:string,irkPubHex:string,issuedAt:number}} r */
export function canonicalDibsInitiateBytes({ username, name, irkPubHex, issuedAt }) {
  return enc([TAG_INITIATE, username, name, irkPubHex, issuedAt].join("|"));
}

/** @param {{username:string,name:string,nonce:string,issuedAt:number}} r */
export function canonicalDibsVerifyBytes({ username, name, nonce, issuedAt }) {
  return enc([TAG_VERIFY, username, name, nonce, issuedAt].join("|"));
}

function toHex(b) {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function err(message, status) {
  const e = new Error(message);
  if (status) e.status = status;
  return e;
}

/** `GET /api/name-dibs/window` → `{configured, open, start, end, scope, priceUsd}`. */
export async function fetchDibsWindow(deps = {}) {
  const f = deps.fetch || fetch;
  const origin = deps.origin || controlApex();
  const resp = await f(`${origin}/api/name-dibs/window`);
  if (!resp.ok) throw err(`HTTP ${resp.status}`, resp.status);
  return resp.json();
}

async function post(path, payload, deps) {
  const f = deps.fetch || fetch;
  const origin = deps.origin || controlApex();
  let resp;
  try {
    resp = await f(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    throw err(`network error: ${(e && e.message) || e}`);
  }
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw err((body && body.error) || `HTTP ${resp.status}`, resp.status);
  return body;
}

/**
 * Start a claim on `<name>.com`. Returns `.com`'s answer: the nonce, the
 * `record` to publish, where to publish it, and when the claim expires.
 *
 * @param {{username:string,name:string,umk:Uint8Array,irkPubHex:string,signWithIrk:Function}} args
 */
export async function startDibsClaim(args, deps = {}) {
  const request = {
    username: String(args.username).toLowerCase(),
    name: String(args.name).trim().toLowerCase(),
    irkPubHex: String(args.irkPubHex).toLowerCase(),
    issuedAt: (deps.now || Date.now)(),
  };
  const sig = await args.signWithIrk(args.umk, canonicalDibsInitiateBytes(request));
  return post("/api/name-dibs/initiate", { request, signature: toHex(sig) }, deps);
}

/**
 * Ask `.com` to look for the published proof. Resolves `{verified, method}`;
 * rejects with `.com`'s message when the proof isn't visible yet.
 *
 * @param {{username:string,name:string,nonce:string,umk:Uint8Array,signWithIrk:Function}} args
 */
export async function verifyDibsClaim(args, deps = {}) {
  const request = {
    username: String(args.username).toLowerCase(),
    name: String(args.name).trim().toLowerCase(),
    nonce: String(args.nonce).toLowerCase(),
    issuedAt: (deps.now || Date.now)(),
  };
  const sig = await args.signWithIrk(args.umk, canonicalDibsVerifyBytes(request));
  return post("/api/name-dibs/verify", { request, signature: toHex(sig) }, deps);
}

/** Pure: show the Home dibs notice iff the window is open and this device
 *  hasn't dismissed it. */
export function shouldShowDibsBanner({ window: w, dismissed } = {}) {
  return !!(w && w.open) && dismissed !== "true";
}

export function formatDibsDate(ms) {
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

/**
 * Render (or remove) the dismissible "Own a .com?" notice above the server
 * list. Fetches the window once per call; renders nothing when the window is
 * closed or the lookup fails. `onClaim` opens the in-app claim flow.
 */
export async function renderDibsBanner({ onClaim, deps } = {}) {
  let dismissed = null;
  try {
    dismissed = profileGet("dibsBannerDismissed");
  } catch {
    /* localStorage disabled — treat as not dismissed */
  }
  if (dismissed === "true") {
    document.getElementById(DIBS_BANNER_ID)?.remove();
    return;
  }
  let w = null;
  try {
    w = await fetchDibsWindow(deps);
  } catch {
    return;
  }
  const existing = document.getElementById(DIBS_BANNER_ID);
  if (!shouldShowDibsBanner({ window: w, dismissed })) {
    existing?.remove();
    return;
  }
  if (existing) return;

  const host = document.createElement("div");
  host.id = DIBS_BANNER_ID;
  host.innerHTML = announcementCard({
    icon: flagIcon,
    title: "Own a .com? Claim the matching name",
    message: `Until ${formatDibsDate(w.end)}, a name that matches a registered .com is held for whoever controls that domain.`,
    ctaLabel: "Claim your .com name",
    dismissible: true,
    tone: "teal",
  });
  const list = document.getElementById("servers-list");
  list?.parentNode?.insertBefore(host, list);
  host.querySelector("[data-ann-cta]")?.addEventListener("click", () => {
    if (typeof onClaim === "function") onClaim();
    else window.open(DIBS_PAGE_URL, "_blank", "noopener");
  });
  host.querySelector("[data-ann-dismiss]")?.addEventListener("click", () => {
    try {
      profileSet("dibsBannerDismissed", "true");
    } catch {
      /* worst case the notice shows again next time */
    }
    document.getElementById(DIBS_BANNER_ID)?.remove();
  });
}
