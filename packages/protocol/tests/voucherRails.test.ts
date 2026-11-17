// The rails' small helpers (docs/payments-privacy-and-rails.md §11): store product ids, the web order's commitment
// and the used-payment hash. The iOS and Android shops use the same product ids.
import { describe, expect, it } from "vitest";
import { voucherOrderCommit, voucherPackProductId, voucherPackUnits, voucherPaymentHash } from "../src/index.js";

describe("voucher rails helpers", () => {
  it("names a pack the same on both stores and reads it back only for a configured pack", () => {
    expect(voucherPackProductId(30)).toBe("com.flagshipserver.app.vouchers.30");
    expect(voucherPackUnits("com.flagshipserver.app.vouchers.30", [10, 30, 120])).toBe(30);
    for (const id of ["com.flagshipserver.app.vouchers.31", "com.flagshipserver.app.vouchers.030", "com.other.vouchers.30", "com.flagshipserver.app.vouchers.", 30]) {
      expect(voucherPackUnits(id, [10, 30, 120])).toBeNull();
    }
  });
  it("commits to the key and the blinded set in order, and hashes payments per rail", () => {
    const a = voucherOrderCommit("0123456789abcdef", ["AA==", "BB=="]);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(voucherOrderCommit("0123456789abcdef", ["BB==", "AA=="])).not.toBe(a);
    expect(voucherOrderCommit("fedcba9876543210", ["AA==", "BB=="])).not.toBe(a);
    expect(voucherPaymentHash("apple", "1")).not.toBe(voucherPaymentHash("google", "1"));
    // Pinned so the webapp's port can't drift.
    expect(a).toBe("696591b0a66965fb43af0cfe2eb68de883fa1a6d1bc42cf739c68157830fb01d");
  });
});
