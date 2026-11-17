import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rsaPrivateKeyFromJwk, voucherKeyFromRsa } from "@flagship/protocol";
// @ts-expect-error plain .mjs script
import { voucherKeyIdFromJwk } from "./voucher-key.mjs";

describe("voucher-key", () => {
  it("computes the key id the clients compute", () => {
    const { jwk } = JSON.parse(readFileSync(new URL("../packages/protocol/test-vectors/vouchers/test-rsa-key.json", import.meta.url), "utf8"));
    expect(voucherKeyIdFromJwk(jwk)).toEqual(voucherKeyFromRsa(rsaPrivateKeyFromJwk(jwk)));
  });
});
