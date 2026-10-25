/**
 * The owner's answer to an app's request for browser access beyond its manifest (SEC-BROWSER-002):
 * one-time, for the session or for the app, on named origins and optionally the local network.
 * Signed with the sensitive-order key, so a stolen paired session cannot widen what an app's browser
 * reaches.
 *
 *   flagship/browser-grant/v1|<serverDomain lowercase>|<requestId>|<serviceId>|<decision>|<duration>|
 *     <capabilities sorted, comma-joined>|<SHA-256 hex of the origins sorted, newline-joined>|<localNetwork>|<issuedAt>
 *
 * where localNetwork is `none`, `whole-lan` or `exact:<hosts sorted, comma-joined>`.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { ed } from "./edSync.js";
import { hex } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

export const TAG_BROWSER_GRANT = "flagship/browser-grant/v1";
export const BROWSER_GRANT_DURATIONS = ["once", "session", "service"] as const;
export type BrowserGrantDuration = (typeof BROWSER_GRANT_DURATIONS)[number];
export type BrowserGrantLocalNetwork = null | { kind: "exact"; hosts: string[] } | { kind: "whole-lan" };

export interface BrowserGrantAnswer {
  serverDomain: string;
  requestId: string;
  serviceId: string;
  decision: "allow" | "deny";
  duration: BrowserGrantDuration;
  capabilities: string[];
  origins: string[];
  localNetwork: BrowserGrantLocalNetwork;
  issuedAt: number;
}

function localNetworkWire(l: BrowserGrantLocalNetwork): string {
  if (!l) return "none";
  if (l.kind === "whole-lan") return "whole-lan";
  return `exact:${[...l.hosts].sort().join(",")}`;
}

export function canonicalBrowserGrantAnswer(a: BrowserGrantAnswer): Bytes {
  for (const [k, v] of [["serverDomain", a.serverDomain], ["requestId", a.requestId], ["serviceId", a.serviceId]] as const) {
    if (!v || /[|\x00-\x1f\x7f]/.test(v)) throw new Error(`bad ${k}`);
  }
  if (a.decision !== "allow" && a.decision !== "deny") throw new Error("bad decision");
  if (!(BROWSER_GRANT_DURATIONS as readonly string[]).includes(a.duration)) throw new Error("bad duration");
  if (!Number.isSafeInteger(a.issuedAt) || a.issuedAt < 0) throw new Error("bad issuedAt");
  for (const c of a.capabilities) if (!c || /[|,\x00-\x1f\x7f]/.test(c)) throw new Error("bad capability");
  const origins = hex(sha256(new TextEncoder().encode([...a.origins].sort().join("\n"))));
  return new TextEncoder().encode(
    [TAG_BROWSER_GRANT, a.serverDomain.toLowerCase(), a.requestId, a.serviceId, a.decision, a.duration, [...a.capabilities].sort().join(","), origins, localNetworkWire(a.localNetwork), a.issuedAt].join("|"),
  );
}

export function signBrowserGrantAnswer(a: BrowserGrantAnswer, sign: (msg: Bytes) => Bytes): Bytes {
  return sign(canonicalBrowserGrantAnswer(a));
}

export function verifyBrowserGrantAnswer(a: BrowserGrantAnswer, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalBrowserGrantAnswer(a), pub);
  } catch {
    return false;
  }
}

/**
 * What the owner may sign in answer to an ask: the same or narrower, never wider. The duration may be
 * shorter (once < session < service); capabilities and origins a subset of the ask's (exact strings);
 * the local network dropped, kept, or an `exact` ask cut to fewer hosts (a whole-LAN ask stays whole
 * or goes). At least one capability and one site or local-network entry remain.
 */
export interface BrowserGrantScope {
  duration: BrowserGrantDuration;
  capabilities: string[];
  origins: string[];
  localNetwork: BrowserGrantLocalNetwork;
}

const DURATION_RANK: Record<BrowserGrantDuration, number> = { once: 0, session: 1, service: 2 };

/** The durations the owner can choose for an ask, shortest first. */
export function browserGrantDurationChoices(asked: BrowserGrantDuration): BrowserGrantDuration[] {
  if (!(asked in DURATION_RANK)) return [];
  return BROWSER_GRANT_DURATIONS.filter((d) => DURATION_RANK[d] <= DURATION_RANK[asked]);
}

export function browserGrantWithin(ask: BrowserGrantScope, answer: BrowserGrantScope): boolean {
  if (!(answer.duration in DURATION_RANK) || !(ask.duration in DURATION_RANK)) return false;
  if (DURATION_RANK[answer.duration] > DURATION_RANK[ask.duration]) return false;
  const caps = new Set(ask.capabilities);
  if (answer.capabilities.length === 0 || !answer.capabilities.every((c) => caps.has(c))) return false;
  const origins = new Set(ask.origins);
  if (!answer.origins.every((o) => origins.has(o))) return false;
  const a = answer.localNetwork;
  const q = ask.localNetwork;
  if (a) {
    if (!q) return false;
    if (a.kind === "whole-lan" && q.kind !== "whole-lan") return false;
    if (a.kind === "exact") {
      if (q.kind !== "exact" || a.hosts.length === 0) return false;
      const hosts = new Set(q.hosts);
      if (!a.hosts.every((h) => hosts.has(h))) return false;
    }
  }
  return answer.origins.length > 0 || a !== null;
}

/**
 * The owner withdraws a browser grant they gave an app (a grant beyond the manifest; the manifest's
 * own sites go with the app or its manifest). The box drops it at once.
 *
 *   flagship/browser-grant-revoke/v1|<serverDomain lowercase>|<serviceId>|<grantId>|<issuedAt>
 */
export const TAG_BROWSER_GRANT_REVOKE = "flagship/browser-grant-revoke/v1";

export interface BrowserGrantRevoke {
  serverDomain: string;
  serviceId: string;
  grantId: string;
  issuedAt: number;
}

export function canonicalBrowserGrantRevoke(r: BrowserGrantRevoke): Bytes {
  for (const [k, v] of [["serverDomain", r.serverDomain], ["serviceId", r.serviceId], ["grantId", r.grantId]] as const) {
    if (!v || /[|\x00-\x1f\x7f]/.test(v)) throw new Error(`bad ${k}`);
  }
  if (!Number.isSafeInteger(r.issuedAt) || r.issuedAt < 0) throw new Error("bad issuedAt");
  return new TextEncoder().encode([TAG_BROWSER_GRANT_REVOKE, r.serverDomain.toLowerCase(), r.serviceId, r.grantId, r.issuedAt].join("|"));
}

export function signBrowserGrantRevoke(r: BrowserGrantRevoke, sign: (msg: Bytes) => Bytes): Bytes {
  return sign(canonicalBrowserGrantRevoke(r));
}

export function verifyBrowserGrantRevoke(r: BrowserGrantRevoke, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalBrowserGrantRevoke(r), pub);
  } catch {
    return false;
  }
}
