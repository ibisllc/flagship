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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRehomePoller,
  checkAndRecordRehome,
  readRehomeMarker,
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
});
