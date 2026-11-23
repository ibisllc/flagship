// "Choose your own account name" at sign-up (owner decision 2026-11-23; apps/web/public/webapp/lib/chooseName.js),
// driven by the webapp's own module against the gym `.com`, as a device that holds the keys at protocol level: a
// fresh real account opens under a suggested name and is renamed at once, paid by a name-change code, by ten test
// vouchers, and by the owner's free name grant (scripts/name-grant.mjs). Then the new name is in the registry (a
// look-alike is refused to another account, the suggested name is free again), the device's kept key mints a read
// token under the new name, its grant was swapped, and a second device joins under the new name.
import { randomBytes } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils";
import {
  accountReadTokenPath,
  deriveAccountDeviceKeySeed,
  ed,
  signAccountDirectoryRequest,
  type Keypair,
} from "@flagship/protocol";
import { Account, REAL_PRIMARY_DEVICE_ID, createRealAccount, mintDeviceGrant } from "../lib/fleet.js";
import { CONTROL, adminHeaders, assert, http, postJson, short } from "../lib/harness.js";
import { rawTestVouchers, Vouchers } from "../lib/payments.js";
import type { Group } from "./types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const CHOOSE_JS = "../../../apps/web/public/webapp/lib/chooseName.js";
const Choose: Any = await import(CHOOSE_JS);

function keypair(seed: Uint8Array): Keypair {
  return { privateKey: seed, publicKey: ed.getPublicKey(seed) };
}

function memStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

/** Mints a read token for `name` with the device key `.com` holds for `deviceId`. */
async function deviceReadToken(name: string, deviceId: string, key: Keypair) {
  const path = accountReadTokenPath(name);
  const requestId = randomBytes(16).toString("hex");
  const issuedAt = Date.now();
  const sig = signAccountDirectoryRequest(
    { accountId: name, deviceId, signerPubHex: bytesToHex(key.publicKey), method: "POST", path, requestId, issuedAt },
    key,
  );
  return http(`https://${CONTROL}${path}`, {
    method: "POST",
    headers: {
      "x-flagship-device-id": deviceId,
      "x-flagship-device-pub": bytesToHex(key.publicKey),
      "x-flagship-request-id": requestId,
      "x-flagship-issued-at": String(issuedAt),
      "x-flagship-signature": sig,
    },
  });
}

/** The webapp's io for lib/chooseName.js, over this account's keys (no browser storage, no card page). */
function io(acct: Account, opts: { vouchers?: Any[] } = {}) {
  const k = acct.keys;
  const kept = new Map<string, Uint8Array>();
  const state = { name: acct.username, readToken: 0 };
  return {
    state,
    kept,
    storage: memStorage(),
    session: { umk: k.umk, username: acct.username },
    apex: `https://${CONTROL}`,
    fetch: (url: string, init?: RequestInit) => fetch(url, init),
    now: Date.now,
    randomUUID: () => crypto.randomUUID(),
    aidPubHex: bytesToHex(k.aid.publicKey),
    irkPubHex: bytesToHex(k.irk.publicKey),
    signAdmin: async (b: Uint8Array) => ed.sign(b, k.adminRoot.privateKey),
    signIrk: async (b: Uint8Array) => ed.sign(b, k.irk.privateKey),
    deriveAccountDeviceSeed: async (umk: Uint8Array, name: string, id: string) =>
      kept.get(`${name}|${id}`) ?? deriveAccountDeviceKeySeed(umk, name, id),
    persistAccountDeviceSeed: async (_u: Uint8Array, name: string, id: string, seed: Uint8Array) => void kept.set(`${name}|${id}`, seed),
    deriveAccountDeviceKey: async (umk: Uint8Array, name: string, id: string) =>
      keypair(kept.get(`${name}|${id}`) ?? deriveAccountDeviceKeySeed(umk, name, id)),
    // createRealAccount writes no profiles; the webapp's re-put is covered by its unit tests.
    reputProfiles: async () => {},
    moveLocalAccount: async (_o: string, n: string) => {
      state.name = n;
    },
    mintReadToken: async (n: string) => {
      const seed = kept.get(`${n}|${REAL_PRIMARY_DEVICE_ID}`);
      state.readToken = seed ? (await deviceReadToken(n, REAL_PRIMARY_DEVICE_ID, keypair(seed))).status : 0;
    },
    buyPack: async () => ({ url: "about:blank" }),
    navigate: () => {},
    consumeShopReturn: () => "stripe",
    finishShopOrders: async () => ({ added: opts.vouchers?.length ?? 0 }),
    takeVouchers: async (n: number) => (opts.vouchers ?? []).slice(0, n),
    voucherNullifier: (v: Any) => Vouchers.voucherNullifier(v),
    dropSpentVouchers: async () => {},
  };
}

const fresh = (p: string) => `${p}${randomBytes(3).toString("hex")}`;

