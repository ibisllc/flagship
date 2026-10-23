/**
 * Admission of an invited visitor's chat (SECURITY-HARDENING-PLAN.md 17.7-17.8).
 *
 * Only the current lead admits a cross-user start, and only while it can confirm exclusive
 * authority (`LeadAuthority.mayAdmit`). A visitor proves possession of a redeemed invitation by
 * signing the lead's FRESH challenge: it names the exact app and user, the lead generation, the
 * visitor's per-app identity, the requested purpose, the source session and a one-use nonce. A
 * copied invite link or any other signed text does not do it. In one atomic step the lead
 * de-duplicates the request, consumes the nonce and reserves the visitor's single slot for that
 * app; a second start while the slot is held gets the "already used" answer only after its own
 * proof validates, and everyone else gets the generic acceptance.
 *
 * Nonces and slots persist, so a restart cannot open a second conversation in the same generation.
 * A fresh lead generation invalidates every old challenge, proof and reservation.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { keepCorruptAside, readStateFile, withFileLock } from "../durableFile.js";
import { randomId, type Rank } from "./types.js";

/** Exclusive, bounded authority to admit; a generation number alone is not fencing. */
export interface LeadAuthority {
  /** The generation of the current lead term. */
  generation(): number;
  /** True only while this box holds the exclusive lease. False refuses every new admission. */
  mayAdmit(): boolean;
}

export interface Challenge {
  nonce: string;
  target: string;
  leadGeneration: number;
  expiresAt: number;
}

/** What the visitor's phone signs. The harness verifies it with the app's own access authority. */
export interface ChatProof {
  nonce: string;
  target: string;
  leadGeneration: number;
  purpose: "chat";
  sourceSession: string;
  /** The visitor's per-app identity; never an account-wide id. */
  perAppId: string;
  accessGrantRef: string;
  signatureHex: string;
}

export interface ProofVerdict {
  ok: boolean;
  /** The verified per-app identity (from the signature, not the caller's say-so). */
  perAppId?: string;
  /** Current effective rank, recomputed at the receiver. */
  rank?: Rank;
  reason?: string;
}

/** Verifies proof of possession and the visitor's CURRENT access; supplied by the box's access system. */
export interface ProofVerifier {
  verify(proof: ChatProof, challenge: Challenge): Promise<ProofVerdict>;
  /** Is this visitor's access still in force, and at what rank? Called again on later deliveries. */
  currentAccess(target: string, perAppId: string): Promise<{ active: boolean; rank?: Rank }>;
}

export type AdmitResult =
  | { kind: "admitted"; slotKey: string; perAppId: string; rank: Rank; requestId: string }
  | { kind: "already-used" } // only after the caller's own proof validated
  | { kind: "generic" }; // every other outcome looks the same from outside

interface Persisted {
  v: 1;
  generation: number;
  consumedNonces: Array<[string, number]>;
  slots: Record<string, { requestId: string; at: number; conversation: string | null }>;
}

const CHALLENGE_TTL_MS = 120_000;
const NONCE_KEEP_MS = 24 * 3_600_000;
const SLOT_ABANDON_MS = 5 * 60_000;

export class InvitationAdmission {
  private challenges = new Map<string, Challenge>();
  private consumed = new Map<string, number>();
  private slots = new Map<string, { requestId: string; at: number; conversation: string | null }>();
  /** Result of an admitted request, so a retry returns it instead of a second alert. */
  private results = new Map<string, AdmitResult>();
  private failedClosed = false;
  private persistedGeneration = 0;

