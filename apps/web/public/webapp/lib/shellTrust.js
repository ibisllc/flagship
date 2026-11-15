// A verifiable webapp shell (docs/webapp-key-custody.md item 5).
//
// Each deploy carries /shell-manifest.json: the shell version and the SHA-256 of every file the
// service worker installs (built by scripts/webapp-shell.mjs from the SW's own list). A release
// signs that manifest OFFLINE with the ca-track maintainer key, the same key and the same PQ half
// as a security notice, never with anything `.com` or Cloudflare holds:
//
//   flagship/webapp-shell/v1|<shellVersion>|<manifestSha256>|<issuedAt>|<signedBy>
//
// /shell-signature.json = { v, shellVersion, manifestSha256, issuedAt, signedBy, signature,
// pq?: { binding, signature }, mandates }. The signer must be the ca-track authority found by
// walking the mandates forward from the baked pin (lib/maintainerTrust.js), and once
// RELEASE_PQ_KEY_IDS names a key the PQ half is required too.
//
// Who checks what:
// - The new service worker installs only files whose hashes match the manifest of its own
//   version (service-worker.js); a mismatch fails the install and the old shell stays.
// - The running page checks the signature before it offers an update (lib/swRegister.js): an
//   unsigned one is never activated from the page while SHELL_SIGNATURE_REQUIRED is on, and the
//   page says "This version of the webapp isn't signed by Flagship."
// - Settings shows whether the running shell is signed, and lib/keyCustody.js refuses to open a
//   signing key under an unsigned shell while signatures are required.
// Limits: a browser fetches service-worker.js itself; someone who controls a deploy can still
// serve a new worker that skips these checks, and it takes over once every tab is closed. The
// signature makes that attack visible to every page still on a signed shell, and to the
// verifying browser extension the doc proposes for cautious organisations.

import { currentAuthority, edVerify, verifyMandateChainFromPin } from "./maintainerTrust.js";
import { hybridVerify, verifyPqKeyBinding } from "./pqBinding.js";
import { RELEASE_PQ_KEY_IDS } from "./releasePqPin.js";
import { releaseKeyId } from "./securityNotice.js";
import { BAKED_PIN } from "./serverTrust.js";
import { WEB_BUILD } from "./buildInfo.js";

export const TAG_WEBAPP_SHELL = "flagship/webapp-shell/v1";
export const SHELL_MANIFEST_PATH = "/shell-manifest.json";
export const SHELL_SIGNATURE_PATH = "/shell-signature.json";

// Off until the owner signs the first shell at a release (the signing step is in
// docs/webapp-key-custody.md "Signing a release shell"). Turned on, an unsigned update is refused from the page.
// BEGIN SHELL_SIGNATURE_REQUIRED (owner)
export const SHELL_SIGNATURE_REQUIRED = false;
// END SHELL_SIGNATURE_REQUIRED

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const VERSION = /^v[0-9]{1,6}$/;

const hexOf = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(bytes) {
  return hexOf(await crypto.subtle.digest("SHA-256", bytes));
}

export function canonicalShellStatement(s, signedBy) {
  if (!VERSION.test(s.shellVersion ?? "") || !HEX64.test(s.manifestSha256 ?? "") || !Number.isSafeInteger(s.issuedAt) || s.issuedAt <= 0 || !HEX64.test(signedBy ?? "")) {
    throw Object.assign(new Error("shell statement"), { code: "malformed" });
  }
  return new TextEncoder().encode([TAG_WEBAPP_SHELL, s.shellVersion, s.manifestSha256, String(s.issuedAt), signedBy].join("|"));
}

/** Parses manifest bytes: `{ v: 1, shellVersion, files: { "/path": sha256 } }`, or null. */
export function parseShellManifest(bytes) {
  try {
    const m = JSON.parse(new TextDecoder().decode(bytes));
    if (m?.v !== 1 || !VERSION.test(m.shellVersion ?? "") || typeof m.files !== "object" || m.files === null) return null;
    for (const [p, h] of Object.entries(m.files)) if (!p.startsWith("/") || !HEX64.test(h)) return null;
    return m;
  } catch {
    return null;
  }
}

async function verifyPq(doc, bytes, pqKeyIds) {
  if (!doc.pq) return pqKeyIds.length ? "pq-missing" : null;
  const b = doc.pq.binding;
  try {
    if (pqKeyIds.length && !pqKeyIds.includes(await releaseKeyId(b.ed25519PubHex, b.mldsaPubHex))) return "pq-key-not-pinned";
    const vb = verifyPqKeyBinding(b, { role: "release-key", subjectId: "flagship-release", ed25519PubHex: doc.signedBy, now: Number.MAX_SAFE_INTEGER });
    const sig = Uint8Array.from(String(doc.pq.signature).match(/../g) ?? [], (h) => parseInt(h, 16));
    return hybridVerify(vb.hybridPublicKey, TAG_WEBAPP_SHELL, bytes, sig) ? null : "pq-signature-invalid";
  } catch {
    return "pq-signature-invalid";
  }
}

