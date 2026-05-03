import { describe, expect, it } from "vitest";
import { parseClientHelloSni } from "../src/sni.js";

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
