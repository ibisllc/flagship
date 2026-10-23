import { describe, it, expect, beforeEach } from "vitest";
import {
  ed,
  buildSealedSecretResponse,
  buildWatchBootDeposit,
  openSealedSecretResponse,
  openWatchBootKey,
  signBootSuspension,
  signSecretRequest,
  WATCH_BOOT_MAX_MS,
  type Keypair,
  type SecretRequest,
} from "@flagship/protocol";
import { x25519 } from "@noble/curves/ed25519.js";
import { InMemoryBootSuspensionStorage, InMemoryBoxSealedLeaseStorage, InMemorySecretMailboxStorage, InMemoryWatchBootKeyStorage } from "@flagship/storage";
import { routeBoot, type BootRouteDeps } from "../src/routes.js";
import { signBootRequest } from "../src/gate.js";
import { InMemoryNonceStore } from "../src/nonceStore.js";
import type { DirectoryClient } from "../src/directory.js";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const kp = (n: number): Keypair => ({ privateKey: new Uint8Array(32).fill(n), publicKey: ed.getPublicKey(new Uint8Array(32).fill(n)) });
const nonce = (n: number) => hex(new Uint8Array(32).fill(n));

const SERVER = "kitchen.alice.flagship.services";
const box = kp(1);
const owner = kp(2);
const watch = kp(4); // the watch-delegate signing key
const otherWatch = kp(5);
const decryptPriv = x25519.utils.randomSecretKey();
const decryptPub = x25519.getPublicKey(decryptPriv);
const DISK_KEY = new Uint8Array(32).fill(0xd1);
let now = 100_000_000;
let DELEGATE_EXPIRES = now + 3 * 24 * 3600_000;
let delegates: Array<{ pubKeyHex: string; expiresAt: number }>;

const directory: DirectoryClient = {
  async boxStkForDomain(d) { return d.toLowerCase() === SERVER ? hex(box.publicKey) : null; },
  async ownerIrkForDomain(d) { return d.toLowerCase() === SERVER ? hex(owner.publicKey) : null; },
  async activeBootDelegatesForDomain(d) { return d.toLowerCase() === SERVER ? delegates : null; },
  async usernameForDomain(d) { return d.toLowerCase() === SERVER ? "alice" : null; },
};

function deps(): BootRouteDeps {
  const suspensions = new InMemoryBootSuspensionStorage();
  return {
    boxSealedLeases: new InMemoryBoxSealedLeaseStorage(suspensions),
    watchBootKeys: new InMemoryWatchBootKeyStorage(suspensions),
    bootSuspensions: suspensions,
    secretMailbox: new InMemorySecretMailboxStorage(),
    directory,
    notify: { async notifyOwner() { return true; } },
    gate: { directory, nonces: new InMemoryNonceStore(), now: () => now },
    now: () => now,
  };
}

let n = 100;
const auth = (role: "owner" | "delegate" | "box", who: Keypair, method: string, path: string) =>
  signBootRequest({ role, serverDomain: SERVER, method, path, pubKeyHex: hex(who.publicKey), nonceHex: nonce(++n), issuedAt: now }, who.privateKey);

const deposit = (over: { expiresAt?: number; issuedAt?: number; delegatePub?: Uint8Array; signer?: Keypair } = {}) =>
  buildWatchBootDeposit(
    { serverDomain: SERVER, diskKey: DISK_KEY, delegatePub: over.delegatePub ?? watch.publicKey, decryptPub, issuedAt: over.issuedAt ?? now, expiresAt: over.expiresAt ?? now + 24 * 3600_000 },
    over.signer ?? owner,
  );

let d: BootRouteDeps;
beforeEach(() => {
  now = 100_000_000;
  DELEGATE_EXPIRES = now + 3 * 24 * 3600_000;
  delegates = [{ pubKeyHex: hex(watch.publicKey), expiresAt: DELEGATE_EXPIRES }];
  d = deps();
});

