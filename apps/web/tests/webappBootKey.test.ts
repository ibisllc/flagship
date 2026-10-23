// Leases and disk-key replies go to a box's boot key (the only key on its
// unencrypted /boot), adopted only through a binding the pinned STK signed.
import { describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { deriveIRK, ed, openAutoUnlockLeaseV2, sealForEd25519Recipient, signBootKeyBinding, bootKeyBindingToWire } from "@flagship/protocol";
import { enableLongLived } from "../public/webapp/lib/leases.js";
import { bootKeyFor, sharedBootKeyFor } from "../public/webapp/lib/bootKey.js";
import { repinBoxKey } from "../public/webapp/lib/boxKeyPins.js";

const NOW = 1_800_000_000_000;
const DOMAIN = "home.plucky-avocet.flagship.services";
const USER = "plucky-avocet";
const umkSeed = new Uint8Array(32).fill(7);
const irk = deriveIRK({ seed: umkSeed });
const kp = (n: number) => {
  const privateKey = new Uint8Array(32).fill(n);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
};
const stk = kp(0x0b);
const boot = kp(0x1b);
const other = kp(0x0c);
const luksKey = new Uint8Array(64).map((_, i) => i + 1);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const memStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const binding = (signer = stk, bootPub = boot.publicKey) => {
  const b = { serverDomain: DOMAIN, bootPubHex: hex(bootPub), issuedAt: NOW };
  return bootKeyBindingToWire(b, signBootKeyBinding(b, signer));
};

function world(bindingBody: unknown | null) {
  const pinStorage = memStorage();
  repinBoxKey(USER, DOMAIN, hex(stk.publicKey), { pinStorage });
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/boot-key")) return bindingBody ? json(200, bindingBody) : json(404, {});
    if (url.endsWith("/sealed-luks-key")) return json(200, { sealedKey: hex(sealForEd25519Recipient(luksKey, irk.publicKey)) });
    if (url.endsWith("/unlock-key/lease-v2")) return json(200, { ok: true });
    return json(404, {});
  });
  return { pinStorage, calls, fetch, comBase: "https://flagshipserver.com" };
}

async function deposit(w: ReturnType<typeof world>) {
  await enableLongLived(DOMAIN, 86_400_000, {
    session: { umk: umkSeed, username: USER },
    fetch: w.fetch,
    comBase: w.comBase,
    pinStorage: w.pinStorage,
    signWithIrk: async (_u: Uint8Array, bytes: Uint8Array) => ed25519.sign(bytes, irk.privateKey),
    now: () => NOW,
    boxStk: async () => hex(stk.publicKey),
    readSuspension: async () => ({ suspended: false, epoch: 0, seq: 0 }),
    deadMan: null,
  });
  const post = w.calls.find((c) => c.url.endsWith("/unlock-key/lease-v2"))!;
  return JSON.parse(String(post.init!.body)).lease;
}

describe("the boot key in the webapp", () => {
  it("seals a lease to the boot key the pinned STK vouches for, never to the STK", async () => {
    const w = world(binding());
    const lease = await deposit(w);
    expect(lease.stkPub).toBe(hex(boot.publicKey));
    expect(openAutoUnlockLeaseV2({ ...lease, stkPub: unhex(lease.stkPub), sealedKey: unhex(lease.sealedKey) }, boot.privateKey)).toEqual(luksKey);
  });

  it("ignores a binding the pinned STK did not sign (a .com swapping in its own key)", async () => {
    const w = world(binding(other, other.publicKey));
    expect(await bootKeyFor(USER, DOMAIN, { fetch: w.fetch, comBase: w.comBase, pinStorage: w.pinStorage })).toBeNull();
    const lease = await deposit(w);
    expect(lease.stkPub).toBe(hex(stk.publicKey));
  });

  it("keeps the pinned boot key when .com later serves nothing or junk", async () => {
    const good = world(binding());
    expect(await bootKeyFor(USER, DOMAIN, { fetch: good.fetch, comBase: good.comBase, pinStorage: good.pinStorage })).toBe(hex(boot.publicKey));
    const gone = vi.fn(async () => json(404, {}));
    expect(await bootKeyFor(USER, DOMAIN, { fetch: gone, comBase: good.comBase, pinStorage: good.pinStorage })).toBe(hex(boot.publicKey));
  });

  it("a shared server's boot key must be vouched for by the STK pinned in the offer", async () => {
    const w = world(binding());
    expect(await sharedBootKeyFor(DOMAIN, hex(stk.publicKey), { fetch: w.fetch, comBase: w.comBase })).toBe(hex(boot.publicKey));
    expect(await sharedBootKeyFor(DOMAIN, hex(other.publicKey), { fetch: w.fetch, comBase: w.comBase })).toBeNull();
  });
});
