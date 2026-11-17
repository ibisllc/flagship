/**
 * Payments that bought vouchers (migration 0153, docs/payments-privacy-and-rails.md §11): a hash of the rail's
 * payment id, never an account.
 */
import type { D1Database } from "./d1.js";

export interface VoucherPaymentRow {
  paymentHash: string;
  rail: string;
  units: number;
  keyId: string;
  blindedHash: string;
  day: string;
  state: "signed" | "refunded";
}

export interface VoucherPaymentStorage {
  get(paymentHash: string): Promise<VoucherPaymentRow | null>;
  /** Insert unless a row exists; returns the stored row (this one when it won). */
  claim(row: VoucherPaymentRow): Promise<VoucherPaymentRow>;
  /** Mark refunded; writes a refused row (units 0) when nothing was signed yet. */
  markRefunded(paymentHash: string, rail: string, day: string): Promise<void>;
}

type Raw = { payment_hash: string; rail: string; units: number; key_id: string; blinded_hash: string; day: string; state: string };

const fromRaw = (r: Raw): VoucherPaymentRow => ({
  paymentHash: r.payment_hash,
  rail: r.rail,
  units: r.units,
  keyId: r.key_id,
  blindedHash: r.blinded_hash,
  day: r.day,
  state: r.state === "refunded" ? "refunded" : "signed",
});

export class D1VoucherPaymentStorage implements VoucherPaymentStorage {
  constructor(private readonly db: D1Database) {}

  async get(paymentHash: string) {
    const r = await this.db.prepare("SELECT * FROM voucher_payments WHERE payment_hash = ?1").bind(paymentHash).first<Raw>();
    return r ? fromRaw(r) : null;
  }

  async claim(row: VoucherPaymentRow) {
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO voucher_payments (payment_hash, rail, units, key_id, blinded_hash, day, state) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      )
      .bind(row.paymentHash, row.rail, row.units, row.keyId, row.blindedHash, row.day, row.state)
      .run();
    return (await this.get(row.paymentHash)) ?? row;
  }

  async markRefunded(paymentHash: string, rail: string, day: string) {
    await this.db.batch([
      this.db
        .prepare("INSERT OR IGNORE INTO voucher_payments (payment_hash, rail, units, key_id, blinded_hash, day, state) VALUES (?1, ?2, 0, '', '', ?3, 'refunded')")
        .bind(paymentHash, rail, day),
      this.db.prepare("UPDATE voucher_payments SET state = 'refunded' WHERE payment_hash = ?1").bind(paymentHash),
    ]);
  }
}

export class InMemoryVoucherPaymentStorage implements VoucherPaymentStorage {
  readonly rows = new Map<string, VoucherPaymentRow>();
  async get(paymentHash: string) {
    return this.rows.get(paymentHash) ?? null;
  }
  async claim(row: VoucherPaymentRow) {
    const cur = this.rows.get(row.paymentHash);
    if (cur) return cur;
    this.rows.set(row.paymentHash, row);
    return row;
  }
  async markRefunded(paymentHash: string, rail: string, day: string) {
    const cur = this.rows.get(paymentHash);
    this.rows.set(paymentHash, cur ? { ...cur, state: "refunded" } : { paymentHash, rail, units: 0, keyId: "", blindedHash: "", day, state: "refunded" });
  }
}
