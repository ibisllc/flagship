import { describe, expect, it } from "vitest";
import {
  GENESIS_DIGEST,
  ed,
  signDeviceCapabilityGrant,
  signJournalRequest,
  type AdminGrantView,
  type JournalRequest,
  type Keypair,
  type PolicyState,
} from "@flagship/protocol";
import { randomBytes } from "node:crypto";
import { buildJournalHttp, type JournalReader } from "../src/journalHttp.js";
import type { UsedNonceStore } from "../src/updateConsumer.js";
import { setPqAuthority } from "../src/pqAuthority.js";

const SERVER = "home.alice.flagship.services";
const NOW = 5_000_000;

function makeKey(seed: number): Keypair {
  const priv = new Uint8Array(32).fill(seed);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function req(body: unknown) {
  return {
    method: "POST",
    path: "/api/journal",
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(body)),
  };
}

const IRK = makeKey(70);
const STRICT: PolicyState = {
  scope: { kind: "installation", id: SERVER },
  profile: "strict",
  rollout: "enforced",
  generation: 1,
  headDigest: GENESIS_DIGEST,
  enforcedEver: true,
};

function adminGrant(device: Keypair, root: Keypair, username: string, expiresAt: number): AdminGrantView {
  const grant = {
    grantId: "11111111-1111-4111-8111-111111111111",
    username,
    deviceId: "d1".repeat(16),
    devicePubKey: device.publicKey,
    scopes: ["browse", "admin"] as ("browse" | "admin")[],
    issuedAt: NOW - 1000,
    expiresAt,
  };
  return { grant, signatureHex: bytesToHex(signDeviceCapabilityGrant(grant, root)), signerRoot: "admin-root" };
}

/** Records what the reader was asked for, returns canned lines. */
function recordingReader(lines = ["line a", "line b"]) {
  const calls: { unit: string; lines: number }[] = [];
  const reader: JournalReader = {
    read: async (unit, n) => {
      calls.push({ unit, lines: n });
      return lines;
    },
  };
  return { calls, reader };
}

function memNonces(): UsedNonceStore & { used: string[] } {
  const used: string[] = [];
  return { used, has: async (n) => used.includes(n), mark: async (n) => void used.push(n) };
}

function mkHandler(reader: JournalReader, extra?: Partial<Parameters<typeof buildJournalHttp>[0]>) {
  return buildJournalHttp({
    serverId: SERVER,
    ownerIrkPub: IRK.publicKey,
    reader,
    usedNonces: memNonces(),
    now: () => NOW,
    maxLines: 500,
    ...extra,
  });
}

const nonce = () => randomBytes(16).toString("hex");
function journalReq(unit: string, lines: number): JournalRequest {
  return { serverId: SERVER, unit, lines, nonce: nonce(), issuedAt: NOW };
}

