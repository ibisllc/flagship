/**
 * App access lists — which internet hosts a live app may reach
 * (docs/ai-privacy-and-staging.md §3a). Supersedes the all-or-nothing
 * `flagship/app-egress/v1` approval; a v1 grant still converts to `allow`
 * lines (`accessListFromEgressHosts`).
 *
 * One rule per line, checked top to bottom; the first rule that matches
 * decides and a host no rule matches is denied:
 *
 *   allow api.open-meteo.com
 *   allow *.tile.openstreetmap.org   # subdomains only
 *   deny  all
 *
 * The box enforces only a list the owner signed (sensitive-order key):
 *
 *   flagship/app-access/v1|<serverDomain>|<serviceId>|<sha256 hex of the normalized list>|<issuedAt ms>
 *
 * `test-vectors/app-access/vectors.json` is the cross-platform reference.
 */
import { sha256 } from "@noble/hashes/sha256";
import { ed } from "./edSync.js";
import { hex, legacyFieldGuard, resolveMsgSigner, type MsgSigner } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

export const TAG_APP_ACCESS = "flagship/app-access/v1";
export const ACCESS_RULES_MAX = 200;

/**
 * Every app's list until the owner signs one: it denies everything (it has
 * no rules) and shows how to open it up. Allow and Deny add rules above it.
 */
export const DEFAULT_ACCESS_LIST = "# Uncomment the following line to allow all hosts\n#allow all\n";

export type AccessAction = "allow" | "deny";

export interface AccessRule {
  /** 1-based line in the list text. */
  line: number;
  action: AccessAction;
  /** `all`, a lowercase host, or `*.` + one. */
  target: string;
}

export interface AccessListError {
  line: number;
  message: string;
}

export interface ParsedAccessList {
  rules: AccessRule[];
  errors: AccessListError[];
}

export interface AccessDecision {
  result: AccessAction;
  /** 1-based position (among the parsed rules) of the rule that decided, or null when none matched. */
  rule: number | null;
}

/**
 * `\r\n` and `\r` become `\n`, trailing spaces and tabs go from every line,
 * trailing blank lines go, and a non-empty list ends in exactly one `\n`.
 */
export function normalizeAccessList(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t]+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

const LABEL = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
const HOST_RE = new RegExp(`^${LABEL}(\\.${LABEL})+$`);

/**
 * Check one rule target (`all`, a host, `*.` + a host) as typed. Returns the
 * lowercase target, or the error text a list line with it would carry.
 */
export function checkAccessTarget(raw: string): { target: string } | { error: string } {
  const t = raw.toLowerCase();
  if (t === "all") return { target: "all" };
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(t)) return { error: "write the host only, without http:// or https://" };
  if (t.includes("/")) return { error: "write the host only, without a path" };
  if (isIpLiteral(t)) return { error: "IP addresses can't be allowed or denied; use a host name" };
  if (t.includes(":")) return { error: "write the host only, without a port" };
  if (t === "*") return { error: 'write "all" instead of "*"' };
  const wildcard = t.startsWith("*.");
  let host = wildcard ? t.slice(2) : t;
  if (host.includes("*")) return { error: "a * may only start a host, as in *.example.com" };
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "localhost" || host.endsWith(".localhost")) return { error: '"localhost" is not a public host name' };
  if (host.length > 253 || !HOST_RE.test(host) || /^[0-9.]+$/.test(host)) {
    return { error: `"${raw}" is not a valid host name` };
  }
  return { target: wildcard ? `*.${host}` : host };
}

function isIpLiteral(t: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) return true;
  const v6 = t.replace(/^\[/, "").replace(/\](:\d+)?$/, "");
  return /^[0-9a-f:.]+$/.test(v6) && (v6.match(/:/g)?.length ?? 0) >= 2;
}

type LineResult = { kind: "empty" } | { kind: "rule"; action: AccessAction; target: string } | { kind: "error"; message: string };

function parseLine(raw: string): LineResult {
  const hash = raw.indexOf("#");
  const body = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
  if (body.length === 0) return { kind: "empty" };
  const words = body.split(/\s+/);
  const verb = words[0]!.toLowerCase();
  if (verb !== "allow" && verb !== "deny") return { kind: "error", message: 'start the line with "allow" or "deny"' };
  if (words.length === 1) return { kind: "error", message: 'say what to allow or deny, e.g. "allow example.com"' };
  if (words.length > 2) return { kind: "error", message: "one host per line" };
  const t = checkAccessTarget(words[1]!);
  if ("error" in t) return { kind: "error", message: t.error };
  return { kind: "rule", action: verb, target: t.target };
}

