// #30 maintainer→CA gate over the two .com hot-CA signing sites
// (handleUserPubKeyCert / handleUsersCheck). The decisive property is
// DEPLOY-SAFETY: with the shipped (populated) pin but NO authorized CA
// keys, OBSERVE mode must sign BYTE-FOR-BYTE as it does today and only
// emit a log line — landing this code changes nothing observable in
// production until a human flips ENFORCE post-ceremony.
//
// The `CaTrustChain` (links 2-3) is dependency-injected by design
// (see @flagship/protocol maintainerCa.ts) — these tests inject a
// fabricated chain + clock so they are fully hermetic and need no
// @ibisllc/maintainers dependency. The Worker-side test
// (apps/com/test) separately proves the REAL forward verifier runs.

import { describe, expect, it } from "vitest";
import {
  ed,
  verifyUserPubKeyBinding,
  verifyCaSignedUserPubKeyBinding,
  type CaTrustChain,
  type Keypair,
  type UserPubKeyBinding,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  handleUserPubKeyCert,
  caKeypairFromEnv,
  type CaGate,
  type PubkeyCertDeps,
} from "../src/pubkeyCert.js";
import { handleUsersCheck, type UsersCheckResponse } from "../src/usersCheck.js";
import type { UsernameStorage } from "@flagship/storage";

const NOW = 1_770_000_000_000;
const USERNAME = "alice";

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function caFromHex(privHex: string): Keypair {
  const sk = new Uint8Array(32);
  for (let i = 0; i < 32; i++) sk[i] = parseInt(privHex.slice(i * 2, i * 2 + 2), 16);
  return { privateKey: sk, publicKey: ed.getPublicKey(sk) };
}

async function seededUsernames(): Promise<UsernameStorage> {
  const s = new InMemoryStorage().usernames;
  await s.put({ username: USERNAME, irkPubHex: "bb".repeat(32), claimedAt: 1 });
  return s;
}

/** Storage whose `get` returns an is_demo claim (drives the directive). */
function demoStorage(): UsernameStorage {
  return {
    async get(name: string) {
      return {
        username: name.toLowerCase(),
        irkPubHex: "aa".repeat(32),
        claimedAt: 1,
        isDemo: true,
      };
    },
    async put() { return { ok: true } as const; },
    async list() { return []; },
    async swapIrkPub() { return false; },
    async setDemo() { return true; },
  } as unknown as UsernameStorage;
}

/** A fabricated injected chain. `keys` = the CA hex pubkeys it deems
 *  authorized at any `now` (the chokepoint then still checks TTL +
 *  the artifact signature against those keys). */
function fakeChain(keys: string[]): CaTrustChain {
  return { authorizedCaKeys: () => keys };
}

function collectLogs(): { sink: (l: Record<string, unknown>) => void; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  return { sink: (l) => lines.push(l), lines };
}

const CA = caKeypairFromEnv({ FLAGSHIP_CA_PRIV_HEX: "11".repeat(32) });

describe("#30 ca-gate — handleUserPubKeyCert", () => {
  // (a) THE deploy-safety test: OBSERVE + no authorized key ⇒ the
  // response is byte-identical to the no-gate path AND a
  // no-authorized-ca-keys verdict is logged. Proves landing+deploying
  // this changes nothing observable until a human flips ENFORCE.
  it("OBSERVE + no endorsement: signs exactly as today + logs no-authorized-ca-keys", async () => {
    const usernames = await seededUsernames();
    const baseDeps: PubkeyCertDeps = { ca: CA, usernames, now: () => NOW };
    const noGate = await handleUserPubKeyCert(baseDeps, USERNAME);

    const { sink, lines } = collectLogs();
    const gate: CaGate = { caTrustChain: fakeChain([]), enforce: false, log: sink };
    const observed = await handleUserPubKeyCert({ ...baseDeps, caGate: gate }, USERNAME);

    // Byte-for-byte identical happy path (status, body, signature).
    expect(observed.status).toBe(200);
    expect(observed).toEqual(noGate);
    // And exactly one structured verdict was emitted.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      tag: "ca-gate",
      artifact: "UserPubKeyBinding",
      mode: "observe",
      authorized: false,
      reason: "no-authorized-ca-keys",
    });
  });

  // (b) ENFORCE + no endorsement ⇒ 403, NOTHING signed (no binding /
  // signature in the body).
  it("ENFORCE + no endorsement: refuses to sign (403)", async () => {
    const usernames = await seededUsernames();
    const gate: CaGate = { caTrustChain: fakeChain([]), enforce: true, log: () => {} };
    const r = await handleUserPubKeyCert({ ca: CA, usernames, now: () => NOW, caGate: gate }, USERNAME);
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).toContain("no-authorized-ca-keys");
    expect(JSON.stringify(r.body)).not.toContain("signature");
  });

  // (c) ENFORCE + a chain that authorizes the actual signing CA key ⇒
  // signs, and the emitted cert verifies through the protocol
  // chokepoint at the same clock.
  it("ENFORCE + authorized CA key: signs and the cert verifies via verifyCaSignedUserPubKeyBinding", async () => {
    const usernames = await seededUsernames();
    const chain = fakeChain([hex(CA.keypair.publicKey)]);
    const gate: CaGate = { caTrustChain: chain, enforce: true, log: () => {} };
    const r = await handleUserPubKeyCert({ ca: CA, usernames, now: () => NOW, caGate: gate }, USERNAME);
    expect(r.status).toBe(200);
    const body = r.body as { binding: Record<string, unknown>; signature: string };
    const binding: UserPubKeyBinding = {
      version: 1,
      username: USERNAME,
      pubKey: Uint8Array.from(
        (body.binding.pubKey as string).match(/.{2}/g)!.map((h) => parseInt(h, 16)),
      ),
      issuedAt: body.binding.issuedAt as number,
      expiresAt: body.binding.expiresAt as number,
      issuer: body.binding.issuer as string,
    };
    const sig = Uint8Array.from(body.signature.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
    // Raw signature is valid AND the full chokepoint accepts it.
    expect(verifyUserPubKeyBinding(binding, sig, CA.keypair.publicKey)).toBe(true);
    expect(verifyCaSignedUserPubKeyBinding(binding, sig, chain, NOW).ok).toBe(true);
  });

  // (d.1) ENFORCE + chain authorizes only a WRONG key ⇒ the artifact
  // signature can't verify under it ⇒ signature-unverified ⇒ refuse.
  it("ENFORCE + wrong-signer endorsement: refuses (signature-unverified)", async () => {
    const usernames = await seededUsernames();
    const wrong = caFromHex("99".repeat(32));
    const gate: CaGate = { caTrustChain: fakeChain([hex(wrong.publicKey)]), enforce: true, log: () => {} };
    const r = await handleUserPubKeyCert({ ca: CA, usernames, now: () => NOW, caGate: gate }, USERNAME);
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).toContain("signature-unverified");
  });
});

