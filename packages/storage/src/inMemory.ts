import type {
  AutoUnlockLeaseRecord,
  AutoUnlockLeaseStorage,
  PendingUnlockApprovalRecord,
  PendingUnlockApprovalStorage,
  WebauthnRecoveryRecord,
  WebauthnRecoveryStorage,
  EntitlementRevocationListRecord,
  EntitlementRevocationStorage,
  AuthCodeRecord,
  AuthCodeStorage,
  BuildTicketRecord,
  BuildTicketStorage,
  InstallEvent,
  InstallEventStorage,
  LlmPromoLifetimeRecord,
  LlmPromoStorage,
  LlmPromoUsageRecord,
  LuksKeyStorage,
  MarketplaceListingRecord,
  MarketplaceSearchQuery,
  MarketplaceStorage,
  PushTokenRecord,
  PushTokenStorage,
  RoutingRecord,
  RoutingStorage,
  SealedLuksKeyRecord,
  ServerRecord,
  ServerStorage,
  Storage,
  TierStorage,
  TierSubscriptionRecord,
  UnlockKeyDeposit,
  UsernameRecord,
  UsernameStorage,
} from "./types.js";

/**
 * Reference in-process implementations of the storage interfaces.
 * Used by tests and by dev runs of the Fastify server.
 */

export class InMemoryUsernameStorage implements UsernameStorage {
  private byName = new Map<string, UsernameRecord>();
  async put(rec: UsernameRecord) {
    const norm = rec.username.toLowerCase();
    const existing = this.byName.get(norm);
    if (existing && existing.irkPubHex !== rec.irkPubHex) {
      return { ok: false as const, reason: "username already claimed" };
    }
    this.byName.set(norm, { ...rec, username: norm });
    return { ok: true as const };
  }
  async get(username: string) {
    const r = this.byName.get(username.toLowerCase());
    return r ? { ...r } : undefined;
  }
  async list() {
    return [...this.byName.values()].map((r) => ({ ...r }));
  }
}

export class InMemoryAuthCodeStorage implements AuthCodeStorage {
  private bySerial = new Map<string, AuthCodeRecord>();
  async put(rec: AuthCodeRecord) {
    if (this.bySerial.has(rec.serial)) {
      return { ok: false as const, reason: "serial already issued" };
    }
    this.bySerial.set(rec.serial, { ...rec });
    return { ok: true as const };
  }
  async get(serial: string) {
    const r = this.bySerial.get(serial);
    return r ? { ...r } : undefined;
  }
  async markUsed(serial: string, now: number) {
    const r = this.bySerial.get(serial);
    if (!r) return { ok: false as const, reason: "unknown serial" };
    if (r.status === "used") return { ok: false as const, reason: "already used" };
    if (r.status === "revoked") return { ok: false as const, reason: "revoked" };
    if (now > r.expiresAt) return { ok: false as const, reason: "expired" };
    r.status = "used";
    r.usedAt = now;
    return { ok: true as const };
  }
  async markRevoked(serial: string, now: number) {
    const r = this.bySerial.get(serial);
    if (!r) return { ok: false as const, reason: "unknown serial" };
    if (r.status === "revoked") return { ok: true as const };
    r.status = "revoked";
    r.revokedAt = now;
    return { ok: true as const };
  }
}

export class InMemoryBuildTicketStorage implements BuildTicketStorage {
  private byCode = new Map<string, BuildTicketRecord>();
  async put(rec: BuildTicketRecord) {
    if (this.byCode.has(rec.code)) {
      return { ok: false as const, reason: "code collision" };
    }
    this.byCode.set(rec.code, { ...rec });
    return { ok: true as const };
  }
  async get(code: string) {
    const r = this.byCode.get(code);
    return r ? { ...r } : undefined;
  }
  async refresh(code: string, expiresAt: number) {
    const r = this.byCode.get(code);
    if (!r) return { ok: false as const, reason: "unknown code" };
    if (r.status === "revoked") return { ok: false as const, reason: "revoked" };
    r.expiresAt = expiresAt;
    return { ok: true as const };
  }
  async markRedeemed(code: string, now: number) {
    const r = this.byCode.get(code);
    if (!r) return;
    r.status = "redeemed";
    r.redeemedAt = now;
    r.redemptions += 1;
  }
}

export class InMemoryServerStorage implements ServerStorage {
  private byDomain = new Map<string, ServerRecord>();
  async put(rec: ServerRecord) {
    this.byDomain.set(rec.serverDomain, { ...rec });
  }
  async get(serverDomain: string) {
    const r = this.byDomain.get(serverDomain);
    return r ? { ...r } : undefined;
  }
  async listForUser(username: string) {
    return [...this.byDomain.values()]
      .filter((r) => r.username === username)
      .map((r) => ({ ...r }));
  }
  async listAll() {
    return [...this.byDomain.values()].map((r) => ({ ...r }));
  }
  async revoke(serverDomain: string, reason: string, at: number) {
    const r = this.byDomain.get(serverDomain);
    if (!r) return false;
    r.revokedAt = at;
    r.revocationReason = reason;
    return true;
  }
}