/** Parse a list. Line numbers count from 1 over the normalized text. */
export function parseAccessList(text: string): ParsedAccessList {
  const lines = normalizeAccessList(text).split("\n");
  const rules: AccessRule[] = [];
  const errors: AccessListError[] = [];
  let tooMany = false;
  lines.forEach((raw, i) => {
    const r = parseLine(raw);
    if (r.kind === "empty") return;
    if (r.kind === "error") {
      errors.push({ line: i + 1, message: r.message });
      return;
    }
    if (rules.length >= ACCESS_RULES_MAX) {
      if (!tooMany) {
        errors.push({
          line: i + 1,
          message: `an access list can have at most ${ACCESS_RULES_MAX} rules`,
        });
      }
      tooMany = true;
      return;
    }
    rules.push({ line: i + 1, action: r.action, target: r.target });
  });
  return { rules, errors };
}

/** Lowercase and drop one trailing dot (`API.Example.com.` → `api.example.com`). */
export function normalizeAccessHost(raw: string): string {
  const h = raw.trim().toLowerCase();
  return h.endsWith(".") ? h.slice(0, -1) : h;
}

/** Whether one rule target covers `host` (`*.x` covers subdomains of x only). */
export function accessTargetMatches(target: string, host: string): boolean {
  if (target === "all") return true;
  if (target.startsWith("*.")) {
    const suffix = target.slice(1);
    return host.length > suffix.length && host.endsWith(suffix);
  }
  return target === host;
}

/** First match decides; nothing matching means deny with `rule: null`. */
export function decideAccess(list: string | readonly AccessRule[], rawHost: string): AccessDecision {
  const rules = typeof list === "string" ? parseAccessList(list).rules : list;
  const host = normalizeAccessHost(rawHost);
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i]!;
    if (accessTargetMatches(r.target, host)) return { result: r.action, rule: i + 1 };
  }
  return { result: "deny", rule: null };
}

/**
 * The owner's answer to a request: drop every rule for exactly that target,
 * then put the new rule on top so it decides. Comments and other lines stay.
 * Throws on a target a list couldn't hold.
 */
export function withRule(list: string, action: AccessAction, host: string): string {
  const t = checkAccessTarget(host.trim());
  if ("error" in t) throw new Error(t.error);
  const kept = normalizeAccessList(list)
    .split("\n")
    .filter((raw) => {
      const r = parseLine(raw);
      return !(r.kind === "rule" && r.target === t.target);
    });
  return normalizeAccessList([`${action} ${t.target}`, ...kept].join("\n"));
}

/** A v1 approval's hosts as the list the box now enforces: one `allow` each (sorted), above the default list. */
export function accessListFromEgressHosts(hosts: readonly string[]): string {
  const sorted = [...hosts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return normalizeAccessList([...sorted.map((h) => `allow ${h}`), DEFAULT_ACCESS_LIST].join("\n"));
}

/** Lowercase hex SHA-256 of the list's UTF-8 bytes. Pass the normalized list. */
export function accessListSha256(list: string): string {
  return hex(sha256(new TextEncoder().encode(list)));
}

export interface AppAccessGrant {
  /** The box this list is for (its FQDN). */
  serverDomain: string;
  /** The installed service, `<creator>-<slug>`. */
  serviceId: string;
  /** `accessListSha256` of the normalized list sent with the grant. */
  listSha256: string;
  /** Unix ms. The box keeps only the newest list per service. */
  issuedAt: number;
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export function appAccessGrantCanonicalBytes(g: AppAccessGrant): Bytes {
  if (g.serverDomain.length === 0) throw new Error("app-access: empty serverDomain");
  if (g.serviceId.length === 0) throw new Error("app-access: empty serviceId");
  legacyFieldGuard("serverDomain", g.serverDomain);
  legacyFieldGuard("serviceId", g.serviceId);
  if (!SHA256_HEX_RE.test(g.listSha256)) throw new Error("app-access: listSha256 must be 64 lowercase hex");
  if (!Number.isSafeInteger(g.issuedAt) || g.issuedAt < 0) throw new Error("app-access: bad issuedAt");
  return new TextEncoder().encode(
    [TAG_APP_ACCESS, g.serverDomain, g.serviceId, g.listSha256, String(g.issuedAt)].join("|"),
  );
}

export function signAppAccessGrant(g: AppAccessGrant, signer: MsgSigner): Bytes {
  return resolveMsgSigner(signer)(appAccessGrantCanonicalBytes(g));
}

/** Never throws: a malformed grant simply fails. */
export function verifyAppAccessGrant(g: AppAccessGrant, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, appAccessGrantCanonicalBytes(g), pub);
  } catch {
    return false;
  }
}

/** Shape-check an untrusted JSON grant (no signature check). */
export function parseAppAccessGrant(v: unknown): AppAccessGrant | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.serverDomain !== "string" || typeof r.serviceId !== "string") return null;
  if (typeof r.listSha256 !== "string") return null;
  if (typeof r.issuedAt !== "number" || !Number.isSafeInteger(r.issuedAt)) return null;
  const g: AppAccessGrant = {
    serverDomain: r.serverDomain,
    serviceId: r.serviceId,
    listSha256: r.listSha256,
    issuedAt: r.issuedAt,
  };
  try {
    appAccessGrantCanonicalBytes(g);
  } catch {
    return null;
  }
  return g;
}