export const chooseName: Group = {
  name: "choose-name",
  title: "choose your own account name: rename at sign-up paid by a code, by ten vouchers and by a free name grant; the registry, the kept device key, the grant swap, a second device under the new name",
  needs: [],
  phase: 1,
  async run({ rec }) {
    const made: string[] = [];
    try {
      let acct: Account | null = null;
      let renamed = "";
      let suggested = "";
      await rec.check("a fresh account renamed with a name-change code: .com knows it by the new name, the old one is free", async () => {
        acct = await createRealAccount();
        suggested = acct.username;
        const issue = await postJson(`https://${CONTROL}/api/admin/voucher/issue`, { kind: "name-change" }, adminHeaders());
        assert(issue.status === 200 && typeof issue.json?.code === "string", `voucher issue ${issue.status}: ${short(issue.text)}`);
        renamed = fresh("gymname");
        const dev = io(acct);
        const out = await Choose.claimChosenName(
          { suggested, wanted: renamed, method: "code", code: issue.json.code, stage: "quote", deviceId: REAL_PRIMARY_DEVICE_ID },
          dev,
        );
        assert(out.ok === true, `claim: ${short(out)}`);
        made.push(renamed);
        const now = await http(`https://${CONTROL}/api/username/${renamed}`);
        assert(now.status === 200 && now.json?.irkPub === bytesToHex(acct.keys.irk.publicKey), `lookup new ${now.status}`);
        const old = await http(`https://${CONTROL}/api/username/${suggested}`);
        assert(old.status === 404, `old name still answers ${old.status}`);
        assert(dev.state.readToken === 200, `read token under the new name with the kept key: ${dev.state.readToken}`);
        return `${suggested} → ${renamed}`;
      });

      await rec.check("the new name is in the registry: another account is refused a look-alike, the released name is offered again", async () => {
        assert(renamed, "no rename");
        const other = await createRealAccount();
        made.push(other.username);
        const look = renamed.replace("gymname", "gym-name");
        const q = await postJson(`https://${CONTROL}/api/account/name-change/quote`, { username: other.username, newUsername: look });
        assert(q.json?.available === false && q.json?.code === "taken", `look-alike quote: ${short(q.json)}`);
        const q2 = await postJson(`https://${CONTROL}/api/account/name-change/quote`, { username: other.username, newUsername: suggested });
        assert(q2.json?.available === true, `released name: ${short(q2.json)}`);
        return `${look} taken, ${suggested} free`;
      });

      await rec.check("the device grant was swapped and a second device joins under the new name", async () => {
        assert(acct && renamed, "no rename");
        const a = new Account(renamed, acct.keys, false);
        const deviceId = randomBytes(16).toString("hex");
        const key = keypair(deriveAccountDeviceKeySeed(acct.keys.umk, renamed, deviceId));
        const g = await mintDeviceGrant(a, deviceId, key, ["browse", "view-directory"], acct.keys.irk);
        assert(g.status === 200, `second device grant ${g.status}: ${short(g.text)}`);
        const t = await deviceReadToken(renamed, deviceId, key);
        assert(t.status === 200, `second device read token ${t.status}: ${short(t.text)}`);
        return "joined";
      });

      await rec.check("ten test vouchers pay a sign-up rename", async () => {
        const b = await createRealAccount();
        const wanted = fresh("gympaid");
        const v = await rawTestVouchers(10);
        const out = await Choose.claimChosenName(
          { suggested: b.username, wanted, method: "pay", stage: "paying", deviceId: REAL_PRIMARY_DEVICE_ID },
          io(b, { vouchers: v }),
        );
        assert(out.ok === true, `claim: ${short(out)}`);
        made.push(wanted);
        // Spent: the same vouchers can't pay again.
        const again = await postJson(`https://${CONTROL}/api/vouchers/redeem`, { v: 1, username: wanted, for: "pro", vouchers: v });
        assert(again.status === 409 && again.json?.code === "voucher-spent", `respend ${again.status}: ${short(again.json)}`);
        return wanted;
      });

      await rec.check("a free name grant from the owner pays, once, for its own name only", async () => {
        const c = await createRealAccount();
        const wanted = fresh("gymgift");
        const g = await postJson(`https://${CONTROL}/api/admin/name-grant`, { name: wanted, free: true, hours: 1 }, adminHeaders());
        assert(g.status === 200 && g.json?.free === true, `grant ${g.status}: ${short(g.text)}`);
        const link = `https://${CONTROL}/app/choose-name#n=${wanted}&g=${g.json.code}&e=${g.json.expiresAt}&f=1`;
        const grant = Choose.parseNameGrantLink(link);
        assert(grant?.paid === true, "link did not parse");
        const elsewhere = await postJson(`https://${CONTROL}/api/account/name-change/quote`, {
          username: c.username,
          newUsername: fresh("gymother"),
          nameGrant: { code: grant.code, expiresAt: grant.expiresAt },
        });
        assert(elsewhere.json?.code === "grant-invalid", `a grant for another name: ${short(elsewhere.json)}`);
        const out = await Choose.claimChosenName(
          { suggested: c.username, wanted, method: "grant", grant, stage: "quote", deviceId: REAL_PRIMARY_DEVICE_ID },
          io(c),
        );
        assert(out.ok === true, `claim: ${short(out)}`);
        made.push(wanted);
        return wanted;
      });
    } finally {
      if (made.length) {
        await http(`https://${CONTROL}/api/gym/teardown`, {
          method: "POST",
          headers: { "content-type": "application/json", ...adminHeaders() },
          body: JSON.stringify({ usernames: made }),
        }).catch(() => null);
      }
    }
  },
};
