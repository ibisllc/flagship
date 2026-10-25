/**
 * A generic forging harness for the protocol's `signX` / `verifyX` pairs (V01, AT-ENV).
 *
 * Nobody wrote a sample input for each of the ~200 signed families, so the harness infers one: it
 * hands `signX` a recording Proxy, sees which fields the canonical encoder reads, and offers each
 * field a short list of candidate values (by its name first, then by type) until the encoder stops
 * throwing. The signer is an opaque key (packages/protocol/src/opaqueKey.ts), so whatever path the
 * family takes to `ed.sign`, the harness sees the exact bytes that were signed. With a plain object
 * built from what worked, it finds the calling convention under which the PRODUCTION verifier says
 * true, and from then on every attack in envelopeForgery.test.ts runs against that verifier.
 *
 * What it cannot see: a field the encoder never reads. A field omitted from the signed bytes is
 * caught only by the bespoke tests (envelopeForgery.hybrid.test.ts) and by each family's vectors.
 */
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { opaqueKey } from "../../../../packages/protocol/src/opaqueKey.js";

ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

export type Bytes = Uint8Array;
type Fn = (...a: unknown[]) => unknown;

export interface TestKey {
  seed: Bytes;
  pub: Bytes;
}

export function newKey(fill?: number): TestKey {
  const seed = new Uint8Array(32);
  if (fill === undefined) crypto.getRandomValues(seed);
  else seed.fill(fill);
  return { seed, pub: ed.getPublicKey(seed) };
}

export const toHex = (b: Bytes): string => Buffer.from(b).toString("hex");
export const fromHex = (h: string): Bytes => Uint8Array.from(Buffer.from(h, "hex"));

/** A signer every convention in the protocol accepts: callable, a Keypair, with an opaque privateKey. */
export function recordingSigner(key: TestKey, captured: Bytes[]) {
  const ops = {
    publicKey: key.pub,
    sign(msg: Bytes): Bytes {
      captured.push(Uint8Array.from(msg));
      return ed.sign(msg, key.seed);
    },
  };
  const priv = opaqueKey(ops);
  const signer = Object.assign((msg: Bytes) => ops.sign(msg), { publicKey: key.pub, privateKey: priv });
  return { signer, priv };
}

// ---------------------------------------------------------------- value inference

type Cand = { kind: "value"; v: () => unknown } | { kind: "object" };

const NOW = Date.now();
const DAY = 86_400_000;
const b = (n: number, fill = 7) => () => new Uint8Array(n).fill(fill);
const s = (v: string) => () => v;
const n = (v: number) => () => v;
const vv = (f: () => unknown): Cand => ({ kind: "value", v: f });

const STR_GENERIC: Cand[] = [
  vv(s("home.alice.flagship.services")),
  vv(s("alice")),
  vv(s("home")),
  vv(s("x")),
  vv(s("alice--notes")),
  vv(s("a".repeat(64))),
  vv(s("https://example.test/x")),
];
const NUM_GENERIC: Cand[] = [vv(n(1)), vv(n(NOW)), vv(n(NOW + DAY)), vv(n(0)), vv(n(2))];
const BYTES_GENERIC: Cand[] = [vv(b(32)), vv(b(64)), vv(b(16)), vv(b(12)), vv(b(1088)), vv(b(1216)), vv(b(1952)), vv(b(3309)), vv(b(24)), vv(b(8)), vv(b(0))];
const HEX_GENERIC: Cand[] = [vv(s("07".repeat(32))), vv(s("07".repeat(20))), vv(s("07".repeat(64))), vv(s("07".repeat(16))), vv(s("07".repeat(12)))];
const MISC: Cand[] = [vv(() => true), vv(() => false), vv(() => []), vv(() => ["a"]), vv(() => null), { kind: "object" }];

function enumFor(name: string): Cand[] {
  const lists: [RegExp, string[]][] = [
    [/^role$|rank/i, ["member", "manager", "master", "admin", "owner"]],
    [/mode$/i, ["open", "members-only", "off", "restart", "cut", "copy", "auto", "approve", "manual"]],
    [/platform/i, ["apns", "fcm"]],
    [/reason/i, ["lost", "stolen", "decommissioned"]],
    [/^op$|action/i, ["set", "unset", "allow", "deny", "add", "remove"]],
    [/scope/i, ["read", "write"]],
    [/kind|type$/i, ["remote", "device", "set-front-page", "power-off"]],
    [/arch/i, ["amd64", "arm64"]],
    [/answer|decision|verdict/i, ["allow", "deny", "once", "session", "always"]],
  ];
  for (const [re, vals] of lists) if (re.test(name)) return vals.map((x) => vv(s(x)));
  return [];
}

