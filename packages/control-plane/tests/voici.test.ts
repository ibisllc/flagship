import { describe, expect, it } from "vitest";
import {
  ed,
  signVoiciShorten,
  type Keypair,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  handleVoiciRedirect,
  handleVoiciShorten,
  mintShortLink,
} from "../src/voici.js";

const USER = "alice";

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

async function seed(s: InMemoryStorage, irk: Keypair) {
  await s.usernames.put({
    username: USER,
    irkPubHex: bytesToHex(irk.publicKey),
    claimedAt: 1,
  });
}

describe("mintShortLink (internal)", () => {
  it("returns a 6-char lowercase base36 code by default", async () => {
    const s = new InMemoryStorage();
    const r = await mintShortLink(
      { usernames: s.usernames, voiciLinks: s.voiciLinks, now: () => 1000 },
      { username: USER, targetUrl: "https://example.com/page" },
    );
    expect("error" in r).toBe(false);
    if ("code" in r) {
      expect(r.code).toMatch(/^[a-z0-9]{6}$/);
      expect(r.shortUrl).toBe(`https://voi.ci/${r.code}`);
    }
  });

  it("rejects non-https targets (no javascript: smuggling)", async () => {
    const s = new InMemoryStorage();
    const r = await mintShortLink(
      { usernames: s.usernames, voiciLinks: s.voiciLinks },
      { username: USER, targetUrl: "javascript:alert(1)" },
    );
    expect("error" in r).toBe(true);
  });

  it("rejects malformed usernames", async () => {
    const s = new InMemoryStorage();
    const r = await mintShortLink(
      { usernames: s.usernames, voiciLinks: s.voiciLinks },
      { username: "BAD..NAME", targetUrl: "https://example.com/" },
    );
    expect("error" in r).toBe(true);
  });

  it("respects deps.shortHost when formatting the returned URL", async () => {
    const s = new InMemoryStorage();
    const r = await mintShortLink(
      { usernames: s.usernames, voiciLinks: s.voiciLinks, shortHost: "staging.voi.ci" },
      { username: USER, targetUrl: "https://example.com/" },
    );
    if ("code" in r) {
      expect(r.shortUrl).toBe(`https://staging.voi.ci/${r.code}`);
    }
  });

  it("respects deps.codeLength", async () => {
    const s = new InMemoryStorage();
    const r = await mintShortLink(
      { usernames: s.usernames, voiciLinks: s.voiciLinks, codeLength: 8 },
      { username: USER, targetUrl: "https://example.com/" },
    );
    if ("code" in r) {
      expect(r.code).toMatch(/^[a-z0-9]{8}$/);
    }
  });
});

describe("handleVoiciRedirect (hostname route)", () => {
  it("302s with the target URL on a hit", async () => {
    const s = new InMemoryStorage();
    await s.voiciLinks.insert({
      code: "abc123",
      username: USER,
      targetUrl: "https://example.com/landing",
      createdAt: 1,
    });
    const res = await handleVoiciRedirect(
      { usernames: s.usernames, voiciLinks: s.voiciLinks, now: () => 1000 },
      "abc123",
    );
    expect(res.status).toBe(302);
    expect(res.headers?.location).toBe("https://example.com/landing");
  });

  it("404s on miss", async () => {
    const s = new InMemoryStorage();
    const res = await handleVoiciRedirect(
      { usernames: s.usernames, voiciLinks: s.voiciLinks },
      "nope42",
    );
    expect(res.status).toBe(404);
  });

  it("410s on expired (the rotated-link case)", async () => {
    const s = new InMemoryStorage();
    await s.voiciLinks.insert({
      code: "stale1",
      username: USER,
      targetUrl: "https://example.com/",
      createdAt: 1,
      expiresAt: 100,
    });
    const res = await handleVoiciRedirect(
      { usernames: s.usernames, voiciLinks: s.voiciLinks, now: () => 500 },
      "stale1",
    );
    expect(res.status).toBe(410);
  });

  it("404s on malformed codes (no path traversal)", async () => {
    const s = new InMemoryStorage();
    const res = await handleVoiciRedirect(
      { usernames: s.usernames, voiciLinks: s.voiciLinks },
      "../../etc/passwd",
    );
    expect(res.status).toBe(404);
  });
});

describe("handleVoiciShorten (phone-signed API)", () => {
  function signedBody(args: {
    irk: Keypair;
    username?: string;
    serviceId?: string;
    targetUrl?: string;
    issuedAt?: number;
  }) {
    const issuedAt = args.issuedAt ?? Date.now();
    const targetUrl = args.targetUrl ?? "https://app.example.com/page";
    const username = args.username ?? USER;
    const sig = signVoiciShorten(
      {
        username,
        ...(args.serviceId ? { serviceId: args.serviceId } : {}),
        targetUrl,
        issuedAt,
      },
      args.irk,
    );
    return {
      request: {
        username,
        ...(args.serviceId ? { serviceId: args.serviceId } : {}),
        targetUrl,
        issuedAt,
      },
      signature: bytesToHex(sig),
    };
  }

  it("mints a code for an IRK-signed request", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    await seed(s, irk);
    const res = await handleVoiciShorten(
      { usernames: s.usernames, voiciLinks: s.voiciLinks },
      signedBody({ irk }),
    );
    expect(res.status).toBe(200);
    const b = res.body as { ok: boolean; code: string; shortUrl: string };
    expect(b.ok).toBe(true);
    expect(b.code).toMatch(/^[a-z0-9]{6}$/);
    expect(b.shortUrl).toBe(`https://voi.ci/${b.code}`);
  });

  it("403s on invalid signature", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    await seed(s, irk);
    const other = makeKey();
    const res = await handleVoiciShorten(
      { usernames: s.usernames, voiciLinks: s.voiciLinks },
      signedBody({ irk: other }),
    );
    expect(res.status).toBe(403);
  });

  it("403s on stale request", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    await seed(s, irk);
    const res = await handleVoiciShorten(
      { usernames: s.usernames, voiciLinks: s.voiciLinks },
      signedBody({ irk, issuedAt: Date.now() - 10 * 60_000 }),
    );
    expect(res.status).toBe(403);
  });

  it("400s on non-https targetUrl", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    await seed(s, irk);
    const res = await handleVoiciShorten(
      { usernames: s.usernames, voiciLinks: s.voiciLinks },
      signedBody({ irk, targetUrl: "http://example.com/" }),
    );
    expect(res.status).toBe(400);
  });

  it("404s on unknown username", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    const res = await handleVoiciShorten(
      { usernames: s.usernames, voiciLinks: s.voiciLinks },
      signedBody({ irk }),
    );
    expect(res.status).toBe(404);
  });
});
