import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_SNI_LIMITS, parseClientHelloSni } from "../src/sni.js";

/** Build a minimal valid TLS 1.2 ClientHello with optional SNI. */
function buildClientHello(opts: { sni?: string; tlsVersion?: [number, number] } = {}): Uint8Array {
  const ver = opts.tlsVersion ?? [0x03, 0x03]; // TLS 1.2
  const random = new Uint8Array(32); // zeros are fine for test
  const sessionId = new Uint8Array(0);
  const cipherSuites = new Uint8Array([0x00, 0x9c]); // TLS_RSA_WITH_AES_128_GCM_SHA256
  const compressionMethods = new Uint8Array([0x00]);

  let extensions = new Uint8Array(0);
  if (opts.sni) {
    const hostBytes = new TextEncoder().encode(opts.sni);
    const nameEntry = concat(
      new Uint8Array([0x00]), // host_name
      u16(hostBytes.length),
      hostBytes,
    );
    const list = concat(u16(nameEntry.length), nameEntry);
    const sniExt = concat(
      u16(0x0000), // ext type = server_name
      u16(list.length),
      list,
    );
    extensions = concat(u16(sniExt.length), sniExt);
  }

  const body = concat(
    new Uint8Array(ver),
    random,
    new Uint8Array([sessionId.length]),
    sessionId,
    u16(cipherSuites.length),
    cipherSuites,
    new Uint8Array([compressionMethods.length]),
    compressionMethods,
    extensions,
  );
  const handshake = concat(
    new Uint8Array([0x01]), // ClientHello
    u24(body.length),
    body,
  );
  const record = concat(
    new Uint8Array([0x16]), // handshake
    new Uint8Array([0x03, 0x01]), // legacy record version (TLS 1.0)
    u16(handshake.length),
    handshake,
  );
  return record;
}

function concat(...arrs: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const a of arrs) {
    out.set(a, p);
    p += a.length;
  }
  return out;
}

function u16(v: number): Uint8Array {
  return new Uint8Array([(v >> 8) & 0xff, v & 0xff]);
}

