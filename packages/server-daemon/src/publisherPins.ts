/**
 * The first publisher key this box verified for each app, and any key waiting for the owner
 * (SECURITY-HARDENING-PLAN.md 18.11, N11). Kept in the state directory beside the box's keys, not
 * in the app's data: uninstalling an app deletes its files, database and sessions but not this pin
 * (it is system identity metadata, content-free), so a retired name reinstalled later cannot
 * inherit trust it never earned. Restoring app data cannot touch it either.
 *
 * A key that differs from the pin never replaces it here. It becomes `pending`, the app's updates
 * stop, and only the owner's device signing `flagship/publisher-trust/v1` for that exact service and
 * key change moves the pin.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  verifyPublisherTrust,
  type AppRelease,
  type PublisherPin,
  type PublisherTrust,
} from "@flagship/protocol";
import { keepCorruptAside, readStateFile, withFileLock } from "./durableFile.js";

export interface PendingPublisher {
  serviceId: string;
  continuity: "valid-chain" | "none";
  from: PublisherPin;
  toKeyHex: string;
  toEpoch: number;
  release: AppRelease;
  seenAt: number;
  /** The owner said no: updates stay paused until they choose again. */
  rejectedAt?: number;
}

interface Persisted {
  v: 1;
  pins: Record<string, PublisherPin>;
  pending: Record<string, PendingPublisher>;
}

export class PublisherPins {
  private pins = new Map<string, PublisherPin>();
  private pending = new Map<string, PendingPublisher>();
  /** A damaged file: every app's updates stop until the owner re-confirms each publisher. */
  private failedClosed = false;

  constructor(private readonly path: string) {}

  get unavailable(): boolean {
    return this.failedClosed;
  }

  async load(): Promise<void> {
    const read = await readStateFile(this.path);
    if (read.kind === "missing") return;
    try {
      if (read.kind === "unreadable") throw read.error;
      const p = JSON.parse(read.text) as Persisted;
      if (p?.v !== 1) throw new Error("not a publisher pin file");
      for (const [k, v] of Object.entries(p.pins ?? {})) this.pins.set(k, v);
      for (const [k, v] of Object.entries(p.pending ?? {})) this.pending.set(k, v);
    } catch (e) {
      await keepCorruptAside(this.path, e, "Updates from other creators are paused until you confirm each publisher again.");
      this.failedClosed = true;
    }
  }

  get(serviceId: string): PublisherPin | null {
    return this.failedClosed ? null : this.pins.get(serviceId) ?? null;
  }

  pendingFor(serviceId: string): PendingPublisher | null {
    return this.pending.get(serviceId) ?? null;
  }

  /** Pin the first key verified for an app. Refuses to replace one. */
  async pin(serviceId: string, pin: PublisherPin): Promise<boolean> {
    if (this.failedClosed || this.pins.has(serviceId)) return false;
    this.pins.set(serviceId, pin);
    await this.persist();
    return true;
  }

  async setPending(p: PendingPublisher): Promise<void> {
    const prior = this.pending.get(p.serviceId);
    // The same candidate seen again keeps its original time and any rejection.
    if (prior && prior.toKeyHex === p.toKeyHex && prior.toEpoch === p.toEpoch) return;
    this.pending.set(p.serviceId, p);
    await this.persist();
  }

  async reject(serviceId: string, at: number): Promise<boolean> {
    const p = this.pending.get(serviceId);
    if (!p) return false;
    this.pending.set(serviceId, { ...p, rejectedAt: at });
    await this.persist();
    return true;
  }

  /**
   * Apply the owner's approval of the waiting key. The signature must be the owner's, for this
   * service and exactly this change; anything else leaves the pin where it was.
   */
  async approve(trust: PublisherTrust, signatureHex: string, ownerPub: Uint8Array): Promise<{ ok: true } | { ok: false; reason: string }> {
    const p = this.pending.get(trust.serviceId);
    const cur = this.pins.get(trust.serviceId);
    if (!p || !cur) return { ok: false, reason: "no key is waiting for approval" };
    if (
      trust.appId !== cur.appId || trust.identityGeneration !== cur.identityGeneration || trust.oldKeyHex !== cur.keyHex ||
      trust.newKeyHex !== p.toKeyHex || trust.newEpoch !== p.toEpoch
    ) {
      return { ok: false, reason: "the approval is for a different key change" };
    }
    if (!verifyPublisherTrust(trust, signatureHex, ownerPub)) return { ok: false, reason: "the approval was not signed by the owner" };
    this.pins.set(trust.serviceId, { ...cur, keyHex: p.toKeyHex, keyEpoch: p.toEpoch, firstVerifiedAt: trust.issuedAt });
    this.pending.delete(trust.serviceId);
    await this.persist();
    return { ok: true };
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const body: Persisted = { v: 1, pins: Object.fromEntries(this.pins), pending: Object.fromEntries(this.pending) };
    await withFileLock(this.path, (write) => write(JSON.stringify(body)));
  }
}

/** A short, comparable form of a key for the owner to read. */
export function keyFingerprint(keyHex: string): string {
  return keyHex.slice(0, 16).replace(/(.{4})/g, "$1 ").trim();
}
