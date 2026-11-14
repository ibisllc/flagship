/**
 * keyd's master check needs a recent `.com` revocation list, checked against CA keys root writes
 * (keydCaKeys.ts), and the device book hands keyd each list `.com` sends beside the grants.
 */
import { describe, expect, it } from "vitest";
import { ed, parseKeydCaKeys, signDeviceRevocationList, verifyDeviceRevocationList } from "@flagship/protocol";
import { AccountDeviceBook } from "../src/accessPrincipals.js";
import { KEYD_CA_KEYS_WINDOW_MS, keydCaKeys, writeKeydCaKeys } from "../src/keydCaKeys.js";

const NOW = 1_800_000_000_000;
const caSeed = new Uint8Array(32).fill(0x0c);
const caHex = Buffer.from(ed.getPublicKey(caSeed)).toString("hex");
const irk = ed.getPublicKey(new Uint8Array(32).fill(0x07));
const irkHex = Buffer.from(irk).toString("hex");

describe("the CA keys root writes for keyd", () => {
  it("are the keys the box's chain authorizes now, for a window around the write; none without a chain", async () => {
    const out = keydCaKeys({ authorizedCaKeys: () => [caHex.toUpperCase(), caHex] }, NOW);
    expect(parseKeydCaKeys(out)).toEqual({ v: 1, keys: [caHex], validFrom: NOW - 86_400_000, validUntil: NOW + KEYD_CA_KEYS_WINDOW_MS });
    expect(keydCaKeys(null, NOW).keys).toEqual([]);
    expect(keydCaKeys({ authorizedCaKeys: () => [] }, NOW).keys).toEqual([]);
    const writes: Array<[string, string, number]> = [];
    const r = await writeKeydCaKeys({
      keydState: "/var/lib/flagship-keyd",
      chain: () => {
        throw new Error("no .maintainers");
      },
      now: NOW,
      write: async (p, t, m) => void writes.push([p, t, m]),
    });
    expect(r).toEqual({ keys: 0 });
    expect(writes[0]![0]).toBe("/var/lib/flagship-keyd/ca-keys.json");
    expect(writes[0]![2]).toBe(0o644);
  });

  it("let keyd take .com's list, and only inside the window", () => {
    const caKeys = keydCaKeys({ authorizedCaKeys: () => [caHex] }, NOW);
    const list = (at: number) => signDeviceRevocationList({ irkPubHex: irkHex, issuedAt: at, grantIds: [] }, caSeed);
    expect(verifyDeviceRevocationList(list(NOW + 1000), { irkPubHex: irkHex, caKeys, now: NOW + 1000 }).ok).toBe(true);
    const late = NOW + KEYD_CA_KEYS_WINDOW_MS + 1;
    expect(verifyDeviceRevocationList(list(late), { irkPubHex: irkHex, caKeys, now: late })).toEqual({ ok: false, code: "outside-window" });
  });
});

describe("the device book hands keyd .com's revocation list", () => {
  it("passes the list on with each read, and keeps the book when keyd refuses it", async () => {
    const seen: unknown[] = [];
    const list = signDeviceRevocationList({ irkPubHex: irkHex, issuedAt: NOW, grantIds: [] }, caSeed);
    let refuse = false;
    const book = new AccountDeviceBook({
      path: "/nonexistent/account-devices.json",
      username: "alice",
      ownerIrkPub: () => irk,
      adminRootPub: () => undefined,
      fetchGrants: async () => ({ grants: [], revocationList: list }),
      onRevocationList: (l) => {
        if (refuse) throw new Error("keyd refused");
        seen.push(l);
      },
      now: () => NOW,
    });
    await book.refresh({ live: true }).catch(() => {});
    expect(seen).toEqual([list]);
    refuse = true;
    await book.refresh({ live: true }).catch(() => {});
    expect(seen).toHaveLength(1);
  });
});
