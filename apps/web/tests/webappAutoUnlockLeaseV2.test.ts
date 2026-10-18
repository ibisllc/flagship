// The webapp's auto-unlock lease is the box-sealed v2 lease iOS and Android
// deposit: `.com` receives only the disk key sealed FOR the box's STK, in a
// lease the account IRK signs and that pins that STK. The plaintext v1 lease
// (the disk key handed to `.com`) is gone.
import { describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  deriveIRK,
  deriveSTK,
  openAutoUnlockLeaseV2,
  sealForEd25519Recipient,
  verifyAutoUnlockLeaseV2,
  verifyLeaseRevocation,
} from "@flagship/protocol";
import { readFileSync } from "node:fs";
import {
  canonicalLeaseV2Bytes,
  enableLongLived,
  renewIfExpiringSoon,
  revokeLease,
} from "../public/webapp/lib/leases.js";

const NOW = 1_800_000_000_000;
const DOMAIN = "home.plucky-avocet.flagship.services";
const umkSeed = new Uint8Array(32).fill(7);
const irk = deriveIRK({ seed: umkSeed });
const stk = deriveSTK(new Uint8Array(32).fill(9));
const luksKey = new Uint8Array(32).map((_, i) => i + 1);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));
const signWithIrk = async (_umk: Uint8Array, bytes: Uint8Array) => ed25519.sign(bytes, irk.privateKey);
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("enableLongLived deposits a box-sealed v2 lease", () => {
  it("re-seals the disk key for the box's STK and signs the lease with the IRK", async () => {
    const sealedForIrk = sealForEd25519Recipient(luksKey, irk.publicKey);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/sealed-luks-key")) return json(200, { sealedKey: hex(sealedForIrk) });
      if (url.endsWith("/unlock-key/lease-v2")) return json(200, { ok: true });
      return json(404, {});
    });
    const out = await enableLongLived(DOMAIN, 7 * 86_400_000, {
      session: { umk: umkSeed, username: "plucky-avocet" },
      fetch,
      comBase: "https://flagshipserver.com",
      signWithIrk,
      now: () => NOW,
      boxStk: async () => hex(stk.publicKey),
    });
    const post = calls.find((c) => c.url === `https://flagshipserver.com/api/server/${DOMAIN}/unlock-key/lease-v2`);
    expect(post?.init?.method).toBe("POST");
    const body = JSON.parse(String(post!.init!.body));
    expect(Object.keys(body.lease).sort()).toEqual(["expiresAt", "issuedAt", "leaseId", "sealedKey", "serverDomain", "stkPub"]);
    expect(body.lease).not.toHaveProperty("unlockKey");
    expect(String(post!.init!.body)).not.toContain(hex(luksKey));
    const lease = {
      serverDomain: body.lease.serverDomain,
      stkPub: unhex(body.lease.stkPub),
      leaseId: body.lease.leaseId,
      sealedKey: unhex(body.lease.sealedKey),
      issuedAt: body.lease.issuedAt,
      expiresAt: body.lease.expiresAt,
    };
    expect(verifyAutoUnlockLeaseV2(lease, unhex(body.signature), irk.publicKey)).toBe(true);
    expect(openAutoUnlockLeaseV2(lease, stk.privateKey)).toEqual(luksKey);
    expect(out).toEqual({ leaseId: body.lease.leaseId, expiresAt: NOW + 7 * 86_400_000 });
  });

  it("refuses a server the directory doesn't list", async () => {
    await expect(
      enableLongLived(DOMAIN, 1000, {
        session: { umk: umkSeed, username: "plucky-avocet" },
        fetch: vi.fn(),
        signWithIrk,
        boxStk: async () => null,
      }),
    ).rejects.toThrow(/isn't in your account's server list/);
  });
});

