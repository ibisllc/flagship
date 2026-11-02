/**
 * The relay feed's encryption layer (docs/architecture-v2/relay-mesh.md §4.5.1, owner decision 2026-11-01): the
 * head and the log pages `.com` publishes are encrypted to a Flagship-owned symmetric MESH KEY, one per epoch, and
 * each authorized relay receives every epoch's key sealed to its own relay key. Signatures stay over the plaintext
 * canonical bytes (packages/protocol/src/relayMesh.ts): a relay opens a file, then verifies what is inside exactly as
 * it would a clear one. Used by `.com` (apps/com/src/relayFeed.ts) to write and by the TS relay (chunk C) to read;
 * the Rust relay (chunk D) follows the same bytes (vectors: packages/control-plane/tests/vectors/relay-feed-seal.json).
 *
 * Sealed object (head.json, log/<page>.json):
 *   {kind:"RelayFeedSealed", version:1, servicesApex, object:"head"|"log", page, epoch, nonce, ciphertext}
 *   page: the page number for "log", null for "head"; epoch ≥ 1; nonce 24 lowercase hex (12 bytes);
 *   ciphertext: standard base64 (with padding) of AES-256-GCM(ciphertext ‖ 16-byte tag)
 *   key: the epoch's 32-byte mesh key
 *   AAD: UTF-8 of `flagship/relay-feed-sealed/v1|<servicesApex>|<object>|<page or empty>|<epoch>`
 *   plaintext: UTF-8 JSON of the clear object ({head, signature} or {page, entries})
 *
 * Key delivery (keys/<relayId>.json, and `meshKeys` in the blessing answer):
 *   {kind:"RelayMeshKeys", version:1, servicesApex, relayId, relayKey, current, epochs:[{epoch, sealed}]}
 *   sealed: hex of `sealForEd25519Recipient(utf8(line), relayKey)` (the repo's flagship.seal.v1:
 *   eph X25519 pub ‖ nonce ‖ AES-256-GCM, HKDF-SHA256(shared, salt = eph pub, info "flagship.seal.v1")), with
 *   line = `flagship/relay-mesh-key/v1|<servicesApex>|<relayId>|<epoch>|<key as 64 lowercase hex>`.
 *   The relay opens each with its seed (`openSealedFromEd25519Recipient`) and refuses a line that names another apex,
 *   relay or epoch.
 *
 * Epoch keys are derived on `.com` only: HKDF-SHA256(ikm = RELAY_MESH_KEY_SEED (32 bytes), salt = empty,
 * info = `flagship/relay-mesh-key-derive/v1|<servicesApex>|<epoch>`, 32). A relay never derives; it only receives.
 */
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { openSealedFromEd25519Recipient, sealForEd25519Recipient } from "@flagship/protocol";

export const TAG_RELAY_FEED_SEALED = "flagship/relay-feed-sealed/v1";
export const TAG_RELAY_MESH_KEY = "flagship/relay-mesh-key/v1";
export const TAG_RELAY_MESH_KEY_DERIVE = "flagship/relay-mesh-key-derive/v1";

export type RelayFeedObject = "head" | "log";

export interface RelayFeedSealed {
  kind: "RelayFeedSealed";
  version: 1;
  servicesApex: string;
  object: RelayFeedObject;
  /** The page number for `log`; null for `head`. */
  page: number | null;
  epoch: number;
  /** 12 bytes, lowercase hex. */
  nonce: string;
  /** Standard base64 of the AES-256-GCM output (ciphertext then the 16-byte tag). */
  ciphertext: string;
}

export interface RelayMeshKeys {
  kind: "RelayMeshKeys";
  version: 1;
  servicesApex: string;
  relayId: string;
  relayKey: string;
  /** The epoch new files are written under. */
  current: number;
  epochs: Array<{ epoch: number; sealed: string }>;
}

const te = new TextEncoder();
const td = new TextDecoder("utf-8", { fatal: true });
const HEX = /^[0-9a-f]*$/;

function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function fromHex(h: string): Uint8Array {
  if (h.length % 2 !== 0 || !HEX.test(h)) throw new Error("not lowercase hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function toB64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const epochOk = (e: unknown): e is number => typeof e === "number" && Number.isSafeInteger(e) && e >= 1;

/** `.com`: the mesh key of one epoch, from the Worker secret RELAY_MESH_KEY_SEED (64 hex). */
export function deriveMeshEpochKey(seedHex: string, servicesApex: string, epoch: number): Uint8Array {
  const seed = seedHex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(seed)) throw new Error("RELAY_MESH_KEY_SEED must be 64 hex");
  if (!epochOk(epoch)) throw new Error("epoch must be ≥ 1");
  return hkdf(sha256, fromHex(seed), new Uint8Array(0), te.encode(`${TAG_RELAY_MESH_KEY_DERIVE}|${servicesApex}|${epoch}`), 32);
}

export function relayFeedAad(servicesApex: string, object: RelayFeedObject, page: number | null, epoch: number): Uint8Array {
  return te.encode(`${TAG_RELAY_FEED_SEALED}|${servicesApex}|${object}|${page === null ? "" : page}|${epoch}`);
}

function checkPlacement(object: RelayFeedObject, page: number | null): void {
  if (object === "head" ? page !== null : !(typeof page === "number" && Number.isSafeInteger(page) && page >= 0)) {
    throw new Error("a head has no page; a log page has a page number ≥ 0");
  }
}

async function gcmKey(key: Uint8Array, use: "encrypt" | "decrypt") {
  if (key.length !== 32) throw new Error("mesh key must be 32 bytes");
  return crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, [use]);
}

