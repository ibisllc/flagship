// Batched usage reports from an edge (spec/report-and-lease-v1.md).
//
// An edge (a relay, a proxy, a model server) observes usage for many
// accounts and reports it in batches. A batch that carries an id is counted
// at most once: the store records the id (only the id and an expiry) in the
// same atomic step as the adds, so a batch retried after a lost response is
// recognised and skipped. A batch without an id is counted as it arrives,
// which double-counts a retry; it exists for edges that predate batch ids.

import { meterJudgeAt, meterPeriodKey, type MeterDeps, type MeterVerdict } from "./meter.js";
import type { MeterBatchEntry } from "./store.js";

/** A batch id: 16–128 characters of [A-Za-z0-9_-] (an edge sends 128 random
 *  bits, e.g. 32 hex digits). */
export const METER_BATCH_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;

/** How long a batch id is remembered by default: one hour. An edge must stop
 *  retrying a batch well before this (the reference edge stops at 10 min). */
export const DEFAULT_BATCH_KEEP_MS = 60 * 60 * 1000;

export interface MeterReportItem<Resource extends string = string> {
  account: string;
  resource: Resource;
  amount: number;
}

export interface MeterReport<Resource extends string = string> {
  /** Omit only for edges that predate batch ids (counted without dedupe). */
  batchId?: string;
  items: MeterReportItem<Resource>[];
}

export interface MeterReportResult<Resource extends string = string, Plan extends string = string> {
  /** The batch id was already on record: nothing was added, and the verdicts
   *  judge the current totals. */
  duplicate: boolean;
  /** One per distinct (account, resource), in first-seen order. */
  verdicts: MeterVerdict<Resource, Plan>[];
}

function wholeNonNegative(n: number): number {
  if (!Number.isFinite(n) || n < 0) throw new RangeError("amount must be a finite non-negative number");
  return Math.floor(n);
}

/** Record a batch of usage and judge every account in it. Items for the same
 *  (account, resource) are summed. With a `batchId`, the store must implement
 *  `addBatch`. */
export async function meterReport<R extends string, P extends string>(
  deps: MeterDeps<R, P>,
  report: MeterReport<R>,
  opts: { keepMs?: number } = {},
): Promise<MeterReportResult<R, P>> {
  if (report.batchId !== undefined && !METER_BATCH_ID_RE.test(report.batchId)) {
    throw new RangeError("batchId must be 16–128 characters of [A-Za-z0-9_-]");
  }
  const now = deps.now ? deps.now() : Date.now();
  const merged = new Map<string, MeterBatchEntry & { resource: R }>();
  for (const it of report.items) {
    const spec = deps.catalog[it.resource];
    if (!spec) throw new Error(`unknown metered resource: ${it.resource}`);
    const amount = wholeNonNegative(it.amount);
    const k = JSON.stringify([it.account, it.resource]);
    const prev = merged.get(k);
    if (prev) prev.amount += amount;
    else merged.set(k, { account: it.account, resource: it.resource, period: meterPeriodKey(spec.period, now), amount });
  }
  const entries = [...merged.values()];

  let totals: number[] | undefined;
  let duplicate = false;
  if (report.batchId !== undefined) {
    if (!deps.store.addBatch) throw new Error("this MeterStore does not support idempotent batches (addBatch)");
    const r = await deps.store.addBatch(report.batchId, entries, now, now + (opts.keepMs ?? DEFAULT_BATCH_KEEP_MS));
    if (r.duplicate) duplicate = true;
    else totals = r.totals;
  } else {
    totals = [];
    for (const e of entries) totals.push(await deps.store.add(e.account, e.resource, e.period, e.amount, now));
  }
  if (!totals) {
    totals = [];
    for (const e of entries) totals.push((await deps.store.get(e.account, e.resource, e.period))?.amount ?? 0);
  }

  const verdicts: MeterVerdict<R, P>[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    verdicts.push(await meterJudgeAt(deps, e.account, e.resource, totals[i] ?? 0, now));
  }
  return { duplicate, verdicts };
}
