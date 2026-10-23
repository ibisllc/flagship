/**
 * drain-v1 on the box: a DRAIN_NOTICE from a hub that is shutting down makes the supervisor
 * dial a new tunnel at once (landing on another relay machine) while the old one finishes
 * its streams, instead of waiting for the hub to close it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  superviseTunnelClient,
  type TunnelClient,
  type TunnelClientOptions,
} from "../src/tunnel/tunnelClient.js";

interface Fake {
  opts: TunnelClientOptions;
  resolveReady: () => void;
  closedBySupervisor: boolean;
}

function factory() {
  const fakes: Fake[] = [];
  const startClient = (opts: TunnelClientOptions): TunnelClient => {
    let resolveReady!: () => void;
    const ready = new Promise<void>((r) => (resolveReady = r));
    const f: Fake = { opts, resolveReady, closedBySupervisor: false };
    fakes.push(f);
    return {
      ready: () => ready,
      rehello: async () => {},
      requestTransfer: () => {},
      closeStreams: () => 0,
      close: async () => {
        f.closedBySupervisor = true;
        opts.onClose?.();
      },
    };
  };
  return { fakes, startClient };
}

const common: TunnelClientOptions = {
  hubUrl: "wss://hub.example/tunnel",
  sign: () => new Uint8Array(64),
  getEntitlements: async () => ({
    rootEntitlement: {
      username: "alice",
      podPubKey: new Uint8Array(32),
      podCanonical: "home.alice.flagship.services",
      issuedAt: 0,
    },
    rootEntitlementSig: new Uint8Array(64),
  }),
  resolveBackend: () => null,
};

describe("superviseTunnelClient — drain notice", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("dials a new tunnel at once and retires the old one after the grace", async () => {
    const { fakes, startClient } = factory();
    const sup = superviseTunnelClient({ ...common, startClient, initialJitterMs: 0, random: () => 0.99 });
    await vi.advanceTimersByTimeAsync(0);
    fakes[0]!.resolveReady();
    await sup.ready();
    expect(fakes[0]!.opts.onDrain).toBeTypeOf("function");

    fakes[0]!.opts.onDrain!(5_000);
    // No backoff: the replacement exists before any timer runs.
    expect(fakes.length).toBe(2);
    fakes[1]!.resolveReady();
    await Promise.resolve();
    expect(sup.isConnected()).toBe(true);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(fakes[0]!.closedBySupervisor).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(fakes[0]!.closedBySupervisor).toBe(true);
    // The retired client's close neither drops the new one nor schedules another dial.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fakes.length).toBe(2);
    expect(sup.isConnected()).toBe(true);
    await sup.close();
  });

  it("ignores the old tunnel closing early, and a notice from a client that is not live", async () => {
    const { fakes, startClient } = factory();
    const sup = superviseTunnelClient({ ...common, startClient, initialJitterMs: 0, random: () => 0 });
    await vi.advanceTimersByTimeAsync(0);
    fakes[0]!.resolveReady();
    await sup.ready();
    fakes[0]!.opts.onDrain!(10_000);
    fakes[1]!.resolveReady();
    await Promise.resolve();
    fakes[0]!.opts.onClose!(); // the hub closed it before the grace ran out
    fakes[0]!.opts.onDrain!(10_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fakes.length).toBe(2);
    expect(sup.isConnected()).toBe(true);
    // The live one dropping still reconnects as before.
    fakes[1]!.opts.onClose!();
    expect(sup.isConnected()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(fakes.length).toBe(3);
    await sup.close();
  });

  it("closes retiring tunnels on close()", async () => {
    const { fakes, startClient } = factory();
    const sup = superviseTunnelClient({ ...common, startClient, initialJitterMs: 0, random: () => 0 });
    await vi.advanceTimersByTimeAsync(0);
    fakes[0]!.resolveReady();
    await sup.ready();
    fakes[0]!.opts.onDrain!(60_000);
    await sup.close();
    expect(fakes[0]!.closedBySupervisor).toBe(true);
    expect(fakes[1]!.closedBySupervisor).toBe(true);
  });
});
