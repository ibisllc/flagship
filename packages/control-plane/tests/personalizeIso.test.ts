import { describe, expect, it } from "vitest";
import { generateUMK, deriveIRK, signAuthCode, signInstallBlob } from "@flagship/protocol";
import { installBlobToJson, parseTrailer } from "@flagship/iso-personalizer";
import { buildPersonalizedIso, parseRecipeEnvelope } from "../src/personalizeIso.js";

function signedRecipe() {
  const irk = deriveIRK(generateUMK());
  const now = Date.now();
  const authCode = {
    version: 1 as const,
    serial: "CPSERIAL0001",
    username: "alice",
    serverName: "home",
    serverDomain: "home.alice.flagship.services",
    delegatedPubKey: irk.publicKey,
    userPubKey: irk.publicKey,
    issuedAt: now,
    expiresAt: now + 3_600_000,
  };
  const blob = {
    version: 2 as const,
    serverDomain: authCode.serverDomain,
    username: authCode.username,
    serverName: authCode.serverName,
    phoneDelegatedPubKey: irk.publicKey,
    registrationUrl: "https://flagshipserver.com",
    authCode,
    authCodeUserSignature: signAuthCode(authCode, irk),
    installerGitRef: "main",
    rckPubKey: irk.publicKey,
  };
  const sig = signInstallBlob(blob, irk);
  return { blob, sig, json: installBlobToJson(blob) };
}

// A minimal base ISO (the content is opaque to streamPersonalize; size is what
// matters for the trailer append + Content-Length).
function baseIso(bytes = 4096): { stream: ReadableStream<Uint8Array>; size: number; buf: Uint8Array } {
  const buf = new Uint8Array(bytes).fill(0x5a);
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(buf);
      c.close();
    },
  });
  return { stream, size: bytes, buf };
}

describe("parseRecipeEnvelope — accepts every shape the burner/webapp emit", () => {
  it("flat InstallBlobJson + blobSignatureHex (the webapp/burner recipe)", () => {
    const { sig, json } = signedRecipe();
    const text = JSON.stringify({ ...json, blobSignatureHex: Buffer.from(sig).toString("hex") });
    const r = parseRecipeEnvelope(text);
    expect("blob" in r).toBe(true);
  });

  it("{ blob, blobSignature } envelope", () => {
    const { sig, json } = signedRecipe();
    const text = JSON.stringify({ blob: json, blobSignature: Buffer.from(sig).toString("hex") });
    const r = parseRecipeEnvelope(text);
    expect("blob" in r).toBe(true);
  });

  it("rejects bad JSON / missing sig / short sig", () => {
    expect("error" in parseRecipeEnvelope("not json")).toBe(true);
    const { json } = signedRecipe();
    expect("error" in parseRecipeEnvelope(JSON.stringify(json))).toBe(true); // no sig
    expect("error" in parseRecipeEnvelope(JSON.stringify({ ...json, blobSignatureHex: "ab" }))).toBe(true);
  });
});

describe("buildPersonalizedIso — streams base + appended recipe trailer", () => {
  it("appends a trailer that parses back to the same blob+sig (round-trip)", async () => {
    const { blob, sig, json } = signedRecipe();
    const base = baseIso(8192);
    const text = JSON.stringify({ ...json, blobSignatureHex: Buffer.from(sig).toString("hex") });
    const res = buildPersonalizedIso(text, { size: base.size });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.filename).toBe("flagship-home.alice.flagship.services.iso");

    // The Worker streams the base bytes verbatim, then appends res.trailerBytes.
    // Reconstruct that to verify the trailer round-trips.
    const personalized = new Uint8Array(base.size + res.trailerBytes.length);
    personalized.set(base.buf, 0);
    personalized.set(res.trailerBytes, base.size);
    expect(personalized.length).toBe(res.totalBytes);
    expect(res.totalBytes).toBeGreaterThan(base.size);
    expect(personalized.slice(0, base.size)).toEqual(base.buf);

    // parseTrailer (the same code the box mirrors) recovers a valid recipe.
    const parsed = parseTrailer(personalized);
    expect(parsed.signatureValid).toBe(true);
    expect(installBlobToJson(parsed.blob)).toEqual(json);
    expect(Buffer.from(parsed.signature).equals(Buffer.from(sig))).toBe(true);
  });

  it("fail-closed: rejects a tampered recipe with HTTP 400 (no ISO streamed)", async () => {
    const { sig, json } = signedRecipe();
    const tampered = { ...json, installerGitRef: "evil", blobSignatureHex: Buffer.from(sig).toString("hex") };
    const base = baseIso();
    const res = buildPersonalizedIso(JSON.stringify(tampered), { size: base.size });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    expect(res.error).toMatch(/does not verify/);
  });

  it("rejects a malformed envelope with HTTP 400", () => {
    const base = baseIso();
    const res = buildPersonalizedIso("{}", { size: base.size });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
  });
});
