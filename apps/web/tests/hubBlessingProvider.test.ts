import { describe, expect, it, vi } from "vitest";
import { ed, signServiceBlessing, type ServiceBlessing } from "@flagship/protocol";
import {
  HubBlessingProvider,
  loadOrCreateHubKeypair,
} from "../src/tunnel/hubBlessingProvider.js";

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

const CA_PRIV = new Uint8Array(32).fill(0xca);
const CA_KP = { privateKey: CA_PRIV, publicKey: ed.getPublicKey(CA_PRIV) };

function mintBlessing(hubKeyPub: string): ServiceBlessing {
  return signServiceBlessing(
    {
      hubKeyPub,
      hubHost: "flagship.services",
      nonce: "n",
      issuedAt: 1000,
      expiresAt: 1000 + 26 * 60 * 60_000,
    },
    CA_KP,
  );
}

describe("loadOrCreateHubKeypair", () => {
  it("generates a valid Ed25519 keypair when no path given", () => {
    const kp = loadOrCreateHubKeypair();
    expect(kp.privateKey.length).toBe(32);
    expect(kp.publicKey.length).toBe(32);
    expect(bytesToHex(ed.getPublicKey(kp.privateKey))).toBe(bytesToHex(kp.publicKey));
  });
});

describe("HubBlessingProvider", () => {
  it("fetches a blessing from .com and holds it; signs box nonces", async () => {
    const kp = loadOrCreateHubKeypair();
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { hubKeyPub: string };
      const blessing = mintBlessing(body.hubKeyPub);
      return new Response(JSON.stringify({ blessing }), { status: 200 });
    });
    const provider = new HubBlessingProvider({
      keypair: kp,
      hubHost: "flagship.services",
      comBaseUrl: "https://flagshipserver.com/",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: () => {},
    });
    expect(provider.currentBlessing()).toBeNull();
    const b = await provider.refresh();
    expect(b).not.toBeNull();
    expect(b!.hubKeyPub).toBe(provider.hubKeyPubHex());
    expect(provider.currentBlessing()).toBe(b);
    // POST to the right URL (trailing slash normalized).
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      "https://flagshipserver.com/api/services/hub-blessing",
    );

    // hubSig verifies against the hub key over a nonce.
    const nonce = new Uint8Array(32).fill(7);
    const sigHex = provider.signNonce(nonce);
    const sig = new Uint8Array(sigHex.length / 2);
    for (let i = 0; i < sig.length; i++) sig[i] = parseInt(sigHex.slice(i * 2, i * 2 + 2), 16);
    expect(ed.verify(sig, nonce, kp.publicKey)).toBe(true);
  });

  it("keeps the prior blessing on a .com error (fail-open / OBSERVE-safe)", async () => {
    const kp = loadOrCreateHubKeypair();
    let call = 0;
    const fetchImpl = vi.fn(async (_url, init?: RequestInit) => {
      call += 1;
      if (call === 1) {
        const body = JSON.parse(String(init?.body)) as { hubKeyPub: string };
        return new Response(JSON.stringify({ blessing: mintBlessing(body.hubKeyPub) }), {
          status: 200,
        });
      }
      throw new Error("network down");
    });
    const provider = new HubBlessingProvider({
      keypair: kp,
      hubHost: "flagship.services",
      comBaseUrl: "https://flagshipserver.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: () => {},
    });
    const first = await provider.refresh();
    expect(first).not.toBeNull();
    const second = await provider.refresh();
    expect(second).toBe(first); // kept prior
  });

  it("rejects a blessing whose hubKeyPub does not match (no swap)", async () => {
    const kp = loadOrCreateHubKeypair();
    const fetchImpl = vi.fn(async () => {
      // blessing for a DIFFERENT key
      const other = mintBlessing("ab".repeat(32));
      return new Response(JSON.stringify({ blessing: other }), { status: 200 });
    });
    const provider = new HubBlessingProvider({
      keypair: kp,
      hubHost: "flagship.services",
      comBaseUrl: "https://flagshipserver.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: () => {},
    });
    const b = await provider.refresh();
    expect(b).toBeNull();
    expect(provider.currentBlessing()).toBeNull();
  });

  it("start() fetches immediately and arms the refresh timer", async () => {
    const kp = loadOrCreateHubKeypair();
    const fetchImpl = vi.fn(async (_url, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { hubKeyPub: string };
      return new Response(JSON.stringify({ blessing: mintBlessing(body.hubKeyPub) }), {
        status: 200,
      });
    });
    let armed: { cb: () => void; ms: number } | null = null;
    const setIntervalImpl = ((cb: () => void, ms: number) => {
      armed = { cb, ms };
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;
    const clearIntervalImpl = vi.fn() as unknown as typeof clearInterval;
    const provider = new HubBlessingProvider({
      keypair: kp,
      hubHost: "flagship.services",
      comBaseUrl: "https://flagshipserver.com",
      refreshIntervalMs: 12 * 60 * 60_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      setIntervalImpl,
      clearIntervalImpl,
      log: () => {},
    });
    await provider.start();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(provider.currentBlessing()).not.toBeNull();
    expect(armed).not.toBeNull();
    expect(armed!.ms).toBe(12 * 60 * 60_000);
    // tick fires a refresh
    armed!.cb();
    await Promise.resolve();
    provider.stop();
    expect(clearIntervalImpl).toHaveBeenCalled();
  });
});
