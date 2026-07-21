import { describe, expect, it } from "vitest";
import {
  decodeFrame,
  encodeFrame,
  FRAME_DATA,
  FRAME_OPEN,
  type Frame,
} from "@flagship/tunnel-protocol";
import { TunnelRegistry } from "../src/tunnel/registry.js";
import type { RegisteredTunnel, StreamCallbacks } from "../src/tunnel/registry.js";
import {
  deliverGossipToBox,
  fanOutGossip,
  parseGossipHost,
  GOSSIP_BOX_PATH,
} from "../src/tunnel/gossipFanout.js";

/**
 * A mock connected box. Records every frame the hub sends it (the OPEN +
 * DATA of an originated gossip stream) so tests can assert the verbatim
 * opaque body crossed the tunnel unmodified, and that NON-members got nothing.
 */
function mockTunnel(podCanonical: string): RegisteredTunnel & {
  sent: Frame[];
  streams: Map<number, StreamCallbacks>;
} {
  let next = 1;
  const streams = new Map<number, StreamCallbacks>();
  const sent: Frame[] = [];
  return {
    podCanonical,
    sent,
    streams,
    send(frame: Frame) {
      sent.push(frame);
    },
    attachStream(id, cb) {
      streams.set(id, cb);
    },
    detachStream(id) {
      streams.delete(id);
    },
    nextStreamId() {
      return next++;
    },
  };
}

/** Reassemble the request bytes a tunnel received (concat of FRAME_DATA payloads). */
function reassembleRequest(t: { sent: Frame[] }): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const f of t.sent) if (f.type === FRAME_DATA) parts.push(f.payload);
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.byteLength; }
  return out;
}

function register(reg: TunnelRegistry, t: RegisteredTunnel): void {
  reg.register({ tunnel: t, canonicals: [t.podCanonical] });
}

const OPAQUE = new Uint8Array([0x00, 0x01, 0xff, 0xca, 0xfe, 0x00, 0xba, 0xbe]);

describe("parseGossipHost", () => {
  const apex = "flagship.services";
  it("recognizes broadcast--<user>.<apex>", () => {
    expect(parseGossipHost("broadcast--harry.flagship.services", apex)).toBe("harry");
    expect(parseGossipHost("BROADCAST--Harry.Flagship.Services", apex)).toBe("harry");
    expect(parseGossipHost("broadcast--happy-otter.flagship.services", apex)).toBe("happy-otter");
  });
  it("strips a trailing :port", () => {
    expect(parseGossipHost("broadcast--harry.flagship.services:8443", apex)).toBe("harry");
  });
  it("rejects non-gossip hosts", () => {
    expect(parseGossipHost("home.harry.flagship.services", apex)).toBeNull();
    expect(parseGossipHost("harry.flagship.services", apex)).toBeNull();
    expect(parseGossipHost("broadcast.harry.flagship.services", apex)).toBeNull(); // single dash, not the `--` form
    expect(parseGossipHost("broadcast--harry.flagship.com", apex)).toBeNull(); // wrong apex
  });
  it("rejects an embedded extra label (can't address another zone)", () => {
    // broadcast--a.b.<apex> would otherwise be read as user "a.b".
    expect(parseGossipHost("broadcast--a.b.flagship.services", apex)).toBeNull();
  });
  it("is apex-relative (gym test env)", () => {
    expect(parseGossipHost("broadcast--harry.gym.flagship.services", "gym.flagship.services")).toBe("harry");
    expect(parseGossipHost("broadcast--harry.flagship.services", "gym.flagship.services")).toBeNull();
  });
});

describe("TunnelRegistry.tunnelsForUser", () => {
  it("returns every connected box of an account and no others", () => {
    const reg = new TunnelRegistry({ apex: "flagship.services" });
    const a1 = mockTunnel("kitchen.harry.flagship.services");
    const a2 = mockTunnel("woodshed.harry.flagship.services");
    const b1 = mockTunnel("kitchen.bob.flagship.services");
    register(reg, a1);
    register(reg, a2);
    register(reg, b1);
    const harry = reg.tunnelsForUser("harry").map((t) => t.podCanonical).sort();
    expect(harry).toEqual([
      "kitchen.harry.flagship.services",
      "woodshed.harry.flagship.services",
    ]);
    expect(reg.tunnelsForUser("bob").map((t) => t.podCanonical)).toEqual([
      "kitchen.bob.flagship.services",
    ]);
    expect(reg.tunnelsForUser("nobody")).toEqual([]);
  });

  it("is apex-relative (gym env) and case-insensitive", () => {
    const reg = new TunnelRegistry({ apex: "gym.flagship.services" });
    const a1 = mockTunnel("kitchen.harry.gym.flagship.services");
    register(reg, a1);
    expect(reg.tunnelsForUser("HARRY").map((t) => t.podCanonical)).toEqual([
      "kitchen.harry.gym.flagship.services",
    ]);
  });
});