export class InMemoryRoutingStorage implements RoutingStorage {
  private bySubdomain = new Map<string, RoutingRecord>();
  async register(rec: RoutingRecord) {
    const existing = this.bySubdomain.get(rec.subdomain);
    if (existing && existing.rckPubKeyHex !== rec.rckPubKeyHex) {
      return { ok: false as const, reason: "subdomain already controlled by a different RCK" };
    }
    this.bySubdomain.set(rec.subdomain, { ...rec });
    return { ok: true as const };
  }
  async get(subdomain: string) {
    const r = this.bySubdomain.get(subdomain);
    return r ? { ...r } : undefined;
  }
  async setTarget(subdomain: string, newTargetHex: string, nonce: string, at: number) {
    const r = this.bySubdomain.get(subdomain);
    if (!r) return { ok: false as const, reason: "unknown subdomain" };
    if (r.lastTargetNonce && nonce <= r.lastTargetNonce) {
      return { ok: false as const, reason: "stale nonce (replay)" };
    }
    r.currentTargetHex = newTargetHex;
    r.lastTargetUpdate = at;
    r.lastTargetNonce = nonce;
    return { ok: true as const };
  }
}

export class InMemoryInstallEventStorage implements InstallEventStorage {
  private bySerial = new Map<string, InstallEvent[]>();
  private maxPerSerial = 100;
  async put(rec: Omit<InstallEvent, "seq">) {
    const arr = this.bySerial.get(rec.serial) ?? [];
    const seq = arr.length === 0 ? 1 : arr[arr.length - 1]!.seq + 1;
    arr.push({ ...rec, seq });
    while (arr.length > this.maxPerSerial) arr.shift();
    this.bySerial.set(rec.serial, arr);
    return { ok: true as const, seq };
  }
  async list(serial: string, sinceSeq = 0) {
    const arr = this.bySerial.get(serial) ?? [];
    return arr.filter((e) => e.seq > sinceSeq).map((e) => ({ ...e }));
  }
}

export class InMemoryLuksKeyStorage implements LuksKeyStorage {
  private sealed = new Map<string, SealedLuksKeyRecord>();
  private unlock = new Map<string, UnlockKeyDeposit>();
  async putSealed(rec: SealedLuksKeyRecord): Promise<void> {
    this.sealed.set(rec.serverDomain, { ...rec });
  }
  async getSealed(serverDomain: string): Promise<SealedLuksKeyRecord | undefined> {
    const r = this.sealed.get(serverDomain);
    return r ? { ...r } : undefined;
  }
  async putUnlock(rec: UnlockKeyDeposit): Promise<void> {
    this.unlock.set(rec.serverDomain, { ...rec });
  }
  async consumeUnlock(serverDomain: string, now: number): Promise<UnlockKeyDeposit | undefined> {
    const r = this.unlock.get(serverDomain);
    if (!r) return undefined;
    this.unlock.delete(serverDomain);
    if (r.expiresAt <= now) return undefined;
    return { ...r };
  }
}

export class InMemoryMarketplaceStorage implements MarketplaceStorage {
  private listings = new Map<string, MarketplaceListingRecord>();
  private key(c: string, s: string) { return `${c.toLowerCase()}/${s.toLowerCase()}`; }
  async upsert(rec: MarketplaceListingRecord): Promise<void> {
    this.listings.set(this.key(rec.creator, rec.slug), { ...rec });
  }
  async get(creator: string, slug: string): Promise<MarketplaceListingRecord | undefined> {
    const r = this.listings.get(this.key(creator, slug));
    return r ? { ...r } : undefined;
  }
  async search(q: MarketplaceSearchQuery): Promise<MarketplaceListingRecord[]> {
    const limit = q.limit ?? 30;
    const offset = q.offset ?? 0;
    let all = [...this.listings.values()].filter((l) => l.status === "listed");
    if (q.category) all = all.filter((l) => l.category === q.category);
    if (q.verifiedOnly) all = all.filter((l) => !!l.scanGrade);
    if (q.text) {
      const needle = q.text.toLowerCase();
      all = all.filter((l) =>
        l.name.toLowerCase().includes(needle) ||
        l.tagline.toLowerCase().includes(needle) ||
        l.tagsCsv.toLowerCase().includes(needle),
      );
    }
    switch (q.sort ?? "popular") {
      case "popular":
        all.sort((a, b) => b.rankScore - a.rankScore || b.installCount - a.installCount);
        break;
      case "newest":
        all.sort((a, b) => b.listedAt - a.listedAt);
        break;
      case "name":
        all.sort((a, b) => a.name.localeCompare(b.name));
        break;
    }
    return all.slice(offset, offset + limit).map((r) => ({ ...r }));
  }
  async remove(creator: string, slug: string): Promise<void> {
    const key = this.key(creator, slug);
    const r = this.listings.get(key);
    if (r) this.listings.set(key, { ...r, status: "removed" });
  }
  async recordInstall(creator: string, slug: string): Promise<void> {
    const r = this.listings.get(this.key(creator, slug));
    if (r) {
      r.installCount += 1;
      r.rankScore = computeMarketplaceRank(r);
    }
  }
}

