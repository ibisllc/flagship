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
  now?: () => number;
}

const REASONS = new Set(["lost", "stolen", "decommissioned", "replaced"]);
const GRANT_ID = /^[0-9a-zA-Z-]{8,64}$/;
const SKEW_MS = 5 * 60_000;

export class DeviceRevocations {
  private revoked = new Map<string, { at: number; reason: string }>();
  private readonly now: () => number;
  private readonly listeners: Array<(grantId: string) => void> = [];

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
      const raw = JSON.parse(read.text) as { revoked?: Record<string, { at?: unknown; reason?: unknown }> };
      for (const [id, v] of Object.entries(raw.revoked ?? {})) {
        if (GRANT_ID.test(id)) this.revoked.set(id, { at: typeof v.at === "number" ? v.at : 0, reason: String(v.reason ?? "") });
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
    if (this.revoked.has(r.grantId)) return null;
    this.revoked.set(r.grantId, { at: this.now(), reason: r.reason });
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
