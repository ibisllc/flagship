// A server's backup policy (docs/server-backup-and-clone.md, "Backup policy"):
// Phone-side, Peer-distributed or No backups, picked at create time (signed and
// carried beside the pairing order) and changed from the server page. Each
// policy sets a size limit on the server's app data that the box enforces.
//
//   flagship/backup-policy/v1|<serverDomain>|<phone|peer|none>|<phoneReserveBytes>|<issuedAt>
//
// Must pass packages/protocol/test-vectors/backup-policy/vectors.json.

export const TAG_BACKUP_POLICY = "flagship/backup-policy/v1";
export const BACKUP_POLICY_PATH = "/api/screens/backup-policy";
export const POLICIES = ["phone", "peer", "none"];
const GB = 1024 ** 3;
/** The webapp can't see the phone's free space: a sensible default reserve. */
export const DEFAULT_WEB_RESERVE_GB = 16;

export const POLICY_LABEL = {
  phone: "Phone-side backups",
  peer: "Peer-distributed backups",
  none: "No backups",
  unset: "Not chosen yet",
};

export const POLICY_TEXT = {
  phone:
    "Your server makes an encrypted backup every night and your phone keeps a copy, over Wi-Fi while charging. Your server's apps can hold up to the space you reserve here.",
  peer:
    "Encrypted pieces of your backup are kept on other Flagship servers, and yours keeps theirs. Your apps can use up to a third of this server's disk; the rest holds other servers' pieces.",
  none: "Nothing is backed up. If this server's disk fails, its apps and data are gone. You can still use Back up now on the server page.",
};
export const WEB_RESERVE_NOTE = "Keep this much free on your phone for the backup.";

/** The draft store's values ("phone-only" | "peer" | "none") → the wire's. */
export function policyFromDraft(v) {
  if (v === "peer" || v === "none") return v;
  return "phone";
}

export function backupPolicyCanonicalBytes({ serverDomain, policy, phoneReserveBytes, issuedAt }) {
  if (!serverDomain || /[|\r\n]/.test(serverDomain)) throw new Error("backup-policy: bad serverDomain");
  if (!POLICIES.includes(policy)) throw new Error("backup-policy: bad policy");
  if (!Number.isSafeInteger(phoneReserveBytes) || phoneReserveBytes < 0) throw new Error("backup-policy: bad phoneReserveBytes");
  if (policy === "phone" ? phoneReserveBytes === 0 : phoneReserveBytes !== 0) {
    throw new Error("backup-policy: phoneReserveBytes is set exactly when the policy is phone");
  }
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new Error("backup-policy: bad issuedAt");
  return new TextEncoder().encode([TAG_BACKUP_POLICY, serverDomain, policy, String(phoneReserveBytes), String(issuedAt)].join("|"));
}

const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** The order for `policy` (reserve in GB, used only for "phone"). */
export function policyOrder({ serverDomain, policy, reserveGb, issuedAt = Date.now() }) {
  const phoneReserveBytes = policy === "phone" ? Math.max(1, Math.round(Number(reserveGb) || DEFAULT_WEB_RESERVE_GB)) * GB : 0;
  return { serverDomain: String(serverDomain).toLowerCase(), policy, phoneReserveBytes, issuedAt };
}

/** Sign the order with the sensitive-order key: `sign(bytes) → Uint8Array`. */
export async function signPolicy(order, sign) {
  return { order, signatureHex: toHex(await sign(backupPolicyCanonicalBytes(order))) };
}

/** Put the signed policy beside the pairing order (the box takes it when the pairing order verifies). */
export async function attachBackupPolicy(pairingOrderJson, { serverDomain, policy, reserveGb, issuedAt, sign }) {
  const signed = await signPolicy(policyOrder({ serverDomain, policy, reserveGb, issuedAt }), sign);
  const o = JSON.parse(pairingOrderJson);
  o.backupPolicy = signed;
  return JSON.stringify(o);
}

export async function fetchPolicy({ client }) {
  return client.fetch(BACKUP_POLICY_PATH);
}

export async function setPolicy({ client, serverDomain, policy, reserveGb, sign, now = Date.now }) {
  const body = await signPolicy(policyOrder({ serverDomain, policy, reserveGb, issuedAt: now() }), sign);
  return client.fetch(BACKUP_POLICY_PATH, { method: "POST", body: JSON.stringify(body) });
}

export function formatGb(n) {
  if (!Number.isFinite(n)) return "";
  return `${(n / GB).toFixed(n < 10 * GB ? 1 : 0)} GB`;
}

/** "Backup policy: Phone-side backups · up to 32 GB" */
export function policyLine(view) {
  const p = view?.policy?.policy ?? "unset";
  const limit = view?.cap?.limitBytes;
  const label = POLICY_LABEL[p] ?? POLICY_LABEL.unset;
  if (p === "phone" && limit) return `${label} · up to ${formatGb(limit)}`;
  if (p === "peer" && limit) return `${label} · up to ${formatGb(limit)}`;
  return label;
}

/** "Apps use 3.2 GB of 32 GB" (peer: "… (a third of this server's disk)"; none: just the use). */
export function usageLine(view) {
  const cap = view?.cap ?? {};
  if (cap.usedBytes == null) return "";
  const used = formatGb(cap.usedBytes);
  if (cap.limitBytes == null) return `Apps use ${used}`;
  const of = `Apps use ${used} of ${formatGb(cap.limitBytes)}`;
  return view?.policy?.policy === "peer" ? `${of} (a third of this server's disk)` : of;
}

/** 0..1 for the usage bar, null when there is no limit. */
export function usageFraction(view) {
  const cap = view?.cap ?? {};
  if (cap.limitBytes == null || cap.usedBytes == null || cap.limitBytes <= 0) return null;
  return Math.min(1, cap.usedBytes / cap.limitBytes);
}

const PEER_STATE = {
  "waiting-for-peers": "Looking for servers to keep pieces",
  filling: "Getting ready",
  placing: "Sending pieces to other servers",
  protected: "Protected",
  "at-risk": "At risk",
  leaving: "Leaving peer backups",
  off: "Off",
};

/** The peer engine's status, as lines for the page. */
export function peerLines(peer, { formatTime = (t) => new Date(t).toLocaleString() } = {}) {
  if (!peer || typeof peer !== "object") return [];
  const out = [];
  const state = PEER_STATE[peer.state] ?? String(peer.state ?? "");
  out.push(peer.reason ? `${state}: ${String(peer.reason).replace(/[.\s]+$/, "")}.` : state);
  if (Number.isFinite(peer.totalBricks) && peer.totalBricks > 0) {
    out.push(`${peer.healthyBricks ?? 0} of ${peer.totalBricks} pieces safe${Number.isFinite(peer.holders) ? ` on ${peer.holders} server${peer.holders === 1 ? "" : "s"}` : ""}`);
  }
  if (Number.isFinite(peer.lastPlacedAt) && peer.lastPlacedAt > 0) out.push(`Last placed: ${formatTime(peer.lastPlacedAt)}`);
  if (Number.isFinite(peer.hostingBytes) && peer.hostingBytes > 0) out.push(`Holds ${formatGb(peer.hostingBytes)} for other servers`);
  return out;
}