/**
 * Checks a signature document against the manifest bytes it should sign.
 * @returns {Promise<{ok: true, shellVersion: string, issuedAt: number} | {ok: false, reason: string}>}
 */
export async function verifyShellSignature(doc, manifestBytes, { pin = BAKED_PIN, pqKeyIds = RELEASE_PQ_KEY_IDS, now = Date.now() } = {}) {
  if (!doc || doc.v !== 1) return { ok: false, reason: "unsigned" };
  const manifest = parseShellManifest(manifestBytes);
  if (!manifest) return { ok: false, reason: "manifest" };
  let bytes;
  try {
    bytes = canonicalShellStatement(doc, doc.signedBy);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!HEX128.test(doc.signature ?? "")) return { ok: false, reason: "malformed" };
  if (doc.shellVersion !== manifest.shellVersion) return { ok: false, reason: "version" };
  if ((await sha256Hex(manifestBytes)) !== doc.manifestSha256) return { ok: false, reason: "manifest-digest" };
  let auth = null;
  try {
    auth = currentAuthority(await verifyMandateChainFromPin(pin, doc.mandates ?? []), now);
  } catch {
    auth = null;
  }
  if (!auth || auth.holder !== doc.signedBy) return { ok: false, reason: "unauthorized-signer" };
  if (!(await edVerify(doc.signature, bytes, doc.signedBy))) return { ok: false, reason: "signature-invalid" };
  const pq = await verifyPq(doc, bytes, pqKeyIds);
  if (pq) return { ok: false, reason: pq };
  return { ok: true, shellVersion: doc.shellVersion, issuedAt: doc.issuedAt };
}

async function fetchPair(fetchImpl, read) {
  const m = await read(SHELL_MANIFEST_PATH);
  if (!m) return { manifestBytes: null, doc: null };
  const s = await read(SHELL_SIGNATURE_PATH);
  let doc = null;
  if (s) {
    try {
      doc = JSON.parse(new TextDecoder().decode(s));
    } catch {
      doc = null;
    }
  }
  return { manifestBytes: m, doc };
}

/**
 * The deploy's shell (what a waiting service worker installed): verified or not, and its version.
 * `expectVersion` is the waiting worker's own SHELL_VERSION.
 * @returns {Promise<{signed: boolean, reason?: string, shellVersion?: string}>}
 */
export async function checkDeployedShell({ expectVersion = null, fetchImpl = fetch, now = Date.now(), pin, pqKeyIds } = {}) {
  const read = async (path) => {
    try {
      const r = await fetchImpl(path, { cache: "no-store" });
      return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
    } catch {
      return null;
    }
  };
  const { manifestBytes, doc } = await fetchPair(fetchImpl, read);
  if (!manifestBytes) return { signed: false, reason: "manifest" };
  const manifest = parseShellManifest(manifestBytes);
  if (expectVersion && manifest?.shellVersion !== expectVersion) return { signed: false, reason: "version", shellVersion: manifest?.shellVersion };
  const v = await verifyShellSignature(doc, manifestBytes, { now, ...(pin ? { pin } : {}), ...(pqKeyIds ? { pqKeyIds } : {}) });
  return v.ok ? { signed: true, shellVersion: v.shellVersion } : { signed: false, reason: v.reason, shellVersion: manifest?.shellVersion };
}

let runningStatus = null;

/** The running shell's status, from the copies the service worker cached with it (once per page). */
export async function runningShellStatus({ cachesImpl = typeof caches === "undefined" ? null : caches, cacheName = `flagship-webapp-shell-v${WEB_BUILD}` } = {}) {
  if (runningStatus) return runningStatus;
  if (!cachesImpl) return { signed: false, reason: "no-service-worker" };
  // This shell's own cache (an update waiting beside it has its own).
  let cache = null;
  try {
    cache = (await cachesImpl.has(cacheName)) ? await cachesImpl.open(cacheName) : null;
  } catch {
    cache = null;
  }
  if (!cache) return { signed: false, reason: "no-service-worker" };
  const read = async (path) => {
    try {
      const r = await cache.match(path);
      return r ? new Uint8Array(await r.arrayBuffer()) : null;
    } catch {
      return null;
    }
  };
  const { manifestBytes, doc } = await fetchPair(null, read);
  if (!manifestBytes) return (runningStatus = { signed: false, reason: "manifest" });
  const v = await verifyShellSignature(doc, manifestBytes);
  runningStatus = v.ok ? { signed: true, shellVersion: v.shellVersion } : { signed: false, reason: v.reason };
  return runningStatus;
}

/** Tests. */
export function _resetShellTrustForTests() {
  runningStatus = null;
}

/** Whether this page may open a signing key: always, unless signatures are required and this shell isn't signed. */
export async function shellAllowsSigning({ required = SHELL_SIGNATURE_REQUIRED, status = runningShellStatus } = {}) {
  if (!required) return true;
  return (await status()).signed === true;
}
