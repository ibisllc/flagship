/**
 * Box-side transfer-a-box re-home consumer
 * (docs/account-deletion-and-name-reclaim.md §4, Layer A).
 *
 * The daemon polls `.com`'s PUBLIC re-home read; when a completed transfer is
 * reported it persists a marker recording the NEW canonical FQDN + the
 * acquirer's owner-IRK pub. The boot path applies the marker (overriding the
 * canonical + owner IRK) on the next restart. These tests cover:
 *   - 404 (never transferred) → no marker, no-op;
 *   - a completed transfer → marker written with the new canonical + acquirer
 *     IRK; the poller stops after writing it;
 *   - "already current" idempotency (the new domain == our live domain) → no
 *     marker;
 *   - malformed / non-rehomed responses → ignored, no marker;
 *   - readRehomeMarker round-trip + rejection of a bad marker.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ed,
  signAdminRootTransfer,
  type AdminRootTransfer,
  type Keypair,
} from "@flagship/protocol";
import {
  buildRehomePoller,
  checkAndRecordRehome,
  readRehomeMarker,
  reconcileAdminRootPinOnRehome,
  rehomeAdminRootOverride,
  type RehomeMarker,
} from "../src/transferRehomeConsumer.js";

const ACQUIRER_IRK = "a".repeat(64);
const OLD = "home.alice.flagship.services";
const NEW = "home.bob.flagship.services";
const CTRL = "https://flagshipserver.com";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("transferRehomeConsumer", () => {
  let dir: string;
  let markerPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rehome-"));
    markerPath = join(dir, "transfer-rehome.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("does nothing on a 404 (box was never transferred)", async () => {
    const fetchImpl = (async () => jsonResponse(404, { error: "no completed transfer" })) as typeof fetch;
    const out = await checkAndRecordRehome({
      serverDomain: OLD,
      controlPlaneBaseUrl: CTRL,
      markerPath,
      fetchImpl,
    });
    expect(out).toEqual({ rehomed: false, reason: "no-transfer" });
    expect(await readRehomeMarker(markerPath)).toBeNull();
  });

  it("writes a marker on a completed transfer (new canonical + acquirer IRK)", async () => {
    let calledUrl = "";
    const fetchImpl = (async (url: string) => {
      calledUrl = url;
      return jsonResponse(200, {
        rehomed: true,
        serverDomain: OLD,
        newServerDomain: NEW,
        acquirerUsername: "bob",
        acquirerIrkPub: ACQUIRER_IRK,
        claimedAt: 1234,
      });
    }) as unknown as typeof fetch;

    const out = await checkAndRecordRehome({
      serverDomain: OLD,
      controlPlaneBaseUrl: CTRL,
      markerPath,
      fetchImpl,
    });
    expect(calledUrl).toBe(`${CTRL}/api/server/${encodeURIComponent(OLD)}/transfer/rehome`);
    expect(out.rehomed).toBe(true);

    const marker = await readRehomeMarker(markerPath);
    expect(marker).toEqual({
      newServerDomain: NEW,
      acquirerUsername: "bob",
      acquirerIrkPubHex: ACQUIRER_IRK,
      oldServerDomain: OLD,
      claimedAt: 1234,
    });
  });

  it("treats a new domain equal to the current domain as already-current (no marker)", async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, {
        rehomed: true,
        newServerDomain: OLD, // already serving this
        acquirerUsername: "alice",
        acquirerIrkPub: ACQUIRER_IRK,
        claimedAt: 1,
      })) as unknown as typeof fetch;
    const out = await checkAndRecordRehome({
      serverDomain: OLD,
      controlPlaneBaseUrl: CTRL,
      markerPath,
      fetchImpl,
    });
    expect(out).toEqual({ rehomed: false, reason: "already-current" });
    expect(await readRehomeMarker(markerPath)).toBeNull();
  });

  it("ignores a malformed / non-rehomed response without writing a marker", async () => {
    for (const body of [
      { rehomed: false },
      { rehomed: true, newServerDomain: NEW }, // missing acquirer fields
      { rehomed: true, newServerDomain: NEW, acquirerUsername: "bob", acquirerIrkPub: "zz" },
    ]) {
      const fetchImpl = (async () => jsonResponse(200, body)) as unknown as typeof fetch;
      const out = await checkAndRecordRehome({
        serverDomain: OLD,
        controlPlaneBaseUrl: CTRL,
        markerPath,
        fetchImpl,
      });
      expect(out.rehomed).toBe(false);
      expect(await readRehomeMarker(markerPath)).toBeNull();
    }
  });

  it("returns error (no throw) on a network failure", async () => {
    const fetchImpl = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const out = await checkAndRecordRehome({
      serverDomain: OLD,
      controlPlaneBaseUrl: CTRL,
      markerPath,
      fetchImpl,
    });
    expect(out).toEqual({ rehomed: false, reason: "error" });
  });

  it("readRehomeMarker rejects a malformed marker file", async () => {
    await writeFile(markerPath, JSON.stringify({ newServerDomain: 123 }));
    expect(await readRehomeMarker(markerPath)).toBeNull();
    await writeFile(markerPath, "not json");
    expect(await readRehomeMarker(markerPath)).toBeNull();
  });

  it("poller stops itself after recording a re-home", async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, {
        rehomed: true,
        newServerDomain: NEW,
        acquirerUsername: "bob",
        acquirerIrkPub: ACQUIRER_IRK,
        claimedAt: 9,
      })) as unknown as typeof fetch;
    const poller = buildRehomePoller({
      serverDomain: OLD,
      controlPlaneBaseUrl: CTRL,
      markerPath,
      fetchImpl,
    });
    const out = await poller.pollOnce();
    expect(out.rehomed).toBe(true);
    expect(JSON.parse(await readFile(markerPath, "utf-8")).newServerDomain).toBe(NEW);
    poller.stop();
  });

  // ── Slice D §9.8: admin-root handoff gate ────────────────────────────────
  describe("admin-root handoff gate (pinned box)", () => {
    function makeKey(fill: number): Keypair {
      const seed = new Uint8Array(32).fill(fill);
      return { privateKey: seed, publicKey: ed.getPublicKey(seed) };
    }
    function hex(b: Uint8Array): string {
      let s = "";
      for (const x of b) s += x.toString(16).padStart(2, "0");
      return s;
    }
    const giverRoot = makeKey(0x21);
    const acquirerRoot = makeKey(0x42);
    const PINNED = hex(giverRoot.publicKey);
    const NEW_ROOT = hex(acquirerRoot.publicKey);
    const NONCE = "cd".repeat(32);

    function signedHandoff(overrides?: Partial<AdminRootTransfer> & { signer?: Keypair }) {
      const t: AdminRootTransfer = {
        serverDomain: OLD,
        giverUsername: "alice",
        acquirerUsername: "bob",
        oldAdminRootPubHex: PINNED,
        newAdminRootPubHex: NEW_ROOT,
        transferNonce: NONCE,
        issuedAt: 1234,
        ...overrides,
      };
      const sig = signAdminRootTransfer(t, overrides?.signer ?? giverRoot);
      return {
        giverUsername: t.giverUsername,
        acquirerUsername: t.acquirerUsername,
        oldAdminRootPub: t.oldAdminRootPubHex,
        newAdminRootPub: t.newAdminRootPubHex,
        transferNonce: t.transferNonce,
        issuedAt: t.issuedAt,
        signatureHex: hex(sig),
      };
    }

    function rehomeBody(adminHandoff?: unknown) {
      return {
        rehomed: true,
        serverDomain: OLD,
        newServerDomain: NEW,
        acquirerUsername: "bob",
        acquirerIrkPub: ACQUIRER_IRK,
        claimedAt: 1234,
        ...(adminHandoff !== undefined ? { adminHandoff } : {}),
      };
    }

    async function check(body: unknown, pinned: string | null = PINNED) {
      const fetchImpl = (async () => jsonResponse(200, body)) as unknown as typeof fetch;
      return checkAndRecordRehome({
        serverDomain: OLD,
        controlPlaneBaseUrl: CTRL,
        markerPath,
        pinnedAdminRootPubHex: pinned,
        fetchImpl,
      });
    }

    it("UNPINNED box (no opt) is byte-identical legacy — marker has NO admin field", async () => {
      const out = await check(rehomeBody(signedHandoff()), null);
      expect(out.rehomed).toBe(true);
      const raw = JSON.parse(await readFile(markerPath, "utf-8"));
      expect(raw).toEqual({
        newServerDomain: NEW,
        acquirerUsername: "bob",
        acquirerIrkPubHex: ACQUIRER_IRK,
        oldServerDomain: OLD,
        claimedAt: 1234,
      });
      expect("newAdminRootPubHex" in raw).toBe(false);
    });

    it("pinned + NO handoff ⇒ awaiting, no marker — and the poller KEEPS polling", async () => {
      let calls = 0;
      const fetchImpl = (async () => {
        calls += 1;
        // First poll: transfer visible but the giver hasn't deposited the
        // proof yet. Second poll: the proof arrived.
        return jsonResponse(200, calls === 1 ? rehomeBody() : rehomeBody(signedHandoff()));
      }) as unknown as typeof fetch;
      const poller = buildRehomePoller({
        serverDomain: OLD,
        controlPlaneBaseUrl: CTRL,
        markerPath,
        pinnedAdminRootPubHex: PINNED,
        fetchImpl,
      });
      const first = await poller.pollOnce();
      expect(first).toEqual({ rehomed: false, reason: "awaiting-admin-handoff" });
      expect(await readRehomeMarker(markerPath)).toBeNull();
      // The poller did NOT stop: a later poll picks up the late deposit.
      const second = await poller.pollOnce();
      expect(second.rehomed).toBe(true);
      poller.stop();
    });

    it("pinned + valid handoff ⇒ marker carries the verified new admin root", async () => {
      const out = await check(rehomeBody(signedHandoff()));
      expect(out.rehomed).toBe(true);
      const marker = await readRehomeMarker(markerPath);
      expect(marker?.newAdminRootPubHex).toBe(NEW_ROOT);
    });

    it('"" new root (acquirer has no admin root) ⇒ marker records ""', async () => {
      const out = await check(rehomeBody(signedHandoff({ newAdminRootPubHex: "" })));
      expect(out.rehomed).toBe(true);
      const marker = await readRehomeMarker(markerPath);
      expect(marker?.newAdminRootPubHex).toBe("");
    });

    it("refuses a forged / wrong-signer handoff", async () => {
      const out = await check(rehomeBody(signedHandoff({ signer: acquirerRoot })));
      expect(out).toEqual({ rehomed: false, reason: "awaiting-admin-handoff" });
      expect(await readRehomeMarker(markerPath)).toBeNull();
    });

    it("refuses a handoff whose old root is not OUR pinned root", async () => {
      const otherRoot = makeKey(0x33);
      const out = await check(
        rehomeBody(
          signedHandoff({ oldAdminRootPubHex: hex(otherRoot.publicKey), signer: otherRoot }),
        ),
      );
      expect(out).toEqual({ rehomed: false, reason: "awaiting-admin-handoff" });
    });

    it("refuses a proof minted for a DIFFERENT box (instance binding)", async () => {
      // Validly signed by the giver root — but over another box's canonical.
      const out = await check(
        rehomeBody(signedHandoff({ serverDomain: "other.alice.flagship.services" })),
      );
      expect(out).toEqual({ rehomed: false, reason: "awaiting-admin-handoff" });
    });

    it("refuses a handoff naming a different acquirer than the transfer", async () => {
      const out = await check(rehomeBody(signedHandoff({ acquirerUsername: "mallory" })));
      expect(out).toEqual({ rehomed: false, reason: "awaiting-admin-handoff" });
    });

    it("readRehomeMarker rejects a marker whose admin field is corrupt", async () => {
      await writeFile(
        markerPath,
        JSON.stringify({
          newServerDomain: NEW,
          acquirerUsername: "bob",
          acquirerIrkPubHex: ACQUIRER_IRK,
          oldServerDomain: OLD,
          claimedAt: 1,
          newAdminRootPubHex: "not-hex",
        }),
      );
      expect(await readRehomeMarker(markerPath)).toBeNull();
    });
  });

  // ── Slice D §9.8: boot-apply (cfg override + pin-store reconciliation) ────
  describe("boot-apply admin override + pin reconciliation", () => {
    const marker = (newAdminRootPubHex?: string): RehomeMarker => ({
      newServerDomain: NEW,
      acquirerUsername: "bob",
      acquirerIrkPubHex: ACQUIRER_IRK,
      oldServerDomain: OLD,
      claimedAt: 7,
      ...(newAdminRootPubHex !== undefined ? { newAdminRootPubHex } : {}),
    });

    it("rehomeAdminRootOverride: none / unpin / repin", () => {
      expect(rehomeAdminRootOverride(marker())).toEqual({ kind: "none" });
      expect(rehomeAdminRootOverride(marker(""))).toEqual({ kind: "unpin" });
      expect(rehomeAdminRootOverride(marker("ab".repeat(32)))).toEqual({
        kind: "repin",
        adminRootPubHex: "ab".repeat(32),
      });
    });

    it("repin RESETS a stale giver-era pin file to the acquirer root (seq 0)", async () => {
      const pinPath = join(dir, "admin-root-pin.json");
      const appliedPath = join(dir, "transfer-rehome.json.applied");
      // A giver-era rotation pin that must NOT survive the transfer.
      await writeFile(pinPath, JSON.stringify({ adminRootPubHex: "9e".repeat(32), seq: 3, updatedAt: 1 }));
      const out = await reconcileAdminRootPinOnRehome({
        marker: marker("ab".repeat(32)),
        pinPath,
        appliedPath,
        now: () => 99,
      });
      expect(out).toBe("repinned");
      const pin = JSON.parse(await readFile(pinPath, "utf-8"));
      expect(pin).toEqual({ adminRootPubHex: "ab".repeat(32), seq: 0, updatedAt: 99 });
    });

    it("reconciliation is ONCE per transfer — a later acquirer rotation pin survives reboots", async () => {
      const pinPath = join(dir, "admin-root-pin.json");
      const appliedPath = join(dir, "transfer-rehome.json.applied");
      const m = marker("ab".repeat(32));
      expect(await reconcileAdminRootPinOnRehome({ marker: m, pinPath, appliedPath })).toBe(
        "repinned",
      );
      // The acquirer rotates their admin root — the rotation consumer re-pins.
      await writeFile(pinPath, JSON.stringify({ adminRootPubHex: "cd".repeat(32), seq: 1, updatedAt: 2 }));
      // Next boot re-applies the SAME marker: must NOT clobber the rotation.
      expect(await reconcileAdminRootPinOnRehome({ marker: m, pinPath, appliedPath })).toBe(
        "already-applied",
      );
      expect(JSON.parse(await readFile(pinPath, "utf-8")).adminRootPubHex).toBe("cd".repeat(32));
      // A LATER transfer (different claim) reconciles again.
      const m2: RehomeMarker = { ...m, claimedAt: 8, newAdminRootPubHex: "ef".repeat(32) };
      expect(await reconcileAdminRootPinOnRehome({ marker: m2, pinPath, appliedPath })).toBe(
        "repinned",
      );
      expect(JSON.parse(await readFile(pinPath, "utf-8")).adminRootPubHex).toBe("ef".repeat(32));
    });

    it("unpin removes the pin file; legacy marker touches nothing", async () => {
      const pinPath = join(dir, "admin-root-pin.json");
      const appliedPath = join(dir, "transfer-rehome.json.applied");
      await writeFile(pinPath, JSON.stringify({ adminRootPubHex: "9e".repeat(32), seq: 3, updatedAt: 1 }));

      expect(
        await reconcileAdminRootPinOnRehome({ marker: marker(), pinPath, appliedPath }),
      ).toBe("legacy-no-op");
      expect(existsSync(pinPath)).toBe(true);

      expect(
        await reconcileAdminRootPinOnRehome({ marker: marker(""), pinPath, appliedPath }),
      ).toBe("unpinned");
      expect(existsSync(pinPath)).toBe(false);
    });
  });
});