export function computeMarketplaceRank(l: MarketplaceListingRecord): number {
  const installs = Math.log10(l.installCount + 1) * 4;
  const recency = Math.max(0, 30 - (Date.now() - l.updatedAt) / 86_400_000);
  const grade = l.scanGrade ? { A: 5, B: 3, C: 1, D: -2, F: -5 }[l.scanGrade] : 0;
  const featured = l.featuredUntil && l.featuredUntil > Date.now() ? 10 : 0;
  return installs + recency + grade + featured;
}

export class InMemoryPushTokenStorage implements PushTokenStorage {
  private byId = new Map<string, PushTokenRecord>();
  async put(rec: PushTokenRecord): Promise<void> { this.byId.set(rec.tokenId, { ...rec }); }
  async get(tokenId: string): Promise<PushTokenRecord | undefined> {
    const r = this.byId.get(tokenId);
    return r ? { ...r } : undefined;
  }
  async listByUser(username: string): Promise<PushTokenRecord[]> {
    return [...this.byId.values()].filter((r) => r.username === username).map((r) => ({ ...r }));
  }
  async remove(tokenId: string): Promise<void> { this.byId.delete(tokenId); }
  async touchLastSeen(tokenId: string, at: number): Promise<void> {
    const r = this.byId.get(tokenId);
    if (r) r.lastSeenAt = at;
  }
}

export class InMemoryLlmPromoStorage implements LlmPromoStorage {
  private daily = new Map<string, LlmPromoUsageRecord>();
  private lifetime = new Map<string, LlmPromoLifetimeRecord>();
  private dailyKey(u: string, d: number) { return `${u}|${d}`; }
  async getDaily(u: string, d: number) { const r = this.daily.get(this.dailyKey(u, d)); return r ? { ...r } : undefined; }
  async bumpDaily(u: string, d: number, i: number, o: number): Promise<LlmPromoUsageRecord> {
    const k = this.dailyKey(u, d);
    const cur = this.daily.get(k) ?? { username: u, day: d, dailyCount: 0, dailyInputTokens: 0, dailyOutputTokens: 0 };
    const next = { ...cur, dailyCount: cur.dailyCount + 1, dailyInputTokens: cur.dailyInputTokens + i, dailyOutputTokens: cur.dailyOutputTokens + o };
    this.daily.set(k, next);
    return { ...next };
  }
  async getLifetime(u: string) { const r = this.lifetime.get(u); return r ? { ...r } : undefined; }
  async bumpLifetime(u: string, i: number, o: number, now: number): Promise<LlmPromoLifetimeRecord> {
    const cur = this.lifetime.get(u) ?? { username: u, lifetimeCount: 0, lifetimeInputTokens: 0, lifetimeOutputTokens: 0, updatedAt: now };
    const next = { ...cur, lifetimeCount: cur.lifetimeCount + 1, lifetimeInputTokens: cur.lifetimeInputTokens + i, lifetimeOutputTokens: cur.lifetimeOutputTokens + o, updatedAt: now };
    this.lifetime.set(u, next);
    return { ...next };
  }
}

export class InMemoryTierStorage implements TierStorage {
  private byUser = new Map<string, TierSubscriptionRecord>();
  async get(u: string) { const r = this.byUser.get(u); return r ? { ...r } : undefined; }
  async put(r: TierSubscriptionRecord): Promise<void> { this.byUser.set(r.username, { ...r }); }
}

export class InMemoryEntitlementRevocationStorage implements EntitlementRevocationStorage {
  private byUser = new Map<string, EntitlementRevocationListRecord>();
  async putIfNewer(rec: EntitlementRevocationListRecord) {
    const existing = this.byUser.get(rec.username);
    if (existing && rec.issuedAt <= existing.issuedAt) {
      return { stored: { ...existing }, accepted: false };
    }
    this.byUser.set(rec.username, { ...rec });
    return { stored: { ...rec }, accepted: true };
  }
  async get(username: string) {
    const r = this.byUser.get(username);
    return r ? { ...r } : undefined;
  }
}

