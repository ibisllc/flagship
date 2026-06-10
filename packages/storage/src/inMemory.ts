import type {
  WatchDelegateRecord,
  WatchDelegateStorage,
  AcmeAccountKeyGrantRecord,
  AcmeAccountKeyGrantStorage,
  AcmeAccountKeyDeliveryRecord,
  AcmeAccountKeyDeliveryStorage,
  MintReservationRecord,
  MintReservationStorage,
  AuditEventRecord,
  AuditEventStorage,
  AutoUnlockLeaseRecord,
  AutoUnlockLeaseStorage,
  SecretMailboxRecord,
  SecretMailboxStorage,
  BoxSealedLeaseRecord,
  BoxSealedLeaseStorage,
  PendingRePairRecord,
  PendingRePairStorage,
  WebauthnRecoveryRecord,
  WebauthnRecoveryStorage,
  EntitlementRevocationListRecord,
  EntitlementRevocationStorage,
  AuthCodeRecord,
  AuthCodeStorage,
  InstallEvent,
  InstallEventStorage,
  ProvisionStatusRecord,
  ProvisionStatusHistoryEntry,
  ProvisionStatusStorage,
  LlmPromoLifetimeRecord,
  LlmPromoStorage,
  LlmPromoUsageRecord,
  LuksKeyStorage,
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
  UserIdentityRecord,
  UserIdentityRecordStorage,
  UsernameAliasRecord,
  UsernameAliasStorage,
  UsernameRecord,
  UsernameStorage,
  DaemonStatusRecord,
  DaemonStatusStorage,
  UserServiceAliasRecord,
  UserServiceAliasStorage,
  VoiciLinkRecord,
  VoiciLinkStorage,
  CustomDomainOrderRecord,
  CustomDomainOrderStorage,
  DemoLlmLedgerStorage,
  DemoUserRecord,
  DemoUserState,
  DemoUsersStorage,
  InstallPolicyFanoutRecord,
  InstallPolicyFanoutStorage,
  DeviceCapabilityGrantRecord,
  DeviceCapabilityGrantStorage,
  NameClaimRecord,
  NamespaceStorage,
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
    // A re-claim (same IRK) must not silently clear an already-set
    // demo flag: only an explicit isDemo on the incoming record, or
    // setDemo(), changes it. The same preservation logic applies to
    // the v1.2 fields (accountType + TOTP enrolment artifacts) — a
    // benign re-put with `accountType` absent must keep the existing
    // value, otherwise a recovery flow re-claim could silently kick
    // a multi-device account back to single-device.
    this.byName.set(norm, {
      ...rec,
      username: norm,
      isDemo: rec.isDemo ?? existing?.isDemo ?? false,
      accountType: rec.accountType ?? existing?.accountType ?? "single",
      totpSecretEncrypted:
        rec.totpSecretEncrypted ?? existing?.totpSecretEncrypted,
      recoveryCodesHashesJson:
        rec.recoveryCodesHashesJson ?? existing?.recoveryCodesHashesJson,
      totpEnrolledAt: rec.totpEnrolledAt ?? existing?.totpEnrolledAt,
      // v2.1 — recovery-wipe policy survives a benign re-put. Absent
      // on incoming + existing → 'graceful' (the migration default).
      recoveryWipePolicy:
        rec.recoveryWipePolicy ??
        existing?.recoveryWipePolicy ??
        "graceful",
    });
    return { ok: true as const };
  }
  async get(username: string) {
    const r = this.byName.get(username.toLowerCase());
    return r ? { ...r } : undefined;
  }
  async list() {
    return [...this.byName.values()].map((r) => ({ ...r }));
  }
  async swapIrkPub(username: string, expectedOldIrkPubHex: string, newIrkPubHex: string, at: number) {
    const norm = username.toLowerCase();
    const r = this.byName.get(norm);
    if (!r) return false;
    if (r.irkPubHex.toLowerCase() !== expectedOldIrkPubHex.toLowerCase()) return false;
    this.byName.set(norm, { ...r, irkPubHex: newIrkPubHex, claimedAt: at });
    return true;
  }
  async setDemo(username: string, isDemo: boolean) {
    const norm = username.toLowerCase();
    const r = this.byName.get(norm);
    if (!r) return false;
    this.byName.set(norm, { ...r, isDemo });
    return true;
  }
  async setTotpSecretEncrypted(username: string, encrypted: string) {
    const norm = username.toLowerCase();
    const r = this.byName.get(norm);
    if (!r) return false;
    this.byName.set(norm, { ...r, totpSecretEncrypted: encrypted });
    return true;
  }
  async finalizeTotpEnrollment(
    username: string,
    at: number,
    recoveryCodesHashesJson: string,
  ) {
    const norm = username.toLowerCase();
    const r = this.byName.get(norm);
    if (!r) return false;
    this.byName.set(norm, {
      ...r,
      accountType: "multi",
      totpEnrolledAt: at,
      recoveryCodesHashesJson,
    });
    return true;
  }
  async clearTotp(username: string) {
    const norm = username.toLowerCase();
    const r = this.byName.get(norm);
    if (!r) return false;
    const next: UsernameRecord = {
      username: r.username,
      irkPubHex: r.irkPubHex,
      claimedAt: r.claimedAt,
      accountType: "single",
    };
    if (r.isDemo !== undefined) next.isDemo = r.isDemo;
    // v2.1 — wipe policy is independent of TOTP state. Preserve it.
    if (r.recoveryWipePolicy !== undefined) {
      next.recoveryWipePolicy = r.recoveryWipePolicy;
    }
    this.byName.set(norm, next);
    return true;
  }
  async casRecoveryCodes(
    username: string,
    expectedJson: string,
    newJson: string,
  ) {
    const norm = username.toLowerCase();
    const r = this.byName.get(norm);
    if (!r) return false;
    // Match by string equality. `undefined ⇄ ""` collapses so the
    // caller can pass `""` for the "no-codes" baseline.
    const current = r.recoveryCodesHashesJson ?? "";
    if (current !== expectedJson) return false;
    this.byName.set(norm, { ...r, recoveryCodesHashesJson: newJson });
    return true;
  }
}

