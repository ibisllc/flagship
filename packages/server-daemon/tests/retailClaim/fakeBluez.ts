// BlueZ in memory, seen from the claim peripheral's side of the system bus: the adapter object,
// GattManager1 / LEAdvertisingManager1 that read our exported objects the way bluetoothd does,
// and phones that write the inbox characteristic and get the outbox notifications.
import { ClaimFrameReassembler, fragmentClaimMessage } from "@flagship/protocol";
import { DbusError, MSG_CALL, ObjectTable, Variant, type CallSpec, type DbusBus, type DbusMessage, type ExportedObject } from "../../src/retailClaim/dbus.js";
import type { ClaimLink } from "../../src/retailClaim/transport.js";

export const BLUEZ_OWNER = ":1.7";
export const ADAPTER = "/org/bluez/hci0";

export class FakeBluezBus implements DbusBus {
  readonly uniqueName = ":1.50";
  readonly table = new ObjectTable();
  readonly calls: CallSpec[] = [];
  readonly matches: string[] = [];
  readonly signalsOut: Array<{ path: string; iface: string; member: string; body: unknown[] }> = [];
  private handlers = new Set<(m: DbusMessage) => void>();
  app: { path: string; objects: Map<string, Map<string, Map<string, Variant>>> } | null = null;
  advert: { path: string; props: Map<string, Variant> } | null = null;
  powered = false;
  notifyingFor = new Set<string>();
  refuseAdvert = false;
  private serial = 0;

  async call(c: CallSpec): Promise<unknown[]> {
    this.calls.push(c);
    if (c.destination === "org.freedesktop.DBus") {
      if (c.member === "GetNameOwner") return [BLUEZ_OWNER];
      if (c.member === "AddMatch") {
        this.matches.push(String(c.body?.[0]));
        return [];
      }
    }
    if (c.interface === "org.freedesktop.DBus.ObjectManager" && c.path === "/") {
      return [
        new Map([
          ["/org/bluez", new Map([["org.bluez.AgentManager1", new Map()]])],
          [ADAPTER, new Map([["org.bluez.Adapter1", new Map()], ["org.bluez.GattManager1", new Map()], ["org.bluez.LEAdvertisingManager1", new Map()]])],
        ]),
      ];
    }
    if (c.interface === "org.freedesktop.DBus.Properties" && c.member === "Set") {
      if (c.body?.[1] === "Powered") this.powered = (c.body[2] as Variant).value === true;
      return [];
    }
    if (c.interface === "org.bluez.GattManager1" && c.member === "RegisterApplication") {
      const root = String(c.body?.[0]);
      const r = await this.fromBluez({ path: root, interface: "org.freedesktop.DBus.ObjectManager", member: "GetManagedObjects" });
      this.app = { path: root, objects: r.body[0] as Map<string, Map<string, Map<string, Variant>>> };
      return [];
    }
    if (c.interface === "org.bluez.GattManager1" && c.member === "UnregisterApplication") {
      if (!this.app) throw new DbusError("org.bluez.Error.DoesNotExist", "no app");
      this.app = null;
      return [];
    }
    if (c.interface === "org.bluez.LEAdvertisingManager1" && c.member === "RegisterAdvertisement") {
      if (this.refuseAdvert) throw new DbusError("org.bluez.Error.Failed", "Failed to register advertisement");
      if (this.advert) throw new DbusError("org.bluez.Error.AlreadyExists", "already");
      const path = String(c.body?.[0]);
      const r = await this.fromBluez({ path, interface: "org.freedesktop.DBus.Properties", member: "GetAll", signature: "s", body: ["org.bluez.LEAdvertisement1"] });
      this.advert = { path, props: r.body[0] as Map<string, Variant> };
      return [];
    }
    if (c.interface === "org.bluez.LEAdvertisingManager1" && c.member === "UnregisterAdvertisement") {
      if (!this.advert) throw new DbusError("org.bluez.Error.DoesNotExist", "no advert");
      this.advert = null;
      return [];
    }
    if (c.interface === "org.bluez.Device1" && c.member === "Disconnect") {
      this.disconnect(c.path);
      return [];
    }
    throw new DbusError("org.freedesktop.DBus.Error.UnknownMethod", `${c.interface}.${c.member}`);
  }

  emitSignal(path: string, iface: string, member: string, _signature: string, body: unknown[]): void {
    this.signalsOut.push({ path, iface, member, body });
    if (member !== "PropertiesChanged" || !this.app) return;
    const value = (body[1] as Map<string, Variant>).get("Value");
    if (!value) return;
    for (const p of this.phones.values()) if (p.subscribed) p.notified(value.value as Uint8Array);
  }

