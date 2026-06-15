// Owner diagnostics — read the box's flagship-daemon systemd journal.
//
// Same security shape as lib/lockAndPower.js: an IRK-signed envelope POSTed
// DIRECTLY to the user's pod (NOT the .com relay), verified by the daemon
// against its config-pinned owner IRK before it returns any logs. .com never
// sees the request or the journal. Canonical bytes mirror
// @flagship/protocol's canonicalJournalRequest byte-for-byte.

export const TAG_JOURNAL_READ = "flagship/journal-read/v1";

/** Units the daemon allows + the default. Mirrors journalHttp.ts. */
export const JOURNAL_UNITS = ["flagship-daemon", "flagship-data-services"];
export const JOURNAL_DEFAULT_UNIT = "flagship-daemon";
export const JOURNAL_DEFAULT_LINES = 200;
export const JOURNAL_MAX_LINES = 500;

function defaultBytesToHex(b) {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function err(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function podBase(baseUrl) {
  const b = String(baseUrl || "").replace(/\/+$/, "");
  if (!/^https:\/\//.test(b)) throw err("pod baseUrl must be https://", "400");
  return b;
}

/** flagship/journal-read/v1|<serverId>|<unit>|<lines>|<issuedAt> */
export function canonicalJournalBytes({ serverId, unit, lines, issuedAt }) {
  if (typeof unit !== "string" || unit.includes("|")) {
    throw err(`invalid journal unit: ${String(unit)}`, "400");
  }
  return new TextEncoder().encode([TAG_JOURNAL_READ, serverId, unit, String(lines), String(issuedAt)].join("|"));
}

/**
 * IRK-sign + POST a journal-read request to the pod; resolve with the lines.
 *
 * @param {object} args
 * @param {string} args.baseUrl  the pod base URL (https://<server>.<user>.flagship.services)
 * @param {string} [args.unit]   systemd unit (default flagship-daemon; must be allowlisted)
 * @param {number} [args.lines]  trailing lines to fetch (clamped to JOURNAL_MAX_LINES)
 * @param {Uint8Array} args.umk
 * @param {(umk: Uint8Array, bytes: Uint8Array) => Promise<Uint8Array>} args.signWithIrk
 * @param {{ fetch?, bytesToHex?, now? }} [deps]
 * @returns {Promise<{ ok: true, unit: string, lines: string[] }>}
 */
export async function fetchJournal(args, deps = {}) {
  const { baseUrl, umk, signWithIrk } = args;
  if (!umk || typeof signWithIrk !== "function") throw err("unlock the webapp first", "400");
  const unit = args.unit || JOURNAL_DEFAULT_UNIT;
  let lines = Number(args.lines ?? JOURNAL_DEFAULT_LINES);
  if (!Number.isFinite(lines)) lines = JOURNAL_DEFAULT_LINES;
  lines = Math.max(1, Math.min(JOURNAL_MAX_LINES, Math.floor(lines)));
  const base = podBase(baseUrl);
  const serverId = new URL(base).host;
  const issuedAt = (deps.now || Date.now)();
  const toHex = deps.bytesToHex || defaultBytesToHex;
  const f = deps.fetch || fetch;
  const sig = await signWithIrk(umk, canonicalJournalBytes({ serverId, unit, lines, issuedAt }));
  const request = { serverId, unit, lines, issuedAt };
  let resp;
  try {
    resp = await f(`${base}/api/journal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request, signature: toHex(sig) }),
    });
  } catch {
    throw err("could not reach the server", "network");
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw err(`request failed (${resp.status}): ${text}`.trim(), String(resp.status));
  }
  const body = await resp.json().catch(() => ({}));
  return { ok: true, unit: body.unit ?? unit, lines: Array.isArray(body.lines) ? body.lines : [] };
}