export class InMemoryUsernameAliasStorage implements UsernameAliasStorage {
  private byOld = new Map<string, UsernameAliasRecord>();
  async put(rec: UsernameAliasRecord) {
    const oldNorm = rec.oldUsername.toLowerCase();
    const newNorm = rec.newUsername.toLowerCase();
    const existing = this.byOld.get(oldNorm);
    if (existing && existing.newUsername.toLowerCase() !== newNorm) {
      return { ok: false as const, reason: "alias already points elsewhere" };
    }
    this.byOld.set(oldNorm, { ...rec, oldUsername: oldNorm, newUsername: newNorm });
    return { ok: true as const };
  }
  async resolve(username: string) {
    const chain: string[] = [];
    let current = username.toLowerCase();
    chain.push(current);
    for (let hops = 0; hops < 8; hops++) {
      const next = this.byOld.get(current);
      if (!next) break;
      current = next.newUsername.toLowerCase();
      chain.push(current);
    }
    return { current, chain };
  }
  async isConsumed(username: string) {
    const norm = username.toLowerCase();
    if (this.byOld.has(norm)) return true;
    for (const v of this.byOld.values()) {
      if (v.newUsername.toLowerCase() === norm) return true;
    }
    return false;
  }
}

export class InMemoryPendingRePairStorage implements PendingRePairStorage {
  private rows = new Map<string, PendingRePairRecord>();
  async initiate(rec: PendingRePairRecord) {
    const key = rec.username.toLowerCase();
    if (this.rows.has(key)) return { ok: false as const, reason: "re-pair already pending" };
    // v1.2 — capture defaults so callers that don't yet set the new
    // fields land a 24h grace + no-TOTP row, matching the SQL DEFAULTs.
    this.rows.set(key, {
      ...rec,
      username: key,
      graceSeconds: rec.graceSeconds ?? 86_400,
      totpRequired: rec.totpRequired ?? false,
      totpProofConsumed: rec.totpProofConsumed ?? false,
      alertsFiredBitmap: rec.alertsFiredBitmap ?? 0,
    });
    return { ok: true as const };
  }
  async get(username: string) {
    const r = this.rows.get(username.toLowerCase());
    return r ? { ...r } : undefined;
  }
  async object(username: string, at: number) {
    const r = this.rows.get(username.toLowerCase());
    if (!r) return false;
    r.objectedAt = at;
    return true;
  }
  async delete(username: string) {
    return this.rows.delete(username.toLowerCase());
  }
  async listActive(limit = 100): Promise<PendingRePairRecord[]> {
    const all = [...this.rows.values()]
      .filter((r) => r.objectedAt === undefined)
      .sort((a, b) => a.initiatedAt - b.initiatedAt)
      .slice(0, Math.max(0, limit));
    return all.map((r) => ({ ...r }));
  }
  async orInAlertsFiredBit(username: string, bit: number): Promise<number> {
    const r = this.rows.get(username.toLowerCase());
    if (!r) return 0;
    r.alertsFiredBitmap = (r.alertsFiredBitmap ?? 0) | bit;
    return r.alertsFiredBitmap;
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
  async listActiveByServerDomain(serverDomain: string) {
    return [...this.bySerial.values()]
      .filter((r) => r.serverDomain === serverDomain && r.status === "active")
      .map((r) => ({ ...r }));
  }
  async listOutstandingByUsername(username: string, now: number) {
    return [...this.bySerial.values()]
      .filter(
        (r) =>
          r.username === username && r.status === "active" && r.expiresAt > now,
      )
      .map((r) => ({ ...r }));
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
  async release(subdomain: string) {
    this.bySubdomain.delete(subdomain);
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

export class InMemoryProvisionStatusStorage implements ProvisionStatusStorage {
  private bySerial = new Map<string, ProvisionStatusRecord>();
  async putProvisionStatus(
    serial: string,
    entry: { serverDomain?: string; phase: string; detail?: string; ts: number },
  ): Promise<void> {
    const existing = this.bySerial.get(serial);
    const historyEntry: ProvisionStatusHistoryEntry = {
      phase: entry.phase,
      ts: entry.ts,
      ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
    };
    const next: ProvisionStatusRecord = {
      serial,
      serverDomain: entry.serverDomain ?? existing?.serverDomain,
      phase: entry.phase,
      detail: entry.detail,
      updatedAt: entry.ts,
      history: [...(existing?.history ?? []), historyEntry],
    };
    this.bySerial.set(serial, next);
  }
  async getProvisionStatus(serial: string): Promise<ProvisionStatusRecord | null> {
    const r = this.bySerial.get(serial);
    return r ? { ...r, history: r.history.map((h) => ({ ...h })) } : null;
  }
}

export class InMemoryLuksKeyStorage implements LuksKeyStorage {
  private sealed = new Map<string, SealedLuksKeyRecord>();
  async putSealed(rec: SealedLuksKeyRecord): Promise<void> {
    this.sealed.set(rec.serverDomain, { ...rec });
  }
  async getSealed(serverDomain: string): Promise<SealedLuksKeyRecord | undefined> {
    const r = this.sealed.get(serverDomain);
    return r ? { ...r } : undefined;
  }
  async deleteSealed(serverDomain: string): Promise<void> {
    this.sealed.delete(serverDomain);
  }
}

export class InMemoryPushTokenStorage implements PushTokenStorage {
  private byId = new Map<string, PushTokenRecord>();
  async put(rec: PushTokenRecord): Promise<void> {
    // v1.2 — default quarantineUntil to 0 (already-trusted) when the
    // caller doesn't set it, matching the SQL column default. Lets
    // pre-cascade callers (Phase 2 hasn't shipped yet) keep working
    // without touching every put-site.
    this.byId.set(rec.tokenId, {
      ...rec,
      quarantineUntil: rec.quarantineUntil ?? 0,
      quarantineAlertsFiredBitmap: rec.quarantineAlertsFiredBitmap ?? 0,
    });
  }
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
  async setQuarantineUntil(tokenId: string, untilMs: number): Promise<boolean> {
    const r = this.byId.get(tokenId);
    if (!r) return false;
    r.quarantineUntil = untilMs;
    return true;
  }
  async listQuarantined(now: number, limit = 100): Promise<PushTokenRecord[]> {
    return [...this.byId.values()]
      .filter((r) => (r.quarantineUntil ?? 0) > now)
      .sort((a, b) => a.registeredAt - b.registeredAt)
      .slice(0, Math.max(0, limit))
      .map((r) => ({ ...r }));
  }
  async orInQuarantineAlertBit(tokenId: string, bit: number): Promise<number> {
    const r = this.byId.get(tokenId);
    if (!r) return 0;
    r.quarantineAlertsFiredBitmap = (r.quarantineAlertsFiredBitmap ?? 0) | bit;
    return r.quarantineAlertsFiredBitmap;
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

export class InMemoryDemoLlmLedgerStorage implements DemoLlmLedgerStorage {
  private byUser = new Map<string, { grantedAt: number; tokens: number }[]>();
  async append(username: string, grantedAt: number, tokens: number, pruneBefore: number) {
    const rows = this.byUser.get(username) ?? [];
    rows.push({ grantedAt, tokens });
    this.byUser.set(username, rows.filter((r) => r.grantedAt >= pruneBefore));
  }
  async sumSince(username: string, sinceMs: number) {
    const rows = this.byUser.get(username) ?? [];
    return rows.reduce((s, r) => (r.grantedAt >= sinceMs ? s + r.tokens : s), 0);
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

export class InMemorySecretMailboxStorage implements SecretMailboxStorage {
  // Composite key: `${serverDomain} ${requestNonceHex}`.
  private rows = new Map<string, SecretMailboxRecord>();
  private k(server: string, nonce: string): string {
    return `${server} ${nonce}`;
  }

  async putRequest(rec: SecretMailboxRecord) {
    const key = this.k(rec.serverDomain, rec.requestNonceHex);
    if (this.rows.has(key)) {
      return { ok: false as const, reason: "duplicate nonce" };
    }
    this.rows.set(key, { ...rec });
    return { ok: true as const };
  }

  async getRequest(serverDomain: string, requestNonceHex: string) {
    const r = this.rows.get(this.k(serverDomain, requestNonceHex));
    return r ? { ...r } : undefined;
  }

  async listPendingForUser(username: string, now: number, limit = 50) {
    const u = username.toLowerCase();
    const out: SecretMailboxRecord[] = [];
    for (const r of this.rows.values()) {
      if (r.username.toLowerCase() !== u) continue;
      if (r.expiresAt <= now) continue;
      if (r.responseSealedHex !== null) continue;
      if (r.consumedAt !== null) continue;
      out.push({ ...r });
    }
    out.sort((a, b) => b.postedAt - a.postedAt);
    return out.slice(0, Math.max(0, limit));
  }

  async touchLastPushAt(serverDomain: string, requestNonceHex: string, at: number) {
    const r = this.rows.get(this.k(serverDomain, requestNonceHex));
    if (r) r.lastPushAt = at;
  }

  async refreshExpiry(serverDomain: string, requestNonceHex: string, expiresAt: number) {
    const r = this.rows.get(this.k(serverDomain, requestNonceHex));
    if (r) r.expiresAt = expiresAt;
  }

  async putResponse(
    serverDomain: string,
    requestNonceHex: string,
    responseSealedHex: string,
    responseIssuedAt: number,
    now: number,
  ) {
    const r = this.rows.get(this.k(serverDomain, requestNonceHex));
    if (!r || r.expiresAt <= now) {
      return { ok: false as const, reason: "unknown request" };
    }
    if (r.responseSealedHex !== null) {
      return { ok: false as const, reason: "already answered" };
    }
    r.responseSealedHex = responseSealedHex;
    r.responseIssuedAt = responseIssuedAt;
    r.respondedAt = now;
    return { ok: true as const };
  }

  async consumeResponse(serverDomain: string, requestNonceHex: string, now: number) {
    const key = this.k(serverDomain, requestNonceHex);
    const r = this.rows.get(key);
    if (!r) return undefined;
    if (r.expiresAt <= now) {
      this.rows.delete(key);
      return undefined;
    }
    if (r.responseSealedHex === null) return undefined;
    if (r.consumedAt !== null) return undefined;
    r.consumedAt = now;
    return { ...r };
  }
}

export class InMemoryBoxSealedLeaseStorage implements BoxSealedLeaseStorage {
  // Composite key: `${serverDomain} ${leaseId}`.
  private rows = new Map<string, BoxSealedLeaseRecord>();
  private k(server: string, lease: string): string {
    return `${server} ${lease}`;
  }

  async put(rec: BoxSealedLeaseRecord): Promise<void> {
    this.rows.set(this.k(rec.serverDomain, rec.leaseId), { ...rec });
  }

  async release(serverDomain: string, now: number): Promise<BoxSealedLeaseRecord | undefined> {
    let best: BoxSealedLeaseRecord | undefined;
    const expired: string[] = [];
    for (const [k, r] of this.rows) {
      if (r.serverDomain !== serverDomain) continue;
      if (r.expiresAt <= now) {
        expired.push(k);
        continue;
      }
      // Skip exhausted leases — they're as good as gone.
      if (r.maxUses !== null && r.usesConsumed >= r.maxUses) {
        expired.push(k);
        continue;
      }
      if (!best || r.depositedAt > best.depositedAt) best = r;
    }
    for (const k of expired) this.rows.delete(k);
    if (!best) return undefined;
    best.usesConsumed += 1;
    const snapshot = { ...best };
    if (best.maxUses !== null && best.usesConsumed >= best.maxUses) {
      this.rows.delete(this.k(best.serverDomain, best.leaseId));
    }
    return snapshot;
  }

  async revoke(serverDomain: string, leaseId: string): Promise<boolean> {
    return this.rows.delete(this.k(serverDomain, leaseId));
  }

  async list(serverDomain: string, now: number): Promise<BoxSealedLeaseRecord[]> {
    const out: BoxSealedLeaseRecord[] = [];
    for (const r of this.rows.values()) {
      if (r.serverDomain !== serverDomain) continue;
      if (r.expiresAt <= now) continue;
      if (r.maxUses !== null && r.usesConsumed >= r.maxUses) continue;
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

export class InMemoryUserIdentityRecordStorage implements UserIdentityRecordStorage {
  private byHash = new Map<string, UserIdentityRecord>();
  private clone(r: UserIdentityRecord): UserIdentityRecord {
    return {
      ...r,
      encryptedBlob: new Uint8Array(r.encryptedBlob),
      authorizedSigners: [...r.authorizedSigners],
    };
  }
  async putIfNewer(rec: UserIdentityRecord) {
    const existing = this.byHash.get(rec.usernameHash);
    if (existing && rec.blobVersion <= existing.blobVersion) {
      return { stored: this.clone(existing), accepted: false };
    }
    this.byHash.set(rec.usernameHash, this.clone(rec));
    return { stored: this.clone(rec), accepted: true };
  }
  async get(usernameHash: string) {
    const r = this.byHash.get(usernameHash);
    return r ? this.clone(r) : undefined;
  }
}

export class InMemoryDaemonStatusStorage implements DaemonStatusStorage {
  private rows = new Map<string, DaemonStatusRecord>();
  async put(rec: DaemonStatusRecord) {
    this.rows.set(rec.serverDomain.toLowerCase(), { ...rec });
  }
  async get(serverDomain: string) {
    const r = this.rows.get(serverDomain.toLowerCase());
    return r ? { ...r } : undefined;
  }
  async listForUser(username: string, serverFilter?: (sd: string) => boolean) {
    const u = username.toLowerCase();
    const out: DaemonStatusRecord[] = [];
    for (const r of this.rows.values()) {
      // Heuristic for tests: serverDomain is "<server>.<username>.flagship.services".
      const parts = r.serverDomain.toLowerCase().split(".");
      if (parts.length < 4 || parts[1] !== u) continue;
      if (serverFilter && !serverFilter(r.serverDomain)) continue;
      out.push({ ...r });
    }
    return out;
  }
}

export class InMemoryAuditEventStorage implements AuditEventStorage {
  private rows: AuditEventRecord[] = [];
  private nextSeq = 1;
  async append(rec: Omit<AuditEventRecord, "seq">): Promise<AuditEventRecord> {
    const full: AuditEventRecord = { ...rec, seq: this.nextSeq++ };
    this.rows.push(full);
    return { ...full };
  }
  async list(username: string, sinceSeq: number, limit: number): Promise<AuditEventRecord[]> {
    const u = username.toLowerCase();
    return this.rows
      .filter((r) => r.username.toLowerCase() === u && r.seq > sinceSeq)
      .sort((a, b) => b.seq - a.seq)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
}

export class InMemoryUserServiceAliasStorage implements UserServiceAliasStorage {
  private rows = new Map<string, UserServiceAliasRecord>();
  private key(u: string, app: string) { return `${u.toLowerCase()}|${app}`; }
  async upsert(rec: UserServiceAliasRecord): Promise<void> {
    this.rows.set(this.key(rec.username, rec.serviceId), { ...rec, username: rec.username.toLowerCase() });
  }
  async get(username: string, serviceId: string) {
    const r = this.rows.get(this.key(username, serviceId));
    return r ? { ...r } : undefined;
  }
  async listForUser(username: string) {
    const u = username.toLowerCase();
    return [...this.rows.values()].filter((r) => r.username === u).map((r) => ({ ...r }));
  }
  async delete(username: string, serviceId: string) {
    return this.rows.delete(this.key(username, serviceId));
  }
}

export class InMemoryVoiciLinkStorage implements VoiciLinkStorage {
  private rows = new Map<string, VoiciLinkRecord>();
  async insert(rec: VoiciLinkRecord) {
    if (this.rows.has(rec.code)) return { ok: false as const, reason: "code already taken" };
    this.rows.set(rec.code, { ...rec, username: rec.username.toLowerCase() });
    return { ok: true as const };
  }
  async get(code: string) {
    const r = this.rows.get(code);
    return r ? { ...r } : undefined;
  }
  async getByService(username: string, serviceId: string) {
    const u = username.toLowerCase();
    // Most-recently created wins on (defensively) duplicate rows.
    let pick: VoiciLinkRecord | undefined;
    for (const r of this.rows.values()) {
      if (r.username === u && r.serviceId === serviceId) {
        if (!pick || r.createdAt > pick.createdAt) pick = r;
      }
    }
    return pick ? { ...pick } : undefined;
  }
  async deleteByService(username: string, serviceId: string) {
    const u = username.toLowerCase();
    let n = 0;
    for (const [code, r] of this.rows) {
      if (r.username === u && r.serviceId === serviceId) {
        this.rows.delete(code);
        n++;
      }
    }
    return n;
  }
  async deleteExpired(before: number) {
    let n = 0;
    for (const [code, r] of this.rows) {
      if (r.expiresAt !== undefined && r.expiresAt <= before) {
        this.rows.delete(code);
        n++;
      }
    }
    return n;
  }
}

export class InMemoryCustomDomainOrderStorage implements CustomDomainOrderStorage {
  private byKey = new Map<string, CustomDomainOrderRecord>();
  private k(userId: string, serviceId: string) {
    return `${userId.toLowerCase()} ${serviceId}`;
  }
  async get(userId: string, serviceId: string) {
    const r = this.byKey.get(this.k(userId, serviceId));
    return r ? { ...r } : undefined;
  }
  async upsert(rec: CustomDomainOrderRecord) {
    const stored: CustomDomainOrderRecord = { ...rec, userId: rec.userId.toLowerCase() };
    this.byKey.set(this.k(stored.userId, stored.serviceId), stored);
    return { ...stored };
  }
  async setStatus(
    userId: string,
    serviceId: string,
    fqdn: string,
    status: CustomDomainOrderRecord["status"],
    at: number,
  ) {
    const r = this.byKey.get(this.k(userId, serviceId));
    if (!r || r.fqdn !== fqdn) return false;
    r.status = status;
    r.updatedAt = at;
    if (status === "failed") r.failCount += 1;
    return true;
  }
  async listActive() {
    return this.listByStatus("active");
  }
  async listByStatus(status: CustomDomainOrderRecord["status"]) {
    return [...this.byKey.values()].filter((r) => r.status === status).map((r) => ({ ...r }));
  }
}

export class InMemoryInstallPolicyFanoutStorage
  implements InstallPolicyFanoutStorage
{
  private byServer = new Map<string, InstallPolicyFanoutRecord>();
  async recordOnce(rec: InstallPolicyFanoutRecord) {
    if (this.byServer.has(rec.serverDomain)) return false;
    this.byServer.set(rec.serverDomain, { ...rec });
    return true;
  }
  async get(serverDomain: string) {
    const r = this.byServer.get(serverDomain);
    return r ? { ...r } : undefined;
  }
}

const ACTIVE_DEMO_STATES = new Set<DemoUserState>([
  "provisioning",
  "up",
  "idle-pending-teardown",
]);

export class InMemoryDemoUsersStorage implements DemoUsersStorage {
  private byUsername = new Map<string, DemoUserRecord>();
  private key(name: string) {
    return name.toLowerCase();
  }
  async insert(rec: DemoUserRecord) {
    const k = this.key(rec.username);
    if (this.byUsername.has(k)) {
      return { ok: false as const, reason: "demo username already exists" };
    }
    this.byUsername.set(k, { ...rec, username: k });
    return { ok: true as const };
  }
  async get(username: string) {
    const r = this.byUsername.get(this.key(username));
    return r ? { ...r } : undefined;
  }
  async list() {
    return [...this.byUsername.values()].map((r) => ({ ...r }));
  }
  async update(username: string, patch: Partial<DemoUserRecord>) {
    const k = this.key(username);
    const r = this.byUsername.get(k);
    if (!r) return;
    this.byUsername.set(k, { ...r, ...patch, username: k });
  }
  async delete(username: string) {
    this.byUsername.delete(this.key(username));
  }
  async transition(
    username: string,
    from: DemoUserState,
    to: DemoUserState,
    patch?: Partial<DemoUserRecord>,
  ) {
    const k = this.key(username);
    const r = this.byUsername.get(k);
    if (!r) return null;
    if (r.state !== from) return null;
    const next: DemoUserRecord = { ...r, ...patch, state: to, username: k };
    this.byUsername.set(k, next);
    return { ...next };
  }
  async findIdle(cutoffMs: number) {
    return [...this.byUsername.values()]
      .filter(
        (r) =>
          (r.state === "up" ||
            r.state === "provisioning" ||
            r.state === "idle-pending-teardown") &&
          r.lastActivityAt < cutoffMs,
      )
      .sort((a, b) => a.lastActivityAt - b.lastActivityAt)
      .slice(0, 50)
      .map((r) => ({ ...r }));
  }
  async countActive() {
    let n = 0;
    for (const r of this.byUsername.values()) {
      if (ACTIVE_DEMO_STATES.has(r.state)) n++;
    }
    return n;
  }
  async setProvisionPhase(
    username: string,
    phase: string,
    error: string | null,
    at: number,
  ) {
    const k = this.key(username);
    const r = this.byUsername.get(k);
    if (!r) return null;
    const next: DemoUserRecord = {
      ...r,
      provisionPhase: phase,
      provisionPhaseAt: at,
      provisionLastError: error,
      username: k,
    };
    this.byUsername.set(k, next);
    return { ...next };
  }
}

export class InMemoryDeviceCapabilityGrantStorage
  implements DeviceCapabilityGrantStorage
{
  // Two indexes share the underlying record map. Records are cloned
  // on every read/write so callers can mutate the returned object
  // without poisoning the store.
  private byId = new Map<string, DeviceCapabilityGrantRecord>();
  private clone(r: DeviceCapabilityGrantRecord): DeviceCapabilityGrantRecord {
    return { ...r };
  }
  async put(rec: DeviceCapabilityGrantRecord) {
    // Duplicate-active guard mirrors the D1 unique partial index. A
    // tombstoned (revoked_at !== null) row never blocks a new active
    // grant — that's the re-issuance flow.
    if (rec.revokedAt === null) {
      const u = rec.username.toLowerCase();
      const l = rec.deviceLabel.toLowerCase();
      for (const other of this.byId.values()) {
        if (
          other.grantId !== rec.grantId &&
          other.revokedAt === null &&
          other.username.toLowerCase() === u &&
          other.deviceLabel.toLowerCase() === l
        ) {
          return {
            ok: false as const,
            reason: "duplicate active grant for (username, device_label)",
          };
        }
      }
    }
    this.byId.set(rec.grantId, this.clone(rec));
    return { ok: true as const };
  }
  async get(grantId: string) {
    const r = this.byId.get(grantId);
    return r ? this.clone(r) : undefined;
  }
  async listForUser(username: string) {
    const u = username.toLowerCase();
    const out: DeviceCapabilityGrantRecord[] = [];
    for (const r of this.byId.values()) {
      if (r.username.toLowerCase() === u) out.push(this.clone(r));
    }
    out.sort((a, b) => b.issuedAt - a.issuedAt);
    return out;
  }
  async getActiveForUserLabel(username: string, deviceLabel: string) {
    const u = username.toLowerCase();
    const l = deviceLabel.toLowerCase();
    const matches: DeviceCapabilityGrantRecord[] = [];
    for (const r of this.byId.values()) {
      if (
        r.revokedAt === null &&
        r.username.toLowerCase() === u &&
        r.deviceLabel.toLowerCase() === l
      ) {
        matches.push(r);
      }
    }
    if (matches.length > 1) {
      // Defensive — the put-time guard should make this unreachable.
      throw new Error(
        `getActiveForUserLabel: more than one active grant for ${u}/${l}`,
      );
    }
    return matches[0] ? this.clone(matches[0]) : undefined;
  }
  async getByDevicePub(devicePubHex: string) {
    const p = devicePubHex.toLowerCase();
    // Most-recent ACTIVE grant for the pubkey. Re-labeling a device
    // produces two grants sharing the same devicePubHex; the active
    // one (newest by issuedAt) is what callers actually care about.
    let best: DeviceCapabilityGrantRecord | undefined;
    for (const r of this.byId.values()) {
      if (r.revokedAt !== null) continue;
      if (r.devicePubHex.toLowerCase() !== p) continue;
      if (!best || r.issuedAt > best.issuedAt) best = r;
    }
    return best ? this.clone(best) : undefined;
  }
  async revoke(grantId: string, revokedAt: number) {
    const r = this.byId.get(grantId);
    if (!r) throw new Error("unknown grantId");
    r.revokedAt = revokedAt;
  }
}

export class InMemoryStorage implements Storage {
  usernames = new InMemoryUsernameStorage();
  usernameAliases = new InMemoryUsernameAliasStorage();
  daemonStatus = new InMemoryDaemonStatusStorage();
  authCodes = new InMemoryAuthCodeStorage();
  servers = new InMemoryServerStorage();
  routing = new InMemoryRoutingStorage();
  installEvents = new InMemoryInstallEventStorage();
  provisionStatus = new InMemoryProvisionStatusStorage();
  auditEvents = new InMemoryAuditEventStorage();
  luksKeys = new InMemoryLuksKeyStorage();
  autoUnlockLeases = new InMemoryAutoUnlockLeaseStorage();
  secretMailbox = new InMemorySecretMailboxStorage();
  boxSealedLeases = new InMemoryBoxSealedLeaseStorage();
  pendingRePairs = new InMemoryPendingRePairStorage();
  webauthnRecovery = new InMemoryWebauthnRecoveryStorage();
  pushTokens = new InMemoryPushTokenStorage();
  llmPromo = new InMemoryLlmPromoStorage();
  tiers = new InMemoryTierStorage();
  entitlementRevocations = new InMemoryEntitlementRevocationStorage();
  userIdentity = new InMemoryUserIdentityRecordStorage();
  userServiceAliases = new InMemoryUserServiceAliasStorage();
  voiciLinks = new InMemoryVoiciLinkStorage();
  customDomainOrders = new InMemoryCustomDomainOrderStorage();
  demoLlmLedger = new InMemoryDemoLlmLedgerStorage();
  installPolicyFanout = new InMemoryInstallPolicyFanoutStorage();
  demoUsers = new InMemoryDemoUsersStorage();
  deviceCapabilityGrants = new InMemoryDeviceCapabilityGrantStorage();
  watchDelegates = new InMemoryWatchDelegateStorage();
  mintReservations = new InMemoryMintReservationStorage();
  acmeAccountKeyGrants = new InMemoryAcmeAccountKeyGrantStorage();
  acmeAccountKeyDelivery = new InMemoryAcmeAccountKeyDeliveryStorage();
  namespace = new InMemoryNamespaceStorage();
}

/**
 * In-memory MintReservationStorage — the dead-lead-safe CAS lease that
 * serializes per-user cert minting (per-user-cert design). One row per user;
 * acquire wins iff none is live (no row / expired) or you already hold it.
 */
export class InMemoryMintReservationStorage implements MintReservationStorage {
  private byUser = new Map<string, MintReservationRecord>();

  async tryAcquire(args: {
    username: string;
    holderPubHex: string;
    expiresAt: number;
    now: number;
  }): Promise<{ acquired: boolean; holder: MintReservationRecord }> {
    const u = args.username.toLowerCase();
    const holder = args.holderPubHex.toLowerCase();
    const existing = this.byUser.get(u);
    const live = existing !== undefined && existing.expiresAt > args.now;
    // Win iff nothing live, OR you already hold the live lease (extend it).
    if (!live || existing!.holderPubHex === holder) {
      const rec: MintReservationRecord = {
        username: u,
        holderPubHex: holder,
        acquiredAt: live ? existing!.acquiredAt : args.now,
        expiresAt: args.expiresAt,
      };
      this.byUser.set(u, rec);
      return { acquired: true, holder: rec };
    }
    // Someone else holds a live lease — back off.
    return { acquired: false, holder: existing! };
  }

  async get(username: string): Promise<MintReservationRecord | undefined> {
    return this.byUser.get(username.toLowerCase());
  }

  async release(username: string, holderPubHex: string): Promise<void> {
    const u = username.toLowerCase();
    const existing = this.byUser.get(u);
    if (existing && existing.holderPubHex === holderPubHex.toLowerCase()) {
      this.byUser.delete(u);
    }
  }
}

/**
 * In-memory WatchDelegateStorage — opt-in Watch quick-approve delegate keys
 * (docs/watch-delegate-key-design.md). Map keyed by grantId; the
 * one-active-delegate-per-user invariant is enforced in put().
 */
export class InMemoryWatchDelegateStorage implements WatchDelegateStorage {
  private byId = new Map<string, WatchDelegateRecord>();

  async put(rec: WatchDelegateRecord): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (rec.revokedAt === null) {
      for (const r of this.byId.values()) {
        if (r.revokedAt === null && r.username.toLowerCase() === rec.username.toLowerCase()) {
          return { ok: false, reason: "duplicate active watch delegate for user" };
        }
      }
    }
    this.byId.set(rec.grantId, { ...rec });
    return { ok: true };
  }

  async get(grantId: string): Promise<WatchDelegateRecord | undefined> {
    const r = this.byId.get(grantId);
    return r ? { ...r } : undefined;
  }

  async listForUser(username: string): Promise<WatchDelegateRecord[]> {
    const u = username.toLowerCase();
    return [...this.byId.values()]
      .filter((r) => r.username.toLowerCase() === u)
      .sort((a, b) => b.issuedAt - a.issuedAt)
      .map((r) => ({ ...r }));
  }

  async getActiveForUser(username: string): Promise<WatchDelegateRecord | undefined> {
    const u = username.toLowerCase();
    const active = [...this.byId.values()].filter(
      (r) => r.revokedAt === null && r.username.toLowerCase() === u,
    );
    if (active.length > 1) {
      throw new Error(`getActiveForUser: more than one active watch delegate for ${username}`);
    }
    return active[0] ? { ...active[0] } : undefined;
  }

  async getActiveByDelegatePub(delegatePubHex: string): Promise<WatchDelegateRecord | undefined> {
    const p = delegatePubHex.toLowerCase();
    const active = [...this.byId.values()]
      .filter((r) => r.revokedAt === null && r.delegatePubHex.toLowerCase() === p)
      .sort((a, b) => b.issuedAt - a.issuedAt);
    return active[0] ? { ...active[0] } : undefined;
  }

  async revoke(grantId: string, revokedAt: number): Promise<void> {
    const r = this.byId.get(grantId);
    if (!r) throw new Error("unknown grantId");
    r.revokedAt = revokedAt;
  }
}

/**
 * In-memory AcmeAccountKeyGrantStorage — sealed ACME account keys handed to
 * admin devices (per-user-cert design). Map keyed by grantId. Unlike watch
 * delegates, MANY active grants per user coexist (one per admin device), so
 * `put` only rejects a duplicate grantId. `revokeByAccountKeyId` tombstones
 * every active copy of a rotated key.
 */
export class InMemoryAcmeAccountKeyGrantStorage implements AcmeAccountKeyGrantStorage {
  private byId = new Map<string, AcmeAccountKeyGrantRecord>();

  async put(
    rec: AcmeAccountKeyGrantRecord,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.byId.has(rec.grantId)) {
      return { ok: false, reason: "duplicate acme account key grant id" };
    }
    this.byId.set(rec.grantId, { ...rec });
    return { ok: true };
  }

  async get(grantId: string): Promise<AcmeAccountKeyGrantRecord | undefined> {
    const r = this.byId.get(grantId);
    return r ? { ...r } : undefined;
  }

  async listForUser(username: string): Promise<AcmeAccountKeyGrantRecord[]> {
    const u = username.toLowerCase();
    return [...this.byId.values()]
      .filter((r) => r.username.toLowerCase() === u)
      .sort((a, b) => b.issuedAt - a.issuedAt)
      .map((r) => ({ ...r }));
  }

  async getActiveForUser(username: string): Promise<AcmeAccountKeyGrantRecord[]> {
    const u = username.toLowerCase();
    return [...this.byId.values()]
      .filter((r) => r.revokedAt === null && r.username.toLowerCase() === u)
      .sort((a, b) => b.issuedAt - a.issuedAt)
      .map((r) => ({ ...r }));
  }

  async getActiveByRecipient(recipientPubHex: string): Promise<AcmeAccountKeyGrantRecord[]> {
    const p = recipientPubHex.toLowerCase();
    return [...this.byId.values()]
      .filter((r) => r.revokedAt === null && r.recipientPubHex.toLowerCase() === p)
      .sort((a, b) => b.issuedAt - a.issuedAt)
      .map((r) => ({ ...r }));
  }

  async revoke(grantId: string, revokedAt: number): Promise<void> {
    const r = this.byId.get(grantId);
    if (!r) throw new Error("unknown grantId");
    r.revokedAt = revokedAt;
  }

  async revokeByAccountKeyId(accountKeyId: string, revokedAt: number): Promise<number> {
    let n = 0;
    for (const r of this.byId.values()) {
      if (r.revokedAt === null && r.accountKeyId === accountKeyId) {
        r.revokedAt = revokedAt;
        n++;
      }
    }
    return n;
  }
}

/**
 * In-memory AcmeAccountKeyDeliveryStorage — seal-to-box delivery of the shared
 * ACME account key (#28 Option B). ONE slot per serverDomain (the map key), so
 * `put` overwrites a prior deposit. `deleteByAccountKeyId` drops every slot of
 * a rotated key (the rotation hook). Mirrors InMemoryBoxSealedLeaseStorage.
 */
export class InMemoryAcmeAccountKeyDeliveryStorage
  implements AcmeAccountKeyDeliveryStorage
{
  private byDomain = new Map<string, AcmeAccountKeyDeliveryRecord>();

  async put(rec: AcmeAccountKeyDeliveryRecord): Promise<void> {
    this.byDomain.set(rec.serverDomain, { ...rec });
  }

  async getByDomain(serverDomain: string): Promise<AcmeAccountKeyDeliveryRecord | undefined> {
    const r = this.byDomain.get(serverDomain);
    return r ? { ...r } : undefined;
  }

  async deleteByDomain(serverDomain: string): Promise<void> {
    this.byDomain.delete(serverDomain);
  }

  async deleteByAccountKeyId(accountKeyId: string): Promise<number> {
    let n = 0;
    for (const [k, r] of this.byDomain) {
      if (r.accountKeyId === accountKeyId) {
        this.byDomain.delete(k);
        n++;
      }
    }
    return n;
  }
}

/**
 * In-memory NamespaceStorage — the merged per-user leftmost-label uniqueness
 * invariant (§3.4; per-user-cert design). Keyed by `<username> <label>`
 * with BOTH components lower-cased, so the map key IS the case-insensitive
 * (username, label) uniqueness — exactly what the D1 unique index enforces.
 * `claim` admits an identical (kind, refId) re-claim and rejects a different
 * one with the shared reason `"name taken"`.
 */
export class InMemoryNamespaceStorage implements NamespaceStorage {
  private byKey = new Map<string, NameClaimRecord>();

  private key(username: string, label: string): string {
    return `${username.toLowerCase()} ${label.toLowerCase()}`;
  }

  async claim(
    rec: NameClaimRecord,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const k = this.key(rec.username, rec.label);
    const existing = this.byKey.get(k);
    if (existing) {
      // An identical (kind, refId) re-claim is idempotent — keep the
      // original claimedAt. Any other (kind, refId) is the collision the
      // invariant exists to reject.
      if (existing.kind === rec.kind && existing.refId === rec.refId) {
        return { ok: true };
      }
      return { ok: false, reason: "name taken" };
    }
    this.byKey.set(k, {
      ...rec,
      username: rec.username.toLowerCase(),
      label: rec.label.toLowerCase(),
    });
    return { ok: true };
  }

  async release(username: string, label: string): Promise<void> {
    this.byKey.delete(this.key(username, label));
  }

  async resolve(username: string, label: string): Promise<NameClaimRecord | undefined> {
    const r = this.byKey.get(this.key(username, label));
    return r ? { ...r } : undefined;
  }

  async listForUser(username: string): Promise<NameClaimRecord[]> {
    const u = username.toLowerCase();
    return [...this.byKey.values()]
      .filter((r) => r.username.toLowerCase() === u)
      .sort((a, b) => a.claimedAt - b.claimedAt)
      .map((r) => ({ ...r }));
  }
}
