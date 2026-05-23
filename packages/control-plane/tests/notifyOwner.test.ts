import { describe, expect, it, beforeEach } from "vitest";
import { ed, signSecretRequest, type Keypair, type SecretRequest } from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import { handleNotifyOwner, _resetNotifyOwnerRateLedger } from "../src/notifyOwner.js";

const HOST = "home.alice.flagship.services";
const USERNAME = "alice";
const SECRET = "shared-notify-secret-value";

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function rand(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

async function setup(opts: { irk: Keypair; stk: Keypair }): Promise<InMemoryStorage> {
  const s = new InMemoryStorage();
  await s.usernames.put({ username: USERNAME, irkPubHex: bytesToHex(opts.irk.publicKey), claimedAt: 1 });
  await s.servers.put({
    serverDomain: HOST,
    username: USERNAME,
    identityPubKeyHex: bytesToHex(opts.stk.publicKey),
    registeredAt: 2,
  });
  return s;
}

function signedRequest(stk: Keypair, nonce: Uint8Array, issuedAt: number) {
  const req: SecretRequest = { serverDomain: HOST, stkPub: stk.publicKey, purpose: "unlock-key", nonce, issuedAt };
  const sig = signSecretRequest(req, stk);
  return {
    serverDomain: HOST,
    purpose: "unlock-key" as const,
    signedRequest: {
      request: { serverDomain: HOST, stkPub: bytesToHex(stk.publicKey), purpose: "unlock-key", nonce: bytesToHex(nonce), issuedAt },
      signature: bytesToHex(sig),
    },
  };
}

describe("handleNotifyOwner", () => {
  beforeEach(() => _resetNotifyOwnerRateLedger());

  it("503 when not configured", async () => {
    const stk = makeKey();
    const irk = makeKey();
    const s = await setup({ irk, stk });
    const now = 1_000;
    const r = await handleNotifyOwner({ servers: s.servers, usernames: s.usernames, secretMailbox: s.secretMailbox, now: () => now }, SECRET, signedRequest(stk, rand(32), now));
    expect(r.status).toBe(503);
  });

  it("401 on a bad shared secret", async () => {
    const stk = makeKey();
    const irk = makeKey();
    const s = await setup({ irk, stk });
    const now = 1_000;
    const r = await handleNotifyOwner(
      { servers: s.servers, usernames: s.usernames, secretMailbox: s.secretMailbox, notifySharedSecret: SECRET, now: () => now },
      "wrong-secret",
      signedRequest(stk, rand(32), now),
    );
    expect(r.status).toBe(401);
  });

  it("fires the push when the SecretRequest verifies against the directory STK", async () => {
    const stk = makeKey();
    const irk = makeKey();
    const s = await setup({ irk, stk });
    const now = 1_000;
    const pushed: Array<{ user: string; category: string }> = [];
    const r = await handleNotifyOwner(
      {
        servers: s.servers,
        usernames: s.usernames,
        secretMailbox: s.secretMailbox,
        notifySharedSecret: SECRET,
        pushUserDevices: async (user, category) => {
          pushed.push({ user, category });
        },
        now: () => now,
      },
      SECRET,
      signedRequest(stk, rand(32), now),
    );
    expect(r.status).toBe(200);
    expect(pushed.length).toBe(1);
    expect(pushed[0]!.user).toBe(USERNAME);
    expect(pushed[0]!.category).toBe("secret-request");
  });

  it("rejects a foreign STK that isn't the directory-bound box (403)", async () => {
    const stk = makeKey();
    const irk = makeKey();
    const s = await setup({ irk, stk });
    const foreign = makeKey();
    const now = 1_000;
    const r = await handleNotifyOwner(
      { servers: s.servers, usernames: s.usernames, secretMailbox: s.secretMailbox, notifySharedSecret: SECRET, now: () => now },
      SECRET,
      signedRequest(foreign, rand(32), now), // signed by foreign, not the registered STK
    );
    expect(r.status).toBe(403);
  });

  it("dedups the push per (serverDomain, nonce) within the window", async () => {
    const stk = makeKey();
    const irk = makeKey();
    const s = await setup({ irk, stk });
    const now = 1_000;
    let pushes = 0;
    const deps = {
      servers: s.servers,
      usernames: s.usernames,
      secretMailbox: s.secretMailbox,
      notifySharedSecret: SECRET,
      pushUserDevices: async () => {
        pushes++;
      },
      now: () => now,
    };
    const nonce = rand(32);
    const a = await handleNotifyOwner(deps, SECRET, signedRequest(stk, nonce, now));
    expect(a.status).toBe(200);
    const b = await handleNotifyOwner(deps, SECRET, signedRequest(stk, nonce, now));
    expect(b.status).toBe(200);
    expect((b.body as { deduped?: boolean }).deduped).toBe(true);
    expect(pushes).toBe(1);
  });

  it("rate-limits a hostile caller hammering one account with fresh nonces (429)", async () => {
    const stk = makeKey();
    const irk = makeKey();
    const s = await setup({ irk, stk });
    const now = 1_000;
    const deps = {
      servers: s.servers,
      usernames: s.usernames,
      secretMailbox: s.secretMailbox,
      notifySharedSecret: SECRET,
      rateMax: 3,
      pushUserDevices: async () => {},
      now: () => now,
    };
    let last = 0;
    for (let i = 0; i < 5; i++) {
      const r = await handleNotifyOwner(deps, SECRET, signedRequest(stk, rand(32), now));
      last = r.status;
    }
    expect(last).toBe(429);
  });
});
