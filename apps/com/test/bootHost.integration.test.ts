/**
 * Boot-worker consolidation — full phone-approval unlock flow against the
 * IN-PROCESS backing that flagship-com now uses to serve boot.flagshipserver.com
 * (docs/boot-worker-consolidation.md). This is the regression guard that would
 * have CAUGHT the original multi-hour silent failure: the box's request was
 * accepted by the boot worker but never reached the identity plane's mailbox
 * (the shared-secret notify bridge silently 401'd), so the phone had nothing to
 * approve and the box hung with no error.
 *
 * The flow exercised end-to-end (every step asserted, no mocks of the boot
 * logic itself):
 *   1. box POSTs a signed SecretRequest → /api/boot/request
 *        → the request LANDS in the (flagship-state) mailbox AND a push fires.
 *   2. phone reads the parked request (the SAME mailbox the phone's
 *        /api/secret-requests listing reads) → approves → deposits the sealed
 *        key → /api/boot/response.
 *   3. box polls → /api/boot/response/:domain/:nonce → consumes the sealed key
 *        ONCE (a second poll 404s — single-use).
 *
 * Plus the anti-silent-failure invariant: there is NO path where /api/boot/request
 * returns 200 but the request is invisible to the phone — a 200 means BOTH the
 * mailbox row exists AND (when push is configured) the owner was pushed.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  ed,
  signSecretRequest,
  buildSealedSecretResponse,
  type Keypair,
  type SecretRequest,
} from "@flagship/protocol";
import {
  InMemoryServerStorage,
  InMemoryUsernameStorage,
  InMemorySecretMailboxStorage,
  InMemoryBoxSealedLeaseStorage,
  InMemoryWatchDelegateStorage,
  type SecretMailboxStorage,
} from "@flagship/storage";
import { routeBoot, signBootRequest, type BootRouteDeps } from "@flagship/boot-core";
import {
  InProcessDirectoryClient,
  InProcessNotifyPipe,
} from "../src/bootInProcess.js";

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function keypair(seedByte: number): Keypair {
  const privateKey = new Uint8Array(32).fill(seedByte);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
}

const USER = "alice";
const SERVER = `kitchen.${USER}.flagship.services`;
const box = keypair(1);
const owner = keypair(2);

let now = 2_000_000;

interface PushCall {
  username: string;
  category: string;
  payload: unknown;
}

interface Harness {
  deps: BootRouteDeps;
  secretMailbox: SecretMailboxStorage;
  pushes: PushCall[];
  servers: InMemoryServerStorage;
  usernames: InMemoryUsernameStorage;
}

/**
 * Build the in-process deps EXACTLY as apps/com's `tryBootHost` does:
 * flagship-state storage adapters + the in-process directory + the
 * in-process notify pipe wired to a recording push closure. The nonce
 * store is a tiny single-use set (the D1NonceStore equivalent for tests).
 */
