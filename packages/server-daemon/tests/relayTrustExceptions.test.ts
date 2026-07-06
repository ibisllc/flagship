/**
 * makeRelayTrustExceptionResolver — the box-side resolver that feeds
 * RelayLockdownController.resolveTrustExceptions. It fetches the owner
 * exception directory from `.com` and anchors the roster at the provisioned
 * owner IRK (the ONLY roster the box trusts).
 */
import { describe, expect, it } from "vitest";
import { ed, relayCertHash, signTrustException, type Keypair } from "@flagship/protocol";
import { makeRelayTrustExceptionResolver } from "../src/relayTrustExceptions.js";

function ownerKey(seed: number): Keypair {
  const b = new Uint8Array(32).fill(seed);
  return { privateKey: b, publicKey: ed.getPublicKey(b) };
}
function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

const HUB = "cd".repeat(32);
const CERT_HASH = relayCertHash(HUB);

describe("makeRelayTrustExceptionResolver", () => {
  it("anchors allowedDevicePubs at the provisioned owner IRK", async () => {
    const owner = ownerKey(4);
    const resolve = makeRelayTrustExceptionResolver({
      username: "alice",
      ownerIrkPub: owner.publicKey,
      controlPlaneBaseUrl: "https://flagshipserver.com",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ exceptions: [] }), { status: 200 })) as any,
    });
    const { allowedDevicePubs } = await resolve(CERT_HASH);
    expect(allowedDevicePubs).toEqual([hex(owner.publicKey)]);
  });

  it("returns the owner exceptions from the directory, verifiable by the controller", async () => {
    const owner = ownerKey(4);
    const exc = signTrustException(
      { certClass: "relay", certHash: CERT_HASH, grantedAt: 1000 },
      owner,
    );
    let requestedUrl = "";
    const resolve = makeRelayTrustExceptionResolver({
      username: "al ice/needs+encoding",
      ownerIrkPub: owner.publicKey,
      controlPlaneBaseUrl: "https://flagshipserver.com/",
      fetchImpl: (async (url: any) => {
        requestedUrl = String(url);
        return new Response(JSON.stringify({ exceptions: [exc] }), { status: 200 });
      }) as any,
    });
    const { exceptions } = await resolve(CERT_HASH);
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]!.certHash).toBe(CERT_HASH);
    // Username is URL-encoded into the directory path.
    expect(requestedUrl).toBe(
      "https://flagshipserver.com/api/users/al%20ice%2Fneeds%2Bencoding/trust-exceptions",
    );
  });

  it("treats a non-2xx directory response as no exceptions (fail-closed for coverage)", async () => {
    const owner = ownerKey(4);
    const resolve = makeRelayTrustExceptionResolver({
      username: "alice",
      ownerIrkPub: owner.publicKey,
      controlPlaneBaseUrl: "https://flagshipserver.com",
      fetchImpl: (async () => new Response("nope", { status: 503 })) as any,
    });
    const { exceptions } = await resolve(CERT_HASH);
    expect(exceptions).toEqual([]);
  });

  it("never throws on a network error (returns empty)", async () => {
    const owner = ownerKey(4);
    const resolve = makeRelayTrustExceptionResolver({
      username: "alice",
      ownerIrkPub: owner.publicKey,
      controlPlaneBaseUrl: "https://flagshipserver.com",
      fetchImpl: (async () => {
        throw new Error("dns down");
      }) as any,
    });
    const { exceptions, allowedDevicePubs } = await resolve(CERT_HASH);
    expect(exceptions).toEqual([]);
    expect(allowedDevicePubs).toEqual([hex(owner.publicKey)]);
  });

  it("filters non-TrustException garbage from the directory", async () => {
    const owner = ownerKey(4);
    const resolve = makeRelayTrustExceptionResolver({
      username: "alice",
      ownerIrkPub: owner.publicKey,
      controlPlaneBaseUrl: "https://flagshipserver.com",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ exceptions: [{ kind: "not-a-trust-exc" }, null, 42] }),
          { status: 200 },
        )) as any,
    });
    const { exceptions } = await resolve(CERT_HASH);
    expect(exceptions).toEqual([]);
  });
});
