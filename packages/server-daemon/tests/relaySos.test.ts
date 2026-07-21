/**
 * sendRelayTrustAlert — the real STK-signed `flagship/push-relay/v1` SOS that
 * replaces the log-only owner-notify hook. It signs the push-relay canonical
 * bytes with the box STK and POSTs to `.com/api/push/relay`, category
 * "cert-alert".
 */
import { describe, expect, it } from "vitest";
import {
  canonicalPushRelayRequest,
  ed,
  verifyPushRelayRequest,
  type Keypair,
} from "@flagship/protocol";
import { sendRelayTrustAlert } from "../src/relaySos.js";
import type { BoxSigner } from "../src/keyCustodian.js";

function boxSigner(seed: number): { signer: BoxSigner; keypair: Keypair } {
  const priv = new Uint8Array(32).fill(seed);
  const keypair: Keypair = { privateKey: priv, publicKey: ed.getPublicKey(priv) };
  const signer: BoxSigner = {
    boxPublicKey: () => keypair.publicKey,
    signAsBox: (msg) => ed.sign(msg, priv),
  };
  return { signer, keypair };
}

describe("sendRelayTrustAlert", () => {
  it("POSTs an STK-signed cert-alert that verifies over the push-relay canonical bytes", async () => {
    const { signer, keypair } = boxSigner(5);
    let captured: any = null;
    const fetchImpl = (async (url: any, init: any) => {
      captured = { url: String(url), body: JSON.parse(init.body) };
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const okSent = await sendRelayTrustAlert({
      targetUsername: "alice",
      signer,
      controlPlaneBaseUrl: "https://flagshipserver.com/",
      now: () => 1_700_000_000_000,
      fetchImpl,
    });

    expect(okSent).toBe(true);
    expect(captured.url).toBe("https://flagshipserver.com/api/push/relay");
    expect(captured.body.request.category).toBe("cert-alert");
    expect(captured.body.request.targetUsername).toBe("alice");
    expect(captured.body.request.sealedPayloadHex).toBe("00".repeat(32));

    const request = captured.body.request;
    const sigBytes = new Uint8Array(
      captured.body.signature.match(/../g).map((h: string) => parseInt(h, 16)),
    );
    expect(verifyPushRelayRequest(request, sigBytes, keypair.publicKey)).toBe(true);
    // Sanity: it signed the EXACT canonical bytes .com verifies.
    expect(
      ed.verify(sigBytes, canonicalPushRelayRequest(request), keypair.publicKey),
    ).toBe(true);
  });

  it("uses a caller-supplied sealed payload when given", async () => {
    const { signer } = boxSigner(6);
    let body: any = null;
    const fetchImpl = (async (_url: any, init: any) => {
      body = JSON.parse(init.body);
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    await sendRelayTrustAlert({
      targetUsername: "bob",
      signer,
      controlPlaneBaseUrl: "https://flagshipserver.com",
      sealedPayloadHex: "beef".repeat(4),
      fetchImpl,
    });
    expect(body.request.sealedPayloadHex).toBe("beef".repeat(4));
  });

  it("returns false on a non-2xx and never throws on a network error", async () => {
    const { signer } = boxSigner(7);
    const notOk = await sendRelayTrustAlert({
      targetUsername: "carol",
      signer,
      controlPlaneBaseUrl: "https://flagshipserver.com",
      fetchImpl: (async () => new Response("no", { status: 403 })) as any,
    });
    expect(notOk).toBe(false);

    const threw = await sendRelayTrustAlert({
      targetUsername: "carol",
      signer,
      controlPlaneBaseUrl: "https://flagshipserver.com",
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as any,
    });
    expect(threw).toBe(false);
  });
});
