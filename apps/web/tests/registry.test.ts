import { describe, expect, it, vi } from "vitest";
import {
  TunnelRegistry,
  type RegisteredTunnel,
  type StreamCallbacks,
} from "../src/tunnel/registry.js";

function fakeTunnel(podCanonical: string): RegisteredTunnel {
  const streams = new Map<number, StreamCallbacks>();
  let nextStream = 1;
  return {
    podCanonical,
    send: vi.fn(),
    attachStream: (streamId, cbs) => streams.set(streamId, cbs),
    detachStream: (streamId) => streams.delete(streamId),
    nextStreamId: () => nextStream++,
  };
}

describe("TunnelRegistry — allocator-backed (N12b)", () => {
  it("registers a pod and finds it by its canonical", () => {
    const reg = new TunnelRegistry();
    const t = fakeTunnel("home.harry.flagship.services");
    const r = reg.register({ tunnel: t, canonicals: ["home.harry.flagship.services"] });
    expect(r.shortenedsHeld).toEqual([]); // pod-root canonical has no shortened
    expect(reg.findBySni("home.harry.flagship.services")).toBe(t);
  });

  it("a self-authored app's canonical wins the user-zone shortened", () => {
    const reg = new TunnelRegistry();
    const t = fakeTunnel("home.harry.flagship.services");
    reg.register({
      tunnel: t,
      canonicals: ["notes.home.harry.flagship.services"],
    });
    expect(reg.findBySni("notes.home.harry.flagship.services")).toBe(t);
    expect(reg.findBySni("notes.harry.flagship.services")).toBe(t);
  });

  it("preserves existing shortened on second pod (FCFS)", () => {
    const reg = new TunnelRegistry();
    const home = fakeTunnel("home.harry.flagship.services");
    const office = fakeTunnel("office.harry.flagship.services");
    reg.register({ tunnel: home, canonicals: ["notes.home.harry.flagship.services"] });
    reg.register({ tunnel: office, canonicals: ["notes.office.harry.flagship.services"] });
    expect(reg.findBySni("notes.harry.flagship.services")).toBe(home);
  });

  it("explicit transfer reassigns the slot to the requester", () => {
    const reg = new TunnelRegistry();
    const home = fakeTunnel("home.harry.flagship.services");
    const office = fakeTunnel("office.harry.flagship.services");
    reg.register({ tunnel: home, canonicals: ["notes.home.harry.flagship.services"] });
    reg.register({ tunnel: office, canonicals: ["notes.office.harry.flagship.services"] });
    const r = reg.requestTransfer({
      podCanonical: office.podCanonical,
      fqdn: "notes.harry.flagship.services",
    });
    expect(r.ok).toBe(true);
    expect(reg.findBySni("notes.harry.flagship.services")).toBe(office);
  });

  it("unregister removes the pod and redistributes orphans to a survivor", () => {
    const reg = new TunnelRegistry();
    const home = fakeTunnel("home.harry.flagship.services");
    const office = fakeTunnel("office.harry.flagship.services");
    reg.register({ tunnel: home, canonicals: ["notes.home.harry.flagship.services"] });
    reg.register({ tunnel: office, canonicals: ["notes.office.harry.flagship.services"] });
    expect(reg.findBySni("notes.harry.flagship.services")).toBe(home);
    reg.unregister(home.podCanonical);
    expect(reg.findBySni("notes.harry.flagship.services")).toBe(office);
  });

  it("findBySni is case-insensitive", () => {
    const reg = new TunnelRegistry();
    const t = fakeTunnel("home.harry.flagship.services");
    reg.register({ tunnel: t, canonicals: ["notes.home.harry.flagship.services"] });
    expect(reg.findBySni("NOTES.HOME.HARRY.flagship.services")).toBe(t);
  });

  it("size reflects the number of registered tunnels", () => {
    const reg = new TunnelRegistry();
    expect(reg.size()).toBe(0);
    reg.register({
      tunnel: fakeTunnel("home.harry.flagship.services"),
      canonicals: ["notes.home.harry.flagship.services"],
    });
    expect(reg.size()).toBe(1);
  });
});
