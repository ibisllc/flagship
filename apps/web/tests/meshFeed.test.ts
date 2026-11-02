/**
 * The mesh relay's view of the public relay log (relay-mesh.md §4.3–§4.6): head polling, pages, freshness and its
 * thresholds, heads and entries from peers verified like the feed's, gaps asking the peers, and the pluggable
 * `FeedCipher` for an encrypted feed.
 */
import { describe, expect, it } from "vitest";
import { ed, signRelayMeshRecord } from "@flagship/protocol";
import { sealRelayFeedObject, sealRelayMeshKeys } from "@flagship/control-plane";
import { httpFeedSource, MeshFeed, MeshFeedKeys, type FeedSource } from "../src/tunnel/mesh/feed.js";
import { APEX, hex, keypair, MeshFixture } from "./support/meshFixture.js";

function feedOf(fx: MeshFixture, o: { now?: () => number; source?: FeedSource; askPeers?: (s: number) => void } = {}) {
  return new MeshFeed({ servicesApex: APEX, logKey: fx.logPub, source: o.source ?? fx.source(), now: o.now ?? fx.now, refuseNewMs: 60_000, closeAllMs: 600_000, ...(o.askPeers ? { askPeers: o.askPeers } : {}) });
}

describe("mesh feed", () => {
  it("polls the head, fetches the pages past its sequence (across a page boundary) and turns fresh", async () => {
    const fx = new MeshFixture();
    for (let i = 0; i < 520; i++) fx.registerBox(`b${i}.alice.${APEX}`, hex(keypair().publicKey));
    const f = feedOf(fx);
    expect(f.fresh()).toBe(false); // not fresh before its first applied head
    await f.poll();
    expect(f.state.sequence).toBe(520);
    expect(f.stats().status).toBe("applied");
    expect(f.fresh()).toBe(true);
    expect(f.entriesSince(515).map((e) => e.entry.sequence)).toEqual([516, 517, 518, 519, 520]);
  });

  it("goes refuse-new 60 s and lost 10 min after the newest applied head was minted", async () => {
    const fx = new MeshFixture();
    let t = 1_000_000;
    fx.now = () => t;
    const f = feedOf(fx, { now: () => t });
    await f.poll();
    expect(f.contact()).toBe("ok");
    fx.paused = true;
    t += 59_999;
    expect(f.contact()).toBe("ok");
    t += 1;
    expect(f.contact()).toBe("refuse-new");
    expect(f.fresh()).toBe(false);
    t += 540_000;
    expect(f.contact()).toBe("lost");
    // A head from a peer (verifiable wherever it comes from) brings it back.
    fx.paused = false;
    expect(f.offerHead(fx.head(), "rb")).toBe(true);
    expect(f.contact()).toBe("ok");
  });

  it("refuses a forged head and a forged entry from a peer, and asks the peers on a gap", async () => {
    const fx = new MeshFixture();
    fx.registerBox(`home.alice.${APEX}`, hex(keypair().publicKey));
    const asked: number[] = [];
    const f = feedOf(fx, { askPeers: (s) => asked.push(s), source: { head: async () => null, page: async () => null, directory: async () => null } });
    const rogue = keypair();
    const h = fx.head();
    const forged = { head: h.head, signature: signRelayMeshRecord("relay-log-head", h.head, (m) => ed.sign(m, rogue.privateKey)) };
    expect(f.offerHead(forged, "rb")).toBe(false);
    expect(Object.keys(f.stats().rejected)).toContain("rb:head-bad-signature");
    // A real head the feed cannot fill: the relay asks its peers.
    expect(f.offerHead(h, "rb")).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(asked).toEqual([0]);
    expect(f.fresh()).toBe(false);
    const bad = { ...fx.entries[0]!, signature: "00".repeat(64) };
    expect(f.offerEntries([bad], "rb")).toEqual([]);
    expect(f.state.sequence).toBe(0);
    expect(f.offerEntries([fx.entries[0]], "rb").length).toBe(1);
    expect(f.stats().status).toBe("applied");
  });

  it("reads the sealed feed (§4.5.1): opens head and pages with the epoch keys sealed to its relay key, fetches its key file once for an unknown epoch", async () => {
    const fx = new MeshFixture();
    fx.registerBox(`home.alice.${APEX}`, hex(keypair().publicKey));
    const relay = fx.addRelay("ra");
    const k1 = crypto.getRandomValues(new Uint8Array(32));
    const k2 = crypto.getRandomValues(new Uint8Array(32));
    const sealHead = (epoch: number, key: Uint8Array) => sealRelayFeedObject({ servicesApex: APEX, object: "head", page: null, epoch, key, plaintext: JSON.stringify(fx.head()) });
    const files: Record<string, unknown> = {
      "head.json": await sealHead(2, k2),
      "log/0.json": await sealRelayFeedObject({ servicesApex: APEX, object: "log", page: 0, epoch: 1, key: k1, plaintext: JSON.stringify(fx.page(0)) }),
    };
    const fetchImpl = (async (url: string) => {
      const path = url.replace("https://feed.example/v1/", "");
      return files[path] ? new Response(JSON.stringify(files[path]), { status: 200 }) : new Response("", { status: 404 });
    }) as typeof fetch;
    const docWith = (epochs: Array<{ epoch: number; key: Uint8Array }>, current: number) =>
      sealRelayMeshKeys({ servicesApex: APEX, relayId: "ra", relayKey: hex(relay.key.publicKey), current, epochs });
    let keyFileFetches = 0;
    const keys = new MeshFeedKeys({
      servicesApex: APEX,
      relayId: "ra",
      seed: relay.key.privateKey,
      fetchKeyFile: async () => {
        keyFileFetches++;
        return docWith([{ epoch: 1, key: k1 }, { epoch: 2, key: k2 }], 2);
      },
    });
    // The blessing answer brought epoch 1 only; the head is under epoch 2: one key-file fetch, then it opens.
    expect(keys.adopt(docWith([{ epoch: 1, key: k1 }], 1))).toBe(true);
    // A key file for another relay is refused.
    expect(keys.adopt(sealRelayMeshKeys({ servicesApex: APEX, relayId: "rb", relayKey: hex(relay.key.publicKey), current: 1, epochs: [{ epoch: 1, key: k1 }] }))).toBe(false);
    const f = feedOf(fx, { source: httpFeedSource({ baseUrl: "https://feed.example/v1/", cipher: () => keys.cipher(), fetchImpl }) });
    await f.poll();
    expect(f.state.sequence).toBe(1);
    expect(keyFileFetches).toBe(1);
    expect(keys.epochs()).toEqual([1, 2]);
    // A page served in the head's slot is refused (`wrong-place`); a third epoch nobody sealed stays unreadable.
    files["head.json"] = files["log/0.json"];
    await f.poll();
    expect(keys.failures["wrong-place"]).toBe(1);
    files["head.json"] = await sealHead(3, crypto.getRandomValues(new Uint8Array(32)));
    await f.poll();
    await f.poll();
    expect(keyFileFetches).toBe(2);
    expect(keys.failures["no-key"]).toBeGreaterThanOrEqual(2);
  });
});
