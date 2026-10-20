/**
 * The server page's backup policy (owner sessions only; companions refused):
 *
 *   GET  /api/screens/backup-policy  → { policy, cap, peer }
 *   POST /api/screens/backup-policy  { order, signatureHex }  (flagship/backup-policy/v1)
 *
 * `peer` is whatever the peer engine reports while the policy is "peer"
 * (null otherwise, or until an engine is plugged in with setPeerStatus).
 */
import { parseBackupPolicy } from "@flagship/protocol";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import { formatGb, limitFor, type BackupCap } from "./cap.js";
import type { BackupPolicyStore } from "./policy.js";

export const BACKUP_POLICY_PATH = "/api/screens/backup-policy";

const J = { "content-type": "application/json" } as const;

export function isBackupPolicyPath(path: string): boolean {
  return path === BACKUP_POLICY_PATH;
}

export function buildBackupPolicyHttp(deps: {
  policy: BackupPolicyStore;
  cap: BackupCap;
  /**
   * May a server choose the Peer policy? The wiring answers from FLAGSHIP_PEER_BACKUP (off at GA:
   * no live cross-account restore has run). A server already on Peer is left alone. Omitted = yes.
   */
  peerAllowed?: () => boolean;
  note?: (kind: string, detail: string, ok?: boolean) => void;
}) {
  let peerStatus: (() => Promise<unknown>) | null = null;
  const json = (status: number, body: unknown): HttpResponse => ({ status, headers: J, body: JSON.stringify(body) });

  async function view() {
    const policy = deps.policy.current();
    let peer: unknown = null;
    if (policy.policy === "peer" && peerStatus) {
      try {
        peer = (await peerStatus()) ?? null;
      } catch {
        peer = null;
      }
    }
    return { policy, cap: deps.cap.view(), peer };
  }

  const LABEL = { phone: "Phone-side backups", peer: "Peer-distributed backups", none: "No backups" } as const;

  return {
    /** The peer engine's status for the server page (one provider). */
    setPeerStatus(fn: (() => Promise<unknown>) | null): void {
      peerStatus = fn;
    },
    async handle(path: string, method: string, req: HttpRequest, ctx: { companion: boolean }): Promise<HttpResponse | null> {
      if (!isBackupPolicyPath(path)) return null;
      if (ctx.companion) return json(403, { error: "companion sessions can't see or change the backup policy: open your owner app", code: "companion-write-not-allowed" });
      if (method === "GET") return json(200, await view());
      if (method !== "POST") return json(405, { error: "method not allowed" });
      let b: { order?: unknown; signatureHex?: unknown };
      try {
        b = JSON.parse(req.body.toString("utf8")) as typeof b;
      } catch {
        return json(400, { error: "invalid json" });
      }
      const before = deps.policy.current().policy;
      if (before !== "peer" && deps.peerAllowed && !deps.peerAllowed() && parseBackupPolicy(b.order)?.policy === "peer") {
        return json(409, { error: "Backups on other servers aren't available yet. Choose another policy.", code: "peer-backup-not-available" });
      }
      // A policy whose limit the server is already over can't be chosen.
      const asked = parseBackupPolicy(b.order);
      const used = deps.cap.usedBytes();
      if (asked && used !== null) {
        const limit = limitFor({ policy: asked.policy, phoneReserveBytes: asked.phoneReserveBytes, issuedAt: asked.issuedAt }, deps.cap.diskBytes());
        if (limit !== null && used > limit) {
          const sentence =
            asked.policy === "phone"
              ? `This server holds ${formatGb(used)} of app data, more than the ${formatGb(limit)} your device would keep. Reserve at least ${formatGb(used)} on that device, or remove apps or data first.`
              : `This server holds ${formatGb(used)} of app data, more than a third of its disk (${formatGb(limit)}), which is all a server may use with peer backups. Remove apps or data first, or choose another policy.`;
          return json(409, { error: sentence, code: "over-backup-limit" });
        }
      }
      const refused = await deps.policy.adopt(b.order, b.signatureHex);
      if (refused) {
        const status = /malformed/.test(refused) ? 400 : /admin device|different server/.test(refused) ? 403 : 409;
        return json(status, { error: refused });
      }
      await deps.cap.refresh();
      const now = deps.policy.current();
      if (now.policy !== before && now.policy !== "unset") deps.note?.("server.backup.policy", `Backup policy: ${LABEL[now.policy]}.`);
      return json(200, await view());
    },
  };
}

export type BackupPolicyHttp = ReturnType<typeof buildBackupPolicyHttp>;