export class InMemoryAutoUnlockLeaseStorage implements AutoUnlockLeaseStorage {
  // Composite key: `${serverDomain} ${leaseId}`
  private rows = new Map<string, AutoUnlockLeaseRecord>();
  private k(server: string, lease: string): string {
    return `${server} ${lease}`;
  }

  async put(rec: AutoUnlockLeaseRecord): Promise<void> {
    this.rows.set(this.k(rec.serverDomain, rec.leaseId), { ...rec });
  }

  async consume(
    serverDomain: string,
    now: number,
  ): Promise<AutoUnlockLeaseRecord | undefined> {
    // Find the most-recently-deposited non-expired lease for this
    // server. Multiple devices may have signed leases concurrently;
    // we return the freshest. Expired rows are GC'd opportunistically.
    let best: AutoUnlockLeaseRecord | undefined;
    const expired: string[] = [];
    for (const [k, r] of this.rows) {
      if (r.serverDomain !== serverDomain) continue;
      if (r.expiresAt <= now) {
        expired.push(k);
        continue;
      }
      if (!best || r.depositedAt > best.depositedAt) best = r;
    }
    for (const k of expired) this.rows.delete(k);
    if (!best) return undefined;
    if (!best.multiUse) {
      this.rows.delete(this.k(best.serverDomain, best.leaseId));
    }
    return { ...best };
  }

  async revoke(serverDomain: string, leaseId: string): Promise<boolean> {
    return this.rows.delete(this.k(serverDomain, leaseId));
  }

  async list(
    serverDomain: string,
    now: number,
  ): Promise<AutoUnlockLeaseRecord[]> {
    const out: AutoUnlockLeaseRecord[] = [];
    for (const r of this.rows.values()) {
      if (r.serverDomain !== serverDomain) continue;
      if (r.expiresAt <= now) continue;
      out.push({ ...r });
    }
    return out.sort((a, b) => b.depositedAt - a.depositedAt);
  }
}

export class InMemoryWebauthnRecoveryStorage implements WebauthnRecoveryStorage {
  private rows = new Map<string, WebauthnRecoveryRecord>();
  private k(u: string): string { return u.toLowerCase(); }
  async upsert(rec: WebauthnRecoveryRecord): Promise<void> {
    this.rows.set(this.k(rec.username), { ...rec });
  }
  async get(username: string): Promise<WebauthnRecoveryRecord | undefined> {
    const r = this.rows.get(this.k(username));
    return r ? { ...r } : undefined;
  }
  async delete(username: string): Promise<boolean> {
    return this.rows.delete(this.k(username));
  }
}

export class InMemoryPendingUnlockApprovalStorage implements PendingUnlockApprovalStorage {
  private rows = new Map<string, PendingUnlockApprovalRecord>();

  async upsertWithDedup(
    serverDomain: string,
    requestId: string,
    now: number,
    pushDedupMs: number,
  ): Promise<{ requestId: string; shouldPush: boolean }> {
    const existing = this.rows.get(serverDomain);
    if (!existing) {
      this.rows.set(serverDomain, { serverDomain, requestId, requestedAt: now, lastPushAt: 0 });
      return { requestId, shouldPush: true };
    }
    const shouldPush = now - existing.lastPushAt > pushDedupMs;
    return { requestId: existing.requestId, shouldPush };
  }

  async touchLastPushAt(serverDomain: string, at: number): Promise<void> {
    const r = this.rows.get(serverDomain);
    if (r) r.lastPushAt = at;
  }

  async get(serverDomain: string): Promise<PendingUnlockApprovalRecord | undefined> {
    const r = this.rows.get(serverDomain);
    return r ? { ...r } : undefined;
  }

  async delete(serverDomain: string): Promise<boolean> {
    return this.rows.delete(serverDomain);
  }
}

export class InMemoryStorage implements Storage {
  usernames = new InMemoryUsernameStorage();
  authCodes = new InMemoryAuthCodeStorage();
  buildTickets = new InMemoryBuildTicketStorage();
  servers = new InMemoryServerStorage();
  routing = new InMemoryRoutingStorage();
  installEvents = new InMemoryInstallEventStorage();
  luksKeys = new InMemoryLuksKeyStorage();
  autoUnlockLeases = new InMemoryAutoUnlockLeaseStorage();
  pendingUnlockApprovals = new InMemoryPendingUnlockApprovalStorage();
  webauthnRecovery = new InMemoryWebauthnRecoveryStorage();
  marketplace = new InMemoryMarketplaceStorage();
  pushTokens = new InMemoryPushTokenStorage();
  llmPromo = new InMemoryLlmPromoStorage();
  tiers = new InMemoryTierStorage();
  entitlementRevocations = new InMemoryEntitlementRevocationStorage();
}
