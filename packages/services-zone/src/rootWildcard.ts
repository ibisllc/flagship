/**
 * The ROOT-WILDCARD layout of the `flagship.services` zone (docs/wildcard-dns.md).
 *
 * At rest the zone holds ONE wildcard pair at the apex, `*.<apex>` A + AAAA
 * pointing at the relay, plus ONE apex CAA pair (`issue` and `issuewild`
 * "letsencrypt.org"), and nothing at any account or box name. Every
 * `<server>.<user>`, `<service>.<server>.<user>` and `<svc>.<user>` name then
 * resolves by wildcard synthesis, whatever the number of accounts. Only
 * `_acme-challenge.*` TXT records come and go, one or two per certificate in
 * flight.
 *
 * Measured on Cloudflare (docs/wildcard-dns.md section 11): a name that OWNS a
 * record of any type (A, AAAA, CAA, TXT) stops the wildcard for everything
 * below it, and a record at `<user>` stops it for the whole account. A TXT
 * below a name (`_acme-challenge.<box>.<user>`) blocks nothing. So the layout
 * is only correct while no record exists at an account or box name; this
 * module names what such a record is and how to remove it safely. Everything
 * here is pure: it reads record lists and says what is wrong, it never talks
 * to a zone.
 */

import { CHALLENGE_PREFIX } from "./accountDns.js";
import { buildUserZoneCaRestrictionCaaRecords, caaRecordRdata } from "./caaPin.js";
import { validateUserLabel } from "./validation.js";

/** Cloudflare Free caps a zone at this many records. */
export const ZONE_RECORD_CAP = 200;

/** A record as read from the zone (Cloudflare's `dns_records` shape, trimmed). */
export interface ZoneRecordView {
  id?: string;
  type: string;
  name: string;
  content?: string;
  proxied?: boolean;
  created_on?: string;
  modified_on?: string;
}

/** The relay's public addresses; what the root wildcard must point at. */
export interface RelayIps {
  servicesIpv4: string;
  servicesIpv6?: string;
}

const norm = (n: string): string => n.toLowerCase().replace(/\.$/, "");

export function rootWildcardName(apex: string): string {
  return `*.${norm(apex)}`;
}

/** The apex CAA records the layout needs, as zone-file rdata. */
export function expectedApexCaaRdata(): string[] {
  return buildUserZoneCaRestrictionCaaRecords("apex").map(caaRecordRdata);
}

export type ZoneNameKind =
  | { kind: "apex" }
  | { kind: "root-wildcard" }
  /** `_acme-challenge.<...>` under an account: temporary, blocks nothing. */
  | { kind: "challenge"; user: string }
  /**
   * A name at or below an account label: `<user>`, `*.<user>`, `<box>.<user>`,
   * `*.<box>.<user>` or deeper. A record here blocks the root wildcard.
   */
  | { kind: "account"; user: string; shape: "user" | "user-wild" | "box" | "box-wild" | "deeper" }
  /** A reserved or unrecognised label under the apex (hub, www, the gym subtree, ...). */
  | { kind: "system" }
  | { kind: "foreign" };

export function classifyZoneName(nameIn: string, apexIn: string): ZoneNameKind {
  const apex = norm(apexIn);
  const name = norm(nameIn);
  if (name === apex) return { kind: "apex" };
  if (!name.endsWith(`.${apex}`)) return { kind: "foreign" };
  const rel = name.slice(0, -(apex.length + 1));
  if (rel === "*") return { kind: "root-wildcard" };
  const labels = rel.split(".");
  if (labels.some((l) => l === "")) return { kind: "system" };
  const user = validateUserLabel(labels[labels.length - 1]!);
  if (!user.ok) return { kind: "system" };
  if (labels[0]!.startsWith(CHALLENGE_PREFIX.slice(0, -1)) && labels.length >= 2) {
    return { kind: "challenge", user: user.label };
  }
  const wild = labels[0] === "*";
  const depth = labels.length - (wild ? 1 : 0);
  if (depth === 1) return { kind: "account", user: user.label, shape: wild ? "user-wild" : "user" };
  if (depth === 2) return { kind: "account", user: user.label, shape: wild ? "box-wild" : "box" };
  return { kind: "account", user: user.label, shape: "deeper" };
}

