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
