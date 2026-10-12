import { describe, expect, it } from "vitest";
import { ed, verifyPushRelayRequest, type Keypair } from "@flagship/protocol";
import { buildAccessRequestRecorder, type AccessRequestEvent } from "../../src/egress/accessAlerts.js";
import { ALERTS_PER_HOUR, AppAccessStore, DISMISS_QUIET_MS, PENDING_MAX_PER_APP, askableHost } from "../../src/egress/accessStore.js";
import { bootEgress } from "../../src/egress/boot.js";
import { sendPushRelay } from "../../src/relaySos.js";
import { ScreensEventBus } from "../../src/screens/screensEvents.js";
import type { BoxSigner } from "../../src/keyCustodian.js";
import type { CommandRunner } from "../../src/serviceRunner.js";

const DAY = 24 * 60 * 60_000;
const HOUR = 60 * 60_000;

function rig(names: Record<string, string> = { "harry-weather": "weather", "harry-notes": "notes" }) {
  let t = 1_800_000_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const store = new AppAccessStore(null, null, { now: clock.now });
  const pushes: number[] = [];
  const events: AccessRequestEvent[] = [];
  const rec = buildAccessRequestRecorder({
    store,
    appName: (id) => names[id] ?? null,
    sinks: () => ({ push: () => void pushes.push(t), emit: (e) => events.push(e) }),
  });
  return { store, rec, pushes, events, clock };
}

const flush = () => new Promise((r) => setImmediate(r));

describe("recording default-deny attempts", () => {
  it("dedupes per host and counts attempts with first and last seen", async () => {
    const { store, rec, clock } = rig();
    const t0 = clock.now();
    rec.onUnmatched("harry-weather", "api.github.com");
    rec.onUnmatched("harry-weather", "api.github.com");
    clock.advance(1500);
    rec.onUnmatched("harry-weather", "API.GitHub.com.");
    expect(store.pending("harry-weather")).toEqual([
      { host: "api.github.com", source: "attempt", attempts: 2, firstSeen: t0, lastSeen: t0 + 1500 },
    ]);
  });

  it("skips names an owner can't usefully allow, unknown containers and dismissed hosts", async () => {
    const { store, rec, clock } = rig();
    for (const h of ["printer.local", "x.in-addr.arpa", "db.internal", "localhost", "1.2.3.4", "single", "a..b"]) {
      rec.onUnmatched("harry-weather", h);
      expect(askableHost(h), h).toBeNull();
    }
    rec.onUnmatched("harry-staging-copy", "api.github.com");
    expect(store.pendingServiceIds()).toEqual([]);

    rec.onUnmatched("harry-weather", "api.github.com");
    await store.dismiss("harry-weather", "api.github.com");
    rec.onUnmatched("harry-weather", "api.github.com");
    expect(store.pending("harry-weather")).toEqual([]);
    clock.advance(DISMISS_QUIET_MS + 1);
    rec.onUnmatched("harry-weather", "api.github.com");
    expect(store.pending("harry-weather")).toHaveLength(1);
  });

  it("caps each app's pending list, evicting the stalest attempt but never a declared host", async () => {
    const { store, rec, clock } = rig();
    await rec.onDeclared("harry-weather", ["api.open-meteo.com"]);
    for (let i = 0; i < PENDING_MAX_PER_APP + 5; i++) {
      clock.advance(10);
      rec.onUnmatched("harry-weather", `h${i}.example.com`);
    }
    const hosts = store.pending("harry-weather").map((r) => r.host);
    expect(hosts).toHaveLength(PENDING_MAX_PER_APP);
    expect(hosts).toContain("api.open-meteo.com");
    expect(hosts).not.toContain("h0.example.com");
    expect(hosts).toContain(`h${PENDING_MAX_PER_APP + 4}.example.com`);
  });

  it("manifest hosts become 'app' requests at install unless the list already decides them", async () => {
    const { store, rec, events } = rig();
    await store.putSigned("harry-weather", "deny api.open-meteo.com\n", { v: 2, grant: { serverDomain: "b", serviceId: "harry-weather", listSha256: "0".repeat(64), issuedAt: 1 }, signature: "" });
    const created = await rec.onDeclared("harry-weather", ["api.open-meteo.com", "*.tile.openstreetmap.org", "*.tile.openstreetmap.org"]);
    expect(created.map((r) => [r.host, r.source, r.attempts])).toEqual([["*.tile.openstreetmap.org", "app", 0]]);
    expect(events).toEqual([{ type: "access-request", serviceId: "harry-weather" }]);
    expect(await rec.onDeclared("harry-weather", ["*.tile.openstreetmap.org"])).toEqual([]);
    expect(await rec.onDeclared("harry-gone", ["a.example.com"])).toEqual([]);
  });
});

