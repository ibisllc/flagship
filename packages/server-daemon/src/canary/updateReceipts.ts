/**
 * Canary update receipts, the box's side (protocol updateReceipt.ts, docs/runbooks/canary.md).
 *
 *   - The rollout salt: 32 random bytes kept in the state dir, created once. The release catalog gate uses
 *     it to decide whether this box is in a release's open cohort, and the receipt names the cohort from the
 *     same salt. It never leaves the box (it used to be the server's public name, which let anybody work out
 *     every box's cohort).
 *   - Consent: the owner turns sharing on or off from an owner session (`/api/update-reports`). Off unless
 *     the owner said yes, or the box was built as a test box (`FLAGSHIP_UPDATE_RECEIPTS=1`, maintainer and
 *     gym boxes only). The plan's rule: track what runs on CONSENTING boxes.
 *   - The receipt: after an update reaches a verdict (`update-outcome.json`: applied, rolled back, or failed
 *     with the rollback refused below the floor), ONE content-free receipt is queued, sent after a random
 *     delay of up to three hours so its arrival does not line up with the box's other calls, and resent
 *     until `.com` answers. A verdict reached while sharing was off is never sent later.
 */
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { UPDATE_RECEIPT_PATH, canaryCohort, parseUpdateReceipt, receiptArch, type ReceiptStack, type UpdateReceipt } from "@flagship/protocol";
import { readStateFile, writeFileDurable } from "../durableFile.js";
import type { UpdateOutcomeRecord } from "../updateOutcome.js";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import type { PairedSessionGate } from "../alertInboxHttp.js";

export const UPDATE_REPORTS_ROUTE = "/api/update-reports";
const SALT = /^[0-9a-f]{64}$/;
const MAX_QUEUE = 16;
const MAX_DELAY_MS = 3 * 3_600_000;

/**
 * The box's secret rollout salt; made once. A damaged file is replaced (the box moves cohorts once).
 * Never throws: when the state dir cannot be written (a full disk) the salt lives for this run only,
 * which at worst moves the box to another cohort on its next start.
 */
export async function loadRolloutSalt(path: string, rand: (n: number) => Uint8Array = (n) => randomBytes(n)): Promise<string> {
  const r = await readStateFile(path).catch(() => null);
  if (r?.kind === "ok" && SALT.test(r.text.trim())) return r.text.trim();
  const salt = Buffer.from(rand(32)).toString("hex");
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFileDurable(path, salt + "\n", 0o600);
  } catch (e) {
    console.warn(`[update-receipts] rollout salt not saved (${(e as Error).message}); using one for this run`);
  }
  return salt;
}

interface Consent {
  share: boolean;
  setAt: number;
}

interface Outbox {
  /** `at` of the last verdict looked at, sent or not, so an old verdict is never sent later. */
  lastVerdictAt: number;
  queue: { receipt: UpdateReceipt; notBefore: number }[];
}

export interface UpdateReceiptOptions {
  consentPath: string;
  outboxPath: string;
  salt: () => string;
  stack: () => ReceiptStack;
  /** The latest update verdict (update-outcome.json). */
  outcome: () => UpdateOutcomeRecord | null;
  /** `.com`'s base URL. */
  controlBase: string;
  /** A test or maintainer box shares by default; everybody else only after saying yes. */
  defaultShare: boolean;
  arch?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  random?: () => number;
  nonce?: () => string;
}

export class UpdateReceiptReporter {
  constructor(private readonly o: UpdateReceiptOptions) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  async consent(): Promise<{ share: boolean; source: "owner" | "default"; setAt?: number }> {
    const r = await readStateFile(this.o.consentPath);
    if (r.kind === "ok") {
      try {
        const c = JSON.parse(r.text) as Consent;
        if (typeof c.share === "boolean") return { share: c.share, source: "owner", setAt: c.setAt };
      } catch {
        // an unreadable choice reads as "not given": nothing is sent
        return { share: false, source: "owner" };
      }
    }
    return { share: this.o.defaultShare, source: "default" };
  }

  async setConsent(share: boolean): Promise<void> {
    await mkdir(dirname(this.o.consentPath), { recursive: true });
    await writeFileDurable(this.o.consentPath, JSON.stringify({ share, setAt: this.now() } satisfies Consent));
    if (!share) {
      // Turning sharing off also drops anything not yet sent.
      const box = await this.outbox();
      await this.saveOutbox({ ...box, queue: [] });
    }
  }

  private async outbox(): Promise<Outbox> {
    const r = await readStateFile(this.o.outboxPath);
    if (r.kind === "ok") {
      try {
        const j = JSON.parse(r.text) as Outbox;
        if (typeof j.lastVerdictAt === "number" && Array.isArray(j.queue)) {
          return { lastVerdictAt: j.lastVerdictAt, queue: j.queue.filter((q) => parseUpdateReceipt(q.receipt) !== null) };
        }
      } catch {
        /* rebuilt below */
      }
    }
    return { lastVerdictAt: 0, queue: [] };
  }

