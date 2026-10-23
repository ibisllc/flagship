/**
 * Token families: how a store of bearer tokens (paired sessions, API keys, IDE keys) joins the
 * authority index. A store calls `issue` when it mints a token, asks `isLive` before honouring
 * one, and hands the family a `drop` function; revoking a parent grant then removes the tokens
 * below it from the store, not just from the index.
 *
 * A token the index does not know is not live. A store backfills its existing tokens once at boot
 * with `adopt`, so an upgrade does not sign anyone out, and from then on only issued tokens count.
 */
import { createHash } from "node:crypto";
import type { AuthorityHub } from "./hub.js";
import type { Grant, GrantKind } from "./grantIndex.js";

export interface FamilyIssue {
  /** The store's own reference for the token (a key id, or a fingerprint of a session token). */
  ref: string;
  service?: string;
  /** Grants it derives from (the device, the app, the chat). */
  parents?: string[];
  capability: string;
  subject?: string;
  expiresAt?: number | null;
  secretAccess?: boolean;
  issuedAt?: number;
}

export class TokenFamily {
  constructor(
    private readonly hub: AuthorityHub,
    readonly kind: GrantKind,
    private readonly issuer: string,
    private readonly accountGeneration = 1,
    private readonly policyRevision = () => 1,
    private readonly now: () => number = () => Date.now(),
  ) {}

  grantId(ref: string): string {
    return `${this.kind}:${ref}`;
  }

  async issue(i: FamilyIssue): Promise<Grant> {
    return this.hub.grants.issue({
      id: this.grantId(i.ref),
      kind: this.kind,
      issuer: this.issuer,
      subject: i.subject ?? i.ref,
      accountGeneration: this.accountGeneration,
      ...(i.service ? { service: i.service } : {}),
      audience: "box",
      capability: i.capability,
      parents: i.parents ?? [],
      policyRevision: this.policyRevision(),
      issuedAt: i.issuedAt ?? this.now(),
      expiresAt: i.expiresAt ?? null,
      ...(i.secretAccess ? { secretAccess: true } : {}),
    });
  }

  /** Backfill a token that existed before the index did. Idempotent. */
  async adopt(i: FamilyIssue): Promise<void> {
    if (this.hub.grants.get(this.grantId(i.ref))) return;
    try {
      await this.issue(i);
    } catch {
      /* a parent that no longer exists leaves it unadopted, so it is refused */
    }
  }

  isLive(ref: string): boolean {
    return this.hub.grants.isLive(this.grantId(ref), this.now());
  }

  /** Route revocation of this family's grants to the store. */
  onRevoked(drop: (ref: string, grant: Grant) => void | Promise<void>): void {
    this.hub.onRevoked(this.kind, (g) => drop(g.id.slice(this.kind.length + 1), g));
  }

  async revoke(ref: string, reason: string): Promise<void> {
    await this.hub.revoke(this.grantId(ref), reason);
  }
}

/** A short stable fingerprint for a bearer token, so the index never holds the token itself. */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 32);
}
