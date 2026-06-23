/**
 * Box-side owner preferred-server vote consumer + the gossip `readSelfVote`
 * hookup (Phase 6).
 *
 * The phone deposits an owner-IRK `set-leader` vote ADDRESSED to a box. The
 * consumer fetches it, verifies under the owner IRK, stores it, and the
 * `readSelfVote` getter returns it ON THIS box's gossip frame ONLY when the vote
 * names this box's STK. A vote for a sibling → no self-vote (the sibling carries
 * it via gossip). "none" → clears.
 */

import { describe, expect, it } from "vitest";
import {
  ed,
  signSetLeader,
  SET_LEADER_NONE,
  type Keypair,
  type SetLeaderVote,
} from "@flagship/protocol";
import {
  buildReadSelfVote,
  claimSetLeaderDeposit,
  decodeAndVerifySetLeaderCarrier,
  type SetLeaderVoteStore,
  type StoredSetLeaderVote,
} from "../src/setLeaderConsumer.js";

const DOMAIN = "home.alice.flagship.services";
const USER = "alice";

function makeKey(seed: number): Keypair {
  const priv = new Uint8Array(32).fill(seed);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** Build the deposited set-leader carrier hex (`{vote, signature}` JSON). */
function carrier(opts: {
  irk: Keypair;
  preferredStkPubHex: string;
  issuedAt?: number;
  signWith?: Keypair;
  user?: string;
}): string {
  const vote: SetLeaderVote = {
    user: opts.user ?? USER,
    preferredStkPubHex: opts.preferredStkPubHex,
    issuedAt: opts.issuedAt ?? 5_000,
    nonce: "deadbeef",
  };
  const sig = signSetLeader(vote, opts.signWith ?? opts.irk);
  const json = JSON.stringify({
    vote: {
      user: vote.user,
      preferredStkPubHex: vote.preferredStkPubHex,
      issuedAt: vote.issuedAt,
      nonce: vote.nonce,
    },
    signature: hex(sig),
  });
  return hex(new TextEncoder().encode(json));
}

function fetchReturning(sealedHex: string | null): typeof fetch {
  return (async () => {
    if (sealedHex === null) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify({ serverDomain: DOMAIN, sealed: sealedHex }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function memStore(): SetLeaderVoteStore & { value: StoredSetLeaderVote | null } {
  const s = {
    value: null as StoredSetLeaderVote | null,
    async read() {
      return s.value;
    },
    async write(v: StoredSetLeaderVote) {
      s.value = v;
    },
  };
  return s;
}

describe("decodeAndVerifySetLeaderCarrier", () => {
  it("returns the vote for a good owner-IRK carrier", () => {
    const irk = makeKey(1);
    const self = makeKey(9);
    const out = decodeAndVerifySetLeaderCarrier({
      sealedHex: carrier({ irk, preferredStkPubHex: hex(self.publicKey) }),
      ownerIrkPub: irk.publicKey,
      user: USER,
    });
    expect(out).not.toBeNull();
    expect(out!.preferredStkPubHex).toBe(hex(self.publicKey));
  });

  it("returns null on a forged signature / wrong account / junk", () => {
    const irk = makeKey(1);
    const wrong = makeKey(2);
    const self = makeKey(9);
    expect(
      decodeAndVerifySetLeaderCarrier({
        sealedHex: carrier({ irk, preferredStkPubHex: hex(self.publicKey), signWith: wrong }),
        ownerIrkPub: irk.publicKey,
        user: USER,
      }),
    ).toBeNull();
    expect(
      decodeAndVerifySetLeaderCarrier({
        sealedHex: carrier({ irk, preferredStkPubHex: hex(self.publicKey), user: "mallory" }),
        ownerIrkPub: irk.publicKey,
        user: USER,
      }),
    ).toBeNull();
    expect(
      decodeAndVerifySetLeaderCarrier({ sealedHex: "zzzz", ownerIrkPub: irk.publicKey, user: USER }),
    ).toBeNull();
  });
});

describe("readSelfVote hookup", () => {
  it("a vote for THIS box → the getter returns the self-vote (rides our frame)", () => {
    const self = makeKey(9);
    const vote: StoredSetLeaderVote = {
      user: USER,
      preferredStkPubHex: hex(self.publicKey),
      issuedAt: 5_000,
      nonce: "n",
    };
    const getter = buildReadSelfVote({ currentVote: () => vote, selfStkHex: hex(self.publicKey) });
    expect(getter()).toEqual({ stkHex: hex(self.publicKey), date: 5_000 });
  });

  it("a vote for a SIBLING → no self-vote (null; the sibling carries it via gossip)", () => {
    const self = makeKey(9);
    const sibling = makeKey(11);
    const vote: StoredSetLeaderVote = {
      user: USER,
      preferredStkPubHex: hex(sibling.publicKey),
      issuedAt: 5_000,
      nonce: "n",
    };
    const getter = buildReadSelfVote({ currentVote: () => vote, selfStkHex: hex(self.publicKey) });
    expect(getter()).toBeNull();
  });

  it("'none' → clears (the getter returns null)", () => {
    const self = makeKey(9);
    const vote: StoredSetLeaderVote = {
      user: USER,
      preferredStkPubHex: SET_LEADER_NONE,
      issuedAt: 5_000,
      nonce: "n",
    };
    const getter = buildReadSelfVote({ currentVote: () => vote, selfStkHex: hex(self.publicKey) });
    expect(getter()).toBeNull();
  });

  it("no stored vote → null", () => {
    const self = makeKey(9);
    const getter = buildReadSelfVote({ currentVote: () => null, selfStkHex: hex(self.publicKey) });
    expect(getter()).toBeNull();
  });
});

describe("claimSetLeaderDeposit", () => {
  it("stores a verified vote + fires onVote", async () => {
    const irk = makeKey(1);
    const self = makeKey(9);
    const store = memStore();
    let seen: StoredSetLeaderVote | null = null;
    const out = await claimSetLeaderDeposit({
      serverDomain: DOMAIN,
      user: USER,
      ownerIrkPub: irk.publicKey,
      controlPlaneBaseUrl: "https://flagshipserver.com",
      store,
      onVote: (v) => {
        seen = v;
      },
      fetchImpl: fetchReturning(carrier({ irk, preferredStkPubHex: hex(self.publicKey) })),
      onLog: () => {},
    });
    expect(out.stored).toBe(true);
    expect(store.value?.preferredStkPubHex).toBe(hex(self.publicKey));
    expect(seen).not.toBeNull();
  });

  it("end-to-end: claim a self-vote → readSelfVote lights up", async () => {
    const irk = makeKey(1);
    const self = makeKey(9);
    const store = memStore();
    let snapshot: StoredSetLeaderVote | null = null;
    await claimSetLeaderDeposit({
      serverDomain: DOMAIN,
      user: USER,
      ownerIrkPub: irk.publicKey,
      controlPlaneBaseUrl: "https://flagshipserver.com",
      store,
      onVote: (v) => {
        snapshot = v;
      },
      fetchImpl: fetchReturning(carrier({ irk, preferredStkPubHex: hex(self.publicKey) })),
      onLog: () => {},
    });
    const getter = buildReadSelfVote({
      currentVote: () => snapshot,
      selfStkHex: hex(self.publicKey),
    });
    expect(getter()).toEqual({ stkHex: hex(self.publicKey), date: 5_000 });
  });

  it("a forged vote is NOT stored (keep polling)", async () => {
    const irk = makeKey(1);
    const wrong = makeKey(2);
    const self = makeKey(9);
    const store = memStore();
    const out = await claimSetLeaderDeposit({
      serverDomain: DOMAIN,
      user: USER,
      ownerIrkPub: irk.publicKey,
      controlPlaneBaseUrl: "https://flagshipserver.com",
      store,
      fetchImpl: fetchReturning(carrier({ irk, preferredStkPubHex: hex(self.publicKey), signWith: wrong })),
      onLog: () => {},
    });
    expect(out).toEqual({ stored: false, reason: "rejected" });
    expect(store.value).toBeNull();
  });

  it("404 → no-deposit, nothing stored", async () => {
    const irk = makeKey(1);
    const store = memStore();
    const out = await claimSetLeaderDeposit({
      serverDomain: DOMAIN,
      user: USER,
      ownerIrkPub: irk.publicKey,
      controlPlaneBaseUrl: "https://flagshipserver.com",
      store,
      fetchImpl: fetchReturning(null),
      onLog: () => {},
    });
    expect(out).toEqual({ stored: false, reason: "no-deposit" });
    expect(store.value).toBeNull();
  });
});
