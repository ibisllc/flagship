import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BOX_CLAIM_ADVERTISE_MS,
  BOX_CLAIM_GRANT_MS,
  BOX_CLAIM_PRESS_WINDOW_MS,
  BOX_CLAIM_RESET_WINDOW_MS,
  BOX_SETUP_CODE_TTL_MS,
  setupCodeKey,
  setupCodeMailboxId,
  parseSetupCodeLink,
} from "@flagship/protocol";
import { BoxClaimMachine } from "../../src/retailClaim/claimMachine.js";
import { ClaimStateStore } from "../../src/retailClaim/claimState.js";
import { codeScreen, qrToText } from "../../src/retailClaim/codeDisplay.js";
import { connectAndDiagnose, nmKeyfile, nmcliJoinFailure, parseNmcliWifiList, type NetworkProbes } from "../../src/retailClaim/network.js";
import {
  INPUT_EVENT_SIZE,
  LOGIND_DROP_IN,
  PowerKeyBursts,
  ensureLogindPowerKeyIgnored,
  findPowerButtonEvents,
  parsePowerKeyEvents,
  type PowerKeyBurst,
} from "../../src/retailClaim/powerKey.js";
import { RESET_LOCK_POINT, clearsResetMarkerOnWindowEnd, writesResetMarkerAt } from "../../src/retailClaim/resetPolicy.js";
import { SetupCodeStore } from "../../src/retailClaim/setupCode.js";
import { encodeQr } from "../../src/qrSvg.js";

const T0 = 1_790_000_000_000;
const burst = (count: number, at: number, long = false): PowerKeyBurst => ({ count, long, startedAt: at, endedAt: at + count * 300 });

describe("power key bursts", () => {
  const run = (edges: Array<[number, "d" | "u"]>, end: number) => {
    const out: PowerKeyBurst[] = [];
    const b = new PowerKeyBursts(T0, (x) => out.push(x));
    for (const [t, e] of edges) e === "d" ? b.keyDown(T0 + t) : b.keyUp(T0 + t);
    b.tick(T0 + end);
    return out;
  };

  it("ignores bounce in the first seconds", () => {
    expect(run([[1_000, "d"], [1_100, "u"]], 30_000)).toEqual([]);
  });

  it("counts one short press", () => {
    expect(run([[20_000, "d"], [20_150, "u"]], 30_000)).toEqual([{ count: 1, long: false, startedAt: T0 + 20_000, endedAt: T0 + 20_150 }]);
  });

  it("joins presses closer than the gap and ends the burst after the quiet time", () => {
    const edges: Array<[number, "d" | "u"]> = [];
    for (let i = 0; i < 5; i++) edges.push([20_000 + i * 500, "d"], [20_000 + i * 500 + 100, "u"]);
    expect(run(edges, 22_500 + 1_000)).toEqual([]);
    expect(run(edges, 30_000)).toMatchObject([{ count: 5, long: false }]);
  });

  it("splits presses further apart than the gap", () => {
    expect(run([[20_000, "d"], [20_100, "u"], [21_700, "d"], [21_800, "u"]], 30_000)).toMatchObject([{ count: 1 }, { count: 1 }]);
  });

  it("marks a held press as long", () => {
    expect(run([[20_000, "d"], [22_000, "u"]], 30_000)).toMatchObject([{ count: 1, long: true }]);
  });
});

