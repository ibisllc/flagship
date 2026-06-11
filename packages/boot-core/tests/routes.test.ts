import { describe, it, expect, beforeEach } from "vitest";
import {
  ed,
  buildAutoUnlockLeaseV2,
  signAutoUnlockLeaseV2,
  signSecretRequest,
  buildSealedSecretResponse,
  type Keypair,
  type SecretRequest,
} from "@flagship/protocol";
import {
  InMemorySecretMailboxStorage,
  InMemoryBoxSealedLeaseStorage,
} from "@flagship/storage";
import { routeBoot, type BootRouteDeps } from "../src/routes.js";
import { signBootRequest } from "../src/gate.js";
import { InMemoryNonceStore } from "../src/nonceStore.js";
import type { DirectoryClient } from "../src/directory.js";
import type { NotifyPipe } from "../src/notify.js";

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function keypair(seedByte: number): Keypair {
  const privateKey = new Uint8Array(32).fill(seedByte);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
}
function nonce(byte: number): string {
  return bytesToHex(new Uint8Array(32).fill(byte));
}

const SERVER_A = "kitchen.alice.flagship.services";
const SERVER_B = "kitchen.bob.flagship.services";
const boxA = keypair(1);
const ownerA = keypair(2);
const boxB = keypair(3);
const delegateA = keypair(4); // active watch delegate for ownerA's account

function makeDirectory(): DirectoryClient {
  return {
    async boxStkForDomain(d) {
      if (d.toLowerCase() === SERVER_A) return bytesToHex(boxA.publicKey);
      if (d.toLowerCase() === SERVER_B) return bytesToHex(boxB.publicKey);
      return null;
    },
    async ownerIrkForDomain(d) {
      if (d.toLowerCase() === SERVER_A) return bytesToHex(ownerA.publicKey);
      return null;
    },
    async activeBootDelegatesForDomain(d) {
      if (d.toLowerCase() === SERVER_A) {
        return [{ pubKeyHex: bytesToHex(delegateA.publicKey), expiresAt: 9_000_000 }];
      }
      if (d.toLowerCase() === SERVER_B) return [];
      return null;
    },
    async usernameForDomain(d) {
      if (d.toLowerCase() === SERVER_A) return "alice";
      if (d.toLowerCase() === SERVER_B) return "bob";
      return null;
    },
  };
}

class RecordingNotify implements NotifyPipe {
  calls: Array<{ serverDomain: string; purpose: string }> = [];
  async notifyOwner(args: { serverDomain: string; signedRequest: unknown; purpose: string }) {
    this.calls.push({ serverDomain: args.serverDomain, purpose: args.purpose });
    return true;
  }
}

let now = 1_000_000;
function makeDeps(notify: NotifyPipe): BootRouteDeps {
  const directory = makeDirectory();
  return {
    boxSealedLeases: new InMemoryBoxSealedLeaseStorage(),
    secretMailbox: new InMemorySecretMailboxStorage(),
    directory,
    notify,
    gate: { directory, nonces: new InMemoryNonceStore(), now: () => now },
    now: () => now,
  };
}

function boxAuth(method: string, path: string, n: number) {
  return signBootRequest(
    { role: "box", serverDomain: SERVER_A, method, path, pubKeyHex: bytesToHex(boxA.publicKey), nonceHex: nonce(n), issuedAt: now },
    boxA.privateKey,
  );
}
function ownerAuth(method: string, path: string, n: number) {
  return signBootRequest(
    { role: "owner", serverDomain: SERVER_A, method, path, pubKeyHex: bytesToHex(ownerA.publicKey), nonceHex: nonce(n), issuedAt: now },
    ownerA.privateKey,
  );
}

