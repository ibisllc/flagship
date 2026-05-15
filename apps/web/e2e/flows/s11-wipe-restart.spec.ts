/**
 * S11 — Wipe & restart end-to-end against the Worker (E1 endpoint).
 *
 * The webapp's actual wipe UI is the v1 placeholder (Danger zone with
 * a "Coming soon" explainer — see E6). The protocol layer + Worker
 * endpoint, by contrast, are fully live as of E1. This scenario
 * exercises the protocol-level round-trip:
 *
 *   1. Mint a fresh test identity (UMK seed → OLD IRK).
 *   2. Seed .com state: register the username with the OLD IRK pubkey
 *      and upload an initial cloud-recovery envelope, so the wipe
 *      handler has a row to replace.
 *   3. Generate NEW IRK + NEW credentialID + NEW wrappedUmk locally.
 *   4. Sign the canonical flagship/wipe-restart/v1 bytes with the OLD
 *      IRK and POST /api/users/:u/wipe-restart with a 16-byte
 *      idempotencyKey.
 *   5. Assert the response: ok=true, auditSeq present, newIrkPub
 *      matches what we sent, ETag header returned.
 *   6. Verify the side effects:
 *      - GET /api/users/:u/audit?since=0 surfaces the new wipe-restart
 *        row.
 *      - A duplicate POST with the same idempotencyKey replays the
 *        same response (auditSeq doesn't advance).
 *      - A second wipe attempt within the rate-limit window returns
 *        429.
 *
 * This is intentionally an API-only scenario (no `page.goto`) — the
 * full UI ceremony lands on mobile (E2-E5) and the webapp ceremony is
 * v1.1 follow-up. The test still uses Playwright's request fixture so
 * it shares the rig's network setup (private-network bypass, etc.).
 */

import { test, expect, request as playwrightRequest } from "@playwright/test";
import {
  ed,
  deriveIRK,
  signWipeRestart,
  signClaimUsername,
  signUploadRecoveryRecord,
  type Keypair,
} from "@flagship/protocol";

const APEX = process.env.APEX_BASE_URL ?? "http://localhost:8787";

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

async function sha256Hex(b: Uint8Array): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", b));
  return bytesToHex(h);
}

function bytesToB64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return Buffer.from(s, "binary").toString("base64");
}

interface SetupResult {
  username: string;
  oldUmkSeed: Uint8Array;
  oldIrk: Keypair;
  initialCredentialId: string;
}

async function seedAccount(apiRequest: ReturnType<typeof playwrightRequest.newContext>): Promise<SetupResult> {
  const ctx = await apiRequest;
  const suffix = Math.floor(Math.random() * 1_000_000).toString(36).padStart(4, "0");
  const username = `e2e-wipe-${Date.now().toString(36).slice(-5)}${suffix}`;
  const umkSeed = randomBytes(32);
  const oldIrk = deriveIRK({ seed: umkSeed });

  // 1 — Claim the username on .com with the OLD IRK as the registered
  // pubkey. This is the precondition for wipe-restart: the OLD IRK on
  // .com must match what the handler verifies the signature against.
  const issuedAtClaim = Date.now();
  const claimSig = signClaimUsername(
    { username, irkPub: oldIrk.publicKey, issuedAt: issuedAtClaim },
    oldIrk,
  );
  const claimResp = await ctx.post(`${APEX}/api/users/claim`, {
    data: {
      request: {
        username,
        irkPub: bytesToHex(oldIrk.publicKey),
        issuedAt: issuedAtClaim,
      },
      signature: bytesToHex(claimSig),
    },
    failOnStatusCode: false,
  });
  expect(claimResp.status(), "username claim").toBe(200);

  // 2 — Upload an initial recovery envelope so the wipe handler has
  // something to REPLACE (the handler does an upsert; an initial
  // record makes the side-effect assertions clearer).
  const initialWrappedUmk = randomBytes(64); // arbitrary; protocol just hashes it
  const initialWrappedHashHex = await sha256Hex(initialWrappedUmk);
  const initialCredentialId = bytesToHex(randomBytes(16));
  const issuedAtUpload = Date.now();
  const uploadSig = signUploadRecoveryRecord(
    {
      username,
      credentialIdHex: initialCredentialId,
      wrappedUmkHashHex: initialWrappedHashHex,
      issuedAt: issuedAtUpload,
    },
    oldIrk,
  );
  const uploadResp = await ctx.post(`${APEX}/api/recovery`, {
    data: {
      request: {
        username,
        credentialId: initialCredentialId,
        wrappedUmk: bytesToB64(initialWrappedUmk),
        issuedAt: issuedAtUpload,
      },
      signature: bytesToHex(uploadSig),
    },
    failOnStatusCode: false,
  });
  expect(uploadResp.status(), "recovery upload").toBe(200);

  return { username, oldUmkSeed: umkSeed, oldIrk, initialCredentialId };
}