/** Candidates in the order a field's name suggests. */
function candidatesFor(name: string): Cand[] {
  const out: Cand[] = [];
  const add = (c: Cand[]) => out.push(...c);
  add(enumFor(name));
  if (/(^|[a-z])(expires|notAfter|until|validUntil|endsAt|deadline)/i.test(name)) add([vv(n(NOW + DAY)), vv(n(Math.floor((NOW + DAY) / 1000)))]);
  if (/(issuedAt|At|Ms|createdAt|notBefore|startsAt|time|Time)$/.test(name)) add([vv(n(NOW)), vv(n(Math.floor(NOW / 1000)))]);
  if (/Hex$|^sha256|Sha256$|Sha256Hex$|^digest$|Digest$|Commit$|^commit$|Fingerprint$/i.test(name)) add(HEX_GENERIC);
  if (/(Pub|PubKey|PublicKey|Key|nonce|Nonce|Hash|Sig|Signature|Salt|Mac|Id)$|^(nonce|salt|mac|hash)$/i.test(name)) add(BYTES_GENERIC);
  if (/^(v|version|seq|sequence|generation|epoch|n|count|threshold|port|level|attempts)$|(Version|Count|Bytes|Size|Percent|Ratio|ratio|Seq|Sequence|Generation|Epoch|Index|Limit|Days|Hours|Minutes|Tokens|Seconds|Sec|Floor)$/.test(name)) add(NUM_GENERIC);
  if (/^(serverId|serverDomain|domain|fqdn|host|hostname|serverFqdn|subdomain)$|Domain$|Host$|Fqdn$/i.test(name)) add([vv(s("home.alice.flagship.services"))]);
  if (/^(userId|username|user|creator|owner|account|accountName|fromUser|toUser)$|Username$/i.test(name)) add([vv(s("alice"))]);
  if (/^(serverName|label|name)$/.test(name)) add([vv(s("home"))]);
  if (/^(serviceId|appId)$/i.test(name)) add([vv(s("alice--notes"))]);
  if (/(Url|url|URL|Endpoint)$/.test(name)) add([vv(s("https://example.test/x"))]);
  add(STR_GENERIC);
  add(NUM_GENERIC);
  add(BYTES_GENERIC);
  add(HEX_GENERIC);
  add(MISC);
  // drop duplicates of the same producer
  return out.filter((c, i) => out.indexOf(c) === i);
}

interface FieldState {
  name: string;
  cands: Cand[];
  idx: number;
  child?: Shape;
}

interface Root {
  last: { shape: Shape; field: string } | null;
  reads: number;
  order: { shape: Shape; field: string }[];
}

class Shape {
  fields = new Map<string, FieldState>();
  lastRead: { shape: Shape; field: string } | null = null;
  constructor(private readonly root: Root) {}

  proxy(): Record<string, unknown> {
    const self = this;
    const ignore = new Set<PropertyKey>(["then", "toJSON", "constructor", "valueOf", "toString", "asymmetricMatch", "$$typeof", "nodeType", "inspect"]);
    return new Proxy({} as Record<string, unknown>, {
      get(_t, p) {
        if (typeof p === "symbol" || ignore.has(p)) return undefined;
        let f = self.fields.get(p);
        if (!f) {
          f = { name: p, cands: candidatesFor(p), idx: 0 };
          self.fields.set(p, f);
        }
        self.root.last = { shape: self, field: p };
        self.root.reads += 1;
        if (!self.root.order.some((r) => r.shape === self && r.field === p)) self.root.order.push({ shape: self, field: p });
        return self.value(f, true);
      },
      has(_t, p) {
        return typeof p === "string" && self.fields.has(p);
      },
      ownKeys() {
        return [...self.fields.keys()];
      },
      getOwnPropertyDescriptor(_t, p) {
        if (typeof p !== "string" || !self.fields.has(p)) return undefined;
        return { enumerable: true, configurable: true, writable: true, value: self.value(self.fields.get(p)!, true) };
      },
    });
  }