/**
 * Order in which blocking records must be deleted so that no name goes dark in
 * between: the record at `<user>` first (it blocks nothing while the others
 * answer), then the box names, then the box wildcards, last the account
 * wildcard. At every step the names still answer from a record that stays or
 * from the root wildcard.
 */
export function legacyDeletionRank(nameIn: string, apexIn: string): number {
  const k = classifyZoneName(nameIn, apexIn);
  if (k.kind !== "account") return 9;
  switch (k.shape) {
    case "user":
      return 0;
    case "box":
      return 1;
    case "deeper":
      return 2;
    case "box-wild":
      return 3;
    case "user-wild":
      return 4;
  }
}

const LEGACY_TYPES = new Set(["A", "AAAA", "CAA"]);

// Within one name: CAA first (it answers no address query), then AAAA, then A.
// A name left owning only an A still answers IPv4, while one left owning only
// an AAAA would answer NODATA to every A query.
const TYPE_ORDER: Record<string, number> = { CAA: 0, AAAA: 1, A: 2 };

function byDeletionOrder(apex: string) {
  return (a: ZoneRecordView, b: ZoneRecordView): number =>
    legacyDeletionRank(a.name, apex) - legacyDeletionRank(b.name, apex) ||
    (TYPE_ORDER[a.type.toUpperCase()] ?? 3) - (TYPE_ORDER[b.type.toUpperCase()] ?? 3);
}

export interface AccountScope {
  /**
   * Restrict to one account's records.
   */
  user?: string;
  /**
   * The accounts that exist (lower case). A record at a single-label name
   * (`<label>.<apex>`) blocks only the names BELOW it, and a name below it
   * exists only when the label is an account, so without this set an A, AAAA
   * or TXT there is taken for a host record (`hub`, `www`, ...) and left alone;
   * a CAA there is always the old per-account record. With the set, any record
   * at an account's own name blocks.
   */
  accounts?: ReadonlySet<string>;
}

function blocksRoot(r: ZoneRecordView, k: ZoneNameKind, scope: AccountScope, types: ReadonlySet<string> | null): boolean {
  if (k.kind !== "account") return false;
  if (scope.user !== undefined && k.user !== scope.user.toLowerCase()) return false;
  const type = r.type.toUpperCase();
  if (k.shape === "user") {
    const isAccount = scope.accounts?.has(k.user) === true;
    if (!(type === "CAA" || isAccount || scope.user !== undefined)) return false;
  }
  return types === null || types.has(type);
}

/**
 * The records an earlier layout wrote that the root wildcard replaces: A, AAAA
 * and CAA at an account or box name (per-account `*.<user>`, per-account CAA,
 * per-box pairs, challenge shields). Returned in safe deletion order.
 */
export function legacyAccountRecords<T extends ZoneRecordView>(
  records: readonly T[],
  apex: string,
  scope: AccountScope = {},
): T[] {
  return records
    .filter((r) => blocksRoot(r, classifyZoneName(r.name, apex), scope, LEGACY_TYPES))
    .sort(byDeletionOrder(apex));
}

/**
 * Every record that blocks the root wildcard: ANY type at an account or box
 * name (see {@link AccountScope.accounts} for single-label names), except the
 * temporary `_acme-challenge` TXT (a different kind).
 */
export function blockingRecords<T extends ZoneRecordView>(
  records: readonly T[],
  apex: string,
  scope: AccountScope = {},
): T[] {
  return records.filter((r) => blocksRoot(r, classifyZoneName(r.name, apex), scope, null)).sort(byDeletionOrder(apex));
}

export type WildcardCheck = "ok" | "missing" | "wrong";

export interface RootWildcardStatus {
  ready: boolean;
  a: WildcardCheck;
  aaaa: WildcardCheck;
  proxied: boolean;
  problems: string[];
}

