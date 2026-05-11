/**
 * Seedable pending unlock-approval list for pod-sim's
 * /api/screens/unlock-approvals/pending response. The real daemon
 * proxies this to .com; the pod-sim short-circuits with whatever
 * the test seeded.
 */

export interface PendingUnlockRequest {
  requestId: string;
  serverFqdn: string;
  requestedAt: number;
  ip?: string;
  userAgent?: string;
}

export class PendingStore {
  private rows: PendingUnlockRequest[] = [];

  seed(rows: PendingUnlockRequest[]): void {
    this.rows = rows.map((r) => ({ ...r }));
  }

  list(): PendingUnlockRequest[] {
    return this.rows.map((r) => ({ ...r }));
  }

  reset(): void {
    this.rows = [];
  }
}
