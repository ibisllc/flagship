/**
 * Boot gate role "share" (docs/share-a-server.md §5.4): another account's
 * per-share key that holds an owner-deposited copy of the disk key may read
 * the server's pending start-up requests and its copy, and answer one unlock.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { buildSealedSecretResponse, ed, signSecretRequest, type Keypair, type SecretRequest } from "@flagship/protocol";
import { InMemoryBoxSealedLeaseStorage, InMemorySecretMailboxStorage } from "@flagship/storage";
import { routeBoot, type BootRouteDeps } from "../src/routes.js";
import { signBootRequest, type GateRole } from "../src/gate.js";
import { InMemoryNonceStore } from "../src/nonceStore.js";
import type { DirectoryClient } from "../src/directory.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const kp = (n: number): Keypair => {
  const privateKey = new Uint8Array(32).fill(n);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
};
const S = "kitchen.alice.flagship.services";
const box = kp(1);
const owner = kp(2);
const member = kp(5);
const outsider = kp(6);
const COPY = "ab".repeat(70);

let now = 1_000_000;
let n = 1;
function directory(withShares = true): DirectoryClient {
  const d: DirectoryClient = {
    async boxStkForDomain(x) {
      return x === S ? hex(box.publicKey) : null;
    },
    async ownerIrkForDomain(x) {
      return x === S ? hex(owner.publicKey) : null;
    },
    async activeBootDelegatesForDomain() {
      return [];
    },
    async usernameForDomain(x) {
      return x === S ? "alice" : null;
    },
  };
  if (withShares) {
    d.shareUnlockForMember = async (x, pub) => (x === S && pub === hex(member.publicKey) ? { sealedKeyHex: COPY } : null);
  }
  return d;
}
function deps(withShares = true): BootRouteDeps {
  const dir = directory(withShares);
  return {
    boxSealedLeases: new InMemoryBoxSealedLeaseStorage(),
    secretMailbox: new InMemorySecretMailboxStorage(),
    directory: dir,
    notify: { notifyOwner: async () => true },
    gate: { directory: dir, nonces: new InMemoryNonceStore(), now: () => now },
    now: () => now,
  };
}
function auth(role: GateRole, k: Keypair, method: string, path: string): string {
  return signBootRequest(
    { role, serverDomain: S, method, path, pubKeyHex: hex(k.publicKey), nonceHex: hex(new Uint8Array(32).fill(n++)), issuedAt: now },
    k.privateKey,
  );
}
async function announce(d: BootRouteDeps, purpose: "unlock-key" | "entitlement" = "unlock-key"): Promise<SecretRequest> {
  const req: SecretRequest = { serverDomain: S, stkPub: box.publicKey, purpose, nonce: new Uint8Array(32).fill(n++), issuedAt: now };
  const body = {
    request: { serverDomain: S, stkPub: hex(box.publicKey), purpose, nonce: hex(req.nonce), issuedAt: now },
    signature: hex(signSecretRequest(req, box)),
  };
  const r = await routeBoot(d, "POST", "/api/boot/request", auth("box", box, "POST", "/api/boot/request"), body);
  expect(r?.status).toBe(200);
  return req;
}
function responseBody(req: SecretRequest) {
  return {
    response: {
      serverDomain: S,
      requestNonceHex: hex(req.nonce),
      purpose: req.purpose,
      sealed: hex(buildSealedSecretResponse(new Uint8Array(32).fill(0xcc), req).sealed),
      issuedAt: now,
    },
  };
}

describe("boot gate: role share", () => {
  beforeEach(() => {
    now = 1_000_000;
  });

  it("reads pending start-ups and its copy, then answers one; the box picks it up", async () => {
    const d = deps();
    const req = await announce(d);
    const pendingPath = `/api/boot/share/pending/${S}`;
    const pending = await routeBoot(d, "GET", pendingPath, auth("share", member, "GET", pendingPath), undefined);
    expect(pending?.status).toBe(200);
    const list = (pending!.body as { requests: Array<{ request: { nonce: string; stkPub: string }; signature: string }> }).requests;
    expect(list).toHaveLength(1);
    expect(list[0]!.request.nonce).toBe(hex(req.nonce));
    expect(list[0]!.request.stkPub).toBe(hex(box.publicKey));

    const keyPath = `/api/boot/share/key/${S}`;
    const key = await routeBoot(d, "GET", keyPath, auth("share", member, "GET", keyPath), undefined);
    expect(key).toEqual({ status: 200, body: { sealedKey: COPY } });

    const posted = await routeBoot(d, "POST", "/api/boot/response", auth("share", member, "POST", "/api/boot/response"), responseBody(req));
    expect(posted?.status).toBe(200);
    const pollPath = `/api/boot/response/${S}/${hex(req.nonce)}`;
    expect((await routeBoot(d, "GET", pollPath, auth("box", box, "GET", pollPath), undefined))?.status).toBe(200);
  });

  it("refuses a key without a copy, and every share when the directory has none", async () => {
    const d = deps();
    await announce(d);
    const p = `/api/boot/share/pending/${S}`;
    expect((await routeBoot(d, "GET", p, auth("share", outsider, "GET", p), undefined))?.status).toBe(403);
    const bare = deps(false);
    await announce(bare);
    expect((await routeBoot(bare, "GET", p, auth("share", member, "GET", p), undefined))?.status).toBe(403);
  });

  it("can't answer the entitlement, which stays the owner's", async () => {
    const d = deps();
    const req = await announce(d, "entitlement");
    const r = await routeBoot(d, "POST", "/api/boot/response", auth("share", member, "POST", "/api/boot/response"), responseBody(req));
    expect(r?.status).toBe(403);
  });

  it("can't touch the owner's lease routes", async () => {
    const d = deps();
    const r = await routeBoot(d, "DELETE", `/api/boot/lease/${S}/abcdabcdabcdabcd`, auth("share", member, "DELETE", `/api/boot/lease/${S}/abcdabcdabcdabcd`), {});
    expect(r?.status).toBe(403);
    const box2 = await routeBoot(d, "POST", "/api/boot/request", auth("share", member, "POST", "/api/boot/request"), {});
    expect([400, 403]).toContain(box2?.status);
  });
});
