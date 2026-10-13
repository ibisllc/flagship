/**
 * Relay ↔ `.com` round trip for public egress: the relay's UsageMeter posts
 * its byte deltas to the real `/api/usage/report` handler (the metering core
 * over in-memory counters), and the verdict decides who the relay slows.
 */
import { describe, expect, it } from "vitest";
import { InMemoryMeterStorage, InMemoryTierStorage } from "@flagship/storage";
import { handleUsageReport, type MeteringDeps } from "@flagship/control-plane";
import { UsageMeter } from "../src/tunnel/usageMeter.js";

const GB = 1024 * 1024 * 1024;
const SECRET = "relay-secret";
const RATE = 32_000;

async function relayAgainstCom() {
  const tiers = new InMemoryTierStorage();
  await tiers.put({ username: "bob", tier: "hobby", updatedAt: 1 });
  const com: MeteringDeps = { meter: new InMemoryMeterStorage(), tiers };
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    const res = await handleUsageReport(com, headers["x-usage-secret"] ?? null, SECRET, JSON.parse(String(init?.body)));
    return { ok: res.status === 200, json: async () => res.body } as Response;
  }) as typeof fetch;
  const relay = new UsageMeter({
    reportUrl: "https://com/api/usage/report",
    secret: SECRET,
    fetchImpl,
    throttleBytesPerSec: RATE,
    now: () => 0, // a frozen throttle clock keeps the delays exact
  });
  return { relay, com };
}

describe("egress metering — relay and .com through the metering core", () => {
  it("a free account under 25 GB keeps full speed", async () => {
    const { relay } = await relayAgainstCom();
    relay.add("alice", 24 * GB);
    await relay.flush();
    expect(relay.admits("alice")).toBe(true);
    expect(relay.throttleDelayMs("alice", RATE * 10)).toBe(0);
  });

  it("a free account over 25 GB is slowed, not refused", async () => {
    const { relay, com } = await relayAgainstCom();
    relay.add("alice", 20 * GB);
    await relay.flush();
    relay.add("alice", 6 * GB);
    await relay.flush();
    expect((await com.meter.get("alice", "egress", new Date().toISOString().slice(0, 7)))?.amount).toBe(26 * GB);
    expect(relay.admits("alice")).toBe(false);
    expect(relay.throttleDelayMs("alice", RATE)).toBe(0); // the burst
    expect(relay.throttleDelayMs("alice", RATE)).toBe(1000); // then 256 kbit/s
  });

  it("a paid account over its allowance is never slowed", async () => {
    const { relay } = await relayAgainstCom();
    relay.add("bob", 300 * GB);
    await relay.flush();
    expect(relay.admits("bob")).toBe(true);
    expect(relay.throttleDelayMs("bob", RATE * 10)).toBe(0);
  });
});
