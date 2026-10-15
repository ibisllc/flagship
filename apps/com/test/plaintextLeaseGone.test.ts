// The plaintext auto-unlock lease (flagship/auto-unlock-lease/v1: the disk
// key handed to `.com`) is gone. Only the box-sealed v2 lease remains, so no
// route may accept, list or release a v1 lease again.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as protocol from "@flagship/protocol";
import * as controlPlane from "@flagship/control-plane";

const ROUTES = readFileSync(resolve(__dirname, "..", "src", "controlPlaneRoutes.ts"), "utf8");

describe("the plaintext auto-unlock lease is gone", () => {
  it(".com routes only the box-sealed lease", () => {
    expect(ROUTES).not.toMatch(/unlock-key\\\/consume/);
    expect(ROUTES).not.toMatch(/unlock-key\\\/lease\$/);
    expect(ROUTES).not.toMatch(/unlock-key\\\/leases\$/);
    expect(ROUTES).toMatch(/unlock-key\\\/lease-v2\$/);
    expect(ROUTES).toMatch(/unlock-key\\\/leases-v2\$/);
  });

  it("no handler or protocol encoder for it remains", () => {
    for (const name of ["handleConsumeUnlockKey", "handleDepositAutoUnlockLease", "handleRevokeAutoUnlockLease", "handleListAutoUnlockLeases"]) {
      expect(name in controlPlane, name).toBe(false);
    }
    for (const name of ["signAutoUnlockLease", "verifyAutoUnlockLease", "signRevokeAutoUnlockLease", "verifyRevokeAutoUnlockLease"]) {
      expect(name in protocol, name).toBe(false);
    }
    expect("verifyAutoUnlockLeaseV2" in protocol).toBe(true);
    expect("verifyLeaseRevocation" in protocol).toBe(true);
  });
});