/** Encrypt one feed file. `nonce` is for vectors only; production lets it be random. */
export async function sealRelayFeedObject(o: {
  servicesApex: string;
  object: RelayFeedObject;
  page: number | null;
  epoch: number;
  key: Uint8Array;
  plaintext: string;
  nonce?: Uint8Array;
}): Promise<RelayFeedSealed> {
  checkPlacement(o.object, o.page);
  if (!epochOk(o.epoch)) throw new Error("epoch must be ≥ 1");
  const nonce = o.nonce ?? crypto.getRandomValues(new Uint8Array(12));
  if (nonce.length !== 12) throw new Error("nonce must be 12 bytes");
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: relayFeedAad(o.servicesApex, o.object, o.page, o.epoch), tagLength: 128 },
      await gcmKey(o.key, "encrypt"),
      te.encode(o.plaintext),
    ),
  );
  return { kind: "RelayFeedSealed", version: 1, servicesApex: o.servicesApex, object: o.object, page: o.page, epoch: o.epoch, nonce: toHex(nonce), ciphertext: toB64(ct) };
}

export type RelayFeedOpenFailure = "malformed" | "wrong-place" | "no-key" | "undecryptable";

/**
 * Open one feed file: it must be the object (and page) the caller asked for, under its apex, and the caller must hold
 * that epoch's key. Returns the plaintext JSON text; the caller then verifies the signatures inside.
 */
export async function openRelayFeedObject(
  s: unknown,
  expect: { servicesApex: string; object: RelayFeedObject; page: number | null },
  keyFor: (epoch: number) => Uint8Array | null | undefined,
): Promise<{ ok: true; plaintext: string; epoch: number } | { ok: false; reason: RelayFeedOpenFailure }> {
  const o = s as Partial<RelayFeedSealed> | null;
  if (
    !o || o.kind !== "RelayFeedSealed" || o.version !== 1 || !epochOk(o.epoch) ||
    typeof o.nonce !== "string" || !/^[0-9a-f]{24}$/.test(o.nonce) || typeof o.ciphertext !== "string"
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (o.servicesApex !== expect.servicesApex || o.object !== expect.object || (o.page ?? null) !== expect.page) {
    return { ok: false, reason: "wrong-place" };
  }
  const key = keyFor(o.epoch);
  if (!key) return { ok: false, reason: "no-key" };
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromHex(o.nonce), additionalData: relayFeedAad(expect.servicesApex, expect.object, expect.page, o.epoch), tagLength: 128 },
      await gcmKey(key, "decrypt"),
      fromB64(o.ciphertext),
    );
    return { ok: true, plaintext: td.decode(pt), epoch: o.epoch };
  } catch {
    return { ok: false, reason: "undecryptable" };
  }
}

function keyLine(servicesApex: string, relayId: string, epoch: number, key: Uint8Array): string {
  return `${TAG_RELAY_MESH_KEY}|${servicesApex}|${relayId}|${epoch}|${toHex(key)}`;
}

/** `.com`: every epoch key the relay may hold, each sealed to its relay key. */
export function sealRelayMeshKeys(o: {
  servicesApex: string;
  relayId: string;
  relayKey: string;
  current: number;
  epochs: ReadonlyArray<{ epoch: number; key: Uint8Array }>;
}): RelayMeshKeys {
  if (!/^[0-9a-f]{64}$/.test(o.relayKey)) throw new Error("relayKey must be 64 lowercase hex");
  const epochs = [...o.epochs].sort((a, b) => a.epoch - b.epoch).map((e) => {
    if (!epochOk(e.epoch) || e.key.length !== 32) throw new Error("bad epoch key");
    return { epoch: e.epoch, sealed: toHex(sealForEd25519Recipient(te.encode(keyLine(o.servicesApex, o.relayId, e.epoch, e.key)), fromHex(o.relayKey))) };
  });
  if (!epochs.some((e) => e.epoch === o.current)) throw new Error("the current epoch must be sealed too");
  return { kind: "RelayMeshKeys", version: 1, servicesApex: o.servicesApex, relayId: o.relayId, relayKey: o.relayKey, current: o.current, epochs };
}

/**
 * Relay: open its key file with its relay key seed (32 bytes, the Ed25519 seed from FLAGSHIP_RELAY_KEY_SEED). Every
 * sealed line must name this apex, this relay and the epoch it is filed under; one that does not, or does not open,
 * is skipped. Returns epoch → key, and the current epoch.
 */
export function openRelayMeshKeys(
  doc: unknown,
  relaySeed: Uint8Array,
  expect: { servicesApex: string; relayId: string },
): { ok: true; current: number; keys: Map<number, Uint8Array> } | { ok: false; reason: "malformed" | "wrong-relay" | "no-current-key" } {
  const d = doc as Partial<RelayMeshKeys> | null;
  if (!d || d.kind !== "RelayMeshKeys" || d.version !== 1 || !epochOk(d.current) || !Array.isArray(d.epochs)) return { ok: false, reason: "malformed" };
  if (d.servicesApex !== expect.servicesApex || d.relayId !== expect.relayId) return { ok: false, reason: "wrong-relay" };
  const keys = new Map<number, Uint8Array>();
  for (const e of d.epochs) {
    if (!e || !epochOk(e.epoch) || typeof e.sealed !== "string") continue;
    try {
      const line = td.decode(openSealedFromEd25519Recipient(fromHex(e.sealed), relaySeed));
      const prefix = `${TAG_RELAY_MESH_KEY}|${expect.servicesApex}|${expect.relayId}|${e.epoch}|`;
      const k = line.startsWith(prefix) ? line.slice(prefix.length) : "";
      if (/^[0-9a-f]{64}$/.test(k)) keys.set(e.epoch, fromHex(k));
    } catch {
      /* not for this key */
    }
  }
  if (!keys.has(d.current)) return { ok: false, reason: "no-current-key" };
  return { ok: true, current: d.current, keys };
}