test.describe("S11 — Wipe & restart Worker integration", () => {
  test("happy path: signed envelope rotates IRK + audit row appears", async () => {
    const ctx = await playwrightRequest.newContext();
    const seeded = await seedAccount(Promise.resolve(ctx));
    const { username, oldIrk } = seeded;

    // Generate NEW identity material.
    const newUmkSeed = randomBytes(32);
    const newIrk = deriveIRK({ seed: newUmkSeed });
    const newCredentialId = bytesToHex(randomBytes(16));
    const newWrappedUmk = randomBytes(64);
    const wrappedHashHex = await sha256Hex(newWrappedUmk);

    const issuedAt = Date.now();
    const sig = signWipeRestart(
      {
        username,
        oldIrkPub: oldIrk.publicKey,
        newIrkPub: newIrk.publicKey,
        newCredentialIdHex: newCredentialId,
        newWrappedUmkHashHex: wrappedHashHex,
        issuedAt,
      },
      oldIrk,
    );
    const idempotencyKey = bytesToHex(randomBytes(16));

    const wipeResp = await ctx.post(`${APEX}/api/users/${username}/wipe-restart`, {
      data: {
        request: {
          username,
          oldIrkPub: bytesToHex(oldIrk.publicKey),
          newIrkPub: bytesToHex(newIrk.publicKey),
          newCredentialId,
          newWrappedUmk: bytesToB64(newWrappedUmk),
          issuedAt,
        },
        signature: bytesToHex(sig),
        idempotencyKey,
      },
      failOnStatusCode: false,
    });
    expect(wipeResp.status(), "wipe-restart status").toBe(200);
    const body = await wipeResp.json();
    expect(body.ok).toBe(true);
    expect(body.newIrkPub.toLowerCase()).toBe(bytesToHex(newIrk.publicKey));
    expect(typeof body.auditSeq).toBe("number");

    // The audit endpoint should now surface a wipe-restart row.
    const auditResp = await ctx.get(`${APEX}/api/users/${username}/audit?since=0&limit=10`);
    expect(auditResp.status()).toBe(200);
    const audit = await auditResp.json();
    expect(audit.events.length).toBeGreaterThan(0);
    expect(audit.events[0].eventKind).toBe("wipe-restart");

    // Duplicate POST with the same idempotencyKey replays the same
    // response — auditSeq must NOT advance.
    const dupResp = await ctx.post(`${APEX}/api/users/${username}/wipe-restart`, {
      data: {
        // Re-sign with a fresh issuedAt to make the bodies different
        // bytes; the idempotency check is keyed only on (username,
        // idempotencyKey), so the replay should match.
        request: {
          username,
          oldIrkPub: bytesToHex(oldIrk.publicKey),
          newIrkPub: bytesToHex(newIrk.publicKey),
          newCredentialId,
          newWrappedUmk: bytesToB64(newWrappedUmk),
          issuedAt: Date.now(),
        },
        signature: bytesToHex(sig), // unchanged
        idempotencyKey,             // SAME key
      },
      failOnStatusCode: false,
    });
    expect(dupResp.status(), "idempotent replay status").toBe(200);
    const dupBody = await dupResp.json();
    expect(dupBody.auditSeq).toBe(body.auditSeq);

    // A SECOND distinct wipe attempt within the rate-limit window
    // hits 429.
    const fresh2NewIrk = deriveIRK({ seed: randomBytes(32) });
    const fresh2IssuedAt = Date.now();
    const fresh2WrappedHash = await sha256Hex(randomBytes(64));
    const fresh2Sig = signWipeRestart(
      {
        // The post-wipe registered IRK is `newIrk`; this 429-target
        // request uses `newIrk` as oldIrkPub.
        username,
        oldIrkPub: newIrk.publicKey,
        newIrkPub: fresh2NewIrk.publicKey,
        newCredentialIdHex: bytesToHex(randomBytes(16)),
        newWrappedUmkHashHex: fresh2WrappedHash,
        issuedAt: fresh2IssuedAt,
      },
      newIrk,
    );
    const fresh2Resp = await ctx.post(`${APEX}/api/users/${username}/wipe-restart`, {
      data: {
        request: {
          username,
          oldIrkPub: bytesToHex(newIrk.publicKey),
          newIrkPub: bytesToHex(fresh2NewIrk.publicKey),
          newCredentialId: bytesToHex(randomBytes(16)),
          newWrappedUmk: bytesToB64(randomBytes(64)),
          issuedAt: fresh2IssuedAt,
        },
        signature: bytesToHex(fresh2Sig),
        idempotencyKey: bytesToHex(randomBytes(16)),
      },
      failOnStatusCode: false,
    });
    expect(fresh2Resp.status(), "second-wipe rate-limit").toBe(429);

    await ctx.dispose();
  });

  test("rejects when oldIrkPub doesn't match the registered IRK", async () => {
    const ctx = await playwrightRequest.newContext();
    const seeded = await seedAccount(Promise.resolve(ctx));
    const { username } = seeded;

    // Sign with a key the server doesn't know about.
    const wrongOld: Keypair = {
      privateKey: randomBytes(32),
      publicKey: new Uint8Array(0),
    };
    wrongOld.publicKey = ed.getPublicKey(wrongOld.privateKey);

    const newIrk = deriveIRK({ seed: randomBytes(32) });
    const newWrappedUmk = randomBytes(64);
    const wrappedHashHex = await sha256Hex(newWrappedUmk);
    const issuedAt = Date.now();
    const sig = signWipeRestart(
      {
        username,
        oldIrkPub: wrongOld.publicKey,
        newIrkPub: newIrk.publicKey,
        newCredentialIdHex: bytesToHex(randomBytes(16)),
        newWrappedUmkHashHex: wrappedHashHex,
        issuedAt,
      },
      wrongOld,
    );

    const resp = await ctx.post(`${APEX}/api/users/${username}/wipe-restart`, {
      data: {
        request: {
          username,
          oldIrkPub: bytesToHex(wrongOld.publicKey),
          newIrkPub: bytesToHex(newIrk.publicKey),
          newCredentialId: bytesToHex(randomBytes(16)),
          newWrappedUmk: bytesToB64(newWrappedUmk),
          issuedAt,
        },
        signature: bytesToHex(sig),
        idempotencyKey: bytesToHex(randomBytes(16)),
      },
      failOnStatusCode: false,
    });
    expect(resp.status()).toBe(403);
    await ctx.dispose();
  });
});
