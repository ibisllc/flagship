/**
 * The org key ring on the box (docs/enterprise-accounts.md §5.4, §8; phase E5).
 *
 * An org box holds its own X-Wing key (a random seed in `org-kem.seed`, 0600), announces it to `.com`
 * signed with its STK (`flagship/org-box-kem/v1`), and opens the newest version of every key sealed
 * to it (the CGK, this server's archive keys and disk key), checking each against the ring's key
 * commitment and the org approval it carries, verified under the box's own pinned chain. The keys
 * it opened are kept in `org-keys.json` (0600), newest version per key.
 *
 * Offboarding: a departed seat's rotation of a key is done on this box once no rotation of that key
 * is pending for the seat (`orgPendingRotations`): every key chain it was ever sealed into has a
 * version since it left that leaves it out, and the disk key of this server has one if it could
 * unlock it at boot. `.com` is not trusted for any of it: a ring that does not verify under the
 * pinned chain is ignored, so `.com` can delay a rotation's end but never fake one.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  buildOrgKeyRings,
  newestOrgKems,
  openOrgKeyRing,
  orgKeyChainId,
  orgKemKeyPair,
  orgNewestRingFor,
  orgPendingRotations,
  canonicalOrgBoxKem,
  canonicalOrgBoxLogHead,
  verifyOrgInstallBlob,
  type OrgInstallBlob,
  type OrgKeyKind,
  type OrgKeyRingBundle,
  type OrgKeyRings,
} from "@flagship/protocol";
import { keepCorruptAside, readStateFile, writeFileDurable } from "./durableFile.js";
import type { OrgPinned, OrgRotationKind } from "./orgAuthorityPin.js";

export interface OrgOpenedKey {
  version: number;
  keyHex: string;
}

export interface OrgKeysFile {
  v: 1;
  /** `<kind>|<scope>` → the newest version this box opened. */
  keys: Record<string, OrgOpenedKey>;
}

