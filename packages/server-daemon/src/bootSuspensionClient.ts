/**
 * The box's side of the durable boot suspension (SEC-LOCK-001, SEC-DEADMAN-001).
 *
 * The box can lock itself out (a dead-man lapse, a lock order) by posting a
 * set-only suspension signed with its STK; it can never clear one. The boot
 * worker revokes the server's leases and releases none until the owner
 * resumes at a newer epoch. This client reads the record, then posts the next
 * `seq` in the current epoch, retrying within a deadline, and says honestly
 * whether the worker confirmed it durably.
 */
import { randomBytes } from "node:crypto";
import type { BootSuspensionOrder, BootSuspensionReason } from "@flagship/protocol";
import type { BootAuthArgs } from "./keyCustodian.js";

export interface BoxBootSigner {
  boxPublicKey(): Uint8Array;
  signBootAuthHeader(args: BootAuthArgs): string;
  signBootSuspension(order: BootSuspensionOrder): Uint8Array;
}

export type SuspendOutcome =
  | { confirmed: true; alreadySuspended: boolean; epoch: number; seq: number }
  | { confirmed: false; why: "unreachable" | "refused" | "not-durable"; detail?: string };

export interface BootSuspensionClientOptions {
  serverDomain: string;
  /** https://boot.<apex> */
  bootBase: string;
  signer: BoxBootSigner;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Hex nonce source (tests). */
  nonce?: () => string;
}

/** `https://flagshipserver.com` → `https://boot.flagshipserver.com`; an already-boot host is kept. */
export function bootBaseFromControl(controlBase: string): string {
  const u = new URL(controlBase);
  const host = u.hostname.startsWith("boot.") ? u.hostname : `boot.${u.hostname}`;
  return `${u.protocol}//${host}${u.port ? `:${u.port}` : ""}`;
}

export class BootSuspensionClient {
  private readonly fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly nonce: () => string;
  private readonly base: string;

  constructor(private readonly opts: BootSuspensionClientOptions) {
    this.fetchImpl = opts.fetch ?? ((u, i) => fetch(u, i));
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.nonce = opts.nonce ?? (() => randomBytes(32).toString("hex"));
    this.base = opts.bootBase.replace(/\/+$/, "");
  }

  private auth(method: string, path: string): string {
    return this.opts.signer.signBootAuthHeader({
      role: "box",
      serverDomain: this.opts.serverDomain,
      method,
      path,
      pubKeyHex: Buffer.from(this.opts.signer.boxPublicKey()).toString("hex"),
      nonceHex: this.nonce(),
      issuedAt: this.now(),
    });
  }

  /** The current record, or null if the worker can't be reached or read. */
  async state(): Promise<{ suspended: boolean; epoch: number; seq: number } | null> {
    const path = `/api/boot/suspension/${this.opts.serverDomain}`;
    try {
      const r = await this.fetchImpl(`${this.base}${path}`, { method: "GET", headers: { authorization: this.auth("GET", path) } });
      if (!r.ok) return null;
      const j = (await r.json()) as { suspended?: unknown; epoch?: unknown; seq?: unknown };
      if (typeof j.suspended !== "boolean" || !Number.isSafeInteger(j.epoch) || !Number.isSafeInteger(j.seq)) return null;
      return { suspended: j.suspended, epoch: j.epoch as number, seq: j.seq as number };
    } catch {
      return null;
    }
  }

  /**
   * Post a set-only suspension. Retries until `deadlineMs` have passed; the
   * result says whether the worker confirmed it durably. Never throws.
   */
  async suspend(reason: Extract<BootSuspensionReason, "dead-man" | "manual-lock" | "box-fail-closed">, deadlineMs: number): Promise<SuspendOutcome> {
    const stop = this.now() + deadlineMs;
    let last: SuspendOutcome = { confirmed: false, why: "unreachable" };
    for (let attempt = 0; this.now() < stop || attempt === 0; attempt++) {
      const st = await this.state();
      if (st === null) {
        last = { confirmed: false, why: "unreachable" };
      } else if (st.suspended) {
        return { confirmed: true, alreadySuspended: true, epoch: st.epoch, seq: st.seq };
      } else {
        const order: BootSuspensionOrder = {
          serverDomain: this.opts.serverDomain,
          epoch: st.epoch,
          seq: st.seq + 1,
          action: "suspend",
          reason,
          signer: "box",
          issuedAt: this.now(),
        };
        const path = "/api/boot/suspension/box";
        try {
          const r = await this.fetchImpl(`${this.base}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: this.auth("POST", path) },
            body: JSON.stringify({ order, signature: Buffer.from(this.opts.signer.signBootSuspension(order)).toString("hex") }),
          });
          const body = (await r.json().catch(() => ({}))) as { durable?: boolean; state?: { epoch?: number; seq?: number } };
          if (r.ok && body.durable === true) {
            return { confirmed: true, alreadySuspended: false, epoch: body.state?.epoch ?? order.epoch, seq: body.state?.seq ?? order.seq };
          }
          last = r.status === 503 ? { confirmed: false, why: "not-durable" } : { confirmed: false, why: "refused", detail: String(r.status) };
          // A 409 means the record moved under us (the owner resumed, or another post won): re-read and retry.
        } catch {
          last = { confirmed: false, why: "unreachable" };
        }
      }
      if (this.now() + 500 >= stop) break;
      await this.sleep(Math.min(2000, 250 * 2 ** Math.min(attempt, 3)));
    }
    return last;
  }
}
