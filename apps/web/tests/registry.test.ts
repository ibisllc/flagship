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

describe("TunnelRegistry — custom-domain redirections (#86)", () => {
  it("resolves a custom fqdn to the pod's tunnel; removeRedirection clears it", () => {
    const reg = new TunnelRegistry();
    const pod = fakeTunnel("home.harry.flagship.services");
    reg.register({ tunnel: pod, canonicals: ["home.harry.flagship.services"] });
    expect(reg.findBySni("shop.example.com")).toBeUndefined();

    reg.addRedirection("Shop.Example.COM", "home.harry.flagship.services");
    expect(reg.redirectionCount()).toBe(1);
    expect(reg.findBySni("shop.example.com")).toBe(pod); // case-normalized

    reg.removeRedirection("shop.example.com");
    expect(reg.findBySni("shop.example.com")).toBeUndefined();
    expect(reg.redirectionCount()).toBe(0);
  });

  it("never shadows first-party flagship.services routing (consulted last)", () => {
    const reg = new TunnelRegistry();
    const pod = fakeTunnel("home.harry.flagship.services");
    reg.register({ tunnel: pod, canonicals: ["notes.home.harry.flagship.services"] });
    // A (mis)configured redirection for a real canonical must not win.
    reg.addRedirection("notes.harry.flagship.services", "home.harry.flagship.services");
    expect(reg.findBySni("notes.harry.flagship.services")).toBe(pod); // native path
  });

  it("survives a pod reconnect (keyed on podCanonical, not the WS object)", () => {
    const reg = new TunnelRegistry();
    const t1 = fakeTunnel("home.harry.flagship.services");
    reg.register({ tunnel: t1, canonicals: ["home.harry.flagship.services"] });
    reg.addRedirection("shop.example.com", "home.harry.flagship.services");
    expect(reg.findBySni("shop.example.com")).toBe(t1);

    // Reconnect: same canonical, brand-new tunnel object.
    const t2 = fakeTunnel("home.harry.flagship.services");
    reg.register({ tunnel: t2, canonicals: ["home.harry.flagship.services"] });
    expect(reg.findBySni("shop.example.com")).toBe(t2);
  });

  it("loadRedirections replaces the whole set (cold-start pull)", () => {
    const reg = new TunnelRegistry();
    const pod = fakeTunnel("home.harry.flagship.services");
    reg.register({ tunnel: pod, canonicals: ["home.harry.flagship.services"] });
    reg.addRedirection("old.example.com", "home.harry.flagship.services");
    reg.loadRedirections([
      ["a.example.com", "home.harry.flagship.services"],
      ["b.example.com", "home.harry.flagship.services"],
    ]);
    expect(reg.redirectionCount()).toBe(2);
    expect(reg.findBySni("old.example.com")).toBeUndefined();
    expect(reg.findBySni("a.example.com")).toBe(pod);
  });

  it("a redirection to an unknown pod resolves to undefined (no throw)", () => {
    const reg = new TunnelRegistry();
    reg.addRedirection("shop.example.com", "ghost.nobody.flagship.services");
    expect(reg.findBySni("shop.example.com")).toBeUndefined();
  });
});
