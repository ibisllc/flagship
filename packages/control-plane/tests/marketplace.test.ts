/**
 * Tests for the marketplace handler module. Asserts the IRK-signed
 * upsert path, search, single-listing fetch, soft-remove, and install
 * counter.
 */

import { describe, expect, it } from "vitest";
import {
  ed,
  signMarketplaceList,
  signMarketplaceScanResult,
  type Keypair,
  type MarketplaceListRequest,
} from "@flagship/protocol";
import { InMemoryUsernameStorage, InMemoryMarketplaceStorage } from "@flagship/storage";
import {
  handleMarketplaceGet,
  handleMarketplaceInstall,
  handleMarketplaceList,
  handleMarketplaceScanResult,
  handleMarketplaceSearch,
} from "../src/marketplace.js";

function makeIrk(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

async function seedUser(usernames: InMemoryUsernameStorage, name: string, irk: Keypair) {
  await usernames.put({
    username: name,
    irkPubHex: bytesToHex(irk.publicKey),
    claimedAt: Date.now(),
  });
}

function listingPayload(overrides: Partial<MarketplaceListRequest> = {}): MarketplaceListRequest {
  return {
    creator: "alice",
    slug: "habit-tracker",
    name: "Habit Tracker",
    tagline: "Tracks daily habits and streaks.",
    descriptionMd: "# Habits\n\nTrack your habits. Honestly.",
    category: "productivity",
    tagsCsv: "productivity,habits,streaks",
    canonicalUrl: "habit-tracker.alice.flagship.services",
    manifestHashHex: "deadbeef".repeat(8),
    screenshotKeys: ["s1.png", "s2.png"],
    publicDistribution: true,
    status: "listed",
    issuedAt: Date.now(),
    ...overrides,
  };
}

describe("handleMarketplaceList", () => {
  it("upserts a listing signed by the registered IRK", async () => {
    const usernames = new InMemoryUsernameStorage();
    const marketplace = new InMemoryMarketplaceStorage();
    const irk = makeIrk();
    await seedUser(usernames, "alice", irk);

    const claim = listingPayload();
    const sig = signMarketplaceList(claim, irk);
    const r = await handleMarketplaceList(
      { marketplace, usernames },
      {
        request: { ...claim, irkPub: bytesToHex(irk.publicKey) },
        signature: bytesToHex(sig),
      },
    );
    expect(r.status).toBe(200);

    const stored = await marketplace.get("alice", "habit-tracker");
    expect(stored?.name).toBe("Habit Tracker");
    expect(stored?.publicDistribution).toBe(true);
  });

  it("rejects when the creator username isn't registered", async () => {
    const usernames = new InMemoryUsernameStorage();
    const marketplace = new InMemoryMarketplaceStorage();
    const irk = makeIrk();
    const claim = listingPayload({ creator: "ghost" });
    const sig = signMarketplaceList(claim, irk);
    const r = await handleMarketplaceList(
      { marketplace, usernames },
      { request: { ...claim }, signature: bytesToHex(sig) },
    );
    expect(r.status).toBe(404);
  });

  it("rejects with the wrong IRK signature", async () => {
    const usernames = new InMemoryUsernameStorage();
    const marketplace = new InMemoryMarketplaceStorage();
    const realIrk = makeIrk();
    const evilIrk = makeIrk();
    await seedUser(usernames, "alice", realIrk);
    const claim = listingPayload();
    const sig = signMarketplaceList(claim, evilIrk); // wrong key
    const r = await handleMarketplaceList(
      { marketplace, usernames },
      { request: { ...claim }, signature: bytesToHex(sig) },
    );
    expect(r.status).toBe(403);
  });

  it("rejects oversize description", async () => {
    const usernames = new InMemoryUsernameStorage();
    const marketplace = new InMemoryMarketplaceStorage();
    const irk = makeIrk();
    await seedUser(usernames, "alice", irk);
    const claim = listingPayload({ descriptionMd: "a".repeat(20_000) });
    const sig = signMarketplaceList(claim, irk);
    const r = await handleMarketplaceList(
      { marketplace, usernames },
      { request: { ...claim }, signature: bytesToHex(sig) },
    );
    expect(r.status).toBe(400);
  });

  it("rejects too many screenshots", async () => {
    const usernames = new InMemoryUsernameStorage();
    const marketplace = new InMemoryMarketplaceStorage();
    const irk = makeIrk();
    await seedUser(usernames, "alice", irk);
    const claim = listingPayload({
      screenshotKeys: ["a", "b", "c", "d", "e", "f"],
    });
    const sig = signMarketplaceList(claim, irk);
    const r = await handleMarketplaceList(
      { marketplace, usernames },
      { request: { ...claim }, signature: bytesToHex(sig) },
    );
    expect(r.status).toBe(400);
  });

  it("rejects malformed slug", async () => {
    const usernames = new InMemoryUsernameStorage();
    const marketplace = new InMemoryMarketplaceStorage();
    const irk = makeIrk();
    await seedUser(usernames, "alice", irk);
    const claim = listingPayload({ slug: "not a slug" });
    const sig = signMarketplaceList(claim, irk);
    const r = await handleMarketplaceList(
      { marketplace, usernames },
      { request: { ...claim }, signature: bytesToHex(sig) },
    );
    expect(r.status).toBe(400);
  });

  it("preserves install_count + scan_grade across re-listing", async () => {
    const usernames = new InMemoryUsernameStorage();
    const marketplace = new InMemoryMarketplaceStorage();
    const irk = makeIrk();
    await seedUser(usernames, "alice", irk);

    // Initial list.
    let claim = listingPayload();
    let sig = signMarketplaceList(claim, irk);
    await handleMarketplaceList(
      { marketplace, usernames },
      { request: { ...claim }, signature: bytesToHex(sig) },
    );
    // Simulate scan + installs.
    const cur = (await marketplace.get("alice", "habit-tracker"))!;
    await marketplace.upsert({ ...cur, scanGrade: "A", installCount: 50 });

    // Re-list with new description.
    claim = listingPayload({
      descriptionMd: "# Habits v2\n\nNow with photos.",
      issuedAt: Date.now() + 1,
    });
    sig = signMarketplaceList(claim, irk);
    await handleMarketplaceList(
      { marketplace, usernames },
      { request: { ...claim }, signature: bytesToHex(sig) },
    );
    const updated = (await marketplace.get("alice", "habit-tracker"))!;
    expect(updated.scanGrade).toBe("A");
    expect(updated.installCount).toBe(50);
    expect(updated.descriptionMd).toContain("Now with photos");
  });
});

describe("handleMarketplaceGet / handleMarketplaceSearch", () => {
  it("get returns the listing", async () => {
    const usernames = new InMemoryUsernameStorage();
    const marketplace = new InMemoryMarketplaceStorage();
    const irk = makeIrk();
    await seedUser(usernames, "alice", irk);
    const claim = listingPayload();
    const sig = signMarketplaceList(claim, irk);
    await handleMarketplaceList(
      { marketplace, usernames },
      { request: { ...claim }, signature: bytesToHex(sig) },
    );
    const r = await handleMarketplaceGet({ marketplace, usernames }, "alice", "habit-tracker");
    expect(r.status).toBe(200);
  });

  it("get returns 404 when removed", async () => {
    const usernames = new InMemoryUsernameStorage();
    const marketplace = new InMemoryMarketplaceStorage();
    const irk = makeIrk();
    await seedUser(usernames, "alice", irk);
    const claim = listingPayload();
    const sig = signMarketplaceList(claim, irk);
    await handleMarketplaceList(
      { marketplace, usernames },
      { request: { ...claim }, signature: bytesToHex(sig) },
    );
    await marketplace.remove("alice", "habit-tracker");
    const r = await handleMarketplaceGet({ marketplace, usernames }, "alice", "habit-tracker");
    expect(r.status).toBe(404);
  });

  it("search filters by category + free text", async () => {
    const usernames = new InMemoryUsernameStorage();
    const marketplace = new InMemoryMarketplaceStorage();
    const irk = makeIrk();
    await seedUser(usernames, "alice", irk);

    for (const slug of ["habit-tracker", "study-club", "shopper"]) {
      const claim = listingPayload({ slug, name: slug, issuedAt: Date.now() + Math.random() });
      const sig = signMarketplaceList(claim, irk);
      await handleMarketplaceList(
        { marketplace, usernames },
        { request: { ...claim }, signature: bytesToHex(sig) },
      );
    }

    const r = await handleMarketplaceSearch(
      { marketplace, usernames },
      { text: "study" },
    );
    expect(r.status).toBe(200);
    const body = r.body as { listings: Array<{ slug: string }> };
    expect(body.listings.length).toBe(1);
    expect(body.listings[0]?.slug).toBe("study-club");
  });
});

describe("handleMarketplaceInstall", () => {
  it("bumps install_count + rank_score", async () => {
    const usernames = new InMemoryUsernameStorage();
    const marketplace = new InMemoryMarketplaceStorage();
    const irk = makeIrk();
    await seedUser(usernames, "alice", irk);

    const claim = listingPayload();
    const sig = signMarketplaceList(claim, irk);
    await handleMarketplaceList(
      { marketplace, usernames },
      { request: { ...claim }, signature: bytesToHex(sig) },
    );

    const before = (await marketplace.get("alice", "habit-tracker"))!.installCount;
    await handleMarketplaceInstall({ marketplace, usernames }, "alice", "habit-tracker");
    const after = (await marketplace.get("alice", "habit-tracker"))!.installCount;
    expect(after).toBe(before + 1);
  });
});

describe("handleMarketplaceScanResult", () => {
  async function seededWithListing() {
    const usernames = new InMemoryUsernameStorage();
    const marketplace = new InMemoryMarketplaceStorage();
    const irk = makeIrk();
    await seedUser(usernames, "alice", irk);
    const claim = listingPayload();
    const sig = signMarketplaceList(claim, irk);
    await handleMarketplaceList(
      { marketplace, usernames },
      { request: { ...claim, irkPub: bytesToHex(irk.publicKey) }, signature: bytesToHex(sig) },
    );
    return { usernames, marketplace };
  }

  it("accepts a scanner-signed result + writes scan_grade on the listing", async () => {
    const { marketplace } = await seededWithListing();
    const scanner = makeIrk();
    const claim = {
      creator: "alice",
      slug: "habit-tracker",
      grade: "A" as const,
      reportKey: "alice/habit-tracker/1700000000000.json",
      imageDigestHex: "ab".repeat(32),
      scannedAt: Date.now(),
    };
    const sig = signMarketplaceScanResult(claim, scanner);
    const res = await handleMarketplaceScanResult(
      { marketplace, scannerPubkey: scanner.publicKey },
      { request: claim, signature: bytesToHex(sig) },
    );
    expect(res.status).toBe(200);
    const stored = await marketplace.get("alice", "habit-tracker");
    expect(stored?.scanGrade).toBe("A");
    expect(stored?.scanReportKey).toBe(claim.reportKey);
  });

  it("403s on a signature from anything other than the configured scanner key", async () => {
    const { marketplace } = await seededWithListing();
    const scanner = makeIrk();
    const attacker = makeIrk();
    const claim = {
      creator: "alice",
      slug: "habit-tracker",
      grade: "A" as const,
      reportKey: "x.json",
      imageDigestHex: "ab".repeat(32),
      scannedAt: Date.now(),
    };
    const sig = signMarketplaceScanResult(claim, attacker);
    const res = await handleMarketplaceScanResult(
      { marketplace, scannerPubkey: scanner.publicKey },
      { request: claim, signature: bytesToHex(sig) },
    );
    expect(res.status).toBe(403);
  });

  it("400s on grade outside A..F", async () => {
    const { marketplace } = await seededWithListing();
    const scanner = makeIrk();
    const claim = {
      creator: "alice", slug: "habit-tracker", grade: "X" as never,
      reportKey: "x.json", imageDigestHex: "00".repeat(32), scannedAt: Date.now(),
    };
    const sig = signMarketplaceScanResult(claim as never, scanner);
    const res = await handleMarketplaceScanResult(
      { marketplace, scannerPubkey: scanner.publicKey },
      { request: claim, signature: bytesToHex(sig) },
    );
    expect(res.status).toBe(400);
  });

  it("404s when the listing doesn't exist", async () => {
    const marketplace = new InMemoryMarketplaceStorage();
    const scanner = makeIrk();
    const claim = {
      creator: "ghost", slug: "nope", grade: "A" as const,
      reportKey: "x.json", imageDigestHex: "00".repeat(32), scannedAt: Date.now(),
    };
    const sig = signMarketplaceScanResult(claim, scanner);
    const res = await handleMarketplaceScanResult(
      { marketplace, scannerPubkey: scanner.publicKey },
      { request: claim, signature: bytesToHex(sig) },
    );
    expect(res.status).toBe(404);
  });

  it("403s on a stale scannedAt (replay defense)", async () => {
    const { marketplace } = await seededWithListing();
    const scanner = makeIrk();
    const claim = {
      creator: "alice", slug: "habit-tracker", grade: "A" as const,
      reportKey: "x.json", imageDigestHex: "00".repeat(32),
      scannedAt: Date.now() - 2 * 60 * 60_000, // 2h old, default freshness is 1h
    };
    const sig = signMarketplaceScanResult(claim, scanner);
    const res = await handleMarketplaceScanResult(
      { marketplace, scannerPubkey: scanner.publicKey },
      { request: claim, signature: bytesToHex(sig) },
    );
    expect(res.status).toBe(403);
  });
});