describe("buildJournalHttp", () => {
  it("returns null for unrelated paths", async () => {
    const { reader } = recordingReader();
    const handle = mkHandler(reader);
    expect(await handle({ ...req({}), path: "/api/other" })).toBeNull();
  });

  it("accepts a valid IRK-signed read and returns the journal lines", async () => {
    const { reader, calls } = recordingReader(["2026 boot", "2026 cert minted"]);
    const handle = mkHandler(reader);
    const order = journalReq("flagship-daemon", 50);
    const res = await handle(
      req({ request: { ...order }, signature: bytesToHex(signJournalRequest(order, IRK)) }),
    );
    expect(res!.status).toBe(200);
    const body = JSON.parse(String(res!.body));
    expect(body.ok).toBe(true);
    expect(body.unit).toBe("flagship-daemon");
    expect(body.lines).toEqual(["2026 boot", "2026 cert minted"]);
    expect(calls).toEqual([{ unit: "flagship-daemon", lines: 50 }]);
  });

  it("clamps lines to maxLines before reading", async () => {
    const { reader, calls } = recordingReader();
    const handle = mkHandler(reader, { maxLines: 100 });
    const order = journalReq("flagship-daemon", 99999);
    const res = await handle(
      req({ request: { ...order }, signature: bytesToHex(signJournalRequest(order, IRK)) }),
    );
    expect(res!.status).toBe(200);
    expect(calls[0]!.lines).toBe(100);
  });

  it("rejects a wrong-key signature with 403 (no read)", async () => {
    const { reader, calls } = recordingReader();
    const handle = mkHandler(reader);
    const attacker = makeKey(71);
    const order = journalReq("flagship-daemon", 50);
    const res = await handle(
      req({ request: { ...order }, signature: bytesToHex(signJournalRequest(order, attacker)) }),
    );
    expect(res!.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("rejects a stale issuedAt with 403 (no read)", async () => {
    const { reader, calls } = recordingReader();
    const handle = mkHandler(reader);
    const order: JournalRequest = { serverId: SERVER, unit: "flagship-daemon", lines: 50, nonce: nonce(), issuedAt: NOW - 10 * 60_000 };
    const res = await handle(
      req({ request: { ...order }, signature: bytesToHex(signJournalRequest(order, IRK)) }),
    );
    expect(res!.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("rejects a tampered unit with 403 (signature no longer matches)", async () => {
    const { reader, calls } = recordingReader();
    const handle = mkHandler(reader);
    const order = journalReq("flagship-daemon", 50);
    const sig = bytesToHex(signJournalRequest(order, IRK));
    const res = await handle(req({ request: { ...order, unit: "sshd" }, signature: sig }));
    expect(res!.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("rejects a non-allowlisted unit with 403 even when validly signed", async () => {
    const { reader, calls } = recordingReader();
    const handle = mkHandler(reader);
    // Validly sign a request for a unit that's not on the allowlist.
    const order = journalReq("sshd", 50);
    const res = await handle(
      req({ request: { ...order }, signature: bytesToHex(signJournalRequest(order, IRK)) }),
    );
    expect(res!.status).toBe(403);
    expect(JSON.parse(String(res!.body)).error).toBe("unit not allowed");
    expect(calls).toEqual([]);
  });

  it("rejects a serverId mismatch with 403", async () => {
    const { reader } = recordingReader();
    const handle = mkHandler(reader);
    const order: JournalRequest = { serverId: "evil.bob.flagship.services", unit: "flagship-daemon", lines: 50, nonce: nonce(), issuedAt: NOW };
    const res = await handle(
      req({ request: { ...order }, signature: bytesToHex(signJournalRequest(order, IRK)) }),
    );
    expect(res!.status).toBe(403);
  });

  it("405 for non-POST", async () => {
    const { reader } = recordingReader();
    const handle = mkHandler(reader);
    const res = await handle({ ...req({}), method: "GET" });
    expect(res!.status).toBe(405);
  });
});

describe("buildJournalHttp: admin root and units", () => {
  const ADMIN = makeKey(71);
  const ROTATED = makeKey(72);
  const signed = (r: JournalRequest, k: Keypair) => req({ request: r, signature: bytesToHex(signJournalRequest(r, k)) });

  it("accepts the pinned admin root where the box pins one and refuses the IRK there", async () => {
    const { reader, calls } = recordingReader();
    const handle = mkHandler(reader, { adminRootPub: ADMIN.publicKey, username: "alice" });
    expect((await handle(signed(journalReq("flagship-daemon", 10), ADMIN)))!.status).toBe(200);
    const byIrk = await handle(signed(journalReq("flagship-daemon", 10), IRK));
    expect(byIrk!.status).toBe(403);
    expect(JSON.parse(String(byIrk!.body)).error).toBe("invalid signature");
    expect(calls).toHaveLength(1);
  });

  it("refuses the IRK on a pinned box even for a unit off the allowlist (no allowlist oracle)", async () => {
    const { reader, calls } = recordingReader();
    const handle = mkHandler(reader, { adminRootPub: ADMIN.publicKey, username: "alice" });
    const res = await handle(signed(journalReq("sshd", 10), IRK));
    expect(res!.status).toBe(403);
    expect(JSON.parse(String(res!.body)).error).toBe("invalid signature");
    expect(calls).toHaveLength(0);
  });

  it("refuses an IRK signature replayed under an admin-root envelope field", async () => {
    const { reader, calls } = recordingReader();
    const handle = mkHandler(reader, { adminRootPub: ADMIN.publicKey, username: "alice" });
    const r = journalReq("flagship-daemon", 10);
    const res = await handle(
      req({ request: r, signature: bytesToHex(signJournalRequest(r, IRK)), signerPub: bytesToHex(ADMIN.publicKey) }),
    );
    expect(res!.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("takes a delegated admin device only with a live admin grant, read on each request", async () => {
    const { reader, calls } = recordingReader();
    const DEVICE = makeKey(74);
    let grants: AdminGrantView[] = [];
    const handle = mkHandler(reader, { adminRootPub: ADMIN.publicKey, username: "alice", activeGrants: () => grants });
    expect((await handle(signed(journalReq("flagship-daemon", 10), DEVICE)))!.status).toBe(403);
    grants = [adminGrant(DEVICE, ADMIN, "alice", Date.now() + 3_600_000)];
    expect((await handle(signed(journalReq("flagship-daemon", 10), DEVICE)))!.status).toBe(200);
    grants = [];
    expect((await handle(signed(journalReq("flagship-daemon", 10), DEVICE)))!.status).toBe(403);
    expect(calls).toHaveLength(1);
  });

  it("under strict, refuses a classical-only read and a broken PQ half, pinned or not", async () => {
    const { reader, calls } = recordingReader();
    setPqAuthority({ policy: () => STRICT, bindingFor: () => null });
    try {
      const pinned = mkHandler(reader, { adminRootPub: ADMIN.publicKey, username: "alice" });
      expect((await pinned(signed(journalReq("flagship-daemon", 10), ADMIN)))!.status).toBe(403);
      const r = journalReq("flagship-daemon", 10);
      const broken = req({ request: r, signature: bytesToHex(signJournalRequest(r, ADMIN)), pqSignature: { suite: "ed25519+ml-dsa-65", signature: "00" } });
      expect((await pinned(broken))!.status).toBe(403);
      expect((await mkHandler(reader)(signed(journalReq("flagship-daemon", 10), IRK)))!.status).toBe(403);
    } finally {
      setPqAuthority(null);
    }
    expect(calls).toHaveLength(0);
  });

  it("follows a rotated admin root: the old root is refused once the box pins the new one", async () => {
    const { reader, calls } = recordingReader();
    const handle = mkHandler(reader, { adminRootPub: ROTATED.publicKey, username: "alice" });
    expect((await handle(signed(journalReq("flagship-daemon", 10), ROTATED)))!.status).toBe(200);
    expect((await handle(signed(journalReq("flagship-daemon", 10), ADMIN)))!.status).toBe(403);
    expect(calls).toHaveLength(1);
  });

  it("refuses the admin root on a box that pins none, and a stranger everywhere", async () => {
    const { reader, calls } = recordingReader();
    expect((await mkHandler(reader)(signed(journalReq("flagship-daemon", 10), ADMIN)))!.status).toBe(403);
    expect((await mkHandler(reader, { adminRootPub: ADMIN.publicKey })(signed(journalReq("flagship-daemon", 10), makeKey(73))))!.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("lets the owner read keyd, privd and the broker, and nothing outside the flagship units", async () => {
    const { reader, calls } = recordingReader();
    const handle = mkHandler(reader);
    expect((await mkHandler(reader, { adminRootPub: ADMIN.publicKey, username: "alice" })(signed(journalReq("flagship-keyd", 10), ADMIN)))!.status).toBe(200);
    calls.length = 0;
    for (const unit of ["flagship-keyd", "flagship-privd", "flagship-broker", "flagship-data-services"]) {
      expect((await handle(signed(journalReq(unit, 10), IRK)))!.status).toBe(200);
    }
    expect(calls.map((c) => c.unit)).toEqual(["flagship-keyd", "flagship-privd", "flagship-broker", "flagship-data-services"]);
    for (const unit of ["ssh", "sshd", "flagship-keyd.service ", "docker"]) {
      expect((await handle(signed(journalReq(unit, 10), IRK)))!.status).toBe(403);
    }
  });
});

describe("buildJournalHttp: single-use nonce (review 2026-10-25 #15)", () => {
  it("reads once per signed request: a replay inside the window is refused, and the nonce is kept in the store", async () => {
    const { reader, calls } = recordingReader();
    const store = memNonces();
    const handle = mkHandler(reader, { usedNonces: store });
    const r = journalReq("flagship-daemon", 10);
    const body = { request: r, signature: bytesToHex(signJournalRequest(r, IRK)) };
    expect((await handle(req(body)))!.status).toBe(200);
    const again = await handle(req(body));
    expect(again!.status).toBe(409);
    expect(JSON.parse(String(again!.body)).error).toBe("this request was already used");
    expect(store.used).toEqual([r.nonce]);
    expect(calls).toHaveLength(1);
  });

  it("burns no nonce for a request that fails its signature, and refuses one without a nonce (the v1 shape)", async () => {
    const { reader, calls } = recordingReader();
    const store = memNonces();
    const handle = mkHandler(reader, { usedNonces: store });
    const r = journalReq("flagship-daemon", 10);
    expect((await handle(req({ request: r, signature: bytesToHex(signJournalRequest(r, makeKey(99))) })))!.status).toBe(403);
    expect(store.used).toEqual([]);
    const { nonce: _n, ...v1 } = r;
    const old = await handle(req({ request: v1, signature: "00".repeat(64) }));
    expect(old!.status).toBe(400);
    // A 0.2 app (journal-read/v1, no nonce) hears one sentence telling the person to update (F9).
    expect(JSON.parse(String(old!.body))).toEqual({
      error: "Reading this server's log needs the newest version of Flagship. Update the app, then try again.",
      code: "app-update-required",
    });
    expect((await handle(req({ request: { ...r, nonce: "XYZ" }, signature: "00".repeat(64) })))!.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
