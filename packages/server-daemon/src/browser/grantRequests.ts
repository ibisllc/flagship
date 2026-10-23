/**
 * Browser grants beyond the manifest (SECURITY-HARDENING-PLAN.md 10.4 and 17.3, N14). An app's
 * manifest `browser.domains`, approved at install, is its standing grant. Anything more, a one-time
 * visit, access for this session, or a device on the owner's local network, is a request the app
 * makes and the owner answers:
 *
 *   POST /api/browser/grant-requests                 (app token)  { capabilities, origins, localNetwork?, duration, explanation? }
 *   GET  /api/browser/grant-requests/<id>            (app token)  -> { status }
 *   GET  /api/browser/owner/grant-requests           (owner session) -> { requests: [...] }
 *   POST /api/browser/owner/grant-requests/answer    (owner session) { requestId, decision, issuedAt, signature? }
 *
 * An answer that lets something in is an owner signature over exactly what the owner was shown
 * (`flagship/browser-grant/v1`, the sensitive-order key), so a stolen paired session cannot widen
 * an app's browser. A denial only narrows and needs the session alone; it starts a cooldown on the
 * same ask from the same app (1 minute, then 10, then an hour, then a day), so an app cannot nag.
 */
import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { authorizeSensitiveOrder } from "../adminAuthorityLocal.js";
import type { SensitiveAuthority } from "../egress/approvals.js";
import { contextSession } from "./egress.js";
import {
  describeGrant,
  GrantRequestError,
  normalizeOriginPattern,
  type BrowserCapability,
  type BrowserGrants,
  type GrantDuration,
  type LocalNetworkGrant,
} from "./policy/grants.js";

const CAPS: BrowserCapability[] = ["navigate", "read-dom", "screenshot", "input", "download"];
const DURATIONS: GrantDuration[] = ["once", "session", "service"];
const COOLDOWNS_MS = [60_000, 10 * 60_000, 3_600_000, 24 * 3_600_000];

export interface BrowserGrantAsk {
  serviceId: string;
  capabilities: BrowserCapability[];
  origins: string[];
  localNetwork: LocalNetworkGrant;
  duration: GrantDuration;
  explanation: string;
}

/** The signed answer's bytes live in the protocol, shared with the clients (`flagship/browser-grant/v1`). */
export { TAG_BROWSER_GRANT, canonicalBrowserGrantAnswer, verifyBrowserGrantAnswer, type BrowserGrantAnswer } from "@flagship/protocol";
import { verifyBrowserGrantAnswer, type BrowserGrantAnswer } from "@flagship/protocol";

/** Validate and normalize what an app asks for; throws GrantRequestError with the reason. */
export function normalizeAsk(serviceId: string, body: Record<string, unknown>): BrowserGrantAsk {
  const caps = Array.isArray(body.capabilities) ? body.capabilities : [];
  if (caps.length === 0 || caps.some((c) => !CAPS.includes(c as BrowserCapability))) throw new GrantRequestError("name the capabilities: navigate, read-dom, screenshot, input or download");
  const origins = (Array.isArray(body.origins) ? body.origins : []).map((o) => {
    if (typeof o !== "string") throw new GrantRequestError("origins must be host names");
    return normalizeOriginPattern(o);
  });
  let localNetwork: LocalNetworkGrant = null;
  const ln = body.localNetwork as { kind?: unknown; hosts?: unknown } | null | undefined;
  if (ln && typeof ln === "object") {
    if (ln.kind === "whole-lan") localNetwork = { kind: "whole-lan" };
    else if (ln.kind === "exact" && Array.isArray(ln.hosts) && ln.hosts.length > 0 && ln.hosts.length <= 16) {
      const hosts = ln.hosts.map((h) => {
        const s = typeof h === "string" ? h.trim().toLowerCase() : "";
        if (!s || /[|,\s/]/.test(s) || !(isIP(s) || /^[a-z0-9.-]{1,253}$/.test(s))) throw new GrantRequestError("local-network hosts must be addresses or names");
        return s;
      });
      localNetwork = { kind: "exact", hosts: [...new Set(hosts)].sort() };
    } else throw new GrantRequestError("localNetwork is { kind: \"exact\", hosts } or { kind: \"whole-lan\" }");
  }
  if (origins.length === 0 && !localNetwork) throw new GrantRequestError("ask for at least one site or local-network access");
  const duration = body.duration as GrantDuration;
  if (!DURATIONS.includes(duration)) throw new GrantRequestError("duration is once, session or service");
  return {
    serviceId,
    capabilities: [...new Set(caps as BrowserCapability[])].sort(),
    origins: [...new Set(origins)].sort(),
    localNetwork,
    duration,
    explanation: typeof body.explanation === "string" ? body.explanation.slice(0, 500) : "",
  };
}

interface Held {
  id: string;
  ask: BrowserGrantAsk;
  at: number;
  status: "pending" | "allowed" | "denied";
  grantId: string | null;
}

export type AskOutcome = { ok: true; requestId: string } | { ok: false; status: 429; retryAfterMs: number } | { ok: false; status: 409; reason: string };

export class BrowserGrantRequests {
  private held = new Map<string, Held>();
  /** `<serviceId>|<digest of the ask>` -> denials so far and when the last one ends. */
  private cooling = new Map<string, { count: number; until: number }>();

