/**
 * Gap 2 — persistent peer-liveness signal.
 *
 * The watchdog bumps a per-peer timestamp on every PeerLink send/receive.
 * `wrapPeerLink` wraps a real PeerLink, preserving its remoteServerId +
 * close semantics while observing traffic.
 */

import { describe, expect, it } from "vitest";
import {
  PeerActivityWatchdog,
  wrapPeerLink,
} from "../src/peerBackup/peerActivityWatchdog.js";
import { loopbackPair } from "../src/peerBackup/peerLink.js";

describe("PeerActivityWatchdog", () => {
  it("returns undefined before any bump", () => {
    const w = new PeerActivityWatchdog(() => 1000);
    expect(w.lastSeenMs("peer-A")).toBeUndefined();
  });

  it("bump stamps the most recent time", () => {
    let now = 1000;
    const w = new PeerActivityWatchdog(() => now);
    w.bump("peer-A");
    expect(w.lastSeenMs("peer-A")).toBe(1000);
    now = 2000;
    w.bump("peer-A");
    expect(w.lastSeenMs("peer-A")).toBe(2000);
  });

  it("bump is monotonic — an older explicit timestamp is ignored", () => {
    const w = new PeerActivityWatchdog(() => 5000);
    w.bump("peer-A", 5000);
    w.bump("peer-A", 1000);
    expect(w.lastSeenMs("peer-A")).toBe(5000);
  });

  it("tracks peers independently", () => {
    let now = 1000;
    const w = new PeerActivityWatchdog(() => now);
    w.bump("peer-A");
    now = 2000;
    w.bump("peer-B");
    expect(w.lastSeenMs("peer-A")).toBe(1000);
    expect(w.lastSeenMs("peer-B")).toBe(2000);
  });
});

describe("wrapPeerLink", () => {
  it("bumps on send", () => {
    let now = 1234;
    const w = new PeerActivityWatchdog(() => now);
    const { a } = loopbackPair("self", "peer-X");
    const wrapped = wrapPeerLink(a, w);
    expect(w.lastSeenMs("peer-X")).toBeUndefined();
    wrapped.send({ streamId: 1, type: 0xff, payload: new Uint8Array(0) });
    expect(w.lastSeenMs("peer-X")).toBe(1234);
  });

  it("bumps on every received frame", async () => {
    let now = 100;
    const w = new PeerActivityWatchdog(() => now);
    const { a, b } = loopbackPair("self", "peer-Y");
    const wrappedA = wrapPeerLink(a, w);

    const seen: number[] = [];
    wrappedA.onFrame((f) => seen.push(f.streamId));

    // b sends → wrapped a observes via onFrame.
    now = 200;
    b.send({ streamId: 7, type: 0xaa, payload: new Uint8Array(0) });
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([7]);
    expect(w.lastSeenMs("peer-Y")).toBe(200);
  });

  it("preserves remoteServerId from the underlying link", () => {
    const w = new PeerActivityWatchdog();
    const { a } = loopbackPair("self", "peer-Z");
    const wrapped = wrapPeerLink(a, w);
    expect(wrapped.remoteServerId).toBe("peer-Z");
  });

  it("close delegates without bumping", () => {
    const w = new PeerActivityWatchdog();
    const { a } = loopbackPair("self", "peer-Q");
    const wrapped = wrapPeerLink(a, w);
    wrapped.close();
    expect(w.lastSeenMs("peer-Q")).toBeUndefined();
  });
});