const put = (dep = deposit()) => routeBoot(d, "PUT", "/api/boot/watch-key", auth("owner", owner, "PUT", "/api/boot/watch-key"), { deposit: dep });
const get = (who: Keypair, role: "owner" | "delegate") => routeBoot(d, "GET", `/api/boot/watch-key/${SERVER}`, auth(role, who, "GET", `/api/boot/watch-key/${SERVER}`), undefined);
const lock = async () => {
  const order = { serverDomain: SERVER, epoch: 1, seq: 0, action: "suspend" as const, reason: "manual-lock" as const, signer: "owner" as const, issuedAt: now };
  const r = await routeBoot(d, "PUT", "/api/boot/suspension", auth("owner", owner, "PUT", "/api/boot/suspension"), { order, signature: hex(signBootSuspension(order, owner.privateKey)) });
  expect(r?.status).toBe(200);
};

describe("the watch boot key protocol", () => {
  it("the watch opens the copy with its decryption key and checks it is the key the account attested", () => {
    const dep = deposit();
    expect(openWatchBootKey(dep, decryptPriv)).toEqual(DISK_KEY);
    // another key cannot open it, and a copy whose key differs from the attested digest is refused
    expect(() => openWatchBootKey(dep, x25519.utils.randomSecretKey())).toThrow();
    expect(() => openWatchBootKey({ ...dep, keySha256Hex: "00".repeat(32) }, decryptPriv)).toThrow(/attested/);
  });

  it("a deposit longer than the delegate's seven days cannot even be signed", () => {
    expect(() => deposit({ expiresAt: now + WATCH_BOOT_MAX_MS + 1 })).toThrow(/7 days/);
  });
});

