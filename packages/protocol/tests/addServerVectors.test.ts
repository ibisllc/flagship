import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hexToBytes } from "@noble/hashes/utils";
import {
  authCodeAdminCanonicalBytes,
  authCodeCanonicalBytes,
  verifyAuthCode,
  verifyAuthCodeAdmin,
  type AuthCode,
} from "../src/installBlob.js";
import { serverRestoreCanonicalBytes, verifyServerRestoreOrder } from "../src/serverBackup.js";
import { buildAddServerVectors, VECTORS_PATH } from "./genAddServerVectors.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as any;
const text = (b: Uint8Array) => new TextDecoder().decode(b);

function code(f: Record<string, unknown>): AuthCode {
  return {
    version: 1,
    serial: f.serial as string,
    username: f.username as string,
    serverName: f.serverName as string,
    serverDomain: f.serverDomain as string,
    delegatedPubKey: hexToBytes(f.delegatedPubKey as string),
    userPubKey: hexToBytes(f.userPubKey as string),
    issuedAt: f.issuedAt as number,
    expiresAt: f.expiresAt as number,
    ...(typeof f.adminRootPubKey === "string" ? { adminRootPubKey: hexToBytes(f.adminRootPubKey) } : {}),
  };
}

describe("add-server vectors (adding a server is admin-only)", () => {
  it("the file is what the generator writes", () => {
    expect(V).toEqual(JSON.parse(JSON.stringify(buildAddServerVectors())));
  });

  it("reproduces both canonical strings and verifies the pinned signatures", () => {
    const c = code(V.authCode.fields);
    expect(text(authCodeCanonicalBytes(c))).toBe(V.authCode.canonical);
    expect(text(authCodeAdminCanonicalBytes(c))).toBe(V.authCode.adminCanonical);
    expect(verifyAuthCode(c, hexToBytes(V.authCode.irkSignatureHex), hexToBytes(V.keys.irkPubHex))).toBe(true);
    expect(verifyAuthCodeAdmin(c, hexToBytes(V.authCode.adminSignatureHex), hexToBytes(V.keys.adminRootPubHex))).toBe(true);
  });

  it("refuses every reject as the admin approval", () => {
    const c = code(V.authCode.fields);
    for (const r of V.reject) {
      expect(verifyAuthCodeAdmin(c, hexToBytes(r.signatureHex), hexToBytes(V.keys.adminRootPubHex)), r.why).toBe(false);
    }
  });

  it("a code pinning another root verifies only under that root", () => {
    const c = code(V.wrongRoot.fields);
    expect(text(authCodeAdminCanonicalBytes(c))).toBe(V.wrongRoot.adminCanonical);
    const sig = hexToBytes(V.wrongRoot.adminSignatureHex);
    expect(verifyAuthCodeAdmin(c, sig, hexToBytes(V.keys.otherRootPubHex))).toBe(true);
    expect(verifyAuthCodeAdmin(c, sig, hexToBytes(V.keys.adminRootPubHex))).toBe(false);
  });

  it("an AuthCode with no admin root has no admin form", () => {
    for (const r of V.refuse) {
      expect(() => authCodeAdminCanonicalBytes(code(r.fields)), r.why).toThrow();
      expect(verifyAuthCodeAdmin(code(r.fields), hexToBytes(V.authCode.adminSignatureHex), hexToBytes(V.keys.adminRootPubHex))).toBe(false);
    }
  });

  it("the restore order verifies under the admin root and not under the IRK or a device key", () => {
    const o = V.restore.order;
    expect(text(serverRestoreCanonicalBytes(o))).toBe(V.restore.canonical);
    expect(verifyServerRestoreOrder(o, hexToBytes(V.restore.adminSignatureHex), hexToBytes(V.keys.adminRootPubHex))).toBe(true);
    for (const r of V.restore.reject) {
      expect(verifyServerRestoreOrder(o, hexToBytes(r.signatureHex), hexToBytes(V.keys.adminRootPubHex)), r.why).toBe(false);
    }
  });
});
