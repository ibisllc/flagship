import {
  boxNameList,
  ed,
  leaseFor,
  nameListSha256,
  signServingRecord,
  type RevocationEntry,
  type ServingGrace,
  type ServingOnLapse,
  type ServingPolicy,
  type SignedServingRecord,
} from "@flagship/protocol";
import type { ComServingRecord } from "../../src/tunnel/servingGate.js";

export interface Ed {
  priv: Uint8Array;
  pub: string;
}

export function edKey(): Ed {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  return { priv, pub: hex(ed.getPublicKey(priv)) };
}

export function hex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

export function signed<K extends "serving-policy" | "serving-lease" | "revocation-entry">(
  kind: K,
  record: Parameters<typeof signServingRecord<K>>[1],
  key: Ed,
): { record: typeof record; signature: string } {
  return { record, signature: hex(signServingRecord(kind, record, (m) => ed.sign(m, key.priv))) };
}

export function policy(o: {
  account: string;
  box: string;
  admin: Ed;
  grace?: ServingGrace;
  onLapse?: ServingOnLapse;
  policyGen?: number;
  regGen?: number;
  server?: string;
}): SignedServingRecord<ServingPolicy> {
  const p: ServingPolicy = {
    account: o.account,
    box: o.box,
    regGen: o.regGen ?? 1,
    policyGen: o.policyGen ?? 1,
    grace: o.grace ?? "7d",
    onLapse: o.onLapse ?? "stop-apps",
    scopeSha256: nameListSha256(boxNameList(o.server ?? "home", o.account, "flagship.services")),
    issuedAt: 1_000,
  };
  return signed("serving-policy", p, o.admin);
}

/** A lease under `p` that ends at `notAfter`. */
export function lease(p: SignedServingRecord<ServingPolicy>, admin: Ed, issuedAt: number, notAfter: number) {
  const l = leaseFor(p.record, issuedAt, "0".repeat(31) + "1")!;
  return signed("serving-lease", { ...l, notAfter }, admin);
}

export function comRecord(o: Partial<ComServingRecord> & { adminKey: string }): ComServingRecord {
  return { regGen: 1, policy: null, leases: [], ...o };
}

export function revocation(seq: number, account: string, subject: string, key: Ed, kind: "box" | "renewal-key" = "box") {
  const entry: RevocationEntry = { sequence: seq, kind, account, subject, generation: kind === "box" ? 1 : 0, revokedAt: 5 };
  return { entry, signature: signed("revocation-entry", entry, key).signature };
}
