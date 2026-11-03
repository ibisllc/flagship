import { describe, expect, it } from "vitest";
import { hexToBytes } from "@noble/hashes/utils";
import { ed, openSealedSecretResponse, signSecretRequest, verifyRootEntitlement, type SecretRequest } from "@flagship/protocol";
import { BOOT_FACTS_SCRIPT, MAKE_CHAIN_STALE, STALE_CHAIN_LINE, parseBootFacts, parseUnlockLog, splitFacts } from "../lib/bootFacts.js";
import { entitlementCarrierHex, requestIsSigned, sealedUnlockReply } from "../lib/bootApprover.js";

const kp = (n: number) => {
  const privateKey = new Uint8Array(32).fill(n);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
};
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const LOG = [
  "flagship [up=3s] premount start (domain=home.ab.gym.flagship.services mode=approve lock-once=yes)",
  "flagship [up=3s] boot unlock v2: off (policy: compat)",
  "flagship [up=9s] asked the phone to approve (request 1)",
  "flagship [up=31s] unlocked with the phone's reply (attempt 7)",
  "flagship [up=31s] unlocked; proceeding to mount root",
  "flagship [up=31s] consumed the one-shot lock marker",
].join("\n");

const OUT = [
  "@@flagship-fact:mount",
  "/dev/vda1 FLAGSHIP_BOOT ext4",
  "@@flagship-fact:label",
  "/dev/vda1",
  "@@flagship-fact:lockonce",
  "absent",
  "@@flagship-fact:unlocklog",
  LOG,
  "@@flagship-fact:cmdline",
  "BOOT_IMAGE=/vmlinuz-6.12.0-amd64 root=/dev/mapper/flagship_root ro quiet panic=30 flagship.bootchain=tok_123-abc",
  "@@flagship-fact:bootid",
  "5f0c1c2e-1111-2222-3333-444455556666",
  "@@flagship-fact:state",
  '{"v":1,"trial":{"token":"tok_123-abc","digest":"d1"}}',
  "@@flagship-fact:grubenv",
  "saved_entry=0\nnext_entry=",
  "@@flagship-fact:customcfg",
  "present",
  "@@flagship-fact:premount",
  `${"c".repeat(64)}  /etc/initramfs-tools/scripts/local-top/flagship-unlock`,
  STALE_CHAIN_LINE,
  "@@flagship-fact:luks",
  "/dev/vda3",
  "@@flagship-fact:end",
].join("\n");

describe("boot facts (B0 / boot-chain lane)", () => {
  it("reads the unlock log the premount wrote on FLAGSHIP_BOOT", () => {
    const l = parseUnlockLog(LOG);
    expect(l).toMatchObject({ premountStarted: true, lockOnce: "yes", mode: "approve", unlockedBy: "phone", consumedMarker: true, fatal: null });
    expect(parseUnlockLog("")).toMatchObject({ premountStarted: false, lockOnce: null, unlockedBy: null });
    expect(parseUnlockLog("flagship [up=2s] FATAL: missing /boot/flagship-boot-key.pem").fatal).toBe("missing /boot/flagship-boot-key.pem");
    expect(parseUnlockLog("flagship [up=2s] premount start (domain=x mode=auto lock-once=no)\nflagship [up=4s] unlocked from the auto-unlock lease").unlockedBy).toBe("lease");
  });

  it("parses every fact the script prints", () => {
    const f = parseBootFacts(OUT);
    expect(f.bootMount).toEqual({ source: "/dev/vda1", label: "FLAGSHIP_BOOT", fstype: "ext4" });
    expect(f.labelDevice).toBe("/dev/vda1");
    expect(f.lockOncePresent).toBe(false);
    expect(f.unlockLog.consumedMarker).toBe(true);
    expect(f.bootchainToken).toBe("tok_123-abc");
    expect(f.state.trial?.token).toBe("tok_123-abc");
    expect(f.nextEntry).toBeNull();
    expect(f.customCfgPresent).toBe(true);
    expect(f.premountSha256).toBe("c".repeat(64));
    expect(f.premountLastLine).toBe(STALE_CHAIN_LINE);
    expect(f.luksDevice).toBe("/dev/vda3");
    expect(f.bootId).toMatch(/^5f0c1c2e/);
  });

  it("tells missing facts apart and refuses output with none", () => {
    const f = parseBootFacts(
      OUT.replace("/dev/vda1 FLAGSHIP_BOOT ext4", "not-a-mount").replace("@@flagship-fact:label\n/dev/vda1", "@@flagship-fact:label\nno-label").replace("absent", "present").replace("next_entry=", "next_entry=flagship-bootchain-trial"),
    );
    expect(f.bootMount).toBeNull();
    expect(f.labelDevice).toBeNull();
    expect(f.lockOncePresent).toBe(true);
    expect(f.nextEntry).toBe("flagship-bootchain-trial");
    expect(() => parseBootFacts("Permission denied (publickey).")).toThrow(/no boot facts/);
    expect(splitFacts("noise\n@@flagship-fact:a\n1\n2\n@@flagship-fact:end").get("a")).toBe("1\n2");
  });

  it("keeps the script and the stale-chain edit free of quotes that would break `sudo sh -c '…'`", () => {
    expect(BOOT_FACTS_SCRIPT).not.toContain('"');
    expect(MAKE_CHAIN_STALE).toContain(STALE_CHAIN_LINE);
    expect(MAKE_CHAIN_STALE.startsWith("grep -qxF")).toBe(true);
  });
});

