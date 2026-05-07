import { describe, expect, it, vi } from "vitest";
import {
  TunnelRegistry,
  type RegisteredTunnel,
  type StreamCallbacks,
} from "../src/tunnel/registry.js";

function fakeTunnel(serverId: string, controlledDomains: string[]): RegisteredTunnel {
  const streams = new Map<number, StreamCallbacks>();
  let nextStream = 1;
  return {
    serverId,
    controlledDomains: [...controlledDomains],
    send: vi.fn(),
    attachStream: (streamId, cbs) => streams.set(streamId, cbs),
    detachStream: (streamId) => streams.delete(streamId),
    nextStreamId: () => nextStream++,
  };
}

describe("TunnelRegistry", () => {
  it("registers and finds by exact FQDN", () => {
    const reg = new TunnelRegistry();
    const t = fakeTunnel("srv-1", ["harry.flagship.services"]);
    const r = reg.register(t);
    expect(r.ok).toBe(true);
    expect(r.takeovers).toEqual([]);
    expect(reg.findBySni("harry.flagship.services")).toBe(t);
  });

  it("matches a wildcard one DNS label deep", () => {
    const reg = new TunnelRegistry();
    const t = fakeTunnel("srv-1", ["*.harry.flagship.services"]);
    reg.register(t);
    expect(reg.findBySni("photos.harry.flagship.services")).toBe(t);
    expect(reg.findBySni("blog.harry.flagship.services")).toBe(t);
  });

  it("does NOT match a wildcard across multiple labels (RFC 6125)", () => {
    const reg = new TunnelRegistry();
    const t = fakeTunnel("srv-1", ["*.flagship.services"]);
    reg.register(t);
    expect(reg.findBySni("harry.flagship.services")).toBe(t);
    expect(reg.findBySni("photos.harry.flagship.services")).toBeUndefined();
  });

  it("last-HELLO-wins: a new tunnel takes over an FQDN held by another server", () => {
    const reg = new TunnelRegistry();
    const t1 = fakeTunnel("srv-1", ["harry.flagship.services"]);
    reg.register(t1);
    const t2 = fakeTunnel("srv-2", ["harry.flagship.services"]);
    const r = reg.register(t2);
    expect(r.ok).toBe(true);
    expect(r.takeovers).toEqual([
      { fqdn: "harry.flagship.services", previousServerId: "srv-1" },
    ]);
    expect(reg.findBySni("harry.flagship.services")).toBe(t2);
    expect(t1.controlledDomains).toEqual([]);
  });

  it("re-registering the same server is idempotent", () => {
    const reg = new TunnelRegistry();
    const t = fakeTunnel("srv-1", ["harry.flagship.services"]);
    reg.register(t);
    expect(reg.register(t).ok).toBe(true);
    expect(reg.findBySni("harry.flagship.services")).toBe(t);
  });

  it("replaceClaims atomically updates the route table", () => {
    const reg = new TunnelRegistry();
    const t = fakeTunnel("srv-1", ["a.harry.flagship.services", "b.harry.flagship.services"]);
    reg.register(t);
    const result = reg.replaceClaims(t, ["b.harry.flagship.services", "c.harry.flagship.services"]);
    expect(result.released).toEqual(["a.harry.flagship.services"]);
    expect(result.takeovers).toEqual([]);
    expect(reg.findBySni("a.harry.flagship.services")).toBeUndefined();
    expect(reg.findBySni("b.harry.flagship.services")).toBe(t);
    expect(reg.findBySni("c.harry.flagship.services")).toBe(t);
  });

  it("replaceClaims to an empty list releases everything but keeps the WS reachable", () => {
    const reg = new TunnelRegistry();
    const t = fakeTunnel("srv-1", ["a.harry.flagship.services"]);
    reg.register(t);
    const result = reg.replaceClaims(t, []);
    expect(result.released).toEqual(["a.harry.flagship.services"]);
    expect(reg.findBySni("a.harry.flagship.services")).toBeUndefined();
    expect(reg.size()).toBe(1);
  });

  it("replaceClaims steals an FQDN from another tunnel", () => {
    const reg = new TunnelRegistry();
    const t1 = fakeTunnel("srv-1", ["x.harry.flagship.services"]);
    const t2 = fakeTunnel("srv-2", []);
    reg.register(t1);
    reg.register(t2);
    const r = reg.replaceClaims(t2, ["x.harry.flagship.services"]);
    expect(r.takeovers).toEqual([
      { fqdn: "x.harry.flagship.services", previousServerId: "srv-1" },
    ]);
    expect(t1.controlledDomains).toEqual([]);
    expect(reg.findBySni("x.harry.flagship.services")).toBe(t2);
  });

  it("clears all entries after unregister", () => {
    const reg = new TunnelRegistry();
    const t = fakeTunnel("srv-1", ["harry.flagship.services", "*.harry.flagship.services"]);
    reg.register(t);
    expect(reg.size()).toBe(1);
    reg.unregister("srv-1");
    expect(reg.size()).toBe(0);
    expect(reg.findBySni("harry.flagship.services")).toBeUndefined();
    expect(reg.findBySni("photos.harry.flagship.services")).toBeUndefined();
  });

  it("findBySni is case-insensitive", () => {
    const reg = new TunnelRegistry();
    reg.register(fakeTunnel("srv-1", ["harry.flagship.services"]));
    expect(reg.findBySni("HARRY.FLAGSHIP.SERVICES")).toBeDefined();
  });
});
