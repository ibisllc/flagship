// Owner diagnostics — webapp journal client (lib/journal.js) tests.
//
// Pins:
//   - canonical-bytes shape byte-for-byte AND signature parity against
//     @flagship/protocol's verifyJournalRequest (the exact envelope the
//     daemon verifies in journalHttp.ts).
//   - the POST shape (URL, headers, body keys) for /api/journal.
//   - lines clamping, unit `|`-guard, and the locked-webapp guard.

import { describe, expect, it, vi } from "vitest";
import {
  canonicalJournalBytes,
  fetchJournal,
  TAG_JOURNAL_READ,
  JOURNAL_MAX_LINES,
} from "../public/webapp/lib/journal.js";
import {
  signJournalRequest,
  verifyJournalRequest,
  ed,
  type JournalRequest,
} from "@flagship/protocol";

const POD = "https://home.harry.flagship.services";
const SERVER_ID = "home.harry.flagship.services";

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function fixedKey() {
  const priv = new Uint8Array(32);
  for (let i = 0; i < 32; i++) priv[i] = (i * 7 + 1) & 0xff;
  return { priv, pub: ed.getPublicKey(priv) };
}

describe("journal — canonical-bytes parity with @flagship/protocol", () => {
  it("uses the protocol tag", () => {
    expect(TAG_JOURNAL_READ).toBe("flagship/journal-read/v1");
  });

  it("composes the exact byte string and verifies under verifyJournalRequest", () => {
    const issuedAt = 1700000000000;
    const unit = "flagship-daemon";
    const lines = 200;
    const got = new TextDecoder().decode(canonicalJournalBytes({ serverId: SERVER_ID, unit, lines, issuedAt }));
    expect(got).toBe(`flagship/journal-read/v1|${SERVER_ID}|${unit}|${lines}|${issuedAt}`);

    const { priv, pub } = fixedKey();
    const req: JournalRequest = { serverId: SERVER_ID, unit, lines, issuedAt };
    const sig = signJournalRequest(req, { privateKey: priv, publicKey: pub });
    // The webapp's canonical bytes MUST verify under the protocol signer.
    expect(ed.verify(sig, canonicalJournalBytes({ serverId: SERVER_ID, unit, lines, issuedAt }), pub)).toBe(true);
    expect(verifyJournalRequest(req, sig, pub)).toBe(true);
  });

  it("rejects a unit containing the canonical separator", () => {
    expect(() => canonicalJournalBytes({ serverId: SERVER_ID, unit: "a|b", lines: 1, issuedAt: 1 })).toThrow();
  });
});

describe("fetchJournal — POST shape + signing", () => {
  it("POSTs an IRK-signed envelope to <pod>/api/journal and returns the lines", async () => {
    const { priv, pub } = fixedKey();
    const fakeFetch = vi.fn(async (_url: string, _opts: any) => ({
      ok: true,
      json: async () => ({ ok: true, unit: "flagship-daemon", lines: ["boot", "cert minted"] }),
    }));
    // The client passes the exact canonical bytes to sign, so signing them
    // directly with the IRK is what the real signWithIrk does.
    const signWithIrk = async (_umk: Uint8Array, bytes: Uint8Array) => ed.sign(bytes, priv);

    const res = await fetchJournal(
      { baseUrl: POD, umk: new Uint8Array(32), signWithIrk },
      { fetch: fakeFetch as any, now: () => 1700000000000 },
    );

    expect(res.lines).toEqual(["boot", "cert minted"]);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = fakeFetch.mock.calls[0]!;
    expect(url).toBe(`${POD}/api/journal`);
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body.request).toEqual({ serverId: SERVER_ID, unit: "flagship-daemon", lines: 200, issuedAt: 1700000000000 });
    expect(typeof body.signature).toBe("string");
    // The posted signature verifies the posted request under the protocol verifier.
    expect(verifyJournalRequest(body.request, hexToBytesLocal(body.signature), pub)).toBe(true);
  });

  it("clamps lines to JOURNAL_MAX_LINES", async () => {
    const { priv } = fixedKey();
    const fakeFetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, unit: "flagship-daemon", lines: [] }) }));
    const signWithIrk = async (_umk: Uint8Array, bytes: Uint8Array) => ed.sign(bytes, priv);
    await fetchJournal(
      { baseUrl: POD, lines: 99999, umk: new Uint8Array(32), signWithIrk },
      { fetch: fakeFetch as any, now: () => 1 },
    );
    const body = JSON.parse(fakeFetch.mock.calls[0]![1].body);
    expect(body.request.lines).toBe(JOURNAL_MAX_LINES);
  });

  it("refuses when the webapp is locked (no umk / signer)", async () => {
    await expect(fetchJournal({ baseUrl: POD } as any)).rejects.toThrow(/unlock/i);
  });
});

function hexToBytesLocal(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