describe("revokeLease signs the v2 kill switch", () => {
  it("DELETEs the lease with an IRK-signed auto-unlock-lease-revoke/v1", async () => {
    const fetch = vi.fn(async () => json(200, { ok: true, removed: true }));
    await revokeLease(DOMAIN, "0123456789abcdef0123456789abcdef", {
      session: { umk: umkSeed },
      fetch,
      comBase: "https://flagshipserver.com",
      signWithIrk,
      now: () => NOW,
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://flagshipserver.com/api/server/${DOMAIN}/unlock-key/lease-v2/0123456789abcdef0123456789abcdef`);
    expect(init.method).toBe("DELETE");
    const body = JSON.parse(String(init.body));
    expect(body.request).toEqual({ serverDomain: DOMAIN, leaseId: "0123456789abcdef0123456789abcdef", issuedAt: NOW });
    expect(verifyLeaseRevocation(body.request, unhex(body.signature), irk.publicKey)).toBe(true);
  });
});

describe("the lease orders are IRK-signed", () => {
  it("are not routed to the admin root (`.com` verifies them against the account IRK)", async () => {
    const { SENSITIVE_TAGS } = await import("../public/webapp/lib/adminRoot.js");
    for (const tag of [
      "flagship/auto-unlock-lease/v2",
      "flagship/auto-unlock-lease-revoke/v1",
      "flagship/auto-unlock-lease/v1",
      "flagship/revoke-auto-unlock-lease/v1",
    ]) {
      expect(SENSITIVE_TAGS.has(tag), tag).toBe(false);
    }
  });
});

describe("renewIfExpiringSoon", () => {
  const deps = (leases: Array<{ leaseId: string; expiresAt: number }>) => {
    const enable = vi.fn(async () => ({ leaseId: "new", expiresAt: NOW + 7 * 86_400_000 }));
    return { enable, deps: { session: { umk: umkSeed }, now: () => NOW, listLeases: async () => leases, enableLongLived: enable } };
  };

  it("re-deposits when the newest lease has under a day left", async () => {
    const { enable, deps: d } = deps([{ leaseId: "old", expiresAt: NOW + 3_600_000 }]);
    expect(await renewIfExpiringSoon(DOMAIN, 86_400_000, d)).toEqual([
      { oldLeaseId: "old", newLeaseId: "new", expiresAt: NOW + 7 * 86_400_000 },
    ]);
    expect(enable).toHaveBeenCalledTimes(1);
  });

  it("leaves a fresh lease, and a server with auto-unlock off, alone", async () => {
    const fresh = deps([{ leaseId: "a", expiresAt: NOW + 3_600_000 }, { leaseId: "b", expiresAt: NOW + 5 * 86_400_000 }]);
    expect(await renewIfExpiringSoon(DOMAIN, 86_400_000, fresh.deps)).toEqual([]);
    const off = deps([]);
    expect(await renewIfExpiringSoon(DOMAIN, 86_400_000, off.deps)).toEqual([]);
    expect(fresh.enable).not.toHaveBeenCalled();
    expect(off.enable).not.toHaveBeenCalled();
  });
});

// packages/protocol/test-vectors/auto-unlock-lease: the lease is the owner IRK's
// to sign (the boot worker and `.com` both verify it against the IRK); a lease
// signed by the admin root does not verify under it.
describe("the shared auto-unlock lease vector", () => {
  const V = JSON.parse(
    readFileSync(new URL("../../../packages/protocol/test-vectors/auto-unlock-lease/vectors.json", import.meta.url), "utf8"),
  );
  it("the webapp's canonical bytes are the vector's, the IRK signature verifies and the admin root's does not", () => {
    const l = V.lease;
    expect(
      new TextDecoder().decode(
        canonicalLeaseV2Bytes({
          serverDomain: l.serverDomain, stkPubHex: l.stkPubHex, leaseId: l.leaseId,
          sealedKeyHex: l.sealedKeyHex, issuedAt: l.issuedAt, expiresAt: l.expiresAt,
        }),
      ),
    ).toBe(V.canonical);
    const msg = new TextEncoder().encode(V.canonical);
    expect(ed25519.verify(unhex(V.irkSignatureHex), msg, unhex(V.irkPubHex))).toBe(true);
    expect(ed25519.verify(unhex(V.adminSignatureHex), msg, unhex(V.irkPubHex))).toBe(false);
  });
});
