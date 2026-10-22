import { describe, expect, it } from "vitest";
import {
  decapsulateOhttpRequest,
  decapsulateOhttpResponse,
  decodeBhttpRequest,
  decodeBhttpResponse,
  encapsulateOhttpRequest,
  encapsulateOhttpResponse,
  encodeBhttpRequest,
  encodeBhttpResponse,
  encodeOhttpKeyConfig,
  encodeOhttpKeys,
  ohttpGatewayKey,
  OhttpError,
  parseOhttpKeyConfig,
  parseOhttpKeys,
} from "../src/index.js";

const h = (s: string) => Uint8Array.from(Buffer.from(s.replace(/\s+/g, ""), "hex"));
const x = (b: Uint8Array) => Buffer.from(b).toString("hex");

// RFC 9458 Appendix A, verbatim.
const A = {
  gatewaySecret: "3c168975674b2fa8e465970b79c8dcf09f1c741626480bd4c6162fc5b6a98e1a",
  keyConfig: "01002031e1f05a740102115220e9af918f738674aec95f54db6e04eb705aae8e79815500080001000100010003",
  request: "00034745540568747470730b6578616d706c652e636f6d012f",
  ephemeralSecret: "bc51d5e930bda26589890ac7032f70ad12e4ecb37abb1b65b1256c9c48999c73",
  encapsulatedRequest:
    "010020000100014b28f881333e7c164ffc499ad9796f877f4e1051ee6d31bad19dec96c208b4726374e469135906992e1268c594d2a10c695d858c40a026e7965e7d86b83dd440b2c0185204b4d63525",
  response: "0140c8",
  exportedSecret: "62d87a6ba569ee81014c2641f52bea36",
  responseNonce: "c789e7151fcba46158ca84b04464910d",
  encapsulatedResponse: "c789e7151fcba46158ca84b04464910d86f9013e404feea014e7be4a441f234f857fbd",
};

describe("OHTTP against RFC 9458 Appendix A", () => {
  const key = ohttpGatewayKey(1, h(A.gatewaySecret));

  it("parses the example's key configuration (which offers two suites)", () => {
    const c = parseOhttpKeyConfig(h(A.keyConfig));
    expect(c?.keyId).toBe(1);
    expect(x(c!.publicKey)).toBe(x(key.publicKey));
  });

  it("reproduces the Encapsulated Request and the exported secret", () => {
    const c = parseOhttpKeyConfig(h(A.keyConfig))!;
    const { encapsulated, context } = encapsulateOhttpRequest(c, h(A.request), h(A.ephemeralSecret));
    expect(x(encapsulated)).toBe(A.encapsulatedRequest);
    expect(x(context.secret)).toBe(A.exportedSecret);
  });

  it("the gateway decrypts it and reproduces the Encapsulated Response", () => {
    const { request, context } = decapsulateOhttpRequest([key], h(A.encapsulatedRequest));
    expect(x(request)).toBe(A.request);
    expect(decodeBhttpRequest(request)).toMatchObject({ method: "GET", scheme: "https", authority: "example.com", path: "/" });
    expect(x(encapsulateOhttpResponse(context, h(A.response), h(A.responseNonce)))).toBe(A.encapsulatedResponse);
  });

  it("the client decrypts the response", () => {
    const c = parseOhttpKeyConfig(h(A.keyConfig))!;
    const { context } = encapsulateOhttpRequest(c, h(A.request), h(A.ephemeralSecret));
    const res = decapsulateOhttpResponse(context, h(A.encapsulatedResponse));
    expect(x(res)).toBe(A.response);
    expect(decodeBhttpResponse(res).status).toBe(200);
  });
});

describe("OHTTP round trip and refusals", () => {
  const key = ohttpGatewayKey(7, new Uint8Array(32).fill(9));

  it("round-trips a POST with headers and a body", () => {
    const req = {
      method: "POST",
      scheme: "https",
      authority: "flagshipserver.com",
      path: "/api/server/register",
      headers: [["content-type", "application/json"]] as Array<[string, string]>,
      body: new TextEncoder().encode('{"a":1}'),
    };
    const { encapsulated, context } = encapsulateOhttpRequest(key, encodeBhttpRequest(req));
    const g = decapsulateOhttpRequest([key], encapsulated);
    expect(decodeBhttpRequest(g.request)).toEqual(req);
    const res = { status: 201, headers: [["content-type", "application/json"]] as Array<[string, string]>, body: new TextEncoder().encode('{"ok":true}') };
    const back = decapsulateOhttpResponse(context, encapsulateOhttpResponse(g.context, encodeBhttpResponse(res)));
    expect(decodeBhttpResponse(back)).toEqual(res);
  });

  it("publishes keys as application/ohttp-keys and reads them back", () => {
    const other = ohttpGatewayKey(8, new Uint8Array(32).fill(3));
    const keys = parseOhttpKeys(encodeOhttpKeys([key, other]));
    expect(keys.map((k) => k.keyId)).toEqual([7, 8]);
    expect(x(keys[1]!.publicKey)).toBe(x(other.publicKey));
    expect(encodeOhttpKeyConfig(key).length).toBe(41);
  });

  it("refuses an unknown key id, a tampered body, and garbage", () => {
    const { encapsulated } = encapsulateOhttpRequest(key, encodeBhttpRequest({ method: "GET", scheme: "https", authority: "a", path: "/", headers: [], body: new Uint8Array(0) }));
    const wrongId = Uint8Array.from(encapsulated);
    wrongId[0] = 9;
    expect(() => decapsulateOhttpRequest([key], wrongId)).toThrow(OhttpError);
    const tampered = Uint8Array.from(encapsulated);
    tampered[tampered.length - 1]! ^= 1;
    expect(() => decapsulateOhttpRequest([key], tampered)).toThrowError(/decrypt/);
    expect(() => decapsulateOhttpRequest([key], new Uint8Array(10))).toThrow(OhttpError);
    expect(() => decodeBhttpRequest(Uint8Array.of(0, 5))).toThrow(OhttpError);
  });
});
