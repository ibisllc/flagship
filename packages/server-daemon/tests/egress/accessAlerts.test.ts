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

  it("caps each app's pending list, evicting the stalest attempt", async () => {
    const { store, rec, clock } = rig();
    for (let i = 0; i < PENDING_MAX_PER_APP + 5; i++) {
      clock.advance(10);
      rec.onUnmatched("harry-weather", `h${i}.example.com`);
    }
    const hosts = store.pending("harry-weather").map((r) => r.host);
    expect(hosts).toHaveLength(PENDING_MAX_PER_APP);
    expect(hosts).not.toContain("h0.example.com");
    expect(hosts).toContain(`h${PENDING_MAX_PER_APP + 4}.example.com`);
  });

  it("manifest hosts become one draft (not per-host requests), unless the list already decides them", async () => {
    const { store, rec, events, pushes } = rig();
    await store.putSigned("harry-weather", "deny api.open-meteo.com\n", { v: 2, grant: { serverDomain: "b", serviceId: "harry-weather", listSha256: "0".repeat(64), issuedAt: 1 }, signature: "" });
    const draft = await rec.onDeclared("harry-weather", [
      { host: "api.open-meteo.com" },
      { host: "*.tile.openstreetmap.org", why: "map tiles" },
      { host: "*.tile.openstreetmap.org" },
    ]);
    expect(draft!.hosts).toEqual([{ host: "*.tile.openstreetmap.org", why: "map tiles" }]);
    expect(draft!.list).toBe("allow *.tile.openstreetmap.org   # map tiles\ndeny api.open-meteo.com\n");
    expect(store.pending("harry-weather")).toEqual([]);
    await flush();
    expect(events).toEqual([{ type: "access-request", serviceId: "harry-weather" }]);
    expect(pushes).toHaveLength(1);
    expect(await rec.onDeclared("harry-weather", [{ host: "*.tile.openstreetmap.org" }])).toBeNull();
    expect(await rec.onDeclared("harry-gone", [{ host: "a.example.com" }])).toBeNull();
    expect(events).toHaveLength(1);
  });

  it("a draft's push respects the alerts switch and the daily limit", async () => {
    const { store } = rig();
    const pushes: number[] = [];
    const events: AccessRequestEvent[] = [];
    let on = false;
    const rec = buildAccessRequestRecorder({
      store,
      appName: () => "weather",
      sinks: () => ({ push: () => void pushes.push(1), emit: (e) => events.push(e), alertsEnabled: () => on }),
    });
    await rec.onDeclared("harry-weather", [{ host: "a.example.com" }]);
    await flush();
    expect(pushes).toHaveLength(0);
    expect(events).toHaveLength(1);
    on = true;
    await rec.onDeclared("harry-weather", [{ host: "b.example.com" }]);
    await rec.onDeclared("harry-weather", [{ host: "c.example.com" }]);
    await flush();
    expect(pushes).toHaveLength(1);
    expect(events).toHaveLength(3);
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

  function relayRig(alertsEnabled: () => boolean) {
    const priv = new Uint8Array(32).fill(5);
    const kp: Keypair = { privateKey: priv, publicKey: ed.getPublicKey(priv) };
    const signer = { boxPublicKey: () => kp.publicKey, signAsBox: (m: Uint8Array) => ed.sign(m, priv) } as unknown as BoxSigner;
    const sent: Array<{ url: string; raw: string }> = [];
    const fetchImpl = (async (url: unknown, init: { body: string }) => {
      sent.push({ url: String(url), raw: init.body });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const store = new AppAccessStore(null, null);
    const events: AccessRequestEvent[] = [];
    // The same sinks the daemon wires (index.ts): category generic, gated by the switch.
    const rec = buildAccessRequestRecorder({
      store,
      appName: () => "weather",
      sinks: () => ({
        emit: (e) => events.push(e),
        alertsEnabled,
        push: () => sendPushRelay({ category: "generic", targetUsername: "harry", signer, controlPlaneBaseUrl: "https://flagshipserver.com", fetchImpl }),
      }),
    });
    return { kp, sent, store, events, rec };
  }

  it("the push is an STK-signed generic relay that names no app or host", async () => {
    const { kp, sent, rec } = relayRig(() => true);
    rec.onUnmatched("harry-weather", "secret-tracker.example.com");
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://flagshipserver.com/api/push/relay");
    const body = JSON.parse(sent[0]!.raw);
    expect(body.request.category).toBe("generic");
    expect(body.request.targetUsername).toBe("harry");
    for (const leak of ["secret-tracker", "example.com", "weather", "harry-weather", "app-access"]) expect(sent[0]!.raw).not.toContain(leak);
    expect(body.request.sealedPayloadHex).toBe("00".repeat(32));
    const sig = Uint8Array.from(Buffer.from(body.signature, "hex"));
    expect(verifyPushRelayRequest(body.request, sig, kp.publicKey)).toBe(true);
  });

  it("with alerts off the box never calls the relay, but still records and emits", async () => {
    const { sent, store, events, rec } = relayRig(() => false);
    for (let i = 0; i < 3; i++) rec.onUnmatched("harry-weather", `h${i}.example.com`);
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toHaveLength(0);
    expect(store.pending("harry-weather")).toHaveLength(3);
    expect(events).toHaveLength(3);
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

  it("install drafts a list and emits, uninstall forgets, the summary shows it", async () => {
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
    // No docker: the fence is down and not opted out, so apps are held back.
    expect(rt.disabled).toBe(false);
    expect(rt.status()).toEqual({ enforced: false, reason: "docker is not available" });
    const events: AccessRequestEvent[] = [];
    rt.setAccessAlerts({ emit: (e) => events.push(e) });
    await rt.noteInstalled("harry-weather", ["api.open-meteo.com", { host: "cdn.example.com", why: "images" }]);
    expect(events).toEqual([{ type: "access-request", serviceId: "harry-weather" }]);
    expect(rt.appEgress!.access("harry-weather")).toEqual({ rules: 0, pending: 0, draft: true });
    installed.delete("harry-weather");
    await rt.pruneUninstalled();
    expect(rt.appEgress!.access("harry-weather")).toEqual({ rules: 0, pending: 0 });
  });

  it("FLAGSHIP_EGRESS=off has no access endpoints", async () => {
    const rt = await bootEgress({ cmd: noDocker, serverDomain: "b", app: () => null, log: () => {}, env: { FLAGSHIP_EGRESS: "off" } });
    expect(rt.appEgress).toBeNull();
    // Turned off on purpose: the box doesn't hold apps back for it.
    expect(rt.disabled).toBe(true);
    await rt.noteInstalled("x", ["a.com"]);
  });
});