  constructor(private readonly o: {
    grants: BrowserGrants;
    serverDomain: string;
    authority: () => SensitiveAuthority;
    now?: () => number;
    /** Wake the owner: a request is waiting (content-free; the screens list carries the detail). */
    onRequest?: (serviceId: string) => void;
    maxSkewMs?: number;
  }) {}

  private now(): number {
    return (this.o.now ?? (() => Date.now()))();
  }

  private key(a: BrowserGrantAsk): string {
    return `${a.serviceId}|${createHash("sha256").update(JSON.stringify([a.capabilities, a.origins, a.localNetwork, a.duration])).digest("hex")}`;
  }

  ask(a: BrowserGrantAsk): AskOutcome {
    const t = this.now();
    const k = this.key(a);
    const c = this.cooling.get(k);
    if (c && c.until > t) return { ok: false, status: 429, retryAfterMs: c.until - t };
    for (const h of this.held.values()) {
      if (h.status === "pending" && this.key(h.ask) === k) return { ok: true, requestId: h.id };
    }
    const mine = [...this.held.values()].filter((h) => h.status === "pending" && h.ask.serviceId === a.serviceId).length;
    if (mine >= 5) return { ok: false, status: 409, reason: "this app already has five requests waiting" };
    if (this.held.size >= 256) {
      for (const [id, h] of this.held) if (h.status !== "pending") this.held.delete(id);
      if (this.held.size >= 256) return { ok: false, status: 409, reason: "too many requests are waiting" };
    }
    const id = randomUUID();
    this.held.set(id, { id, ask: a, at: t, status: "pending", grantId: null });
    try {
      this.o.onRequest?.(a.serviceId);
    } catch {
      // the alert is best effort; the request is kept either way
    }
    return { ok: true, requestId: id };
  }

  status(serviceId: string, id: string): "pending" | "allowed" | "denied" | null {
    const h = this.held.get(id);
    return h && h.ask.serviceId === serviceId ? h.status : null;
  }

  /** What the owner is shown: the normalized ask, in words, beside the app's own explanation. */
  pending(): Array<BrowserGrantAsk & { requestId: string; at: number; meaning: string[] }> {
    return [...this.held.values()].filter((h) => h.status === "pending").map((h) => ({ ...h.ask, requestId: h.id, at: h.at, meaning: describeGrant(h.ask) }));
  }

  answer(b: { requestId: string; decision: "allow" | "deny"; issuedAt?: number; signatureHex?: string }): { ok: true } | { ok: false; status: number; reason: string } {
    const h = this.held.get(b.requestId);
    if (!h || h.status !== "pending") return { ok: false, status: 404, reason: "that request is no longer waiting" };
    if (b.decision === "deny") {
      h.status = "denied";
      const k = this.key(h.ask);
      const prev = this.cooling.get(k)?.count ?? 0;
      this.cooling.set(k, { count: prev + 1, until: this.now() + COOLDOWNS_MS[Math.min(prev, COOLDOWNS_MS.length - 1)]! });
      return { ok: true };
    }
    if (!Number.isSafeInteger(b.issuedAt) || Math.abs(this.now() - (b.issuedAt as number)) > (this.o.maxSkewMs ?? 10 * 60_000)) {
      return { ok: false, status: 400, reason: "a signed answer with a current time is required" };
    }
    if (typeof b.signatureHex !== "string" || !/^[0-9a-f]{128}$/i.test(b.signatureHex)) return { ok: false, status: 400, reason: "a signed answer is required" };
    const order: BrowserGrantAnswer = {
      serverDomain: this.o.serverDomain,
      requestId: h.id,
      serviceId: h.ask.serviceId,
      decision: "allow",
      duration: h.ask.duration,
      capabilities: h.ask.capabilities,
      origins: h.ask.origins,
      localNetwork: h.ask.localNetwork,
      issuedAt: b.issuedAt as number,
    };
    let ok = false;
    try {
      const a = this.o.authority();
      ok = authorizeSensitiveOrder({
        ownerIrkPub: a.ownerIrkPub,
        ...(a.adminRootPub ? { adminRootPub: a.adminRootPub } : {}),
        username: a.username,
        ...(a.activeGrants ? { activeGrants: a.activeGrants } : {}),
        order,
        signature: Uint8Array.from(Buffer.from(b.signatureHex, "hex")),
        verify: verifyBrowserGrantAnswer,
      });
    } catch {
      ok = false;
    }
    if (!ok) return { ok: false, status: 403, reason: "that answer was not signed by the owner" };
    const g = this.o.grants.approve(
      { serviceId: h.ask.serviceId, capabilities: h.ask.capabilities, origins: h.ask.origins, localNetwork: h.ask.localNetwork, duration: h.ask.duration, explanation: h.ask.explanation, schemes: ["https"] },
      h.ask.duration === "session" ? { sessionId: contextSession(h.ask.serviceId) } : {},
    );
    h.status = "allowed";
    h.grantId = g.id;
    this.cooling.delete(this.key(h.ask));
    return { ok: true };
  }

  /** The app was removed: its requests and cooldowns go with it. */
  forgetService(serviceId: string): void {
    for (const [id, h] of this.held) if (h.ask.serviceId === serviceId) this.held.delete(id);
    for (const k of [...this.cooling.keys()]) if (k.startsWith(`${serviceId}|`)) this.cooling.delete(k);
  }
}