describe("evdev", () => {
  const ev = (type: number, code: number, value: number) => {
    const b = new Uint8Array(INPUT_EVENT_SIZE);
    const v = new DataView(b.buffer);
    v.setUint16(16, type, true);
    v.setUint16(18, code, true);
    v.setInt32(20, value, true);
    return b;
  };
  it("reads KEY_POWER edges and drops repeats and other keys", () => {
    const buf = new Uint8Array([...ev(1, 116, 1), ...ev(0, 0, 0), ...ev(1, 116, 2), ...ev(1, 30, 1), ...ev(1, 116, 0)]);
    expect(parsePowerKeyEvents(buf)).toEqual(["down", "up"]);
  });
  it("finds the power button nodes", () => {
    const proc = `I: Bus=0019 Vendor=0000 Product=0001 Version=0000
N: Name="Power Button"
P: Phys=PNP0C0C/button/input0
H: Handlers=kbd event0

I: Bus=0019 Vendor=0000 Product=0001 Version=0000
N: Name="Power Button"
P: Phys=LNXPWRBN/button/input0
H: Handlers=kbd event1

I: Bus=0011 Vendor=0001 Product=0001 Version=ab41
N: Name="AT Translated Set 2 keyboard"
H: Handlers=sysrq kbd event2 leds
`;
    expect(findPowerButtonEvents(proc)).toEqual(["/dev/input/event0", "/dev/input/event1"]);
    expect(findPowerButtonEvents('N: Name="pwr_button"\nH: Handlers=kbd event3\n')).toEqual(["/dev/input/event3"]);
  });
  it("writes the logind drop-in once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "logind-"));
    const path = join(dir, "logind.conf.d", "50-flagship-power-key.conf");
    const ran: string[] = [];
    const cmd = { run: async (c: string, a: string[]) => void ran.push([c, ...a].join(" ")) };
    expect(await ensureLogindPowerKeyIgnored(cmd, { path })).toBe("written");
    expect(readFileSync(path, "utf-8")).toBe(LOGIND_DROP_IN);
    expect(LOGIND_DROP_IN).toContain("HandlePowerKey=ignore");
    expect(LOGIND_DROP_IN).toContain("HandlePowerKeyLongPress=ignore");
    expect(await ensureLogindPowerKeyIgnored(cmd, { path })).toBe("present");
    expect(ran).toEqual(["systemctl kill -s HUP systemd-logind.service"]);
  });
});

