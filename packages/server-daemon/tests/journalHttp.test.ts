import { describe, expect, it } from "vitest";
import { ed, signJournalRequest, type JournalRequest, type Keypair } from "@flagship/protocol";
import { buildJournalHttp, type JournalReader } from "../src/journalHttp.js";

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

function mkHandler(reader: JournalReader, extra?: Partial<Parameters<typeof buildJournalHttp>[0]>) {
  return buildJournalHttp({
    serverId: SERVER,
    ownerIrkPub: IRK.publicKey,
    reader,
    now: () => NOW,
    maxLines: 500,
    ...extra,
  });
}

function journalReq(unit: string, lines: number): JournalRequest {
  return { serverId: SERVER, unit, lines, issuedAt: NOW };
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
    const order: JournalRequest = { serverId: SERVER, unit: "flagship-daemon", lines: 50, issuedAt: NOW - 10 * 60_000 };
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
    const order: JournalRequest = { serverId: "evil.bob.flagship.services", unit: "flagship-daemon", lines: 50, issuedAt: NOW };
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