  value(f: FieldState, live: boolean): unknown {
    const c = f.cands[f.idx]!;
    if (c.kind === "value") return c.v();
    if (!f.child) f.child = new Shape(this.root);
    return live ? f.child.proxy() : f.child.plain();
  }

  plain(): Record<string, unknown> {
    const o: Record<string, unknown> = {};
    for (const [k, f] of this.fields) o[k] = this.value(f, false);
    return o;
  }

  /**
   * An odometer over the fields in the order they were read: move the last one to its next
   * candidate; when it has none left, reset it and move the one read before it.
   */
  static advance(order: { shape: Shape; field: string }[]): boolean {
    for (let i = order.length - 1; i >= 0; i--) {
      const f = order[i]!.shape.fields.get(order[i]!.field)!;
      if (f.idx + 1 < f.cands.length) {
        f.idx += 1;
        f.child = undefined;
        return true;
      }
      f.idx = 0;
      f.child = undefined;
    }
    return false;
  }

  /** Values an error message names ("must be view or manage", "'list' or 'revoked-since'") become candidates. */
  static learn(order: { shape: Shape; field: string }[], message: string): boolean {
    const last = order[order.length - 1];
    if (!last) return false;
    const f = last.shape.fields.get(last.field)!;
    const add: string[] = [];
    const hexLen = /(\d+)[- ](?:byte|bytes)?[^.]*?hex|(\d+) (?:lowercase )?hex/i.exec(message);
    if (hexLen) {
      const k = Number(hexLen[1] ?? hexLen[2]);
      const chars = /byte/i.test(hexLen[0]) ? k * 2 : k;
      add.push("07".repeat(Math.ceil(chars / 2)).slice(0, chars));
    }
    if (/uppercase ASCII/i.test(message)) add.push("POST", "GET");
    const list = /(?:must be|one of|either)\s+((?:'?[a-z][a-z0-9_-]*'?(?:,\s*|\s+or\s+)?)+)/i.exec(message);
    if (list && /\bor\b|,|'/.test(list[1]!)) {
      for (const x of list[1]!.matchAll(/'?([a-z][a-z0-9_-]*)'?/gi)) if (!["or", "and"].includes(x[1]!.toLowerCase())) add.push(x[1]!);
    }
    for (const q of message.matchAll(/"([a-z][a-z0-9_-]*)"/gi)) void q;
    const have = new Set(f.cands.map((c) => (c.kind === "value" ? JSON.stringify(c.v()) : "")));
    const fresh = [...new Set(add)].filter((w) => !have.has(JSON.stringify(w)));
    if (fresh.length === 0) return false;
    f.cands.splice(f.idx + 1, 0, ...fresh.map((w) => vv(s(w))));
    f.idx += 1;
    return true;
  }

  fieldNames(prefix = ""): string[] {
    const out: string[] = [];
    for (const [k, f] of this.fields) {
      const c = f.cands[f.idx]!;
      if (c.kind === "object" && f.child) out.push(...f.child.fieldNames(`${prefix}${k}.`));
      else out.push(prefix + k);
    }
    return out;
  }
}

// ---------------------------------------------------------------- the driver

export type SigForm = "bytes" | "hex";
export type PubForm = "bytes" | "hex";

export interface Family {
  /** `ServerOrder` for signServerOrder / verifyServerOrder. */
  name: string;
  tag: string;
  /** The exact bytes the signer saw. */
  signed: Bytes;
  sample: Record<string, unknown>;
  /** Dotted paths of every field the encoder read. */
  fields: string[];
  sign: (obj: Record<string, unknown>, key: TestKey) => { sig: Bytes; signed: Bytes };
  verify: (obj: Record<string, unknown>, sig: Bytes, pub: Bytes) => Promise<boolean>;
  sigForm: SigForm;
  pubForm: PubForm | "none";
  /** The field that carries the signer's own public key, when the family embeds it. */
  keyField?: string | null;
}

export interface DriveFailure {
  name: string;
  stage: "infer" | "sign-output" | "verify-convention";
  detail: string;
}

function asSig(out: unknown): { sig: Bytes; form: SigForm } | null {
  if (out instanceof Uint8Array && out.length === 64) return { sig: out, form: "bytes" };
  if (typeof out === "string" && /^[0-9a-f]{128}$/i.test(out)) return { sig: fromHex(out), form: "hex" };
  return null;
}