function u24(v: number): Uint8Array {
  return new Uint8Array([(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
}

describe("parseClientHelloSni", () => {
  it("extracts a typical SNI", () => {
    const buf = buildClientHello({ sni: "harry.flagship.services" });
    expect(parseClientHelloSni(buf)).toEqual({ kind: "ok", sni: "harry.flagship.services" });
  });

  it("extracts a two-level subdomain SNI", () => {
    const buf = buildClientHello({ sni: "photos.harry.flagship.services" });
    expect(parseClientHelloSni(buf)).toEqual({
      kind: "ok",
      sni: "photos.harry.flagship.services",
    });
  });

  it("returns sni=null when the client sent no SNI extension", () => {
    const buf = buildClientHello({});
    expect(parseClientHelloSni(buf)).toEqual({ kind: "ok", sni: null });
  });

  it("lowercases the returned hostname", () => {
    const buf = buildClientHello({ sni: "Harry.Flagship.SERVICES" });
    expect(parseClientHelloSni(buf)).toEqual({ kind: "ok", sni: "harry.flagship.services" });
  });

  it("reports incomplete when the buffer is short of the record header", () => {
    const buf = new Uint8Array([0x16, 0x03]);
    const r = parseClientHelloSni(buf);
    expect(r.kind).toBe("incomplete");
  });

  it("reports incomplete when the record is not yet fully buffered", () => {
    const full = buildClientHello({ sni: "x.flagship.services" });
    const partial = full.subarray(0, full.length - 5);
    const r = parseClientHelloSni(partial);
    expect(r.kind).toBe("incomplete");
  });

  it("rejects non-handshake records", () => {
    const buf = new Uint8Array([0x17, 0x03, 0x03, 0x00, 0x00]);
    const r = parseClientHelloSni(buf);
    expect(r.kind).toBe("error");
  });

  it("rejects handshakes that are not ClientHello", () => {
    const buf = new Uint8Array([
      0x16,
      0x03,
      0x01,
      0x00,
      0x05,
      0x02, // ServerHello, not ClientHello
      0x00,
      0x00,
      0x00,
      0x00,
    ]);
    const r = parseClientHelloSni(buf);
    expect(r.kind).toBe("error");
  });

  it("rejects SNI with non-printable bytes (defends against spoofing)", () => {
    // Build a hello with a bad SNI containing 0x00.
    const bad = buildClientHello({ sni: "ok.flagship.services" });
    // Locate the hostname bytes (last N bytes are the hostname). Replace one with 0x00.
    bad[bad.length - 5] = 0x00;
    const r = parseClientHelloSni(bad);
    expect(r.kind).toBe("error");
  });

  it("rejects oversized record lengths", () => {
    const buf = new Uint8Array([0x16, 0x03, 0x03, 0xff, 0xff]);
    const r = parseClientHelloSni(buf);
    expect(r.kind).toBe("error");
  });

  it("does not panic on a single zero byte", () => {
    expect(parseClientHelloSni(new Uint8Array([0x00])).kind).toBe("incomplete");
  });

  it("does not panic on random garbage", () => {
    const garbage = new Uint8Array(2048);
    crypto.getRandomValues(garbage);
    garbage[0] = 0x16; // make it look like a TLS record so we exercise deeper paths
    const r = parseClientHelloSni(garbage);
    // We don't care which non-OK answer it gives, only that it returned cleanly.
    expect(["error", "incomplete", "ok"]).toContain(r.kind);
  });
});

/** Re-frame a single-record hello's handshake bytes into records of at most `size` bytes. */
function splitIntoRecords(single: Uint8Array, size: number): Uint8Array {
  const handshake = single.subarray(5);
  const parts: Uint8Array[] = [];
  for (let off = 0; off < handshake.length; off += size) {
    const frag = handshake.subarray(off, Math.min(handshake.length, off + size));
    parts.push(concat(new Uint8Array([0x16, 0x03, 0x01]), u16(frag.length), frag));
  }
  return concat(...parts);
}

/** Feed every prefix the way the router does; the verdict and the byte it came at. */
function routeByPrefix(raw: Uint8Array): { r: ReturnType<typeof parseClientHelloSni>; at: number } {
  for (let k = 1; k <= raw.length; k++) {
    const r = parseClientHelloSni(raw.subarray(0, k));
    if (r.kind !== "incomplete") return { r, at: k };
  }
  return { r: parseClientHelloSni(raw), at: raw.length };
}

describe("parseClientHelloSni: hellos split across TLS records", () => {
  const vectors = JSON.parse(
    readFileSync(new URL("../test-vectors/sni-pq-hellos.json", import.meta.url), "utf8"),
  ) as { cases: Array<{ name: string; hex: string; sni: string; records: number }> };

  for (const c of vectors.cases) {
    it(`routes the rustls hello "${c.name}" only once its last byte is in`, () => {
      const raw = new Uint8Array(Buffer.from(c.hex, "hex"));
      const { r, at } = routeByPrefix(raw);
      expect(r).toEqual({ kind: "ok", sni: c.sni });
      expect(at).toBe(raw.length);
    });
  }

  it("gives the same answer for one record and for many 1-byte records", () => {
    const single = buildClientHello({ sni: "Photos.Harry.flagship.services" });
    const expected = { kind: "ok", sni: "photos.harry.flagship.services" };
    expect(parseClientHelloSni(single)).toEqual(expected);
    for (const size of [1, 3, 7, 40]) {
      expect(parseClientHelloSni(splitIntoRecords(single, size))).toEqual(expected);
    }
  });

  it("asks for the next record header, then the whole next record", () => {
    const multi = splitIntoRecords(buildClientHello({ sni: "a.b.flagship.services" }), 20);
    expect(parseClientHelloSni(multi.subarray(0, 25))).toEqual({ kind: "incomplete", needAtLeast: 30 });
    expect(parseClientHelloSni(multi.subarray(0, 30))).toEqual({ kind: "incomplete", needAtLeast: 50 });
  });

  it("rejects a continuation that is not a handshake record", () => {
    const multi = splitIntoRecords(buildClientHello({ sni: "a.b.flagship.services" }), 20);
    multi[25] = 0x17;
    expect(parseClientHelloSni(multi)).toEqual({ kind: "error", reason: "not a TLS handshake record" });
  });

  it("rejects an empty record", () => {
    const multi = splitIntoRecords(buildClientHello({ sni: "a.b.flagship.services" }), 20);
    const withEmpty = concat(multi.subarray(0, 25), new Uint8Array([0x16, 3, 1, 0, 0]), multi.subarray(25));
    expect(parseClientHelloSni(withEmpty)).toEqual({ kind: "error", reason: "empty handshake record" });
    expect(parseClientHelloSni(new Uint8Array([0x16, 3, 1, 0, 0]))).toEqual({
      kind: "error",
      reason: "record too small for handshake header",
    });
  });

  it("rejects a hello spread over more records than the cap", () => {
    const multi = splitIntoRecords(buildClientHello({ sni: "a.b.flagship.services" }), 1);
    const r = parseClientHelloSni(multi, { ...DEFAULT_SNI_LIMITS, maxRecords: 10 });
    expect(r).toEqual({ kind: "error", reason: "ClientHello spans too many records" });
  });

  it("rejects a hello whose declared length is over the size cap at the first record", () => {
    const hdr = new Uint8Array([0x16, 3, 1, 0, 4, 0x01, 0x00, 0x80, 0x00]); // 32 KiB hello
    expect(parseClientHelloSni(hdr)).toEqual({ kind: "error", reason: "ClientHello exceeds the size limit" });
  });

  it("rejects before buffering past the peek limit", () => {
    // A 20 KiB hello whose first record says it is 20 KiB, under an 8 KiB peek limit.
    const hdr = new Uint8Array([0x16, 3, 1, 0, 4, 0x01, 0x00, 0x50, 0x00]);
    const limits = { ...DEFAULT_SNI_LIMITS, maxRawBytes: 8 * 1024 };
    expect(parseClientHelloSni(hdr, limits)).toEqual({ kind: "error", reason: "ClientHello exceeds the peek limit" });
    const bigRecord = new Uint8Array([0x16, 3, 1, 0x40, 0x00]);
    expect(parseClientHelloSni(bigRecord, limits)).toEqual({ kind: "error", reason: "ClientHello exceeds the peek limit" });
  });

  it("still reads a hello that spans one record and ignores bytes after it", () => {
    const single = buildClientHello({ sni: "x.y.flagship.services" });
    const trailing = concat(single, new Uint8Array([0x14, 3, 3, 0, 1, 1]));
    expect(parseClientHelloSni(trailing)).toEqual({ kind: "ok", sni: "x.y.flagship.services" });
  });
});
