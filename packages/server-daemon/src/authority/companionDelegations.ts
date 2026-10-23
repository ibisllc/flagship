/**
 * Delegations to Remote sessions (SECURITY-HARDENING-PLAN.md §16.2, SEC-AUTH-002). A delegation is a
 * grant below the Remote session's own grant, so ending the session, or revoking it, ends the
 * delegation and cancels the work it was funding. It is verified on every route it opens.
 */
import { createHash } from "node:crypto";
import { parseCompanionDelegation, verifyCompanionDelegation, COMPANION_DELEGATION_MAX_MS, type CompanionDelegation, type CompanionDelegationOp } from "@flagship/protocol";
import type { AuthorityHub } from "./hub.js";
import { sessionGrantId } from "./sessionWork.js";

export interface DelegationSessions {
  companionRefByListedId(listedId: string): { ref: string; expiresAt: number | null } | null;
}

export type DelegationResult = { ok: true; grantId: string; expiresAt: number } | { ok: false; status: 400 | 403 | 404; reason: string };

const grantIdOf = (sessionRef: string, serviceRef: string) => `companion-delegation:${sessionRef}:${serviceRef}`;

export class CompanionDelegations {
  /** The app a build session is changing; wired once the build registry exists. */
  buildSessionService: (sessionId: string) => string | null = () => null;

  constructor(
    private readonly hub: AuthorityHub,
    private readonly sessions: DelegationSessions,
    /** True when the signature is an admin's (the phone's sensitive key). The caller binds it to the account. */
    private readonly signedByAdmin: (d: CompanionDelegation, sig: Uint8Array, verify: typeof verifyCompanionDelegation) => boolean,
    private readonly serviceInstalled: (serviceRef: string) => boolean,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async grant(raw: unknown, signatureHex: string): Promise<DelegationResult> {
    const d = parseCompanionDelegation(raw);
    if (!d) return { ok: false, status: 400, reason: "malformed delegation" };
    if (!/^[0-9a-f]{128}$/.test(signatureHex)) return { ok: false, status: 400, reason: "malformed signature" };
    const t = this.now();
    if (Math.abs(t - d.issuedAt) > 10 * 60_000) return { ok: false, status: 403, reason: "stale delegation" };
    if (d.expiresAt - d.issuedAt > COMPANION_DELEGATION_MAX_MS) return { ok: false, status: 400, reason: "a delegation lasts at most a day" };
    if (d.expiresAt <= t) return { ok: false, status: 400, reason: "already expired" };
    if (!this.signedByAdmin(d, Uint8Array.from(Buffer.from(signatureHex, "hex")), verifyCompanionDelegation)) {
      return { ok: false, status: 403, reason: "only an admin device can let a Remote session build" };
    }
    const session = this.sessions.companionRefByListedId(d.sessionId);
    if (!session) return { ok: false, status: 404, reason: "that Remote session is not active" };
    // Never past the session's own end.
    if (session.expiresAt !== null && d.expiresAt > session.expiresAt) return { ok: false, status: 400, reason: "a delegation cannot outlast its session" };
    if (!this.serviceInstalled(d.serviceRef)) return { ok: false, status: 404, reason: "that app is not on this server" };
    // A fresh signature replaces the earlier grant for the same session and app.
    for (const g of this.hub.grants.all()) {
      if (g.kind === "companion-delegation" && g.subject === session.ref && g.service === d.serviceRef && g.revokedAt === null) {
        await this.hub.revoke(g.id, "replaced by a new delegation");
      }
    }
    const id = `${grantIdOf(session.ref, d.serviceRef)}#${createHash("sha256").update(signatureHex).digest("hex").slice(0, 8)}`;
    const parent = sessionGrantIdFromRef(session.ref);
    await this.hub.grants.issue({
      id,
      kind: "companion-delegation",
      issuer: "owner",
      subject: session.ref,
      accountGeneration: 1,
      service: d.serviceRef,
      audience: "box",
      capability: [...new Set(d.ops)].sort().join(","),
      parents: [parent],
      policyRevision: 1,
      issuedAt: t,
      expiresAt: d.expiresAt,
    });
    return { ok: true, grantId: id, expiresAt: d.expiresAt };
  }

  /** May this Remote session do `op` to `serviceRef` right now? */
  allows(token: string, serviceRef: string, op: CompanionDelegationOp): boolean {
    const ref = sessionGrantIdFromToken(token);
    const t = this.now();
    return this.hub.grants.all().some(
      (g) => g.kind === "companion-delegation" && g.service === serviceRef && g.subject === ref && g.capability.split(",").includes(op) && this.hub.grants.isLive(g.id, t),
    );
  }

  /** Delegations in force for this session, for the owner's session list. */
  forSession(listedId: string): Array<{ serviceRef: string; ops: string[]; expiresAt: number | null }> {
    const s = this.sessions.companionRefByListedId(listedId);
    if (!s) return [];
    const t = this.now();
    return this.hub.grants.all()
      .filter((g) => g.kind === "companion-delegation" && g.subject === s.ref && this.hub.grants.isLive(g.id, t))
      .map((g) => ({ serviceRef: g.service!, ops: g.capability.split(","), expiresAt: g.expiresAt }));
  }

  async revoke(listedId: string, serviceRef: string): Promise<number> {
    const s = this.sessions.companionRefByListedId(listedId);
    if (!s) return 0;
    let n = 0;
    for (const g of this.hub.grants.all()) {
      if (g.kind === "companion-delegation" && g.subject === s.ref && g.service === serviceRef && g.revokedAt === null) {
        await this.hub.revoke(g.id, "revoked by the owner");
        n++;
      }
    }
    return n;
  }
}

function sessionGrantIdFromRef(ref: string): string {
  return `companion-session:${ref}`;
}

function sessionGrantIdFromToken(token: string): string {
  return sessionGrantId(token, true).split(":")[1]!;
}
