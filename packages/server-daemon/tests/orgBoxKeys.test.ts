import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { canonicalOrgBoxKem, signOrgApproval, canonicalOrgKeyRing, verifyOrgBoxKem } from "@flagship/protocol";
import { checkSign } from "@flagship/keyd";
import { verifyOrgPin, type OrgPinFile } from "../src/orgAuthorityPin.js";
import { adoptOrgKeys, announceOrgBoxKem, orgBoxRotationDone, readOrgCgk, verifyServedRings } from "../src/orgBoxKeys.js";

const dir = resolve(import.meta.dirname, "../../protocol/test-vectors");
const A = JSON.parse(readFileSync(resolve(dir, "org-authority/vectors.json"), "utf8"));
const V = JSON.parse(readFileSync(resolve(dir, "org-servers/vectors.json"), "utf8"));
const R = (v: unknown): any => {
  if (Array.isArray(v)) return v.map(R);
  if (!v || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if (typeof o.$key === "string") return A.keys[o.$key].binding;
  if (typeof o.$approval === "number") return A.approvals[o.$approval];
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, R(x)]));
};
const SERVER = V.servers[0] as string;
const S = A.keys["S scoped admin"].seatId as string;
const ring1 = V.keyRings[0].bundle;
const ring2 = V.opens[0].ring;
const NOW = V.rotations[0].now as number;

function pinned() {
  const file: OrgPinFile = {
    v: 1,
    orgId: A.orgId,
    genesisHash: A.genesisHash,
    entries: R(A.chains[0]).entries.slice(0, 2),
    freezes: [],
    overturns: [],
    vetoes: [],
    grants: R(A.seatBooks[0]).grants,
    revokes: [V.revokeS],
    rotationsPending: [],
    syncedAt: NOW,
  };
  return verifyOrgPin(file, { orgId: A.orgId, genesisHash: A.genesisHash }, NOW);
}

function boxDir() {
  const d = mkdtempSync(join(tmpdir(), "org-box-keys-"));
  writeFileSync(join(d, "org-kem.seed"), "35".repeat(32));
  return d;
}

describe("org key ring on the box", () => {
  it("a departed seat's rotation ends only with a verified version that leaves it out; the box opens the newest", async () => {
    const pin = pinned();
    const d = boxDir();
    const before = verifyServedRings(pin, [ring1], SERVER, NOW);
    expect(orgBoxRotationDone(pin, before, "archive-keys", S, SERVER)).toBe(false);
    expect(orgBoxRotationDone(pin, before, "cgk", S, SERVER)).toBe(true);
    expect((await adoptOrgKeys(d, before, SERVER)).keys[`archive-keys|${SERVER}`]).toEqual({ version: 1, keyHex: "71".repeat(32) });

    const after = verifyServedRings(pin, [ring1, ring2], SERVER, NOW);
    expect(after.refused).toEqual([]);
    expect(orgBoxRotationDone(pin, after, "archive-keys", S, SERVER)).toBe(true);
    expect(orgBoxRotationDone(pin, after, "disk-key", S, SERVER)).toBe(true);
    expect((await adoptOrgKeys(d, after, SERVER)).keys[`archive-keys|${SERVER}`]).toEqual({ version: 2, keyHex: "72".repeat(32) });
    expect(statSync(join(d, "org-keys.json")).mode & 0o777).toBe(0o600);
  });

  it("a version `.com` made up (approved by an outsider) does not end the rotation", () => {
    const pin = pinned();
    const x = A.keys["X outsider"];
    const forged = {
      ...ring2,
      approvals: [
        signOrgApproval(
          { orgId: A.orgId, oarVersion: 1, order: canonicalOrgKeyRing(ring2.ring), seatId: x.seatId, adminKeyId: x.keyId, issuedAt: ring2.ring.issuedAt, notAfter: ring2.ring.issuedAt + 3_600_000 },
          Uint8Array.from(Buffer.from(x.edSeedHex + x.mldsaSeedHex, "hex")),
        ),
      ],
    };
    const rings = verifyServedRings(pin, [ring1, forged], SERVER, NOW);
    expect(rings.refused.length).toBe(1);
    expect(orgBoxRotationDone(pin, rings, "archive-keys", S, SERVER)).toBe(false);
  });

  it("announces its KEM key signed with the STK, a purpose keyd signs", async () => {
    const d = boxDir();
    const seed = new Uint8Array(32).fill(0x5e);
    const pub = Buffer.from(ed25519.getPublicKey(seed)).toString("hex");
    let sent: any = null;
    const kemKeyId = await announceOrgBoxKem({
      dataDir: d,
      orgId: A.orgId,
      serverDomain: SERVER,
      signAsBox: (m) => {
        checkSign(m, pub);
        return ed25519.sign(m, seed);
      },
      controlPlaneBaseUrl: "https://flagshipserver.example",
      now: () => NOW,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    expect(kemKeyId).toBe(V.kems.box[0].statement.kemKeyId);
    expect(verifyOrgBoxKem(sent, A.orgId, pub, NOW).recipient).toBe(`box:${SERVER}`);
    expect(new TextDecoder().decode(canonicalOrgBoxKem(sent.statement)).startsWith("flagship/org-box-kem/v1|")).toBe(true);
  });

  it("reads the org CGK gossip uses from org-keys.json, and nothing from a malformed file", async () => {
    const d = boxDir();
    expect(await readOrgCgk(d)).toBeNull();
    writeFileSync(join(d, "org-keys.json"), JSON.stringify({ v: 1, keys: { "cgk|*": { version: 3, keyHex: "ab".repeat(32) } } }));
    const k = await readOrgCgk(d);
    expect(k?.version).toBe(3);
    expect(Buffer.from(k!.key).toString("hex")).toBe("ab".repeat(32));
    writeFileSync(join(d, "org-keys.json"), JSON.stringify({ v: 1, keys: { "cgk|*": { version: 3, keyHex: "zz" } } }));
    expect(await readOrgCgk(d)).toBeNull();
  });
});