/**
 * Is the root wildcard in place and pointing only at the relay? "Ready" is the
 * guard every legacy deletion waits for: removing an account's own records
 * before this holds would take its names dark.
 */
export function rootWildcardStatus(
  records: readonly ZoneRecordView[],
  apex: string,
  relay: RelayIps,
): RootWildcardStatus {
  const name = rootWildcardName(apex);
  const at = (type: string) => records.filter((r) => norm(r.name) === name && r.type.toUpperCase() === type);
  const check = (type: "A" | "AAAA", want: string | undefined): WildcardCheck => {
    const have = at(type);
    if (want === undefined) return have.length === 0 ? "ok" : "wrong";
    if (have.length === 0) return "missing";
    return have.length === 1 && have[0]!.content?.toLowerCase() === want.toLowerCase() ? "ok" : "wrong";
  };
  const a = check("A", relay.servicesIpv4);
  const aaaa = check("AAAA", relay.servicesIpv6);
  const proxied = [...at("A"), ...at("AAAA")].some((r) => r.proxied === true);
  const problems: string[] = [];
  if (a === "missing") problems.push(`${name} A is missing (it must be ${relay.servicesIpv4})`);
  if (a === "wrong") problems.push(`${name} A is not exactly ${relay.servicesIpv4}`);
  if (aaaa === "missing") problems.push(`${name} AAAA is missing (it must be ${relay.servicesIpv6})`);
  if (aaaa === "wrong") {
    problems.push(
      relay.servicesIpv6
        ? `${name} AAAA is not exactly ${relay.servicesIpv6}`
        : `${name} AAAA exists but the relay has no IPv6 address configured`,
    );
  }
  if (proxied) problems.push(`${name} is proxied (orange cloud): it must be DNS only, or the relay is bypassed`);
  const cname = records.some((r) => norm(r.name) === name && r.type.toUpperCase() === "CNAME");
  if (cname) problems.push(`${name} has a CNAME, which conflicts with the A/AAAA wildcard`);
  return { ready: problems.length === 0, a, aaaa, proxied, problems };
}

export interface ZoneHealthProblem {
  code:
    | "wildcard"
    | "caa-missing"
    | "caa-unexpected"
    | "account-record"
    | "over-cap";
  message: string;
  name?: string;
  type?: string;
  id?: string;
}

export interface ZoneHealth {
  ok: boolean;
  apex: string;
  records: number;
  cap: number;
  rootWildcard: RootWildcardStatus;
  problems: ZoneHealthProblem[];
  warnings: string[];
  /** Records the layout keeps at rest (wildcard pair + apex CAA pair), whichever exist. */
  atRest: number;
  /** Temporary challenge TXT currently in the zone. */
  challenges: number;
}

/**
 * The zone-health verdict. Fails when the root wildcard is missing or points
 * anywhere but the relay, when the apex CAA is missing or allows another CA, or
 * when any record sits at an account or box name (each one is listed with its
 * id so it can be removed). `skipUsers` turns the records of those accounts
 * into warnings (the protected store-review account keeps its own set until
 * its review ends).
 */
