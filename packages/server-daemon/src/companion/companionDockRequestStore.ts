export interface CompanionDockRequestRow {
  requestId: string;
  pollSecretHash: string;
  approvalSecretHash: string;
  issuedAt: number;
  expiresAt: number;
  status: "pending" | "approved";
  userAgent?: string;
  approvedAt?: number;
  companionSessionToken?: string;
  companionExpiresAt?: number;
}

export interface CompanionDockRequestStore {
  insert(row: CompanionDockRequestRow): Promise<void>;
  approveAtomically(args: {
    requestId: string;
    approvalSecretHashMatch: string;
    approvedAt: number;
    companionSessionToken: string;
    companionExpiresAt: number;
  }): Promise<
    | { ok: true; row: CompanionDockRequestRow }
    | { ok: false; reason: "not-found" | "wrong-secret" | "already-approved" | "expired" }
  >;
  poll(args: {
    requestId: string;
    pollSecretHashMatch: string;
    nowMs: number;
  }): Promise<
    | { ok: true; row: CompanionDockRequestRow }
    | { ok: false; reason: "not-found" | "wrong-secret" | "expired" }
  >;
  cleanupExpired(nowMs: number): Promise<number>;
}

export class InMemoryCompanionDockRequestStore implements CompanionDockRequestStore {
  private readonly byId = new Map<string, CompanionDockRequestRow>();
  constructor(private readonly maxEntries = 2_048) {}

  async insert(row: CompanionDockRequestRow): Promise<void> {
    await this.cleanupExpired(row.issuedAt);
    while (this.byId.size >= this.maxEntries) {
      const oldest = this.byId.keys().next().value as string | undefined;
      if (!oldest) break;
      this.byId.delete(oldest);
    }
    this.byId.set(row.requestId, { ...row });
  }

  async approveAtomically(args: {
    requestId: string;
    approvalSecretHashMatch: string;
    approvedAt: number;
    companionSessionToken: string;
    companionExpiresAt: number;
  }): Promise<
    | { ok: true; row: CompanionDockRequestRow }
    | { ok: false; reason: "not-found" | "wrong-secret" | "already-approved" | "expired" }
  > {
    const row = this.byId.get(args.requestId);
    if (!row) return { ok: false, reason: "not-found" };
    if (row.status === "approved") return { ok: false, reason: "already-approved" };
    if (row.expiresAt <= args.approvedAt) return { ok: false, reason: "expired" };
    if (row.approvalSecretHash !== args.approvalSecretHashMatch) {
      return { ok: false, reason: "wrong-secret" };
    }
    const approved: CompanionDockRequestRow = {
      ...row,
      status: "approved",
      approvedAt: args.approvedAt,
      companionSessionToken: args.companionSessionToken,
      companionExpiresAt: args.companionExpiresAt,
    };
    this.byId.set(args.requestId, approved);
    return { ok: true, row: { ...approved } };
  }

  async poll(args: {
    requestId: string;
    pollSecretHashMatch: string;
    nowMs: number;
  }): Promise<
    | { ok: true; row: CompanionDockRequestRow }
    | { ok: false; reason: "not-found" | "wrong-secret" | "expired" }
  > {
    const row = this.byId.get(args.requestId);
    if (!row) return { ok: false, reason: "not-found" };
    if (row.expiresAt <= args.nowMs) return { ok: false, reason: "expired" };
    if (row.pollSecretHash !== args.pollSecretHashMatch) {
      return { ok: false, reason: "wrong-secret" };
    }
    return { ok: true, row: { ...row } };
  }

  async cleanupExpired(nowMs: number): Promise<number> {
    let removed = 0;
    for (const [id, row] of this.byId) {
      if (row.expiresAt <= nowMs) {
        this.byId.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  _all(): CompanionDockRequestRow[] {
    return [...this.byId.values()].map((row) => ({ ...row }));
  }
}