describe("boot routes — watch boot key", () => {
  it("an owner deposits for an active delegate; the delegate gets exactly its copy; the owner sees who holds one, never the key", async () => {
    expect((await put())?.status).toBe(200);
    const got = await get(watch, "delegate");
    expect(got?.status).toBe(200);
    const body = got!.body as { deposit: { sealedKeyHex: string; keySha256Hex: string; decryptPubHex: string } };
    expect(openWatchBootKey(body.deposit, decryptPriv)).toEqual(DISK_KEY);
    expect(body.deposit.decryptPubHex).toBe(hex(decryptPub));
    const listed = await get(owner, "owner");
    expect(listed?.status).toBe(200);
    expect(JSON.stringify(listed!.body)).not.toContain("sealedKeyHex");
    expect((listed!.body as { copies: unknown[] }).copies).toHaveLength(1);
  });

  it("refuses a deposit for a watch that is not an active delegate, one that outlasts its delegate, a bad signature and a stale order", async () => {
    expect((await put(deposit({ delegatePub: otherWatch.publicKey })))?.status).toBe(403);
    expect((await put(deposit({ expiresAt: DELEGATE_EXPIRES + 1 })))?.status).toBe(400);
    expect((await put(deposit({ signer: otherWatch })))?.status).toBe(403);
    expect((await put(deposit({ issuedAt: now - 3_600_000 })))?.status).toBe(400);
    expect((await get(watch, "delegate"))?.status).toBe(404);
  });

  it("another delegate, and a delegate that has since been revoked, get nothing", async () => {
    await put();
    delegates = [{ pubKeyHex: hex(otherWatch.publicKey), expiresAt: DELEGATE_EXPIRES }];
    expect((await get(otherWatch, "delegate"))?.status).toBe(404);
    expect((await get(watch, "delegate"))?.status).toBe(403);
  });

  it("an expired copy is gone", async () => {
    await put(deposit({ expiresAt: now + 60_000 }));
    now += 120_000;
    expect((await get(watch, "delegate"))?.status).toBe(404);
  });

  it("a locked server gives the delegate nothing, says to use the phone, and a lock removes the copies", async () => {
    await put();
    await lock();
    const r = await get(watch, "delegate");
    expect(r?.status).toBe(423);
    expect((r!.body as { locked: boolean }).locked).toBe(true);
    // The lock deleted the copies: resuming does not bring them back.
    const order = { serverDomain: SERVER, epoch: 2, seq: 0, action: "resume" as const, reason: "owner-resume" as const, signer: "owner" as const, issuedAt: now };
    await routeBoot(d, "PUT", "/api/boot/suspension", auth("owner", owner, "PUT", "/api/boot/suspension"), { order, signature: hex(signBootSuspension(order, owner.privateKey)) });
    expect((await get(watch, "delegate"))?.status).toBe(404);
  });

  it("the owner can take every copy away", async () => {
    await put();
    const del = await routeBoot(d, "DELETE", `/api/boot/watch-key/${SERVER}`, auth("owner", owner, "DELETE", `/api/boot/watch-key/${SERVER}`), undefined);
    expect((del!.body as { removed: number }).removed).toBe(1);
    expect((await get(watch, "delegate"))?.status).toBe(404);
  });

  it("a delegate cannot deposit or delete (owner routes)", async () => {
    const dep = await routeBoot(d, "PUT", "/api/boot/watch-key", auth("delegate", watch, "PUT", "/api/boot/watch-key"), { deposit: deposit() });
    expect(dep?.status).toBe(403);
    await put();
    const del = await routeBoot(d, "DELETE", `/api/boot/watch-key/${SERVER}`, auth("delegate", watch, "DELETE", `/api/boot/watch-key/${SERVER}`), undefined);
    expect(del?.status).toBe(403);
  });

  it("end to end with the phone locked: the watch opens its copy, seals it for the box and posts the answer, and the box opens it", async () => {
    await put();
    // The box announces a start-up.
    const req: SecretRequest = { serverDomain: SERVER, stkPub: box.publicKey, purpose: "unlock-key", nonce: new Uint8Array(32).fill(0x77), issuedAt: now };
    const announce = await routeBoot(d, "POST", "/api/boot/request", auth("box", box, "POST", "/api/boot/request"), {
      request: { serverDomain: SERVER, stkPub: hex(box.publicKey), purpose: "unlock-key", nonce: hex(req.nonce), issuedAt: now },
      signature: hex(signSecretRequest(req, box)),
    });
    expect(announce?.status).toBe(200);
    // The watch: fetch its copy, open it with the boot-only key, seal for the box, answer.
    const copy = (await get(watch, "delegate"))!.body as { deposit: { sealedKeyHex: string; keySha256Hex: string } };
    const diskKey = openWatchBootKey(copy.deposit, decryptPriv);
    const sealed = buildSealedSecretResponse(diskKey, req);
    const posted = await routeBoot(d, "POST", "/api/boot/response", auth("delegate", watch, "POST", "/api/boot/response"), {
      response: { serverDomain: SERVER, requestNonceHex: hex(req.nonce), purpose: "unlock-key", sealed: hex(sealed.sealed), issuedAt: now },
    });
    expect(posted?.status).toBe(200);
    const pollPath = `/api/boot/response/${SERVER}/${hex(req.nonce)}`;
    const polled = await routeBoot(d, "GET", pollPath, auth("box", box, "GET", pollPath), undefined);
    const opened = openSealedSecretResponse({ ...sealed, sealed: Uint8Array.from((polled!.body as { sealed: string }).sealed.match(/../g)!.map((b) => parseInt(b, 16))) }, req, box.privateKey);
    expect(opened).toEqual(DISK_KEY);
  });

  it("a delegate's approval is refused while the server is locked, though the owner's is not", async () => {
    await lock();
    const req: SecretRequest = { serverDomain: SERVER, stkPub: box.publicKey, purpose: "unlock-key", nonce: new Uint8Array(32).fill(0x78), issuedAt: now };
    await routeBoot(d, "POST", "/api/boot/request", auth("box", box, "POST", "/api/boot/request"), {
      request: { serverDomain: SERVER, stkPub: hex(box.publicKey), purpose: "unlock-key", nonce: hex(req.nonce), issuedAt: now },
      signature: hex(signSecretRequest(req, box)),
    });
    const sealed = buildSealedSecretResponse(DISK_KEY, req);
    const body = { response: { serverDomain: SERVER, requestNonceHex: hex(req.nonce), purpose: "unlock-key", sealed: hex(sealed.sealed), issuedAt: now } };
    const viaWatch = await routeBoot(d, "POST", "/api/boot/response", auth("delegate", watch, "POST", "/api/boot/response"), body);
    expect(viaWatch?.status).toBe(423);
    const viaPhone = await routeBoot(d, "POST", "/api/boot/response", auth("owner", owner, "POST", "/api/boot/response"), body);
    expect(viaPhone?.status).toBe(200);
  });
});