describe("alerts", () => {
  it("one push per app and host per day; a socket event only for a new request", async () => {
    const { rec, pushes, events, clock } = rig();
    rec.onUnmatched("harry-weather", "api.github.com");
    clock.advance(5000);
    rec.onUnmatched("harry-weather", "api.github.com");
    await flush();
    expect(pushes).toHaveLength(1);
    expect(events).toEqual([{ type: "access-request", serviceId: "harry-weather" }]);
    rec.onUnmatched("harry-notes", "api.github.com");
    await flush();
    expect(pushes).toHaveLength(2);
    clock.advance(DAY);
    rec.onUnmatched("harry-weather", "api.github.com");
    await flush();
    expect(pushes).toHaveLength(3);
    expect(events).toHaveLength(2);
  });

  it("at most five per hour per box", async () => {
    const { store, rec, pushes, clock } = rig();
    for (let i = 0; i < 8; i++) rec.onUnmatched("harry-weather", `h${i}.example.com`);
    await flush();
    expect(pushes).toHaveLength(ALERTS_PER_HOUR);
    expect(store.pending("harry-weather")).toHaveLength(8);
    clock.advance(HOUR + 1);
    rec.onUnmatched("harry-weather", "h7.example.com");
    await flush();
    expect(pushes).toHaveLength(ALERTS_PER_HOUR + 1);
  });

  it("the push is an STK-signed app-access relay that names no app or host", async () => {
    const priv = new Uint8Array(32).fill(5);
    const kp: Keypair = { privateKey: priv, publicKey: ed.getPublicKey(priv) };
    const signer = { boxPublicKey: () => kp.publicKey, signAsBox: (m: Uint8Array) => ed.sign(m, priv) } as unknown as BoxSigner;
    const sent: Array<{ url: string; raw: string }> = [];
    const fetchImpl = (async (url: unknown, init: { body: string }) => {
      sent.push({ url: String(url), raw: init.body });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const store = new AppAccessStore(null, null);
    const rec = buildAccessRequestRecorder({
      store,
      appName: () => "weather",
      sinks: () => ({
        push: () => sendPushRelay({ category: "app-access", targetUsername: "harry", signer, controlPlaneBaseUrl: "https://flagshipserver.com", fetchImpl }),
      }),
    });
    rec.onUnmatched("harry-weather", "secret-tracker.example.com");
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://flagshipserver.com/api/push/relay");
    const body = JSON.parse(sent[0]!.raw);
    expect(body.request.category).toBe("app-access");
    expect(body.request.targetUsername).toBe("harry");
    for (const leak of ["secret-tracker", "example.com", "weather", "harry-weather"]) expect(sent[0]!.raw).not.toContain(leak);
    expect(body.request.sealedPayloadHex).toBe("00".repeat(32));
    const sig = Uint8Array.from(Buffer.from(body.signature, "hex"));
    expect(verifyPushRelayRequest(body.request, sig, kp.publicKey)).toBe(true);
  });
});

describe("the screens event bus", () => {
  it("fans out to subscribers until they leave", () => {
    const bus = new ScreensEventBus();
    const got: string[] = [];
    const off = bus.subscribe((e) => got.push(e.serviceId));
    bus.subscribe(() => {
      throw new Error("broken socket");
    });
    bus.publish({ type: "access-request", serviceId: "a" });
    off();
    bus.publish({ type: "access-request", serviceId: "b" });
    expect(got).toEqual(["a"]);
    expect(bus.subscriberCount).toBe(1);
  });
});

describe("bootEgress wiring", () => {
  const noDocker: CommandRunner = {
    async run() {
      throw Object.assign(new Error("no docker"), { code: "ENOENT" });
    },
    async capture() {
      throw Object.assign(new Error("no docker"), { code: "ENOENT" });
    },
  };

  it("install records requests and emits, uninstall forgets, the summary counts", async () => {
    const installed = new Map([["harry-weather", { name: "weather", declared: ["api.open-meteo.com"] }]]);
    const owner = ed.getPublicKey(new Uint8Array(32).fill(42));
    const rt = await bootEgress({
      cmd: noDocker,
      serverDomain: "home.harry.flagship.services",
      owner: { username: "harry", irkPub: owner },
      app: (id) => installed.get(id) ?? null,
      log: () => {},
      env: {},
      dockerWaitMs: 0,
    });
    const events: AccessRequestEvent[] = [];
    rt.setAccessAlerts({ emit: (e) => events.push(e) });
    await rt.noteInstalled("harry-weather", ["api.open-meteo.com"]);
    expect(events).toEqual([{ type: "access-request", serviceId: "harry-weather" }]);
    expect(rt.appEgress!.access("harry-weather")).toEqual({ rules: 0, pending: 1 });
    installed.delete("harry-weather");
    await rt.pruneUninstalled();
    expect(rt.appEgress!.access("harry-weather")).toEqual({ rules: 0, pending: 0 });
  });

  it("FLAGSHIP_EGRESS=off has no access endpoints", async () => {
    const rt = await bootEgress({ cmd: noDocker, serverDomain: "b", app: () => null, log: () => {}, env: { FLAGSHIP_EGRESS: "off" } });
    expect(rt.appEgress).toBeNull();
    await rt.noteInstalled("x", ["a.com"]);
  });
});