  export(path: string, obj: ExportedObject): void {
    this.table.objects.set(path, obj);
  }
  unexport(path: string): void {
    this.table.objects.delete(path);
  }
  onSignal(cb: (m: DbusMessage) => void): () => void {
    this.handlers.add(cb);
    return () => this.handlers.delete(cb);
  }
  async addMatch(rule: string): Promise<void> {
    this.matches.push(rule);
  }
  close(): void {}

  /** A call into our exported objects as bluetoothd makes it (or as `sender` makes it). */
  fromBluez(m: Partial<DbusMessage>, sender = BLUEZ_OWNER) {
    return this.table.dispatch({ type: MSG_CALL, flags: 0, serial: ++this.serial, signature: "", body: [], sender, ...m });
  }

  signal(m: Partial<DbusMessage>, sender = BLUEZ_OWNER): void {
    const msg: DbusMessage = { type: 4, flags: 1, serial: ++this.serial, signature: "", body: [], sender, ...m };
    for (const h of this.handlers) h(msg);
  }

  readonly phones = new Map<string, FakePhone>();

  phone(name: string, mtu = 185): FakePhone {
    const p = new FakePhone(this, `${ADAPTER}/dev_${name}`, mtu);
    this.phones.set(p.device, p);
    return p;
  }

  disconnect(device: string): void {
    const p = this.phones.get(device);
    if (p) p.dropped();
    this.signal({ path: device, interface: "org.freedesktop.DBus.Properties", member: "PropertiesChanged", signature: "sa{sv}as", body: ["org.bluez.Device1", new Map([["Connected", new Variant("b", false)]]), []] });
  }

  inboxPath(): string {
    return this.charPath("6f3c1a01-5e1b-4f0a-9c55-f1a95e5b0c01");
  }
  outboxPath(): string {
    return this.charPath("6f3c1a02-5e1b-4f0a-9c55-f1a95e5b0c01");
  }
  private charPath(uuid: string): string {
    for (const [path, ifaces] of this.app?.objects ?? []) {
      if (ifaces.get("org.bluez.GattCharacteristic1")?.get("UUID")?.value === uuid) return path;
    }
    throw new Error(`no characteristic ${uuid}`);
  }
}

/** One phone: a GATT client of the box's application. As a ClaimLink it is the phone's end. */
export class FakePhone implements ClaimLink {
  readonly kind = "ble" as const;
  readonly id: string;
  subscribed = false;
  readonly frames: Uint8Array[] = [];
  private readonly reassembler = new ClaimFrameReassembler();
  private handlers: Array<(m: Uint8Array) => void> = [];
  private closers: Array<() => void> = [];
  closed = false;

  constructor(
    private readonly bus: FakeBluezBus,
    readonly device: string,
    readonly mtu: number,
  ) {
    this.id = device;
  }

  async subscribe(): Promise<void> {
    this.subscribed = true;
    if (!this.bus.notifyingFor.size) await this.bus.fromBluez({ path: this.bus.outboxPath(), interface: "org.bluez.GattCharacteristic1", member: "StartNotify" });
    this.bus.notifyingFor.add(this.device);
  }

  async write(frame: Uint8Array): Promise<void> {
    await this.bus.fromBluez({
      path: this.bus.inboxPath(),
      interface: "org.bluez.GattCharacteristic1",
      member: "WriteValue",
      signature: "aya{sv}",
      body: [frame, new Map([["device", new Variant("o", this.device)], ["mtu", new Variant("q", this.mtu)], ["type", new Variant("s", "command")]])],
    });
  }

  async send(msg: Uint8Array): Promise<void> {
    if (this.closed) throw new Error("link closed");
    for (const f of fragmentClaimMessage(msg, this.mtu - 3)) await this.write(f);
  }

  notified(f: Uint8Array): void {
    this.frames.push(f);
    const whole = this.reassembler.push(f);
    if (whole) for (const h of this.handlers) h(whole);
  }

  onMessage(cb: (msg: Uint8Array) => void): void {
    this.handlers.push(cb);
  }
  onClose(cb: () => void): void {
    this.closers.push(cb);
  }
  dropped(): void {
    if (this.closed) return;
    this.closed = true;
    this.subscribed = false;
    for (const c of this.closers) c();
  }
  close(): void {
    this.bus.disconnect(this.device);
  }
}