  constructor(
    private readonly path: string | null,
    private readonly lead: LeadAuthority,
    private readonly verifier: ProofVerifier,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async load(): Promise<void> {
    if (!this.path) return;
    const read = await readStateFile(this.path);
    if (read.kind === "missing") return;
    try {
      if (read.kind === "unreadable") throw read.error;
      const p = JSON.parse(read.text) as Persisted;
      if (p?.v !== 1) throw new Error("not an admission file");
      this.persistedGeneration = p.generation;
      // A different lead generation starts clean: old nonces and reservations mean nothing now.
      if (p.generation === this.lead.generation()) {
        for (const [n, t] of p.consumedNonces) this.consumed.set(n, t);
        for (const [k, v] of Object.entries(p.slots)) this.slots.set(k, v);
      }
    } catch (e) {
      await keepCorruptAside(this.path, e, "Invited visitors cannot open a chat until the app's lead starts a fresh admission generation.");
      this.failedClosed = true;
    }
  }

  /** Issue a fresh challenge for `target`. Refused while this box cannot confirm it is the lead. */
  issueChallenge(target: string): Challenge | null {
    if (this.failedClosed || !this.lead.mayAdmit()) return null;
    const c: Challenge = { nonce: randomId(16), target, leadGeneration: this.lead.generation(), expiresAt: this.now() + CHALLENGE_TTL_MS };
    this.challenges.set(c.nonce, c);
    this.sweep();
    return c;
  }

  /**
   * Admit a start. `requestId` is the visitor's own retry key: the same request returns its
   * existing result. Everything that is not a success or the visitor's own duplicate is `generic`.
   */
  async admit(a: { requestId: string; target: string; proof: ChatProof; recipientApp: string }): Promise<AdmitResult> {
    if (this.failedClosed || !this.lead.mayAdmit()) return { kind: "generic" };
    const t = this.now();
    this.sweep();
    const retry = this.results.get(`${a.target}|${a.requestId}`);
    if (retry) return retry;
    const challenge = this.challenges.get(a.proof.nonce);
    // The nonce is spent whether or not the rest checks out: a guess gets one try.
    this.challenges.delete(a.proof.nonce);
    if (!challenge || this.consumed.has(a.proof.nonce) || challenge.expiresAt <= t) return { kind: "generic" };
    if (challenge.target !== a.target || a.proof.target !== a.target || a.proof.leadGeneration !== this.lead.generation() || challenge.leadGeneration !== this.lead.generation()) {
      return { kind: "generic" };
    }
    if (a.proof.purpose !== "chat") return { kind: "generic" };
    const verdict = await this.verifier.verify(a.proof, challenge);
    if (!verdict.ok || !verdict.perAppId || !verdict.rank) return { kind: "generic" };
    // Lead may have changed while the signature was checked.
    if (!this.lead.mayAdmit() || a.proof.leadGeneration !== this.lead.generation()) return { kind: "generic" };

    this.consumed.set(a.proof.nonce, t);
    const slotKey = `${a.recipientApp}|${verdict.perAppId}|${this.lead.generation()}`;
    const held = this.slots.get(slotKey);
    if (held && !this.abandoned(held)) {
      const r: AdmitResult = { kind: "already-used" };
      this.results.set(`${a.target}|${a.requestId}`, r);
      await this.persist();
      return r;
    }
    this.slots.set(slotKey, { requestId: a.requestId, at: t, conversation: null });
    const r: AdmitResult = { kind: "admitted", slotKey, perAppId: verdict.perAppId, rank: verdict.rank, requestId: a.requestId };
    this.results.set(`${a.target}|${a.requestId}`, r);
    await this.persist();
    return r;
  }

  /** Tie the reserved slot to the conversation that now holds it. */
  async bind(slotKey: string, conversationLocalId: string): Promise<void> {
    const s = this.slots.get(slotKey);
    if (s) {
      s.conversation = conversationLocalId;
      await this.persist();
    }
  }

  /** The conversation ended (closed, dead, revoked, abandoned): the slot is free for a fresh start. */
  async release(slotKey: string): Promise<void> {
    if (this.slots.delete(slotKey)) await this.persist();
  }

  /** The visitor closes their existing conversation themselves, e.g. to switch devices. */
  async releaseFor(recipientApp: string, perAppId: string): Promise<boolean> {
    const key = `${recipientApp}|${perAppId}|${this.lead.generation()}`;
    const had = this.slots.has(key);
    if (had) await this.release(key);
    return had;
  }

  /** Re-check on a later delivery: has the visitor's access ended, or their rank moved? */
  async recheck(target: string, perAppId: string): Promise<{ active: boolean; rank?: Rank }> {
    return this.verifier.currentAccess(target, perAppId);
  }

  isReserved(slotKey: string): boolean {
    const s = this.slots.get(slotKey);
    return !!s && !this.abandoned(s);
  }

  /** An admitted start whose first reply never came frees its slot; a late reply cannot revive it. */
  async sweepAbandoned(): Promise<string[]> {
    const freed: string[] = [];
    for (const [k, s] of [...this.slots]) {
      if (this.abandoned(s)) {
        this.slots.delete(k);
        freed.push(k);
      }
    }
    if (freed.length) await this.persist();
    return freed;
  }

  private abandoned(s: { at: number; conversation: string | null }): boolean {
    return s.conversation === null && this.now() - s.at > SLOT_ABANDON_MS;
  }

  private sweep(): void {
    const t = this.now();
    for (const [n, c] of this.challenges) if (c.expiresAt <= t) this.challenges.delete(n);
    for (const [n, at] of this.consumed) if (t - at > NONCE_KEEP_MS) this.consumed.delete(n);
  }

  private async persist(): Promise<void> {
    if (!this.path) return;
    await mkdir(dirname(this.path), { recursive: true });
    const body: Persisted = { v: 1, generation: this.lead.generation(), consumedNonces: [...this.consumed], slots: Object.fromEntries(this.slots) };
    await withFileLock(this.path, (write) => write(JSON.stringify(body)));
  }
}