describe("deliverGossipToBox (the seam)", () => {
  it("originates a POST /internal/gossip stream carrying the verbatim body", () => {
    const t = mockTunnel("kitchen.harry.flagship.services");
    const ok = deliverGossipToBox(t, OPAQUE);
    expect(ok).toBe(true);

    // It opened exactly one stream toward the box.
    const opens = t.sent.filter((f) => f.type === FRAME_OPEN);
    expect(opens.length).toBe(1);

    const req = reassembleRequest(t);
    const text = new TextDecoder().decode(req);
    expect(text.startsWith(`POST ${GOSSIP_BOX_PATH} HTTP/1.1\r\n`)).toBe(true);
    expect(text).toContain("Host: kitchen.harry.flagship.services\r\n");
    expect(text).toContain(`Content-Length: ${OPAQUE.byteLength}\r\n`);

    // CONTENT-BLIND: the opaque body is the exact trailing bytes, untouched.
    const tail = req.subarray(req.byteLength - OPAQUE.byteLength);
    expect(Array.from(tail)).toEqual(Array.from(OPAQUE));
  });

  it("attaches a no-op response sink (the box's reply is discarded)", () => {
    const t = mockTunnel("kitchen.harry.flagship.services");
    deliverGossipToBox(t, OPAQUE);
    // A stream callback was attached; driving onData must not throw and must
    // surface nothing (the fan-out returns nothing upward).
    expect(t.streams.size).toBe(1);
    const cb = [...t.streams.values()][0]!;
    expect(() => cb.onData(new Uint8Array([1, 2, 3]))).not.toThrow();
    expect(() => cb.onRemoteClose()).not.toThrow();
  });

  it("returns false (best-effort) when the tunnel send throws", () => {
    const t = mockTunnel("kitchen.harry.flagship.services");
    t.send = () => { throw new Error("tunnel gone"); };
    expect(deliverGossipToBox(t, OPAQUE)).toBe(false);
  });
});

describe("fanOutGossip", () => {
  it("delivers to ALL of the account's boxes and NOT other accounts'", () => {
    const reg = new TunnelRegistry({ apex: "flagship.services" });
    const a1 = mockTunnel("kitchen.harry.flagship.services");
    const a2 = mockTunnel("woodshed.harry.flagship.services");
    const b1 = mockTunnel("kitchen.bob.flagship.services");
    [a1, a2, b1].forEach((t) => register(reg, t));

    const res = fanOutGossip(reg, "harry", OPAQUE);
    expect(res.delivered).toBe(2);

    // Both harry boxes got the verbatim body.
    for (const box of [a1, a2]) {
      const tail = reassembleRequest(box);
      expect(Array.from(tail.subarray(tail.byteLength - OPAQUE.byteLength))).toEqual(
        Array.from(OPAQUE),
      );
    }
    // Bob's box got NOTHING (account isolation).
    expect(b1.sent.length).toBe(0);
  });

  it("EXCLUDES the sender when identified", () => {
    const reg = new TunnelRegistry({ apex: "flagship.services" });
    const a1 = mockTunnel("kitchen.harry.flagship.services");
    const a2 = mockTunnel("woodshed.harry.flagship.services");
    [a1, a2].forEach((t) => register(reg, t));

    const res = fanOutGossip(reg, "harry", OPAQUE, "kitchen.harry.flagship.services");
    expect(res.delivered).toBe(1);
    expect(a1.sent.length).toBe(0); // sender excluded
    expect(a2.sent.some((f) => f.type === FRAME_DATA)).toBe(true); // peer delivered
  });

  it("is content-blind: byte-identical body passed through unmodified", () => {
    const reg = new TunnelRegistry({ apex: "flagship.services" });
    const a1 = mockTunnel("kitchen.harry.flagship.services");
    register(reg, a1);
    // A body that is NOT valid JSON/UTF-8 (proves no parse/transform).
    const weird = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x80, 0xfe]);
    fanOutGossip(reg, "harry", weird);
    const req = reassembleRequest(a1);
    const tail = req.subarray(req.byteLength - weird.byteLength);
    expect(Array.from(tail)).toEqual(Array.from(weird));
  });

  it("delivers an EMPTY body (zero-length opaque blob) without error", () => {
    const reg = new TunnelRegistry({ apex: "flagship.services" });
    const a1 = mockTunnel("kitchen.harry.flagship.services");
    register(reg, a1);
    const res = fanOutGossip(reg, "harry", new Uint8Array(0));
    expect(res.delivered).toBe(1);
    expect(reassembleRequest(a1).byteLength).toBeGreaterThan(0); // headers present
  });

  it("returns delivered:0 for an account with no connected boxes", () => {
    const reg = new TunnelRegistry({ apex: "flagship.services" });
    expect(fanOutGossip(reg, "ghost", OPAQUE)).toEqual({ delivered: 0, members: 0 });
  });
});

// Sanity: every frame the hub emits encodes + decodes cleanly (the box uses
// the same decoder on the other end of the tunnel).
describe("emitted frames are well-formed", () => {
  it("OPEN + DATA round-trip through the frame codec", () => {
    const t = mockTunnel("kitchen.harry.flagship.services");
    deliverGossipToBox(t, OPAQUE);
    expect(t.sent.length).toBeGreaterThanOrEqual(2);
    for (const f of t.sent) {
      const r = decodeFrame(encodeFrame(f));
      expect(r.kind).toBe("ok");
      if (r.kind === "ok") expect(r.frame.type).toBe(f.type);
    }
  });
});