function callSign(fn: Fn, obj: unknown, key: TestKey, variant: number): { out: unknown; captured: Bytes[] } {
  const captured: Bytes[] = [];
  const { signer, priv } = recordingSigner(key, captured);
  const out = fn(obj, variant === 0 ? signer : priv);
  return { out, captured };
}

async function settle(v: unknown): Promise<unknown> {
  return v instanceof Promise ? await v : v;
}

/** Infer a sample for `signName` and find the verifier convention. */
export async function drive(api: Record<string, unknown>, signName: string, verifyName: string): Promise<Family | DriveFailure> {
  const a = await driveMode(api, signName, verifyName, false);
  if ("tag" in a) return a;
  const b2 = await driveMode(api, signName, verifyName, true);
  return "tag" in b2 ? b2 : a;
}

async function driveMode(api: Record<string, unknown>, signName: string, verifyName: string, odometer: boolean): Promise<Family | DriveFailure> {
  const signFn = api[signName] as Fn;
  const verifyFn = api[verifyName] as Fn;
  const name = signName.slice(4);
  const key = newKey(1);
  const root: Root = { last: null, reads: 0, order: [] };
  const shape = new Shape(root);
  let variant = 0;
  let lastErr = "";
  let ok = false;
  for (let attempt = 0; attempt < 600 && !ok; attempt++) {
    const tries: { reads: number; order: Root["order"]; err: string }[] = [];
    for (const v of [0, 1]) {
      root.last = null;
      root.reads = 0;
      root.order = [];
      try {
        const r = callSign(signFn, shape.proxy(), key, v);
        const out = await settle(r.out);
        if (asSig(out) && r.captured.length > 0) {
          variant = v;
          ok = true;
          break;
        }
        tries.push({ reads: -1, order: [], err: `sign returned ${out instanceof Uint8Array ? `${out.length} bytes` : typeof out}` });
      } catch (e) {
        tries.push({ reads: root.reads, order: root.order, err: (e as Error).message });
      }
    }
    if (ok) break;
    const best = tries.reduce((a, t) => (t.reads > a.reads ? t : a));
    lastErr = best.err;
    if (best.reads < 0) return { name, stage: "sign-output", detail: lastErr };
    if (Shape.learn(best.order, lastErr)) continue;
    const moved = odometer ? Shape.advance(best.order) : Shape.advance(best.order.slice(-1));
    if (!moved) return { name, stage: "infer", detail: `${lastErr} (last field ${best.order[best.order.length - 1]?.field ?? "none"})` };
  }
  if (!ok) return { name, stage: "infer", detail: `gave up: ${lastErr}` };
  const sample = shape.plain();
  const fields = shape.fieldNames();
  const doSign = (obj: Record<string, unknown>, k: TestKey) => {
    const r = callSign(signFn, obj, k, variant);
    const out = r.out instanceof Promise ? null : asSig(r.out);
    if (!out) throw new Error(`${signName}: no signature`);
    return { sig: out.sig, signed: r.captured[r.captured.length - 1]! };
  };
  return findConvention(name, sample, fields, doSign, verifyFn, key, signFn, variant);
}

/**
 * Find how the production verifier wants to be called. Some families carry the signer's public key
 * inside the signed object (a vetoer, a rotation's old key): when no plain convention verifies, the
 * harness puts the key into each key-looking field in turn and also tries the two-argument form.
 */