  private async saveOutbox(b: Outbox): Promise<void> {
    await mkdir(dirname(this.o.outboxPath), { recursive: true });
    await writeFileDurable(this.o.outboxPath, JSON.stringify(b));
  }

  /** The receipt a verdict makes, or null for one that is not an update result (a refused order). */
  receiptFor(rec: UpdateOutcomeRecord): UpdateReceipt | null {
    if (!rec.targetCommit || (rec.outcome !== "applied" && rec.outcome !== "rolled-back")) return null;
    const pass = rec.outcome === "applied";
    return {
      format: 1,
      release: rec.targetCommit,
      cohort: canaryCohort(this.o.salt(), rec.targetCommit),
      healthGate: pass ? "pass" : "fail",
      rolledBack: !pass && rec.rollbackRefused !== true,
      arch: receiptArch(this.o.arch ?? process.arch),
      stack: this.o.stack(),
      nonce: this.o.nonce ? this.o.nonce() : randomBytes(16).toString("hex"),
    };
  }

  /** Queue a receipt for a verdict not looked at yet. Returns what it did, for the log. */
  async sync(): Promise<"none" | "queued" | "not-shared" | "seen"> {
    const rec = this.o.outcome();
    if (!rec) return "none";
    const box = await this.outbox();
    if (rec.at <= box.lastVerdictAt) return "seen";
    const receipt = this.receiptFor(rec);
    const { share } = await this.consent();
    const next: Outbox = { lastVerdictAt: rec.at, queue: box.queue };
    if (receipt && share) {
      const delay = Math.floor((this.o.random ?? Math.random)() * MAX_DELAY_MS);
      next.queue = [...box.queue, { receipt, notBefore: this.now() + delay }].slice(-MAX_QUEUE);
    }
    await this.saveOutbox(next);
    return receipt && share ? "queued" : receipt ? "not-shared" : "none";
  }

  /** Send what is due. A receipt `.com` refuses as malformed is dropped (it will not get better). */
  async flush(): Promise<{ sent: number; kept: number }> {
    const box = await this.outbox();
    if (box.queue.length === 0 || !this.o.controlBase) return { sent: 0, kept: box.queue.length };
    if (!(await this.consent()).share) {
      await this.saveOutbox({ ...box, queue: [] });
      return { sent: 0, kept: 0 };
    }
    const f = this.o.fetchImpl ?? fetch;
    const url = `${this.o.controlBase.replace(/\/+$/, "")}${UPDATE_RECEIPT_PATH}`;
    const kept: Outbox["queue"] = [];
    let sent = 0;
    for (const item of box.queue) {
      if (item.notBefore > this.now()) {
        kept.push(item);
        continue;
      }
      let status = 0;
      try {
        // No session, no signature, no cookie: the request carries the receipt and nothing else.
        const res = await f(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(item.receipt),
          credentials: "omit",
          redirect: "error",
          signal: AbortSignal.timeout(20_000),
        });
        status = res.status;
      } catch {
        status = 0;
      }
      if (status >= 200 && status < 300) sent++;
      else if (status >= 400 && status < 500 && status !== 429) continue; // refused as malformed: dropped
      else kept.push(item);
    }
    await this.saveOutbox({ ...box, queue: kept });
    return { sent, kept: kept.length };
  }
}

/**
 * GET/POST /api/update-reports: the owner's choice. GET answers `{ share, source }`; POST takes
 * `{ share: boolean }`. Owner sessions only (the gate refuses Remote and co-manager sessions).
 */
export function buildUpdateReportsHttp(o: { reporter: UpdateReceiptReporter; gate: PairedSessionGate }) {
  const J = { "content-type": "application/json", "cache-control": "no-store" };
  return async (req: HttpRequest): Promise<HttpResponse | null> => {
    const path = req.path.split("?")[0];
    if (path !== UPDATE_REPORTS_ROUTE) return null;
    const denied = o.gate.check(req);
    if (denied) return denied;
    const method = req.method.toUpperCase();
    if (method === "GET") {
      const c = await o.reporter.consent();
      return { status: 200, headers: J, body: JSON.stringify({ share: c.share, source: c.source, sends: SENDS }) };
    }
    if (method === "POST") {
      let share: unknown;
      try {
        share = (JSON.parse(req.body.toString("utf8")) as { share?: unknown }).share;
      } catch {
        share = undefined;
      }
      if (typeof share !== "boolean") return { status: 400, headers: J, body: JSON.stringify({ error: "share must be true or false" }) };
      await o.reporter.setConsent(share);
      return { status: 200, headers: J, body: JSON.stringify({ share }) };
    }
    return { status: 405, headers: J, body: JSON.stringify({ error: "method not allowed" }) };
  };
}

/** What a receipt holds, for the owner's screen to show before they agree. */
export const SENDS = ["release", "cohort", "healthGate", "rolledBack", "arch", "stack"] as const;
