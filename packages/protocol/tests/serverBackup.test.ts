import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hex } from "../src/canonicalBase.js";
import { deriveIRK, deriveServerArchiveKey } from "../src/keys.js";
import {
  BackupFormatError,
  backupPasscodeKek,
  backupPasscodeProblem,
  generateBackupPasscode,
  openBackupBody,
  openBackupWithAccountKey,
  openBackupWithPasscode,
  openRestoreFromPairingJson,
  parseBackupFile,
  parseBackupSlots,
  parseServerRestoreOrder,
  sealBackupFile,
  serializeBackupFile,
  serverRestoreCanonicalBytes,
  signServerRestoreOrder,
  unwrapSlot,
  verifyServerRestoreOrder,
  wrapAccountSlot,
  wrapPasscodeSlot,
  type BackupBody,
  type ServerRestoreOrder,
} from "../src/serverBackup.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const B = JSON.parse(readFileSync(join(root, "packages/protocol/test-vectors/server-backup/vectors.json"), "utf8")) as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const R = JSON.parse(readFileSync(join(root, "packages/protocol/test-vectors/server-restore/vectors.json"), "utf8")) as any;
const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));

describe("server-backup vectors", () => {
  it("derives both slot keys", () => {
    expect(hex(deriveServerArchiveKey({ seed: fromHex(B.umkSeedHex) }, B.archiveId))).toBe(B.accountKekHex);
    expect(hex(backupPasscodeKek(B.passcode, B.slots.passcode.kdf))).toBe(B.passcodeKekHex);
  });

  it("pins Argon2id at the default parameters", () => {
    expect(hex(backupPasscodeKek(B.defaultParamsKdf.passcode, B.defaultParamsKdf.kdf))).toBe(B.defaultParamsKdf.kekHex);
  });

  it("normalizes passcodes (trim + NFC)", () => {
    for (const n of B.normalize) expect(hex(backupPasscodeKek(n.input, B.slots.passcode.kdf))).toBe(n.kekHex);
  });

  it("re-creates the slots and the file byte for byte", () => {
    const key = fromHex(B.contentKeyHex);
    const n = B.slotNonces;
    const p = wrapPasscodeSlot(B.archiveId, key, B.passcode, fromHex(n.passcodeSaltHex), fromHex(n.passcodeNonceHex), B.slots.passcode.kdf);
    const a = wrapAccountSlot(B.archiveId, key, fromHex(B.accountKekHex), fromHex(n.accountNonceHex));
    expect(p).toEqual(B.slots.passcode);
    expect(a).toEqual(B.slots.account);
    expect(serializeBackupFile(sealBackupFile(B.archiveId, key, [p, a], B.body as BackupBody, fromHex(n.bodyNonceHex)))).toBe(B.file);
  });

  it("opens with the account key and with the passcode", () => {
    const f = parseBackupFile(B.file);
    const viaAccount = openBackupWithAccountKey(f, fromHex(B.accountKekHex));
    expect(viaAccount?.via).toBe("account");
    expect(hex(viaAccount!.contentKey)).toBe(B.contentKeyHex);
    expect(viaAccount!.body).toEqual(B.body);
    const viaPass = openBackupWithPasscode(f, B.passcode);
    expect(hex(viaPass.contentKey)).toBe(B.contentKeyHex);
    expect(viaPass.body).toEqual(B.body);
  });

  it("refuses a wrong passcode and another account", () => {
    const f = parseBackupFile(B.file);
    expect(() => openBackupWithPasscode(f, B.wrongPasscode)).toThrow(/doesn't open/);
    const other = deriveServerArchiveKey({ seed: fromHex(B.wrongUmkSeedHex) }, B.archiveId);
    expect(openBackupWithAccountKey(f, other)).toBeNull();
  });

  it.each(B.tampered.map((t: { why: string }) => [t.why, t]))("refuses a tampered file: %s", (_why, t) => {
    const f = parseBackupFile((t as { file: string }).file);
    const key = fromHex(B.contentKeyHex);
    const passOpens = (() => {
      try {
        openBackupWithPasscode(f, B.passcode);
        return true;
      } catch {
        return false;
      }
    })();
    expect(passOpens).toBe(false);
    const acct = (() => {
      try {
        return openBackupWithAccountKey(f, fromHex(B.accountKekHex));
      } catch {
        return null;
      }
    })();
    // A changed passcode slot leaves the (separately sealed) account slot working.
    if ((t as { why: string }).why === "passcode params changed") expect(acct?.via).toBe("account");
    else expect(acct).toBeNull();
    // Even with the right content key, a changed id or body doesn't open.
    if ((t as { why: string }).why !== "passcode params changed" && (t as { why: string }).why !== "slots swapped") {
      expect(() => openBackupBody(f, key)).toThrow(BackupFormatError);
    }
  });

  it.each(B.malformed.map((t: { why: string }) => [t.why, t]))("refuses a malformed file: %s", (_why, t) => {
    const m = t as { file: string; code: string };
    try {
      parseBackupFile(m.file);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BackupFormatError);
      expect((e as BackupFormatError).code).toBe(m.code);
    }
  });

  it("generates passcodes from the alphabet", () => {
    const bytes = fromHex(B.generatedPasscode.rngBytesHex);
    let i = 0;
    const rng = (n: number) => {
      const out = bytes.slice(i, i + n);
      i += n;
      return out;
    };
    expect(generateBackupPasscode(rng)).toBe(B.generatedPasscode.passcode);
    expect(generateBackupPasscode()).toMatch(/^[a-km-np-z2-9]{4}(-[a-km-np-z2-9]{4}){4}$/);
  });

  it("applies the passcode rules", () => {
    for (const p of B.passcodeRules.ok) expect(backupPasscodeProblem(p)).toBeNull();
    for (const p of B.passcodeRules.weak) expect(backupPasscodeProblem(p)).not.toBeNull();
  });

  it("accepts slots from an app only one of each kind", () => {
    expect(parseBackupSlots([B.slots.passcode, B.slots.account])).toHaveLength(2);
    expect(parseBackupSlots([B.slots.account])).toHaveLength(1);
    expect(parseBackupSlots([])).toBeNull();
    expect(parseBackupSlots([B.slots.account, B.slots.account])).toBeNull();
    expect(parseBackupSlots([{ ...B.slots.account, wrappedHex: "00" }])).toBeNull();
  });

  it("unwrapSlot returns null under the wrong key", () => {
    expect(unwrapSlot(B.archiveId, B.slots.account, new Uint8Array(32))).toBeNull();
  });
});