function makeDeps(opts?: { withPush?: boolean }): Harness {
  const servers = new InMemoryServerStorage();
  const usernames = new InMemoryUsernameStorage();
  const secretMailbox = new InMemorySecretMailboxStorage();
  const boxSealedLeases = new InMemoryBoxSealedLeaseStorage();
  const watchDelegates = new InMemoryWatchDelegateStorage();

  const directory = new InProcessDirectoryClient({ servers, usernames, watchDelegates });

  const pushes: PushCall[] = [];
  const pushUserDevices = async (username: string, category: string, payload?: Uint8Array) => {
    pushes.push({
      username,
      category,
      payload: payload ? JSON.parse(new TextDecoder().decode(payload)) : null,
    });
  };
  const notify = new InProcessNotifyPipe({
    servers,
    ...(opts?.withPush === false ? {} : { pushUserDevices }),
  });

  const seen = new Set<string>();
  const nonces = {
    async claim(key: string): Promise<boolean> {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
  };

  const deps: BootRouteDeps = {
    boxSealedLeases,
    secretMailbox,
    directory,
    notify,
    gate: { directory, nonces, now: () => now },
    now: () => now,
  };

  return { deps, secretMailbox, pushes, servers, usernames };
}

async function seed(servers: InMemoryServerStorage, usernames: InMemoryUsernameStorage) {
  await usernames.put({ username: USER, irkPubHex: bytesToHex(owner.publicKey) });
  await servers.put({
    serverDomain: SERVER,
    username: USER,
    identityPubKeyHex: bytesToHex(box.publicKey),
    registeredAt: now,
  });
}

function boxAuth(method: string, path: string, n: number) {
  return signBootRequest(
    {
      role: "box",
      serverDomain: SERVER,
      method,
      path,
      pubKeyHex: bytesToHex(box.publicKey),
      nonceHex: bytesToHex(new Uint8Array(32).fill(n)),
      issuedAt: now,
    },
    box.privateKey,
  );
}
function ownerAuth(method: string, path: string, n: number) {
  return signBootRequest(
    {
      role: "owner",
      serverDomain: SERVER,
      method,
      path,
      pubKeyHex: bytesToHex(owner.publicKey),
      nonceHex: bytesToHex(new Uint8Array(32).fill(n)),
      issuedAt: now,
    },
    owner.privateKey,
  );
}

function secretRequestBody(nonceByte: number) {
  const req: SecretRequest = {
    serverDomain: SERVER,
    stkPub: box.publicKey,
    purpose: "unlock-key",
    nonce: new Uint8Array(32).fill(nonceByte),
    issuedAt: now,
  };
  const sig = signSecretRequest(req, box);
  return {
    req,
    body: {
      request: {
        serverDomain: SERVER,
        stkPub: bytesToHex(box.publicKey),
        purpose: "unlock-key",
        nonce: bytesToHex(req.nonce),
        issuedAt: now,
      },
      signature: bytesToHex(sig),
    },
  };
}

describe("boot consolidation — phone-approval unlock end-to-end (in-process)", () => {
  let h: Harness;
  beforeEach(async () => {
    now = 2_000_000;
    h = makeDeps();
    await seed(h.servers, h.usernames);
  });

  it("box request lands in the mailbox AND pushes the owner; phone approves; box consumes once", async () => {
    const { req, body } = secretRequestBody(0x55);

    // 1. Box announces. A 200 must mean BOTH effects happened.
    const reqPath = "/api/boot/request";
    const announced = await routeBoot(h.deps, "POST", reqPath, boxAuth("POST", reqPath, 51), body);
    expect(announced?.status).toBe(200);

    // 1a. The request LANDED in flagship-state's mailbox — exactly the rows the
    //     phone's /api/secret-requests listing reads (scoped to the account).
    const pending = await h.secretMailbox.listPendingForUser(USER, now);
    expect(pending.length).toBe(1);
    expect(pending[0]!.serverDomain).toBe(SERVER);
    expect(pending[0]!.requestNonceHex).toBe(bytesToHex(req.nonce));
    expect(pending[0]!.purpose).toBe("unlock-key");

    // 1b. The owner WAS pushed in-process (no cross-worker notify-owner call).
    expect(h.pushes.length).toBe(1);
    expect(h.pushes[0]!.username).toBe(USER);
    expect(h.pushes[0]!.category).toBe("secret-request");
    expect((h.pushes[0]!.payload as { serverFqdn: string }).serverFqdn).toBe(SERVER);

    // 2. Phone approves: seal the LUKS key FOR the box STK + deposit it.
    const sealed = buildSealedSecretResponse(new Uint8Array(32).fill(0xcc), req);
    const respPath = "/api/boot/response";
    const respBody = {
      response: {
        serverDomain: SERVER,
        requestNonceHex: bytesToHex(req.nonce),
        purpose: "unlock-key",
        sealed: bytesToHex(sealed.sealed),
        issuedAt: now,
      },
    };
    const posted = await routeBoot(h.deps, "POST", respPath, ownerAuth("POST", respPath, 52), respBody);
    expect(posted?.status).toBe(200);

    // 3. Box polls + consumes the sealed key once.
    const pollPath = `/api/boot/response/${SERVER}/${bytesToHex(req.nonce)}`;
    const polled = await routeBoot(h.deps, "GET", pollPath, boxAuth("GET", pollPath, 53), undefined);
    expect(polled?.status).toBe(200);
    const pb = polled!.body as { sealed: string; purpose: string };
    expect(pb.purpose).toBe("unlock-key");
    expect(pb.sealed).toBe(bytesToHex(sealed.sealed));

    // Single-use: a second poll finds nothing.
    const again = await routeBoot(h.deps, "GET", pollPath, boxAuth("GET", pollPath, 54), undefined);
    expect(again?.status).toBe(404);
  });

  it("NO silent path: a 200 announce is never invisible to the phone", async () => {
    const { req, body } = secretRequestBody(0x66);
    const reqPath = "/api/boot/request";
    const announced = await routeBoot(h.deps, "POST", reqPath, boxAuth("POST", reqPath, 61), body);
    expect(announced?.status).toBe(200);

    // The exact failure mode of the original bug: a request accepted but
    // never surfaced. Here the surfacing is the SAME storage the phone reads,
    // so a 200 is provably visible.
    const pending = await h.secretMailbox.listPendingForUser(USER, now);
    expect(pending.some((p) => p.requestNonceHex === bytesToHex(req.nonce))).toBe(true);
  });

  it("a heartbeat re-announce refreshes the row but does NOT re-push", async () => {
    const { body } = secretRequestBody(0x77);
    const reqPath = "/api/boot/request";
    const first = await routeBoot(h.deps, "POST", reqPath, boxAuth("POST", reqPath, 71), body);
    expect(first?.status).toBe(200);
    expect(h.pushes.length).toBe(1);

    // Re-announce the SAME nonce (the box's heartbeat). New gate nonce, same
    // request nonce → deduped, no second push.
    const second = await routeBoot(h.deps, "POST", reqPath, boxAuth("POST", reqPath, 72), body);
    expect(second?.status).toBe(200);
    expect((second!.body as { deduped?: boolean }).deduped).toBe(true);
    expect(h.pushes.length).toBe(1);
  });

  it("an unregistered server's box cannot announce (directory binding fails)", async () => {
    const other = `kitchen.bob.flagship.services`;
    const req: SecretRequest = {
      serverDomain: other,
      stkPub: box.publicKey,
      purpose: "unlock-key",
      nonce: new Uint8Array(32).fill(0x88),
      issuedAt: now,
    };
    const sig = signSecretRequest(req, box);
    const body = {
      request: {
        serverDomain: other,
        stkPub: bytesToHex(box.publicKey),
        purpose: "unlock-key",
        nonce: bytesToHex(req.nonce),
        issuedAt: now,
      },
      signature: bytesToHex(sig),
    };
    const reqPath = "/api/boot/request";
    const auth = signBootRequest(
      {
        role: "box",
        serverDomain: other,
        method: "POST",
        path: reqPath,
        pubKeyHex: bytesToHex(box.publicKey),
        nonceHex: bytesToHex(new Uint8Array(32).fill(0x89)),
        issuedAt: now,
      },
      box.privateKey,
    );
    const r = await routeBoot(h.deps, "POST", reqPath, auth, body);
    expect(r?.status).toBe(404);
    expect(h.pushes.length).toBe(0);
  });

  it("with no push configured the request still parks (box can still poll)", async () => {
    const noPush = makeDeps({ withPush: false });
    await seed(noPush.servers, noPush.usernames);
    const { req, body } = secretRequestBody(0x99);
    const reqPath = "/api/boot/request";
    const announced = await routeBoot(noPush.deps, "POST", reqPath, boxAuth("POST", reqPath, 91), body);
    expect(announced?.status).toBe(200);
    const pending = await noPush.secretMailbox.listPendingForUser(USER, now);
    expect(pending.some((p) => p.requestNonceHex === bytesToHex(req.nonce))).toBe(true);
    expect(noPush.pushes.length).toBe(0);
  });
});
