import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PB_NETWORK_DEFAULT, canonicalPbMailboxAnnounce, ed, pbMailboxEpoch } from "@flagship/protocol";
import { PeerBackupEngine, type PeerPolicy } from "../src/peerNet/engine.js";
import type { PbComClient } from "../src/peerNet/types.js";

function fakeCom(calls: string[]): PbComClient {
  const network = { ...PB_NETWORK_DEFAULT, brickBytes: 4096, leafBytes: 256 };
  return {
    network: async () => (calls.push("network"), { network, tokenKey: { n: 3233n, e: 17n }, relayBase: "https://relay.test" }),
    checkin: async () => (calls.push("checkin"), { network, fillerNext: 0, fillerWanted: 0, challenge: null, reliability: 50, provenSlots: 0 }),
    fetchFiller: async () => new Uint8Array(4096),
    proof: async () => ({ passed: true }),
    directory: async () => (calls.push("directory"), { network, entries: [], self: { accountTag: "a", netTag: "b" } }),
    tokens: async () => [],
    redeem: async () => [],
    putRoot: async () => {},
    getRoot: async () => null,
  };
}

function engine(policy: { p: PeerPolicy }, calls: string[]) {
  const listeners: Array<() => void> = [];
  return {
    listeners,
    e: new PeerBackupEngine({
      serverId: "home.e.flagship.services",
      dataDir: mkdtempSync(join(tmpdir(), "pb-engine-")),
      pbk: new Uint8Array(32).fill(1),
      sign: (m) => ed.sign(m, new Uint8Array(32).fill(2)),
      comBaseUrl: "https://com.test",
      policy: {
        current: () => ({ policy: policy.p }),
        onChange: (cb) => {
          listeners.push(cb);
          return () => {};
        },
      },
      reservedForPeersBytes: () => 1 << 30,
      com: fakeCom(calls),
      transport: { send: async () => new Uint8Array(0) },
    }),
  };
}

describe("peer backup engine", () => {
  it("does nothing on the network unless the policy is Peer", async () => {
    const calls: string[] = [];
    const { e } = engine({ p: "phone" }, calls);
    await e.tick();
    expect(calls).toEqual([]);
    expect((await e.policyStatus()).state).toBe("off");
    expect((await e.policyStatus()).poolBytes).toBe(0);
  });

  it("checks in and reports its pool on Peer, then leaves when the policy changes", async () => {
    const calls: string[] = [];
    const policy = { p: "peer" as PeerPolicy };
    const { e } = engine(policy, calls);
    await e.tick();
    expect(calls).toContain("checkin");
    const s = await e.status();
    expect(s.v).toBe(2);
    expect(s.policy).toBe("peer");
    expect(s.poolBytes).toBe(Math.floor((1 << 30) * 0.98));
    expect(["filling", "waiting-for-peers"]).toContain(s.state);

    // Filler arrives; then the owner moves to Phone-side: the holder leaves.
    const st = await e.holder.state();
    st.fillerHeld = 3;
    policy.p = "phone";
    await e.tick();
    expect((await e.holder.state()).leavingSince).not.toBeNull();
    expect((await e.policyStatus()).state).toBe("leaving");
  });

  it("pins the archive it was handed while on Peer", async () => {
    const { e } = engine({ p: "peer" }, []);
    e.onArchiveSaved({ archiveId: "ab".repeat(16), createdAt: 1, bytes: 10, sha256: "00".repeat(32) }, { dataPath: "/x", backupPath: "/y" });
    await new Promise((r) => setTimeout(r, 20));
    expect(e.pinnedArchiveIds()).toEqual(new Set(["ab".repeat(16)]));
  });

  it("announces its mailbox for this epoch and the next, signed by its PIK", async () => {
    const { e } = engine({ p: "peer" }, []);
    const a = await e.mailboxAnnouncements();
    const ep = pbMailboxEpoch(Date.now());
    expect(a.map((x) => x.epoch)).toEqual([ep, ep + 1]);
    for (const x of a) {
      expect(ed.verify(Buffer.from(x.sigHex, "hex"), canonicalPbMailboxAnnounce(x.pikPubHex, x.epoch), Buffer.from(x.pikPubHex, "hex"))).toBe(true);
    }
  });
});