export interface OrgBoxKeyDeps {
  dataDir: string;
  orgId: string;
  serverDomain: string;
  /** Signs with the box's STK (keyd's `sign`, or the in-process key). */
  signAsBox: (msg: Uint8Array) => Uint8Array;
  controlPlaneBaseUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** The box's X-Wing seed, made once. */
export async function orgBoxKemSeed(dataDir: string): Promise<Uint8Array> {
  const path = join(dataDir, "org-kem.seed");
  const r = await readStateFile(path);
  if (r.kind === "ok" && /^[0-9a-f]{64}$/.test(r.text.trim())) return Uint8Array.from(Buffer.from(r.text.trim(), "hex"));
  if (r.kind !== "missing") await keepCorruptAside(path, r.kind === "unreadable" ? r.error : new Error("shape"), "a new org key is made; the org's next rotation seals to it");
  const seed = new Uint8Array(randomBytes(32));
  await writeFileDurable(path, Buffer.from(seed).toString("hex"));
  return seed;
}

/** Posts the box's KEM statement (`POST /api/orgs/<id>/box-kems`); `.com` keeps the newest. */
export async function announceOrgBoxKem(deps: OrgBoxKeyDeps): Promise<string> {
  const now = (deps.now ?? (() => Date.now()))();
  const kp = orgKemKeyPair(await orgBoxKemSeed(deps.dataDir));
  const statement = { orgId: deps.orgId, serverDomain: deps.serverDomain, kemKeyId: kp.kemKeyId, issuedAt: now };
  const body = { statement, kemPubHex: Buffer.from(kp.kemPub).toString("hex"), signature: Buffer.from(deps.signAsBox(canonicalOrgBoxKem(statement))).toString("hex") };
  const r = await (deps.fetchImpl ?? fetch)(`${deps.controlPlaneBaseUrl.replace(/\/$/, "")}/api/orgs/${deps.orgId}/box-kems`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`box-kems: HTTP ${r.status}`);
  return kp.kemKeyId;
}

/**
 * Signs this box's Activity log head with its STK (`flagship/org-box-log-head/v1`) and posts it
 * (`POST /api/orgs/<id>/box-log-heads`); `.com` keeps the newest per server for the audit export.
 */
export async function postOrgBoxLogHead(deps: OrgBoxKeyDeps, head: { seq: number; hash: string }): Promise<void> {
  const h = { orgId: deps.orgId, serverDomain: deps.serverDomain, seq: head.seq, headHash: head.hash, issuedAt: (deps.now ?? (() => Date.now()))() };
  const body = { head: h, signature: Buffer.from(deps.signAsBox(canonicalOrgBoxLogHead(h))).toString("hex") };
  const r = await (deps.fetchImpl ?? fetch)(`${deps.controlPlaneBaseUrl.replace(/\/$/, "")}/api/orgs/${deps.orgId}/box-log-heads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`box-log-heads: HTTP ${r.status}`);
}

/** The key rings `.com` serves, verified under the box's pinned chain (as of each version's record). */
export function verifyServedRings(pinned: OrgPinned, bundles: readonly OrgKeyRingBundle[], serverDomain: string, now: number): OrgKeyRings {
  return buildOrgKeyRings({ state: pinned.state, book: pinned.book, kems: newestOrgKems([]), servers: new Set([serverDomain]), now }, bundles);
}

const scopeOf = (kind: OrgKeyKind, serverDomain: string) => (kind === "cgk" || kind === "directory-key" ? "*" : serverDomain);

/** True once `seatId` leaves nothing of `kind` to rotate that touches this server. */
export function orgBoxRotationDone(pinned: OrgPinned, rings: OrgKeyRings, kind: OrgRotationKind, seatId: string, serverDomain: string): boolean {
  const pending = orgPendingRotations(pinned.state, pinned.book, rings, { revokes: pinned.file.revokes, grants: pinned.file.grants });
  const mine = pending.find((p) => p.seatId === seatId);
  return !mine?.keys.some((k) => k.kind === kind && k.scope === scopeOf(kind, serverDomain));
}

/**
 * Opens the newest version of every key sealed to this box and keeps it. A version whose copy does
 * not open or whose commitment does not match is skipped (the previous one stays).
 */
export async function adoptOrgKeys(dataDir: string, rings: OrgKeyRings, serverDomain: string): Promise<OrgKeysFile> {
  const path = join(dataDir, "org-keys.json");
  const r = await readStateFile(path);
  let file: OrgKeysFile = { v: 1, keys: {} };
  if (r.kind === "ok") {
    try {
      const f = JSON.parse(r.text) as OrgKeysFile;
      if (f?.v === 1 && f.keys && typeof f.keys === "object") file = f;
    } catch (e) {
      await keepCorruptAside(path, e, "the org's keys are opened again from the key ring");
    }
  }
  const { kemSecret } = orgKemKeyPair(await orgBoxKemSeed(dataDir));
  const me = `box:${serverDomain}`;
  let changed = false;
  for (const kind of ["cgk", "archive-keys", "disk-key"] as const) {
    const scope = scopeOf(kind, serverDomain);
    const b = orgNewestRingFor(rings, kind, scope, me);
    const id = `${kind}|${scope}`;
    if (!b || (file.keys[id]?.version ?? 0) >= b.ring.version) continue;
    try {
      const key = openOrgKeyRing(b, me, kemSecret);
      file.keys[id] = { version: b.ring.version, keyHex: Buffer.from(key).toString("hex") };
      changed = true;
    } catch {
      /* sealed to an older key of this box, or a bad copy: keep the previous version */
    }
  }
  if (changed) await writeFileDurable(path, JSON.stringify(file));
  return file;
}

/**
 * Every version of the org CGK above `after` that is sealed to this box, oldest first, opened with the box's
 * KEM key. keyd takes them one at a time (each must be one version up and link to the one it holds), so a box
 * that missed some rotations hands each in turn. Stops at the first version that does not open.
 */
export async function openOrgCgkVersionsAfter(
  dataDir: string,
  rings: OrgKeyRings,
  serverDomain: string,
  after: number,
): Promise<Array<{ bundle: OrgKeyRingBundle; key: Uint8Array }>> {
  const me = `box:${serverDomain}`;
  const chain = rings.chains.get(orgKeyChainId("cgk", "*")) ?? [];
  const { kemSecret } = orgKemKeyPair(await orgBoxKemSeed(dataDir));
  const out: Array<{ bundle: OrgKeyRingBundle; key: Uint8Array }> = [];
  for (const b of chain) {
    if (b.ring.version <= after || !b.recipients.some((x) => x.recipient === me)) continue;
    try {
      out.push({ bundle: b, key: openOrgKeyRing(b, me, kemSecret) });
    } catch {
      break;
    }
  }
  return out;
}

/** Fetches `GET /api/orgs/<id>/keys` (the rings only; the box verifies them itself). */
export async function fetchOrgRings(deps: Pick<OrgBoxKeyDeps, "orgId" | "controlPlaneBaseUrl" | "fetchImpl">): Promise<OrgKeyRingBundle[]> {
  const r = await (deps.fetchImpl ?? fetch)(`${deps.controlPlaneBaseUrl.replace(/\/$/, "")}/api/orgs/${deps.orgId}/keys`, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`keys: HTTP ${r.status}`);
  const j = (await r.json()) as { rings?: OrgKeyRingBundle[] };
  return Array.isArray(j.rings) ? j.rings : [];
}

/**
 * The org's CGK as this box last opened it from the key ring (`cgk|*` in `org-keys.json`), or null.
 * On an org box it is the only gossip key: an org has no UMK, so no owner phone seals a CGK deposit.
 */
export async function readOrgCgk(dataDir: string): Promise<{ version: number; key: Uint8Array } | null> {
  const r = await readStateFile(join(dataDir, "org-keys.json"));
  if (r.kind !== "ok") return null;
  try {
    const k = (JSON.parse(r.text) as OrgKeysFile).keys?.["cgk|*"];
    if (!k || !/^[0-9a-f]{64}$/.test(k.keyHex) || !Number.isSafeInteger(k.version)) return null;
    return { version: k.version, key: Uint8Array.from(Buffer.from(k.keyHex, "hex")) };
  } catch {
    return null;
  }
}

/**
 * Checks this box's own recipe once its org chain is pinned: the server code and the recipe both
 * carry org approvals (`add-server`) that must verify under the chain replayed from the recipe's
 * genesis. A recipe that does not verify is named in Activity (the box keeps its pin: it already
 * trusts that genesis, as a personal box trusts the IRK its recipe named).
 */
export async function verifyOwnOrgRecipe(pinned: OrgPinned, blobPath: string, now: number): Promise<{ ok: true; signers: string[] } | { ok: false; reason: string }> {
  const r = await readStateFile(blobPath);
  if (r.kind !== "ok") return { ok: false, reason: "the recipe is not on this box" };
  try {
    const b = JSON.parse(r.text) as OrgInstallBlob;
    if (b.kind !== "org") return { ok: false, reason: "the recipe is not an org server's" };
    return { ok: true, signers: verifyOrgInstallBlob(pinned.state, pinned.book, b, now).signers };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}
