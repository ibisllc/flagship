import type {
  AuthCodeRecord,
  AuthCodeStorage,
  BuildTicketRecord,
  BuildTicketStorage,
  InstallEvent,
  InstallEventStorage,
  RoutingRecord,
  RoutingStorage,
  ServerRecord,
  ServerStorage,
  Storage,
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

export class InMemoryStorage implements Storage {
  usernames = new InMemoryUsernameStorage();
  authCodes = new InMemoryAuthCodeStorage();
  buildTickets = new InMemoryBuildTicketStorage();
  servers = new InMemoryServerStorage();
  routing = new InMemoryRoutingStorage();
  installEvents = new InMemoryInstallEventStorage();
}