describe("claim machine", () => {
  it("advertises for 10 minutes after power-on, then goes quiet", () => {
    const m = new BoxClaimMachine("unclaimed", T0);
    expect(m.advertState(T0 + 1)).toBe("unclaimed");
    expect(m.advertState(T0 + BOX_CLAIM_ADVERTISE_MS)).toBe(null);
    m.onBurst(burst(5, T0 + BOX_CLAIM_ADVERTISE_MS + 1_000), T0 + BOX_CLAIM_ADVERTISE_MS + 3_000);
    expect(m.advertState(T0 + BOX_CLAIM_ADVERTISE_MS + 4_000)).toBe("unclaimed");
  });

  it("a claimed box is silent; 5 presses open the reset window for 10 minutes", () => {
    const m = new BoxClaimMachine("claimed", T0);
    expect(m.advertState(T0 + 1)).toBe(null);
    expect(m.onBurst(burst(1, T0 + 20_000), T0 + 22_000).effects).toEqual([]);
    expect(m.onBurst(burst(3, T0 + 20_000), T0 + 22_000).effects).toEqual([]);
    expect(m.onBurst(burst(5, T0 + 30_000), T0 + 33_000).effects).toEqual(["reset-window-opened"]);
    expect(m.advertState(T0 + 34_000)).toBe("reset-window");
    expect(m.tick(T0 + 33_000 + BOX_CLAIM_RESET_WINDOW_MS).effects).toEqual(["reset-window-closed"]);
    expect(m.lifecycle).toBe("claimed");
    expect(m.advertState(T0 + 34_000 + BOX_CLAIM_RESET_WINDOW_MS)).toBe(null);
  });

  it("a locked box takes only the 5-press reset", () => {
    const m = new BoxClaimMachine("locked", T0);
    expect(m.claimable(T0 + 1, true)).toBe(false);
    m.onBurst(burst(5, T0 + 20_000), T0 + 23_000);
    expect(m.advertState(T0 + 24_000)).toBe("reset-window");
  });

  it("3 presses ask for the code only while a claim is possible", () => {
    const m = new BoxClaimMachine("unclaimed", T0);
    expect(m.onBurst(burst(3, T0 + 20_000), T0 + 22_000).effects).toEqual(["show-code"]);
    expect(m.onBurst(burst(3, T0 + BOX_CLAIM_ADVERTISE_MS + 1), T0 + BOX_CLAIM_ADVERTISE_MS + 2_000).effects).toEqual([]);
  });

  it("one short press after arm grants one claim", () => {
    const m = new BoxClaimMachine("unclaimed", T0);
    expect(m.arm("a", T0 + 15_000).send).toEqual([{ link: "a", msg: { t: "armed" } }]);
    const out = m.onBurst(burst(1, T0 + 19_000), T0 + 21_400);
    expect(out.send).toEqual([
      { link: "a", msg: { t: "press", atMs: 4_000, count: 1, long: false } },
      { link: "a", msg: { t: "press-result", ok: true } },
    ]);
    expect(m.takeGrant("b", T0 + 22_000)).toBe(false);
    expect(m.takeGrant("a", T0 + 22_000)).toBe(true);
    expect(m.takeGrant("a", T0 + 22_001)).toBe(false);
  });

  it("refuses two presses, a held press, a late press and no press", () => {
    const at = T0 + 15_000;
    const cases: Array<[PowerKeyBurst, string]> = [
      [burst(2, at + 3_000), "burst"],
      [burst(1, at + 3_000, true), "long-press"],
      [burst(1, at + BOX_CLAIM_PRESS_WINDOW_MS + 500), "late"],
    ];
    for (const [b, reason] of cases) {
      const m = new BoxClaimMachine("unclaimed", T0);
      m.arm("a", at);
      expect(m.onBurst(b, b.endedAt + 2_000).send[1]).toEqual({ link: "a", msg: { t: "press-result", ok: false, reason } });
      expect(m.takeGrant("a", b.endedAt + 2_100)).toBe(false);
    }
    const m = new BoxClaimMachine("unclaimed", T0);
    m.arm("a", at);
    expect(m.tick(at + BOX_CLAIM_PRESS_WINDOW_MS + 1).send).toEqual([{ link: "a", msg: { t: "press-result", ok: false, reason: "no-press" } }]);
  });

  it("ignores a press that began before arm", () => {
    const m = new BoxClaimMachine("unclaimed", T0);
    m.arm("a", T0 + 15_000);
    expect(m.onBurst(burst(1, T0 + 14_000), T0 + 16_500).send).toEqual([]);
  });

  it("aborts both sessions when a second phone arms inside the press window", () => {
    const m = new BoxClaimMachine("unclaimed", T0);
    m.arm("a", T0 + 15_000);
    const out = m.arm("b", T0 + 18_000);
    expect(out.send).toEqual([
      { link: "a", msg: { t: "press-result", ok: false, reason: "contention" } },
      { link: "b", msg: { t: "press-result", ok: false, reason: "contention" } },
    ]);
    expect(m.onBurst(burst(1, T0 + 19_000), T0 + 21_000).send).toEqual([]);
  });

  it("contention also cancels a grant already given", () => {
    const m = new BoxClaimMachine("unclaimed", T0);
    m.arm("a", T0 + 15_000);
    m.onBurst(burst(1, T0 + 17_000), T0 + 19_500);
    m.arm("b", T0 + 20_000);
    expect(m.takeGrant("a", T0 + 20_500)).toBe(false);
  });

  it("a grant lapses", () => {
    const m = new BoxClaimMachine("unclaimed", T0);
    m.arm("a", T0 + 15_000);
    m.onBurst(burst(1, T0 + 17_000), T0 + 19_500);
    m.tick(T0 + 19_500 + BOX_CLAIM_GRANT_MS);
    expect(m.takeGrant("a", T0 + 19_500 + BOX_CLAIM_GRANT_MS)).toBe(false);
  });

  it("five wrong codes close the radio until the next power-on", () => {
    const m = new BoxClaimMachine("unclaimed", T0);
    for (let i = 0; i < 4; i++) expect(m.onCodeFailure().effects).toEqual([]);
    expect(m.onCodeFailure().effects).toEqual(["radio-closed"]);
    expect(m.advertState(T0 + 1)).toBe(null);
    expect(m.claimable(T0 + 1, true)).toBe(false);
  });

  it("a code claims an unclaimed box after the radio window, a claimed one only in its reset window", () => {
    const u = new BoxClaimMachine("unclaimed", T0);
    u.grantForCode("m", T0 + BOX_CLAIM_ADVERTISE_MS + 10);
    expect(u.takeGrant("m", T0 + BOX_CLAIM_ADVERTISE_MS + 20)).toBe(true);
    const c = new BoxClaimMachine("claimed", T0);
    c.grantForCode("m", T0 + 20_000);
    expect(c.takeGrant("m", T0 + 20_001)).toBe(false);
  });
});