describe("#30 ca-gate — handleUsersCheck demo directive", () => {
  // (a') OBSERVE + no endorsement: the demo directive is still
  // attached exactly as today; a no-authorized-ca-keys verdict logs.
  it("OBSERVE + no endorsement: attaches the directive as today + logs", async () => {
    const { sink, lines } = collectLogs();
    const gate: CaGate = { caTrustChain: fakeChain([]), enforce: false, log: sink };
    const r = await handleUsersCheck(
      { storage: demoStorage(), ca: CA, caGate: gate, now: () => NOW },
      { username: USERNAME },
    );
    const body = r.body as UsersCheckResponse;
    expect(body.demoDirective).toBeDefined();
    expect(lines[0]).toMatchObject({ artifact: "DemoDirective", mode: "observe", authorized: false });
  });

  // (b') ENFORCE + no endorsement: the availability response is still
  // 200 "already claimed" (unchanged) but NO CA-signed directive is
  // attached — we refuse to mint the artifact, we don't 403 the check.
  it("ENFORCE + no endorsement: omits the directive, response otherwise unchanged", async () => {
    const gate: CaGate = { caTrustChain: fakeChain([]), enforce: true, log: () => {} };
    const r = await handleUsersCheck(
      { storage: demoStorage(), ca: CA, caGate: gate, now: () => NOW },
      { username: USERNAME },
    );
    expect(r.status).toBe(200);
    const body = r.body as UsersCheckResponse;
    expect(body.available).toBe(false);
    expect(body.reason).toBe("already claimed");
    expect(body.demoDirective).toBeUndefined();
  });

  // (c') ENFORCE + authorized CA key: the directive is attached.
  it("ENFORCE + authorized CA key: attaches the directive", async () => {
    const gate: CaGate = {
      caTrustChain: fakeChain([hex(CA.keypair.publicKey)]),
      enforce: true,
      log: () => {},
    };
    const r = await handleUsersCheck(
      { storage: demoStorage(), ca: CA, caGate: gate, now: () => NOW },
      { username: USERNAME },
    );
    expect((r.body as UsersCheckResponse).demoDirective).toBeDefined();
  });

  // (d.2) ENFORCE + expired window — the chokepoint runs against an
  // authorized key but the directive's own TTL is in the past ⇒
  // artifact-expired ⇒ directive omitted (the gate's own TTL link, not
  // the chain link, does the rejecting here).
  it("ENFORCE + directive outside its own TTL window: artifact-expired ⇒ directive omitted", async () => {
    const { sink, lines } = collectLogs();
    const gate: CaGate = {
      caTrustChain: fakeChain([hex(CA.keypair.publicKey)]),
      enforce: true,
      log: sink,
    };
    // The handler uses one `now` for mint + gate, so drive the
    // artifact-expired branch via a negative TTL (expiresAt <
    // issuedAt ⇒ `now` is outside [issuedAt, expiresAt)).
    const r = await handleUsersCheck(
      {
        storage: demoStorage(),
        ca: CA,
        caGate: gate,
        now: () => NOW,
        demoDirectiveTtlMs: -1, // expiresAt < issuedAt ⇒ outside [issuedAt,expiresAt)
      },
      { username: USERNAME },
    );
    expect((r.body as UsersCheckResponse).demoDirective).toBeUndefined();
    expect(lines[0]).toMatchObject({ authorized: false, reason: "artifact-expired" });
  });
});
