import { describe, expect, it, vi } from "vitest";
import {
  TunnelRegistry,
  type RegisteredTunnel,
  type StreamCallbacks,
} from "../src/tunnel/registry.js";

function fakeTunnel(serverId: string, subdomains: string[]): RegisteredTunnel {
  const streams = new Map<number, StreamCallbacks>();
  let nextStream = 1;
  return {
    serverId,
    subdomains,
    send: vi.fn(),
    attachStream: (streamId, cbs) => streams.set(streamId, cbs),
    detachStream: (streamId) => streams.delete(streamId),
    nextStreamId: () => nextStream++,
  };
}

describe("TunnelRegistry", () => {
  it("registers and finds by exact subdomain", () => {
    const reg = new TunnelRegistry();
    const t = fakeTunnel("srv-1", ["harry.flagship.services"]);
    expect(reg.register(t)).toEqual({ ok: true });
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
    // photos.harry.flagship.services has TWO labels before "flagship.services"
    expect(reg.findBySni("photos.harry.flagship.services")).toBeUndefined();
  });

  it("rejects a registration whose subdomain is already claimed by a different server", () => {
    const reg = new TunnelRegistry();
    reg.register(fakeTunnel("srv-1", ["harry.flagship.services"]));
    const result = reg.register(fakeTunnel("srv-2", ["harry.flagship.services"]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/already claimed/);
  });

  it("allows the same server to re-register the same subdomains", () => {
    const reg = new TunnelRegistry();
    const t = fakeTunnel("srv-1", ["harry.flagship.services"]);
    reg.register(t);
    expect(reg.register(t).ok).toBe(true);
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