describe("claim state on disk", () => {
  const paths = () => {
    const dir = mkdtempSync(join(tmpdir(), "claim-"));
    return { dir, state: join(dir, "claim-state.json"), marker: join(dir, "reset-marker.json") };
  };
  it("starts unclaimed, remembers a claim", async () => {
    const p = paths();
    const s = new ClaimStateStore(p.state, p.marker);
    expect(await s.load()).toEqual({ lifecycle: "unclaimed", claimedAt: null });
    await s.markClaimed(T0);
    expect(await s.load()).toEqual({ lifecycle: "claimed", claimedAt: T0 });
  });
  it("a reset marker locks the box at boot", async () => {
    const p = paths();
    const s = new ClaimStateStore(p.state, p.marker);
    await s.markClaimed(T0);
    await s.writeResetMarker({ v: 1, startedAt: T0, step: "wipe-start" });
    expect((await s.load()).lifecycle).toBe("locked");
    await s.clearResetMarker();
    expect((await s.load()).lifecycle).toBe("claimed");
  });
  it("a damaged state file reads as claimed and is kept aside", async () => {
    const p = paths();
    writeFileSync(p.state, "{not json");
    const s = new ClaimStateStore(p.state, p.marker);
    expect((await s.load()).lifecycle).toBe("claimed");
    expect(readdirSync(p.dir).some((f) => f.startsWith("claim-state.json.corrupt-"))).toBe(true);
  });
});

describe("reset policy", () => {
  it("assumes the recommended rule: lock from the moment the wipe starts", () => {
    expect(RESET_LOCK_POINT).toBe("wipe-start");
    expect(writesResetMarkerAt("wipe-start")).toBe(true);
    expect(writesResetMarkerAt("reset-gesture")).toBe(false);
    expect(clearsResetMarkerOnWindowEnd()).toBe(false);
    expect(writesResetMarkerAt("reset-gesture", "reset-gesture")).toBe(true);
    expect(clearsResetMarkerOnWindowEnd("reset-gesture")).toBe(true);
  });
});

describe("setup code store", () => {
  it("keeps only the hashes, expires and ratchets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "code-"));
    const path = join(dir, "setup-code.json");
    const s = new SetupCodeStore(path);
    expect(await s.current(T0)).toBe(null);
    const { code, live } = await s.issue(T0);
    const disk = readFileSync(path, "utf-8");
    expect(disk).not.toContain(code);
    expect(Buffer.from(live.codeKey).toString("hex")).toBe(Buffer.from(setupCodeKey(code)).toString("hex"));
    expect(live.mailboxId).toBe(setupCodeMailboxId(code));
    expect((await s.current(T0 + 1))?.mailboxId).toBe(live.mailboxId);
    const again = await s.issue(T0 + 2);
    expect(again.code).not.toBe(code);
    expect((await s.current(T0 + 3))?.mailboxId).toBe(again.live.mailboxId);
    expect(await s.current(T0 + 2 + BOX_SETUP_CODE_TTL_MS)).toBe(null);
    expect(existsSync(path)).toBe(false);
    await s.issue(T0);
    await s.ratchet("claim");
    expect(await s.current(T0 + 1)).toBe(null);
  });
});

