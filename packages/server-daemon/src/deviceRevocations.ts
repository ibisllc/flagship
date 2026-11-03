/**
 * Device revocations the box holds for itself (docs/data-sovereignty.md).
 *
 * `.com` lists an account's device grants and the box adopts what verifies, so
 * `.com` can drop a device from that list but cannot keep a revoked one off
 * it: a stale or hostile list would bring the device back. A revocation the
 * ADMIN ROOT signed (`flagship/revoke-device-capability-grant/v1`) and the
 * owner's phone delivered straight to the box is a tombstone the box keeps on
 * its own disk. It applies at once, without `.com`, whatever `.com` lists
 * afterwards, and only ever removes authority, so a replay is harmless.
 *
 * Only the pinned admin root can revoke here (not a delegated admin device):
 * a device being revoked must not be able to revoke the others first.
 */
import {
  verifyRevokeDeviceCapabilityGrant,
  type RevokeDeviceCapabilityGrant,
  type Bytes,
} from "@flagship/protocol";
import { keepCorruptAside, readStateFile, writeFileDurable } from "./durableFile.js";

export interface DeviceRevocationsOptions {
  path: string;
  username: string;
  /** The pinned admin root, read on every call (a rotation may change it). Undefined: nothing can be revoked here. */
  adminRootPub: () => Uint8Array | undefined;
  /** The revoked device's own signed grant, while the device book still holds it (keyd then also refuses its key). */
  grantOf?: (grantId: string) => { statement: string; signatureHex: string } | null;
  now?: () => number;
}

/** A revocation as the admin root signed it, with the revoked grant when it was known: what keyd is handed. */
export interface SignedRevocation {
  grantId: string;
  statement: string;
  signatureHex: string;
  grantStatement?: string;
  grantSignatureHex?: string;
}

const REASONS = new Set(["lost", "stolen", "decommissioned", "replaced"]);
const GRANT_ID = /^[0-9a-zA-Z-]{8,64}$/;
const SKEW_MS = 5 * 60_000;

export class DeviceRevocations {
  private revoked = new Map<string, { at: number; reason: string; signed?: Omit<SignedRevocation, "grantId"> }>();
  private readonly now: () => number;
  private readonly listeners: Array<(grantId: string) => void> = [];
  private readonly signedListeners: Array<(r: SignedRevocation) => void> = [];

  /** Told of every revocation that verifies, a re-sent one included (keyd keeps its own record). */
  subscribeSigned(fn: (r: SignedRevocation) => void): void {
    this.signedListeners.push(fn);
  }

  /** Every revocation held with its signature, to hand keyd again at start. */
  signedRevocations(): SignedRevocation[] {
    return [...this.revoked].flatMap(([grantId, v]) => (v.signed ? [{ grantId, ...v.signed }] : []));
  }

  /** Told once per newly recorded grant (the device book and open rescue sessions drop it). */
  subscribe(fn: (grantId: string) => void): void {
    this.listeners.push(fn);
  }

  constructor(private readonly opts: DeviceRevocationsOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  async load(): Promise<void> {
    const read = await readStateFile(this.opts.path);
    if (read.kind === "missing") return;
    try {
      if (read.kind === "unreadable") throw read.error;
      const raw = JSON.parse(read.text) as { revoked?: Record<string, { at?: unknown; reason?: unknown; signed?: unknown }> };
      for (const [id, v] of Object.entries(raw.revoked ?? {})) {
        if (!GRANT_ID.test(id)) continue;
        const signed = parseSigned(v.signed);
        this.revoked.set(id, { at: typeof v.at === "number" ? v.at : 0, reason: String(v.reason ?? ""), ...(signed ? { signed } : {}) });
      }
    } catch (e) {
      // Losing tombstones would bring revoked devices back: keep the file, say so, and start empty
      // (the device book then trusts `.com`'s list again until the owner re-sends the revocations).
      await keepCorruptAside(this.opts.path, e, "This server found its list of revoked devices damaged; re-send the revocations from your phone.");
    }
  }

  has(grantId: string): boolean {
    return this.revoked.has(grantId);
  }

  list(): string[] {
    return [...this.revoked.keys()];
  }

  /**
   * Take an admin-root-signed revocation. Returns why not, or null when it is
   * recorded (including when it already was).
   */
  async accept(r: RevokeDeviceCapabilityGrant, sig: Bytes): Promise<string | null> {
    const root = this.opts.adminRootPub();
    if (!root || root.length !== 32) return "this server pins no admin key, so a device can't be revoked from here";
    if (!GRANT_ID.test(r.grantId) || !REASONS.has(r.reason) || r.username.toLowerCase() !== this.opts.username.toLowerCase()) {
      return "that is not a revocation for a device of this account";
    }
    if (!Number.isSafeInteger(r.issuedAt) || r.issuedAt > this.now() + SKEW_MS) return "that revocation is dated in the future";
    if (!verifyRevokeDeviceCapabilityGrant(r, sig, root)) return "that revocation isn't signed by this account's admin key";
    const prev = this.revoked.get(r.grantId);
    const grant = prev?.signed?.grantStatement ? null : (this.opts.grantOf?.(r.grantId) ?? null);
    const signed: Omit<SignedRevocation, "grantId"> = prev?.signed ?? {
      statement: `flagship/revoke-device-capability-grant/v1|${r.grantId}|${r.username}|${r.reason}|${r.issuedAt}`,
      signatureHex: Buffer.from(sig).toString("hex"),
    };
    if (grant) Object.assign(signed, { grantStatement: grant.statement, grantSignatureHex: grant.signatureHex });
    for (const fn of this.signedListeners) {
      try {
        fn({ grantId: r.grantId, ...signed });
      } catch {
        /* keyd's record is best effort here: it is handed every held revocation again at start */
      }
    }
    if (prev) {
      if (!prev.signed || grant) {
        prev.signed = signed;
        await this.persist();
      }
      return null;
    }
    this.revoked.set(r.grantId, { at: this.now(), reason: r.reason, signed });
    await this.persist();
    for (const fn of this.listeners) {
      try {
        fn(r.grantId);
      } catch {
        /* a listener never undoes a revocation */
      }
    }
    return null;
  }

  private async persist(): Promise<void> {
    await writeFileDurable(this.opts.path, JSON.stringify({ revoked: Object.fromEntries(this.revoked) }, null, 2));
  }
}

const SIG_HEX = /^[0-9a-f]{128}$/;

function parseSigned(v: unknown): Omit<SignedRevocation, "grantId"> | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.statement !== "string" || typeof o.signatureHex !== "string" || !SIG_HEX.test(o.signatureHex)) return null;
  const grant =
    typeof o.grantStatement === "string" && typeof o.grantSignatureHex === "string" && SIG_HEX.test(o.grantSignatureHex)
      ? { grantStatement: o.grantStatement, grantSignatureHex: o.grantSignatureHex }
      : {};
  return { statement: o.statement, signatureHex: o.signatureHex, ...grant };
}
