import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BOX_CLAIM_BLE_SERVICE_UUID, hybridSigKeygen, hybridSign, verifyBoxClaimReceipt, type BoxClaimBoxMessage } from "@flagship/protocol";
import { BluezPeripheral, advertServiceData, frameSizeForMtu } from "../../src/retailClaim/bluez.js";
import { ClaimStateStore } from "../../src/retailClaim/claimState.js";
import { RetailClaimService, type ClaimIdentity } from "../../src/retailClaim/claimService.js";
import { Variant } from "../../src/retailClaim/dbus.js";
import { FakePowerKeySource } from "../../src/retailClaim/powerKey.js";
import { SetupCodeStore } from "../../src/retailClaim/setupCode.js";
import type { ClaimLink } from "../../src/retailClaim/transport.js";
import { ADAPTER, FakeBluezBus } from "./fakeBluez.js";
import { PhoneDriver } from "./phoneDriver.js";

const ID = "0123456789abcdef0011223344556677";
const tick = () => new Promise((r) => setImmediate(r));

async function setup(opts: { mtu?: number } = {}) {
  const bus = new FakeBluezBus();
  const p = new BluezPeripheral({ bus });
  const links: ClaimLink[] = [];
  p.onLink((l) => links.push(l));
  await p.advertise({ id: ID, state: "unclaimed" });
  return { bus, p, links, phone: bus.phone("AA_BB", opts.mtu ?? 185) };
}

describe("advert layout", () => {
  it("puts version, state and the first 8 id bytes in the scan response", () => {
    expect(Buffer.from(advertServiceData("unclaimed", ID)).toString("hex")).toBe("01010123456789abcdef");
    expect(Buffer.from(advertServiceData("reset-window", ID)).toString("hex")).toBe("01020123456789abcdef");
    expect(() => advertServiceData("unclaimed", "0123")).toThrow();
  });

  it("sizes frames from the ATT MTU", () => {
    expect(frameSizeForMtu(undefined)).toBe(20);
    expect(frameSizeForMtu(23)).toBe(20);
    expect(frameSizeForMtu(185)).toBe(182);
    expect(frameSizeForMtu(1000)).toBe(512);
    expect(frameSizeForMtu(5)).toBe(20);
  });
});