describe("network diagnosis", () => {
  const probes = (o: Partial<Record<keyof NetworkProbes, unknown>> = {}): NetworkProbes => ({
    ethernetLink: async () => (o.ethernetLink ?? true) as boolean,
    scanWifi: async () => (o.scanWifi ?? [{ ssid: "Home", security: "wpa2", signal: 80, band: "5" }]) as never,
    joinWifi: async () => (o.joinWifi ?? { ok: true }) as never,
    hasAddress: async () => (o.hasAddress ?? true) as boolean,
    resolves: async () => (o.resolves ?? true) as boolean,
    portalCheck: async () => (o.portalCheck ?? "clear") as never,
    relayReachable: async () => (o.relayReachable ?? true) as boolean,
  });
  const hosts = { control: "flagshipserver.com", relay: "flagship.services" };
  const wifi = { ssid: "Home", psk: "correct horse", regulatoryRegion: "DE", issuedAt: T0 };

  it("reports the first failing step", async () => {
    expect(await connectAndDiagnose(probes(), null, hosts)).toEqual({ ok: true, via: "ethernet" });
    expect(await connectAndDiagnose(probes({ ethernetLink: false }), null, hosts)).toEqual({ ok: false, via: "ethernet", failure: "no-link" });
    expect(await connectAndDiagnose(probes({ joinWifi: { ok: false, failure: "wrong-password" } }), wifi, hosts)).toMatchObject({ failure: "wrong-password" });
    expect(await connectAndDiagnose(probes({ scanWifi: [{ ssid: "Home", security: "enterprise", signal: 50, band: "5" }] }), wifi, hosts)).toMatchObject({ failure: "unsupported-security" });
    expect(await connectAndDiagnose(probes({ hasAddress: false }), wifi, hosts)).toMatchObject({ failure: "no-dhcp", via: "wifi" });
    expect(await connectAndDiagnose(probes({ resolves: false }), null, hosts)).toMatchObject({ failure: "no-dns" });
    expect(await connectAndDiagnose(probes({ portalCheck: "portal" }), null, hosts)).toMatchObject({ failure: "captive-portal" });
    expect(await connectAndDiagnose(probes({ portalCheck: "unreachable" }), null, hosts)).toMatchObject({ failure: "relay-unreachable" });
    expect(await connectAndDiagnose(probes({ relayReachable: false }), null, hosts)).toMatchObject({ failure: "relay-unreachable" });
  });

  it("parses nmcli's terse scan", () => {
    const out = ["Home\\:Net:WPA2:80:5180", "Home\\:Net:WPA2:40:2412", "Cafe::30:2437", "Office:WPA2 802.1X:70:5500", "New:WPA3 SAE:60:6115", "Mixed:WPA2 WPA3:55:2462", ":WPA2:20:2412"].join("\n");
    expect(parseNmcliWifiList(out)).toEqual([
      { ssid: "Home:Net", security: "wpa2", signal: 80, band: "5" },
      { ssid: "Office", security: "enterprise", signal: 70, band: "5" },
      { ssid: "New", security: "wpa3", signal: 60, band: "6" },
      { ssid: "Mixed", security: "wpa2-wpa3", signal: 55, band: "2.4" },
      { ssid: "Cafe", security: "open", signal: 30, band: "2.4" },
    ]);
  });

  it("maps nmcli join errors", () => {
    expect(nmcliJoinFailure("Error: No network with SSID 'x' found.")).toBe("network-not-found");
    expect(nmcliJoinFailure("Error: Connection activation failed: Secrets were required, but not provided")).toBe("wrong-password");
  });

  it("writes the password into a keyfile, never a command line", () => {
    const k = nmKeyfile({ ssid: "Ünï;cöde", psk: " back\\slash;pw", regulatoryRegion: "", issuedAt: 1 }, "wpa3");
    expect(k).toContain(`ssid=${[...new TextEncoder().encode("Ünï;cöde")].join(";")};`);
    expect(k).toContain("key-mgmt=sae");
    expect(k).toContain("psk=\\sback\\\\slash;pw");
    expect(nmKeyfile({ ssid: "Open", psk: "", regulatoryRegion: "", issuedAt: 1 })).not.toContain("wifi-security");
  });
});

describe("code on a monitor", () => {
  it("shows the QR and the code, and the QR holds the claim link", () => {
    const code = "B9D5MPJTB9D5MPJTB9D5";
    const screen = codeScreen(code, T0 + BOX_SETUP_CODE_TTL_MS);
    expect(screen).toContain("B9D5-MPJT-B9D5-MPJT-B9D5");
    expect(screen).toContain("Anyone who sees this code can set up this box.");
    expect(parseSetupCodeLink(`https://flagshipserver.com/claim#c=${code}&v=1`)).toBe(code);
    const m = encodeQr(`https://flagshipserver.com/claim#c=${code}&v=1`, "M");
    const text = qrToText(m);
    expect(text.split("\n")).toHaveLength(Math.ceil((m.length + 4) / 2));
  });
});