export function evaluateZoneHealth(
  records: readonly ZoneRecordView[],
  opts: {
    apex: string;
    relay: RelayIps;
    cap?: number;
    skipUsers?: readonly string[];
    accounts?: ReadonlySet<string>;
    now?: number;
  },
): ZoneHealth {
  const apex = norm(opts.apex);
  const cap = opts.cap ?? ZONE_RECORD_CAP;
  const skip = new Set((opts.skipUsers ?? []).map((u) => u.toLowerCase()));
  const problems: ZoneHealthProblem[] = [];
  const warnings: string[] = [];

  const rootWildcard = rootWildcardStatus(records, apex, opts.relay);
  for (const message of rootWildcard.problems) problems.push({ code: "wildcard", message });

  const apexCaa = records.filter((r) => norm(r.name) === apex && r.type.toUpperCase() === "CAA");
  const wanted = expectedApexCaaRdata();
  for (const w of wanted) {
    if (!apexCaa.some((r) => (r.content ?? "").trim() === w)) {
      problems.push({ code: "caa-missing", message: `the apex ${apex} has no CAA ${w}`, name: apex, type: "CAA" });
    }
  }
  for (const r of apexCaa) {
    const c = (r.content ?? "").trim();
    if (wanted.includes(c) || / iodef /.test(c)) continue;
    problems.push({
      code: "caa-unexpected",
      message: `the apex CAA ${c} is not one of the two Let's Encrypt records`,
      name: apex,
      type: "CAA",
      ...(r.id ? { id: r.id } : {}),
    });
  }

  for (const r of blockingRecords(records, apex, { accounts: opts.accounts })) {
    const k = classifyZoneName(r.name, apex);
    const owner = k.kind === "account" ? k.user : "";
    const message = `${r.type} ${r.name} blocks the root wildcard for ${owner}'s names`;
    if (skip.has(owner)) {
      warnings.push(`${message} (account kept on purpose: its own records keep it working)`);
      continue;
    }
    problems.push({ code: "account-record", message, name: r.name, type: r.type, ...(r.id ? { id: r.id } : {}) });
  }

  const challenges = records.filter((r) => classifyZoneName(r.name, apex).kind === "challenge").length;
  const atRest = records.filter((r) => {
    const n = norm(r.name);
    const t = r.type.toUpperCase();
    return (n === rootWildcardName(apex) && (t === "A" || t === "AAAA")) || (n === apex && t === "CAA");
  }).length;

  if (records.length > cap) {
    problems.push({ code: "over-cap", message: `the zone holds ${records.length} records, over the ${cap} cap` });
  } else if (records.length > cap - 20) {
    warnings.push(`the zone holds ${records.length} of ${cap} records: under 20 left for certificates in flight`);
  }
  if (opts.now !== undefined) {
    const stale = records.filter((r) => {
      if (classifyZoneName(r.name, apex).kind !== "challenge") return false;
      const t = Date.parse(r.modified_on ?? r.created_on ?? "");
      return Number.isFinite(t) && t < opts.now! - 60 * 60 * 1000;
    }).length;
    if (stale > 0) warnings.push(`${stale} challenge TXT older than an hour (the hourly sweep clears them)`);
  }

  return {
    ok: problems.length === 0,
    apex,
    records: records.length,
    cap,
    rootWildcard,
    problems,
    warnings,
    atRest,
    challenges,
  };
}

export type ZoneAnswer =
  | { result: "answer"; values: string[] }
  | { result: "nodata" }
  | { result: "nxdomain" };

/**
 * What Cloudflare's authoritative servers answer for `name` and `type` from
 * these records, as measured (docs/wildcard-dns.md section 11): a name that
 * owns the type answers it; a name that owns only other types answers NODATA;
 * otherwise the nearest ancestor decides: `*.<ancestor>` answers when it holds
 * the type (NODATA when it holds only other types), and an ancestor that OWNS any record without a wildcard of its own
 * blocks everything below it (NXDOMAIN). An ancestor that only has descendants
 * does not block. A model for tests and for the live gym's expectations, not a
 * resolver.
 */
export function answerFor(
  records: readonly ZoneRecordView[],
  nameIn: string,
  type: "A" | "AAAA" = "A",
): ZoneAnswer {
  const name = norm(nameIn);
  const owned = (n: string) => records.filter((r) => norm(r.name) === n);
  const own = owned(name);
  const ownOfType = own.filter((r) => r.type.toUpperCase() === type);
  if (ownOfType.length > 0) return { result: "answer", values: ownOfType.map((r) => r.content ?? "") };
  if (own.length > 0) return { result: "nodata" };
  const labels = name.split(".");
  for (let i = 1; i < labels.length; i++) {
    const parent = labels.slice(i).join(".");
    const wildAll = owned(`*.${parent}`);
    if (wildAll.length > 0) {
      const wild = wildAll.filter((r) => r.type.toUpperCase() === type);
      return wild.length > 0 ? { result: "answer", values: wild.map((r) => r.content ?? "") } : { result: "nodata" };
    }
    if (owned(parent).length > 0) return { result: "nxdomain" };
  }
  return { result: "nxdomain" };
}