async function findConvention(
  name: string,
  sample0: Record<string, unknown>,
  fields: string[],
  doSign: (obj: Record<string, unknown>, k: TestKey) => { sig: Bytes; signed: Bytes },
  verifyFn: Fn,
  key: TestKey,
  signFn: Fn,
  variant: number,
): Promise<Family | DriveFailure> {
  const signForm = asSig(callSign(signFn, sample0, key, variant).out)?.form ?? "bytes";
  const conventions: [SigForm, PubForm | "none"][] = [
    [signForm, "bytes"],
    [signForm, "hex"],
    [signForm === "bytes" ? "hex" : "bytes", "bytes"],
    [signForm === "bytes" ? "hex" : "bytes", "hex"],
    [signForm, "none"],
  ];
  const keyFields = fields.filter((f) => /(Pub|PubKey|PublicKey|Key|KeyHex|PubHex)$/.test(f) && !f.includes("."));
  const samples: { sample: Record<string, unknown>; injected: string | null }[] = [{ sample: sample0, injected: null }];
  for (const f of keyFields) {
    const cur = sample0[f];
    samples.push({ sample: { ...sample0, [f]: typeof cur === "string" ? toHex(key.pub) : key.pub }, injected: f });
  }
  for (const { sample, injected } of samples) {
    let first;
    try {
      first = doSign(sample, key);
    } catch {
      continue;
    }
    for (const [sf, pf] of conventions) {
      const verify = async (obj: Record<string, unknown>, sig: Bytes, pub: Bytes) => {
        try {
          const sigArg = sf === "hex" ? toHex(sig) : sig;
          const r = await settle(pf === "none" ? verifyFn(obj, sigArg) : verifyFn(obj, sigArg, pf === "hex" ? toHex(pub) : pub));
          return r === true;
        } catch {
          return false;
        }
      };
      if (await verify(sample, first.sig, key.pub)) {
        const text = new TextDecoder().decode(first.signed.slice(0, 120));
        const m = /^(flagship\/[A-Za-z0-9._/-]*?\/v\d+)/.exec(text);
        return {
          name,
          tag: m ? m[1]! : `(untagged:${text.slice(0, 24)})`,
          signed: first.signed,
          sample,
          fields,
          keyField: injected,
          sign: (obj, k) => doSign(injected ? { ...obj, [injected]: typeof obj[injected] === "string" ? toHex(k.pub) : k.pub } : obj, k),
          verify,
          sigForm: sf,
          pubForm: pf,
        };
      }
    }
  }
  return { name, stage: "verify-convention", detail: `no convention verified its own signature (fields ${fields.join(",")})` };
}

/** A value that differs from `v` and keeps its type. */
export function mutate(v: unknown): unknown {
  if (typeof v === "string") {
    if (/^[0-9a-f]+$/i.test(v) && v.length >= 2) return (v[0] === "0" ? "1" : "0") + v.slice(1);
    if (v.length === 0) return "x";
    return v.slice(0, -1) + (v.endsWith("x") ? "y" : "x");
  }
  if (typeof v === "number") return v + 1;
  if (typeof v === "boolean") return !v;
  if (v instanceof Uint8Array) {
    if (v.length === 0) return new Uint8Array([1]);
    const c = Uint8Array.from(v);
    c[0] = c[0]! ^ 1;
    return c;
  }
  if (Array.isArray(v)) return [...v, "zz"];
  if (v === null) return "x";
  return v;
}

export function setPath(obj: Record<string, unknown>, path: string, val: unknown): Record<string, unknown> {
  const [head, ...rest] = path.split(".");
  const copy = { ...obj };
  copy[head!] = rest.length === 0 ? val : setPath(obj[head!] as Record<string, unknown>, rest.join("."), val);
  return copy;
}

export function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], obj);
}

function seedFields(o: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array)) out.push(...seedFields(v as Record<string, unknown>, `${prefix}${k}.`));
    else out.push(prefix + k);
  }
  return out;
}

/** The same convention search for a hand-written sample (support/seeds.ts). */
export async function driveSeeded(api: Record<string, unknown>, signName: string, verifyName: string, seed: Record<string, unknown>): Promise<Family | DriveFailure> {
  const signFn = api[signName] as Fn;
  const verifyFn = api[verifyName] as Fn;
  const name = signName.slice(4);
  const key = newKey(1);
  let variant = -1;
  let lastErr = "";
  for (const v of [0, 1]) {
    try {
      const r = callSign(signFn, seed, key, v);
      if (asSig(await settle(r.out)) && r.captured.length > 0) {
        variant = v;
        break;
      }
      lastErr = "no signature returned";
    } catch (e) {
      lastErr = (e as Error).message;
    }
  }
  if (variant < 0) return { name, stage: "infer", detail: `seed refused: ${lastErr}` };
  const doSign = (obj: Record<string, unknown>, k: TestKey) => {
    const r = callSign(signFn, obj, k, variant);
    const out = r.out instanceof Promise ? null : asSig(r.out);
    if (!out) throw new Error(`${signName}: no signature`);
    return { sig: out.sig, signed: r.captured[r.captured.length - 1]! };
  };
  return findConvention(name, seed, seedFields(seed), doSign, verifyFn, key, signFn, variant);
}