describe("BluezPeripheral on a fake BlueZ", () => {
  it("powers the adapter, registers the GATT layout and an advert with no name", async () => {
    const { bus } = await setup();
    expect(bus.powered).toBe(true);
    expect(bus.matches.some((m) => m.includes("NameOwnerChanged"))).toBe(true);
    const objs = bus.app!.objects;
    const svc = [...objs.values()].find((i) => i.has("org.bluez.GattService1"))!.get("org.bluez.GattService1")!;
    expect(svc.get("UUID")!.value).toBe(BOX_CLAIM_BLE_SERVICE_UUID);
    expect(svc.get("Primary")!.value).toBe(true);
    const chrcs = [...objs.values()].filter((i) => i.has("org.bluez.GattCharacteristic1")).map((i) => i.get("org.bluez.GattCharacteristic1")!);
    expect(chrcs.map((c) => c.get("Flags")!.value)).toEqual([["write-without-response", "write"], ["notify"]]);
    const ad = bus.advert!.props;
    expect(ad.get("Type")!.value).toBe("peripheral");
    expect(ad.get("ServiceUUIDs")!.value).toEqual([BOX_CLAIM_BLE_SERVICE_UUID]);
    const data = (ad.get("ScanResponseServiceData")!.value as Map<string, Variant>).get(BOX_CLAIM_BLE_SERVICE_UUID)!.value as Uint8Array;
    expect(Buffer.from(data).toString("hex")).toBe("01010123456789abcdef");
    expect(ad.has("LocalName")).toBe(false);
    expect(ad.get("Includes")!.value).toEqual([]);
    expect(ad.get("Timeout")!.value).toBe(600);
  });

  it("re-registers the advert when the state changes, and not otherwise", async () => {
    const { bus, p } = await setup();
    const regs = () => bus.calls.filter((c) => c.member === "RegisterAdvertisement").length;
    await p.advertise({ id: ID, state: "unclaimed" });
    expect(regs()).toBe(1);
    await p.advertise({ id: ID, state: "reset-window" });
    expect(regs()).toBe(2);
    const data = (bus.advert!.props.get("ScanResponseServiceData")!.value as Map<string, Variant>).get(BOX_CLAIM_BLE_SERVICE_UUID)!.value as Uint8Array;
    expect(data[1]).toBe(2);
  });

  it("carries messages both ways in frames that fit the MTU", async () => {
    const { bus, links, phone } = await setup({ mtu: 64 });
    await phone.subscribe();
    const got: Uint8Array[] = [];
    const msg = Uint8Array.from({ length: 300 }, (_, i) => i & 0xff);
    await phone.send(msg);
    expect(links).toHaveLength(1);
    links[0]!.onMessage((m) => got.push(m));
    expect(Buffer.from(got[0]!).equals(Buffer.from(msg))).toBe(true);
    expect(links[0]!.id).toBe("ble-1");
    expect(links[0]!.id).not.toContain("AA_BB");

    const back: Uint8Array[] = [];
    phone.onMessage((m) => back.push(m));
    await links[0]!.send(Uint8Array.from({ length: 500 }, (_, i) => (i * 7) & 0xff));
    expect(back).toHaveLength(1);
    expect(back[0]!.length).toBe(500);
    expect(Math.max(...phone.frames.map((f) => f.length))).toBe(61);
    expect(bus.signalsOut.every((s) => s.member === "PropertiesChanged")).toBe(true);
  });

  it("holds notifications until the phone subscribes", async () => {
    const { links, phone } = await setup();
    await phone.send(Uint8Array.of(1, 2, 3));
    const back: Uint8Array[] = [];
    phone.onMessage((m) => back.push(m));
    await links[0]!.send(Uint8Array.of(9));
    expect(back).toHaveLength(0);
    await phone.subscribe();
    expect(back).toEqual([Uint8Array.of(9)]);
  });

  it("refuses a second phone while one is linked, and writes from anyone but BlueZ", async () => {
    const { bus, links, phone } = await setup();
    await phone.send(Uint8Array.of(1));
    const other = bus.phone("CC_DD");
    await expect(other.send(Uint8Array.of(1))).rejects.toMatchObject({ name: "org.bluez.Error.InProgress" });
    await expect(
      bus.fromBluez(
        { path: bus.inboxPath(), interface: "org.bluez.GattCharacteristic1", member: "WriteValue", signature: "aya{sv}", body: [Uint8Array.of(0xc0, 1), new Map([["device", new Variant("o", phone.device)]])] },
        ":1.99",
      ),
    ).rejects.toMatchObject({ name: "org.bluez.Error.NotAuthorized" });
    expect(links).toHaveLength(1);
  });

  it("closes the link on a bad frame, on disconnect, and when the service closes it", async () => {
    const { bus, links, phone } = await setup();
    await expect(phone.write(Uint8Array.of(0x40, 1))).rejects.toMatchObject({ name: "org.bluez.Error.NotPermitted" });
    expect(links[0]).toBeUndefined();
    await phone.write(Uint8Array.of(0x80, 1));
    let closed = 0;
    links[0]!.onClose(() => closed++);
    await phone.write(Uint8Array.of(0x80, 2));
    expect(closed).toBe(1);

    const second = bus.phone("EE_FF");
    await second.send(Uint8Array.of(5));
    links[1]!.onClose(() => closed++);
    bus.disconnect(second.device);
    expect(closed).toBe(2);
    const third = bus.phone("11_22");
    await third.send(Uint8Array.of(5));
    links[2]!.close();
    await tick();
    expect(closed).toBe(2);
    expect(bus.calls.filter((c) => c.member === "Disconnect").map((c) => c.path)).toContain(third.device);
  });

  it("ignores a disconnect signal that BlueZ did not send", async () => {
    const { bus, links, phone } = await setup();
    await phone.send(Uint8Array.of(1));
    bus.signal({ path: phone.device, interface: "org.freedesktop.DBus.Properties", member: "PropertiesChanged", signature: "sa{sv}as", body: ["org.bluez.Device1", new Map([["Connected", new Variant("b", false)]]), []] }, ":1.99");
    let closed = false;
    links[0]!.onClose(() => (closed = true));
    expect(closed).toBe(false);
  });

  it("stop withdraws the advert but keeps an open link and its GATT service until it closes", async () => {
    const { bus, p, links, phone } = await setup();
    await phone.subscribe();
    await phone.send(Uint8Array.of(1));
    await p.stop();
    expect(bus.advert).toBeNull();
    expect(bus.app).not.toBeNull();
    const back: Uint8Array[] = [];
    phone.onMessage((m) => back.push(m));
    await links[0]!.send(Uint8Array.of(7));
    await phone.send(Uint8Array.of(2));
    expect(back).toEqual([Uint8Array.of(7)]);
    const late = bus.phone("99_99");
    await expect(late.send(Uint8Array.of(1))).rejects.toMatchObject({ name: "org.bluez.Error.InProgress" });
    links[0]!.close();
    await tick();
    expect(bus.app).toBeNull();
    await expect(late.send(Uint8Array.of(1))).rejects.toThrow();
  });

  it("stop with no link takes the GATT application down too; close cleans up everything", async () => {
    const { bus, p } = await setup();
    await p.stop();
    expect(bus.app).toBeNull();
    expect(bus.advert).toBeNull();
    await p.advertise({ id: ID, state: "unclaimed" });
    expect(bus.app).not.toBeNull();
    await p.close();
    expect(bus.app).toBeNull();
    expect(bus.advert).toBeNull();
    expect(bus.table.objects.size).toBe(0);
  });

  it("registers again after bluetoothd restarts", async () => {
    const { bus, links, phone } = await setup();
    await phone.send(Uint8Array.of(1));
    let closed = false;
    links[0]!.onClose(() => (closed = true));
    bus.app = null;
    bus.advert = null;
    bus.signal({ path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus", member: "NameOwnerChanged", signature: "sss", body: ["org.bluez", ":1.7", ":1.8"] }, "org.freedesktop.DBus");
    for (let i = 0; i < 10; i++) await tick();
    expect(closed).toBe(true);
    expect(bus.app).not.toBeNull();
    expect(bus.advert).not.toBeNull();
  });

  it("fails advertise when BlueZ refuses the advert (no experimental scan response)", async () => {
    const bus = new FakeBluezBus();
    bus.refuseAdvert = true;
    const p = new BluezPeripheral({ bus, adapterPath: ADAPTER });
    await expect(p.advertise({ id: ID, state: "unclaimed" })).rejects.toThrow(/register advertisement/);
  });
});

describe("the claim service on the BlueZ peripheral", () => {
  it("keeps the claiming phone after the advert stops, through the network step", async () => {
    const t0 = 1_800_000_000_000;
    let now = t0;
    const dir = mkdtempSync(join(tmpdir(), "retail-bluez-"));
    const bus = new FakeBluezBus();
    const keys = new FakePowerKeySource();
    const connects: Array<string | null> = [];
    const provisioned: string[] = [];
    const svc = new RetailClaimService({
      now: () => now,
      bootAt: t0,
      store: new ClaimStateStore(join(dir, "claim-state.json"), join(dir, "reset-marker.json")),
      codes: new SetupCodeStore(join(dir, "setup-code.json")),
      peripheral: new BluezPeripheral({ bus }),
      keys,
      display: { show: async () => {}, clear: async () => {} },
      verifyRecipe: () => ({ ok: true, serverDomain: "home.harry.flagship.services", serial: "retail-serial-1-xxxx" }),
      createIdentity: async (): Promise<ClaimIdentity> => {
        const { publicKey, secretKey } = hybridSigKeygen(crypto.getRandomValues(new Uint8Array(32)), crypto.getRandomValues(new Uint8Array(32)));
        return { stkHybridPubHex: Buffer.from(publicKey).toString("hex"), bootKeyBindingSha256: "", sign: (purpose, payload) => hybridSign(secretKey, purpose, payload) };
      },
      wipe: async () => {},
      network: { scan: async () => [], connect: async (w) => (connects.push(w?.ssid ?? null), { ok: true, via: w ? "wifi" : "ethernet" }) },
      provision: async (text) => void provisioned.push(text),
      model: "test",
      imageVersion: "0.4.0",
    });
    await svc.start({ timer: false });
    const settle = async () => {
      await svc.tick();
      await svc.settle();
      for (let i = 0; i < 5; i++) await tick();
    };
    now += 15_000;
    await settle();
    expect(bus.advert).not.toBeNull();

    const phone = bus.phone("AA_BB", 185);
    await phone.subscribe();
    const p = new PhoneDriver(phone, settle);
    const ch = await p.handshake("open");
    await p.send({ t: "arm" });
    expect((await p.next()).t).toBe("armed");
    now += 3_000;
    keys.down();
    now += 120;
    keys.up();
    now += 2_400;
    await settle();
    await p.until("press-result");
    await p.send({ t: "claim", recipe: "recipe-text" });
    const { msg } = await p.until("receipt");
    verifyBoxClaimReceipt(msg.receipt, { transcriptHex: ch.transcriptHex, mode: "open", serverDomain: "home.harry.flagship.services", serial: "retail-serial-1-xxxx" });
    await settle();
    expect(svc.lifecycle).toBe("claimed");
    expect(bus.advert).toBeNull();
    expect(bus.app).not.toBeNull();
    expect(phone.closed).toBe(false);

    await p.send({ t: "network", wifi: null });
    const seen: BoxClaimBoxMessage[] = [];
    for (;;) {
      const m = await p.next();
      seen.push(m);
      if (m.t === "network-status" && m.stage === "online") break;
    }
    await settle();
    expect(connects).toEqual([null]);
    expect(provisioned).toEqual(["recipe-text"]);

    await svc.stop();
    expect(bus.app).toBeNull();
    expect(bus.table.objects.size).toBe(0);
  });
});