describe("the simulated owner phone (boot approver)", () => {
  const box = kp(7);
  const owner = kp(9);
  const req: SecretRequest = { serverDomain: "home.ab.gym.flagship.services", stkPub: box.publicKey, purpose: "unlock-key", nonce: new Uint8Array(32).fill(3), issuedAt: 1_700_000_000_000 };
  const wire = { serverDomain: req.serverDomain, stkPub: hex(box.publicKey), purpose: "unlock-key", requestNonceHex: hex(req.nonce), requestSignature: hex(signSecretRequest(req, box)), issuedAt: req.issuedAt };

  it("accepts a request only when signed by the key it names", () => {
    expect(requestIsSigned(wire)).toBe(true);
    expect(requestIsSigned({ ...wire, stkPub: hex(owner.publicKey) })).toBe(false);
    expect(requestIsSigned({ ...wire, issuedAt: wire.issuedAt + 1 })).toBe(false);
    expect(requestIsSigned({ ...wire, requestSignature: "zz" })).toBe(false);
  });

  it("seals the disk key so only that box opens it, bound to that request", () => {
    const disk = new Uint8Array(64).fill(5);
    const sealed = sealedUnlockReply(disk, wire);
    const opened = openSealedSecretResponse(
      { serverDomain: req.serverDomain, requestNonceHex: wire.requestNonceHex, purpose: "unlock-key", sealed: hexToBytes(sealed), issuedAt: 0 },
      req,
      box.privateKey,
    );
    expect(hex(opened)).toBe(hex(disk));
    expect(() =>
      openSealedSecretResponse({ serverDomain: req.serverDomain, requestNonceHex: wire.requestNonceHex, purpose: "unlock-key", sealed: hexToBytes(sealed), issuedAt: 0 }, { ...req, purpose: "entitlement" }, box.privateKey),
    ).toThrow();
  });

  it("builds the RootEntitlement carrier the box presents, signed by the admin root", () => {
    const json = JSON.parse(Buffer.from(entitlementCarrierHex("ab", hex(box.publicKey), req.serverDomain, owner, 1234), "hex").toString("utf8"));
    expect(json.rootEntitlement).toEqual({ username: "ab", podPubKey: hex(box.publicKey), podCanonical: req.serverDomain, issuedAt: 1234 });
    expect(json.serviceEntitlement).toBeNull();
    expect(
      verifyRootEntitlement({ username: "ab", podPubKey: box.publicKey, podCanonical: req.serverDomain, issuedAt: 1234 }, hexToBytes(json.rootEntitlementSig), owner.publicKey),
    ).toBe(true);
    expect(() => entitlementCarrierHex("a|b", hex(box.publicKey), req.serverDomain, owner)).toThrow(/separator/);
  });
});