describe("boot routes — lease deposit → get → revoke round-trip", () => {
  let deps: BootRouteDeps;
  beforeEach(() => {
    now = 1_000_000;
    deps = makeDeps(new RecordingNotify());
  });

  function buildLeaseBody() {
    const luksKey = new Uint8Array(32).fill(0xab);
    const lease = buildAutoUnlockLeaseV2({
      serverDomain: SERVER_A,
      stkPub: boxA.publicKey,
      leaseId: "a".repeat(32),
      luksKey,
      issuedAt: now,
      expiresAt: now + 60 * 60_000,
    });
    const sig = signAutoUnlockLeaseV2(lease, ownerA);
    return {
      lease: {
        serverDomain: lease.serverDomain,
        stkPub: bytesToHex(lease.stkPub),
        leaseId: lease.leaseId,
        sealedKey: bytesToHex(lease.sealedKey),
        issuedAt: lease.issuedAt,
        expiresAt: lease.expiresAt,
      },
      signature: bytesToHex(sig),
    };
  }

  it("owner deposits; box fetches the sealed lease; owner revokes; box 404s", async () => {
    const depositPath = "/api/boot/lease";
    const dep = await routeBoot(deps, "PUT", depositPath, ownerAuth("PUT", depositPath, 41), buildLeaseBody());
    expect(dep?.status).toBe(200);

    const getPath = `/api/boot/lease/${SERVER_A}`;
    const got = await routeBoot(deps, "GET", getPath, boxAuth("GET", getPath, 42), undefined);
    expect(got?.status).toBe(200);
    const gb = got!.body as { sealedKey: string; leaseId: string; signature: string };
    expect(gb.leaseId).toBe("a".repeat(32));
    expect(gb.sealedKey.length).toBeGreaterThan(0);
    expect(gb.signature.length).toBe(128);

    const revPath = `/api/boot/lease/${SERVER_A}/${"a".repeat(32)}`;
    const rev = await routeBoot(deps, "DELETE", revPath, ownerAuth("DELETE", revPath, 43), undefined);
    expect(rev?.status).toBe(200);
    expect((rev!.body as { removed: boolean }).removed).toBe(true);

    const gone = await routeBoot(deps, "GET", getPath, boxAuth("GET", getPath, 44), undefined);
    expect(gone?.status).toBe(404);
  });

  it("rejects a deposit whose pinned stkPub is not the directory box STK", async () => {
    const luksKey = new Uint8Array(32).fill(7);
    const lease = buildAutoUnlockLeaseV2({
      serverDomain: SERVER_A,
      stkPub: boxB.publicKey, // wrong recipient
      leaseId: "b".repeat(32),
      luksKey,
      issuedAt: now,
      expiresAt: now + 60_000,
    });
    const sig = signAutoUnlockLeaseV2(lease, ownerA);
    const body = {
      lease: {
        serverDomain: SERVER_A,
        stkPub: bytesToHex(boxB.publicKey),
        leaseId: "b".repeat(32),
        sealedKey: bytesToHex(lease.sealedKey),
        issuedAt: now,
        expiresAt: now + 60_000,
      },
      signature: bytesToHex(sig),
    };
    const path = "/api/boot/lease";
    const r = await routeBoot(deps, "PUT", path, ownerAuth("PUT", path, 45), body);
    expect(r?.status).toBe(403);
  });

  it("box cannot deposit a lease (write route is owner-only)", async () => {
    const path = "/api/boot/lease";
    // a valid body but box-signed Authorization → gate wrong-principal.
    const auth = signBootRequest(
      { role: "owner", serverDomain: SERVER_A, method: "PUT", path, pubKeyHex: bytesToHex(boxA.publicKey), nonceHex: nonce(46), issuedAt: now },
      boxA.privateKey,
    );
    const r = await routeBoot(deps, "PUT", path, auth, buildLeaseBody());
    expect(r?.status).toBe(403);
  });
});

