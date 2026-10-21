import { describe, expect, it } from "vitest";
import { deriveIRK, ed, verifyNameDibsInitiate, verifyNameDibsVerify } from "@flagship/protocol";
import {
  fetchDibsWindow,
  shouldShowDibsBanner,
  startDibsClaim,
  verifyDibsClaim,
} from "../public/webapp/lib/nameDibs.js";

const irk = deriveIRK({ seed: new Uint8Array(32).fill(9) });
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));
const signWithIrk = async (_umk: Uint8Array, bytes: Uint8Array) => ed.sign(bytes, irk.privateKey);

function capture(response: unknown, status = 200) {
  const calls: Array<{ url: string; body: any }> = [];
  const fetch = async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    return { ok: status < 400, status, json: async () => response };
  };
  return { calls, fetch };
}

describe("webapp name dibs", () => {
  it("startDibsClaim posts an IRK-signed initiate the server's verifier accepts", async () => {
    const { calls, fetch } = capture({ nonce: "ab".repeat(32), record: "flagship-claim:x" });
    await startDibsClaim(
      { username: "Fresh-Poppy", name: " Acme ", umk: new Uint8Array(32), irkPubHex: hex(irk.publicKey), signWithIrk },
      { fetch, origin: "https://flagshipserver.com", now: () => 1000 },
    );
    expect(calls[0]!.url).toBe("https://flagshipserver.com/api/name-dibs/initiate");
    const { request, signature } = calls[0]!.body;
    expect(request).toEqual({ username: "fresh-poppy", name: "acme", irkPubHex: hex(irk.publicKey), issuedAt: 1000 });
    expect(verifyNameDibsInitiate(request, fromHex(signature), irk.publicKey)).toBe(true);
  });

  it("verifyDibsClaim posts an IRK-signed verify bound to the nonce", async () => {
    const { calls, fetch } = capture({ verified: true, method: "dns" });
    const r = await verifyDibsClaim(
      { username: "fresh-poppy", name: "acme", nonce: "CD".repeat(32), umk: new Uint8Array(32), signWithIrk },
      { fetch, origin: "https://flagshipserver.com", now: () => 2000 },
    );
    expect(r).toEqual({ verified: true, method: "dns" });
    const { request, signature } = calls[0]!.body;
    expect(request.nonce).toBe("cd".repeat(32));
    expect(verifyNameDibsVerify(request, fromHex(signature), irk.publicKey)).toBe(true);
  });

  it("surfaces the server's refusal message", async () => {
    const { fetch } = capture({ error: "no proof found yet" }, 409);
    await expect(
      verifyDibsClaim(
        { username: "a", name: "acme", nonce: "00".repeat(32), umk: new Uint8Array(32), signWithIrk },
        { fetch, origin: "https://x" },
      ),
    ).rejects.toThrow("no proof found yet");
  });

  it("fetchDibsWindow reads the public window", async () => {
    const { calls, fetch } = capture({ open: true, end: 5 });
    expect(await fetchDibsWindow({ fetch, origin: "https://flagshipserver.com" })).toEqual({ open: true, end: 5 });
    expect(calls[0]!.url).toBe("https://flagshipserver.com/api/name-dibs/window");
  });

  it("the Home notice shows only while the window is open and not dismissed", () => {
    expect(shouldShowDibsBanner({ window: { open: true }, dismissed: null })).toBe(true);
    expect(shouldShowDibsBanner({ window: { open: true }, dismissed: "true" })).toBe(false);
    expect(shouldShowDibsBanner({ window: { open: false }, dismissed: null })).toBe(false);
    expect(shouldShowDibsBanner({ window: null, dismissed: null } as never)).toBe(false);
  });
});