describe("server-restore vectors", () => {
  const irk = deriveIRK({ seed: fromHex(R.umkSeedHex) });
  it("signs with the IRK from the seed", () => {
    expect(hex(irk.publicKey)).toBe(R.pub);
  });
  it.each(R.cases.map((c: unknown, i: number) => [i, c]))("case #%i", (_i, c) => {
    const k = c as { order: ServerRestoreOrder; canonical: string; signature: string };
    expect(new TextDecoder().decode(serverRestoreCanonicalBytes(k.order))).toBe(k.canonical);
    expect(hex(signServerRestoreOrder(k.order, irk))).toBe(k.signature);
    expect(verifyServerRestoreOrder(k.order, fromHex(k.signature), irk.publicKey)).toBe(true);
    expect(verifyServerRestoreOrder({ ...k.order, bytes: k.order.bytes + 1 }, fromHex(k.signature), irk.publicKey)).toBe(false);
    expect(parseServerRestoreOrder(k.order)).toEqual(k.order);
  });
  it.each(R.invalid.map((c: unknown, i: number) => [i, c]))("refuses invalid #%i", (_i, c) => {
    expect(parseServerRestoreOrder(c)).toBeNull();
    expect(() => serverRestoreCanonicalBytes(c as ServerRestoreOrder)).toThrow();
  });
  it("opens from a pairing order's JSON only for this box and this owner", () => {
    const c = R.cases[0] as { order: ServerRestoreOrder; signature: string };
    const json = JSON.stringify({ request: {}, signature: "00", restore: { order: c.order, signatureHex: c.signature } });
    expect(openRestoreFromPairingJson(json, irk.publicKey, c.order.serverDomain)?.order).toEqual(c.order);
    expect(openRestoreFromPairingJson(json, irk.publicKey, "other.harry.flagship.services")).toBeNull();
    const other = deriveIRK({ seed: new Uint8Array(32).fill(1) });
    expect(openRestoreFromPairingJson(json, other.publicKey, c.order.serverDomain)).toBeNull();
    expect(openRestoreFromPairingJson(JSON.stringify({ request: {}, signature: "00" }), irk.publicKey, c.order.serverDomain)).toBeNull();
    expect(openRestoreFromPairingJson("not json", irk.publicKey, c.order.serverDomain)).toBeNull();
  });
});