describe("boot routes — request → notify → response → poll round-trip", () => {
  let notify: RecordingNotify;
  let deps: BootRouteDeps;
  beforeEach(() => {
    now = 1_000_000;
    notify = new RecordingNotify();
    deps = makeDeps(notify);
  });

  function secretRequestBody(n: number) {
    const req: SecretRequest = {
      serverDomain: SERVER_A,
      stkPub: boxA.publicKey,
      purpose: "unlock-key",
      nonce: new Uint8Array(32).fill(n),
      issuedAt: now,
    };
    const sig = signSecretRequest(req, boxA);
    return {
      req,
      body: {
        request: {
          serverDomain: SERVER_A,
          stkPub: bytesToHex(boxA.publicKey),
          purpose: "unlock-key",
          nonce: bytesToHex(req.nonce),
          issuedAt: now,
        },
        signature: bytesToHex(sig),
      },
    };
  }

  it("box announces (notify fires once); owner posts sealed; box polls + consumes once", async () => {
    const { req, body } = secretRequestBody(0x55);
    const reqPath = "/api/boot/request";
    const announced = await routeBoot(deps, "POST", reqPath, boxAuth("POST", reqPath, 51), body);
    expect(announced?.status).toBe(200);
    expect(notify.calls.length).toBe(1);
    expect(notify.calls[0]!.serverDomain).toBe(SERVER_A);

    // Owner posts the sealed response (sealed for the box's STK).
    const sealed = buildSealedSecretResponse(new Uint8Array(32).fill(0xcc), req);
    const respBody = {
      response: {
        serverDomain: SERVER_A,
        requestNonceHex: bytesToHex(req.nonce),
        purpose: "unlock-key",
        sealed: bytesToHex(sealed.sealed),
        issuedAt: now,
      },
    };
    const respPath = "/api/boot/response";
    const posted = await routeBoot(deps, "POST", respPath, ownerAuth("POST", respPath, 52), respBody);
    expect(posted?.status).toBe(200);

    // Box polls — gets the sealed blob once.
    const pollPath = `/api/boot/response/${SERVER_A}/${bytesToHex(req.nonce)}`;
    const poll1 = await routeBoot(deps, "GET", pollPath, boxAuth("GET", pollPath, 53), undefined);
    expect(poll1?.status).toBe(200);
    expect((poll1!.body as { sealed: string }).sealed).toBe(bytesToHex(sealed.sealed));

    // Second poll — single-use; already consumed.
    const poll2 = await routeBoot(deps, "GET", pollPath, boxAuth("GET", pollPath, 54), undefined);
    expect(poll2?.status).toBe(404);
  });

  it("a watch delegate can post the sealed response (boot approval)", async () => {
    // The same round-trip, but the approval is signed by the account's
    // active watch-delegate key instead of the IRK — the Watch-driven
    // quick-approve path. The box still polls + consumes identically.
    const { req, body } = secretRequestBody(0x5a);
    const reqPath = "/api/boot/request";
    await routeBoot(deps, "POST", reqPath, boxAuth("POST", reqPath, 71), body);

    const sealed = buildSealedSecretResponse(new Uint8Array(32).fill(0xcd), req);
    const respBody = {
      response: {
        serverDomain: SERVER_A,
        requestNonceHex: bytesToHex(req.nonce),
        purpose: "unlock-key",
        sealed: bytesToHex(sealed.sealed),
        issuedAt: now,
      },
    };
    const respPath = "/api/boot/response";
    const delegateAuth = signBootRequest(
      { role: "delegate", serverDomain: SERVER_A, method: "POST", path: respPath, pubKeyHex: bytesToHex(delegateA.publicKey), nonceHex: nonce(72), issuedAt: now },
      delegateA.privateKey,
    );
    const posted = await routeBoot(deps, "POST", respPath, delegateAuth, respBody);
    expect(posted?.status).toBe(200);

    // Box polls + consumes the delegate-approved sealed blob.
    const pollPath = `/api/boot/response/${SERVER_A}/${bytesToHex(req.nonce)}`;
    const poll = await routeBoot(deps, "GET", pollPath, boxAuth("GET", pollPath, 73), undefined);
    expect(poll?.status).toBe(200);
    expect((poll!.body as { sealed: string }).sealed).toBe(bytesToHex(sealed.sealed));
  });

  it("a delegate CANNOT deposit a lease (owner-only route)", async () => {
    // The lease-deposit route names only "owner"; a delegate-signed lease
    // deposit is rejected — the delegate is scoped to boot approval alone.
    const respPath = "/api/boot/lease";
    const delegateAuth = signBootRequest(
      { role: "delegate", serverDomain: SERVER_A, method: "PUT", path: respPath, pubKeyHex: bytesToHex(delegateA.publicKey), nonceHex: nonce(74), issuedAt: now },
      delegateA.privateKey,
    );
    // Body shape is irrelevant — the gate rejects on principal before use.
    const r = await routeBoot(deps, "PUT", respPath, delegateAuth, {
      lease: {
        serverDomain: SERVER_A,
        stkPub: bytesToHex(boxA.publicKey),
        leaseId: "a".repeat(32),
        sealedKey: "ab".repeat(48),
        issuedAt: now,
        expiresAt: now + 60_000,
      },
      signature: "00".repeat(64),
    });
    expect(r?.status).toBe(403);
  });

  it("notify is DEDUPED per nonce — repeated announces of the same nonce send ONE push", async () => {
    const { body } = secretRequestBody(0x66);
    const reqPath = "/api/boot/request";
    const first = await routeBoot(deps, "POST", reqPath, boxAuth("POST", reqPath, 61), body);
    expect(first?.status).toBe(200);
    // Re-announce same nonce (the box polling/retrying). Fresh
    // Authorization nonce each time (the gate's anti-replay is separate
    // from the SecretRequest nonce dedup).
    const second = await routeBoot(deps, "POST", reqPath, boxAuth("POST", reqPath, 62), body);
    expect(second?.status).toBe(200);
    expect((second!.body as { deduped?: boolean }).deduped).toBe(true);
    const third = await routeBoot(deps, "POST", reqPath, boxAuth("POST", reqPath, 63), body);
    expect(third?.status).toBe(200);
    // Exactly ONE push despite three announces.
    expect(notify.calls.length).toBe(1);
  });

  it("a heartbeat re-announce EXTENDS the parked row's expiresAt (keeps a waiting box alive)", async () => {
    const { req, body } = secretRequestBody(0x67);
    const reqPath = "/api/boot/request";
    const nonceHex = bytesToHex(req.nonce);

    const first = await routeBoot(deps, "POST", reqPath, boxAuth("POST", reqPath, 64), body);
    expect(first?.status).toBe(200);
    const row1 = await deps.secretMailbox.getRequest(SERVER_A, nonceHex);
    const firstExpiry = row1!.expiresAt;
    expect(firstExpiry).toBeGreaterThan(now);

    // Time advances toward the original TTL; the box heartbeats the SAME nonce.
    now += 9 * 60_000;
    const beat = await routeBoot(deps, "POST", reqPath, boxAuth("POST", reqPath, 65), body);
    expect(beat?.status).toBe(200);
    expect((beat!.body as { deduped?: boolean }).deduped).toBe(true);

    const row2 = await deps.secretMailbox.getRequest(SERVER_A, nonceHex);
    // expires_at bumped forward to now+ttl — strictly later than the first.
    expect(row2!.expiresAt).toBeGreaterThan(firstExpiry);
    expect(row2!.expiresAt).toBe(now + 10 * 60_000);
    // Still exactly one push — the heartbeat does NOT re-notify.
    expect(notify.calls.length).toBe(1);
  });

  it("box cannot POST a response (owner-only write route)", async () => {
    const { req } = secretRequestBody(0x77);
    const sealed = buildSealedSecretResponse(new Uint8Array(32).fill(1), req);
    const respBody = {
      response: {
        serverDomain: SERVER_A,
        requestNonceHex: bytesToHex(req.nonce),
        purpose: "unlock-key",
        sealed: bytesToHex(sealed.sealed),
        issuedAt: now,
      },
    };
    const respPath = "/api/boot/response";
    // box-signed but route requires owner.
    const auth = signBootRequest(
      { role: "owner", serverDomain: SERVER_A, method: "POST", path: respPath, pubKeyHex: bytesToHex(boxA.publicKey), nonceHex: nonce(78), issuedAt: now },
      boxA.privateKey,
    );
    const r = await routeBoot(deps, "POST", respPath, auth, respBody);
    expect(r?.status).toBe(403);
  });

  it("box B cannot poll box A's response (cross-account binding)", async () => {
    const { req } = secretRequestBody(0x88);
    const pollPath = `/api/boot/response/${SERVER_A}/${bytesToHex(req.nonce)}`;
    // box B signs for serverDomain A — STK binding fails.
    const auth = signBootRequest(
      { role: "box", serverDomain: SERVER_A, method: "GET", path: pollPath, pubKeyHex: bytesToHex(boxB.publicKey), nonceHex: nonce(89), issuedAt: now },
      boxB.privateKey,
    );
    const r = await routeBoot(deps, "GET", pollPath, auth, undefined);
    expect(r?.status).toBe(403);
  });
});

describe("boot routes — unknown path", () => {
  it("returns null for a non-boot path", async () => {
    const deps = makeDeps(new RecordingNotify());
    const r = await routeBoot(deps, "GET", "/api/health", null, undefined);
    expect(r).toBeNull();
  });
});
