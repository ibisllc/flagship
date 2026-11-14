// The claim peripheral on a real radio: a GATT application and an LE advertisement registered
// with BlueZ over D-Bus (docs/retail-box-setup.md §7.2, §11.1; layout in protocol boxClaim.ts).
//
// One phone at a time. BlueZ sends a characteristic's notifications to every subscribed client and
// gives an application no per-device notify, so a second phone's writes are refused while a link is
// open (org.bluez.Error.InProgress); it can at most see the first phone's sealed frames.
//
// stop() only withdraws the advert: an open claim link keeps working until it closes, and only then
// does the GATT application go too (phase 1 found the advert's end dropping the claiming phone).

import { fragmentClaimMessage, ClaimFrameReassembler, BOX_CLAIM_ADVERTISE_MS, BOX_CLAIM_ADVERT_ID_BYTES, BOX_CLAIM_ADVERT_STATE_BYTE, BOX_CLAIM_ADVERT_VERSION, BOX_CLAIM_BLE_INBOX_UUID, BOX_CLAIM_BLE_OUTBOX_UUID, BOX_CLAIM_BLE_SERVICE_UUID, type BoxClaimAdvertState } from "@flagship/protocol";
import { DbusError, Variant, type DbusBus, type DbusMessage } from "./dbus.js";
import type { ClaimAdvert, ClaimLink, ClaimPeripheral } from "./transport.js";

export const BLUEZ = "org.bluez";
const PROPS = "org.freedesktop.DBus.Properties";
const OM = "org.freedesktop.DBus.ObjectManager";
const ADAPTER = "org.bluez.Adapter1";
const DEVICE = "org.bluez.Device1";
const GATT_MANAGER = "org.bluez.GattManager1";
const ADV_MANAGER = "org.bluez.LEAdvertisingManager1";
const GATT_SERVICE = "org.bluez.GattService1";
const GATT_CHRC = "org.bluez.GattCharacteristic1";
const ADVERTISEMENT = "org.bluez.LEAdvertisement1";

/** ATT_MTU 23 leaves 20 bytes of value; ATT values stop at 512. */
export const ATT_DEFAULT_PAYLOAD = 20;
export const ATT_MAX_VALUE = 512;
/** Frames queued for a phone that has not subscribed yet; past this the link is dropped. */
const MAX_QUEUED_BYTES = 256 * 1024;

/** The scan response's service data: version, state byte, the first 8 bytes of the advert id. */
export function advertServiceData(state: BoxClaimAdvertState, idHex: string): Uint8Array {
  const id = Buffer.from(idHex, "hex");
  if (id.length < BOX_CLAIM_ADVERT_ID_BYTES || !/^[0-9a-f]+$/i.test(idHex)) throw new Error("advert id must be at least 8 hex bytes");
  return Uint8Array.from([BOX_CLAIM_ADVERT_VERSION, BOX_CLAIM_ADVERT_STATE_BYTE[state], ...id.subarray(0, BOX_CLAIM_ADVERT_ID_BYTES)]);
}

/** Frame size for a link: the ATT MTU less the 3-byte notify header, within [20, 512]. */
export function frameSizeForMtu(mtu: number | undefined): number {
  if (typeof mtu !== "number" || !Number.isFinite(mtu)) return ATT_DEFAULT_PAYLOAD;
  return Math.max(ATT_DEFAULT_PAYLOAD, Math.min(ATT_MAX_VALUE, Math.floor(mtu) - 3));
}

/**
 * What the image sets in `/etc/bluetooth/main.conf`: LE only, a resolvable private address,
 * a generic name for the GAP Device Name characteristic (never the hostname), and the
 * experimental advert properties the scan response needs (`ScanResponseServiceData`).
 */
export const BLUEZ_MAIN_CONF = `[General]
Name = Flagship
ControllerMode = le
Privacy = device
Experimental = true

[Policy]
AutoEnable = true
`;
export const BLUEZ_MAIN_CONF_PATH = "/etc/bluetooth/main.conf";

/**
 * A bluetoothd drop-in that forgets the adapter's local identity key before every start, so the
 * private addresses of one boot cannot be resolved to those of the next.
 */
export const BLUEZ_FRESH_IDENTITY_DROP_IN = `[Service]
ExecStartPre=/bin/sh -c 'rm -f /var/lib/bluetooth/*/identity'
`;
export const BLUEZ_FRESH_IDENTITY_DROP_IN_PATH = "/etc/systemd/system/bluetooth.service.d/50-flagship-fresh-identity.conf";

export interface BluezPeripheralOptions {
  bus: DbusBus;
  /** `/org/bluez/hci0`; found from BlueZ's objects when absent. */
  adapterPath?: string;
  appPath?: string;
  advertPath?: string;
  /** BlueZ withdraws the advert on its own after this, whatever the service does. */
  advertTimeoutMs?: number;
  log?: (m: string) => void;
}

class BluezLink implements ClaimLink {
  readonly kind = "ble" as const;
  private readonly reassembler = new ClaimFrameReassembler();
  private handlers: Array<(m: Uint8Array) => void> = [];
  private early: Uint8Array[] = [];
  private closers: Array<() => void> = [];
  closed = false;
  mtu: number | undefined;

  constructor(
    readonly id: string,
    readonly device: string,
    private readonly out: (frames: Uint8Array[]) => void,
    private readonly onShut: (l: BluezLink) => void,
  ) {}

  async send(msg: Uint8Array): Promise<void> {
    if (this.closed) throw new Error("link closed");
    this.out(fragmentClaimMessage(msg, frameSizeForMtu(this.mtu)));
  }

  frame(f: Uint8Array): void {
    if (this.closed) return;
    let whole: Uint8Array | null;
    try {
      whole = this.reassembler.push(f);
    } catch {
      this.close();
      return;
    }
    if (!whole) return;
    if (this.handlers.length === 0) this.early.push(whole);
    for (const h of this.handlers) h(whole);
  }

  onMessage(cb: (msg: Uint8Array) => void): void {
    this.handlers.push(cb);
    const q = this.early;
    this.early = [];
    for (const m of q) cb(m);
  }

  onClose(cb: () => void): void {
    if (this.closed) cb();
    else this.closers.push(cb);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onShut(this);
    for (const c of this.closers) c();
  }
}

export class BluezPeripheral implements ClaimPeripheral {
  private readonly bus: DbusBus;
  private readonly appPath: string;
  private readonly servicePath: string;
  private readonly inboxPath: string;
  private readonly outboxPath: string;
  private readonly advertPath: string;
  private readonly log: (m: string) => void;
  private adapter: string | null;
  private bluezOwner: string | null = null;
  private linkCb: ((l: ClaimLink) => void) | null = null;
  private link: BluezLink | null = null;
  private seq = 0;
  private advert: ClaimAdvert | null = null;
  private appRegistered = false;
  private advertRegistered = false;
  private accepting = false;
  private notifying = false;
  private queued: Uint8Array[] = [];
  private queuedBytes = 0;
  private outboxValue: Uint8Array = new Uint8Array(0);
  private started: Promise<void> | null = null;
  private unsubscribe: (() => void) | null = null;
  private ops: Promise<void> = Promise.resolve();

  constructor(private readonly o: BluezPeripheralOptions) {
    this.bus = o.bus;
    this.appPath = o.appPath ?? "/org/flagship/claim";
    this.servicePath = `${this.appPath}/service0`;
    this.inboxPath = `${this.servicePath}/char0`;
    this.outboxPath = `${this.servicePath}/char1`;
    this.advertPath = o.advertPath ?? "/org/flagship/claimadvert";
    this.adapter = o.adapterPath ?? null;
    this.log = o.log ?? (() => {});
  }

  onLink(cb: (link: ClaimLink) => void): void {
    this.linkCb = cb;
  }

  /** Serialises register/unregister steps, so a stop racing an advertise ends in a defined state. */
  private serial(fn: () => Promise<void>): Promise<void> {
    const next = this.ops.then(fn, fn);
    this.ops = next.catch(() => {});
    return next;
  }

  advertise(adv: ClaimAdvert): Promise<void> {
    return this.serial(async () => {
      advertServiceData(adv.state, adv.id);
      await this.start();
      this.accepting = true;
      await this.registerApp();
      const changed = !this.advert || this.advert.id !== adv.id || this.advert.state !== adv.state;
      this.advert = { ...adv };
      if (this.advertRegistered && changed) await this.unregisterAdvert();
      if (!this.advertRegistered) await this.registerAdvert();
    });
  }

  stop(): Promise<void> {
    return this.serial(async () => {
      this.accepting = false;
      this.advert = null;
      await this.unregisterAdvert();
      if (!this.link) await this.unregisterApp();
    });
  }

  /** Clean teardown: the advert, any link, the application and the exported objects. */
  close(): Promise<void> {
    return this.serial(async () => {
      this.accepting = false;
      this.advert = null;
      await this.unregisterAdvert();
      this.link?.close();
      await this.unregisterApp();
      for (const p of [this.advertPath, this.outboxPath, this.inboxPath, this.servicePath, this.appPath]) this.bus.unexport(p);
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.started = null;
    });
  }

  private start(): Promise<void> {
    this.started ??= this.init().catch((e) => {
      this.started = null;
      throw e;
    });
    return this.started;
  }

  private async init(): Promise<void> {
    this.exportObjects();
    this.unsubscribe = this.bus.onSignal((m) => this.onSignal(m));
    await this.bus.addMatch(`type='signal',sender='${BLUEZ}',interface='${PROPS}',member='PropertiesChanged'`);
    await this.bus.addMatch(`type='signal',sender='${BLUEZ}',interface='${OM}',member='InterfacesRemoved'`);
    await this.bus.addMatch(`type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='${BLUEZ}'`);
    await this.refreshOwner();
    if (!this.adapter) this.adapter = await this.findAdapter();
    await this.bus.call({ destination: BLUEZ, path: this.adapter, interface: PROPS, member: "Set", signature: "ssv", body: [ADAPTER, "Powered", new Variant("b", true)] });
  }

  private async refreshOwner(): Promise<void> {
    const [owner] = await this.bus.call({ destination: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus", member: "GetNameOwner", signature: "s", body: [BLUEZ] });
    this.bluezOwner = String(owner);
  }

  private async findAdapter(): Promise<string> {
    const [objs] = await this.bus.call({ destination: BLUEZ, path: "/", interface: OM, member: "GetManagedObjects" });
    for (const [path, ifaces] of [...(objs as Map<string, Map<string, unknown>>).entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (ifaces.has(ADAPTER) && ifaces.has(GATT_MANAGER) && ifaces.has(ADV_MANAGER)) return path;
    }
    throw new Error("no Bluetooth adapter with LE advertising and a GATT server");
  }

  private fromBluez(m: DbusMessage): boolean {
    return !!this.bluezOwner && m.sender === this.bluezOwner;
  }

  private exportObjects(): void {
    const onlyBluez = (m: DbusMessage) => {
      if (!this.fromBluez(m)) throw new DbusError("org.bluez.Error.NotAuthorized", "only BlueZ talks to the claim service");
    };
    const notPermitted = (): unknown[] => {
      throw new DbusError("org.bluez.Error.NotPermitted", "not readable");
    };
    this.bus.export(this.appPath, {});
    this.bus.export(this.servicePath, {
      [GATT_SERVICE]: { properties: () => ({ UUID: new Variant("s", BOX_CLAIM_BLE_SERVICE_UUID), Primary: new Variant("b", true) }) },
    });
    this.bus.export(this.inboxPath, {
      [GATT_CHRC]: {
        properties: () => ({
          UUID: new Variant("s", BOX_CLAIM_BLE_INBOX_UUID),
          Service: new Variant("o", this.servicePath),
          Flags: new Variant("as", ["write-without-response", "write"]),
        }),
        methods: {
          WriteValue: {
            in: "aya{sv}",
            out: "",
            fn: (args, m) => {
              onlyBluez(m);
              this.onWrite(args[0] as Uint8Array, args[1] as Map<string, Variant>);
              return [];
            },
          },
          ReadValue: { in: "a{sv}", out: "ay", fn: notPermitted },
        },
      },
    });
    this.bus.export(this.outboxPath, {
      [GATT_CHRC]: {
        properties: () => ({
          UUID: new Variant("s", BOX_CLAIM_BLE_OUTBOX_UUID),
          Service: new Variant("o", this.servicePath),
          Flags: new Variant("as", ["notify"]),
          Value: new Variant("ay", this.outboxValue),
          Notifying: new Variant("b", this.notifying),
        }),
        methods: {
          StartNotify: {
            in: "",
            out: "",
            fn: (_a, m) => {
              onlyBluez(m);
              this.notifying = true;
              this.flush();
              return [];
            },
          },
          StopNotify: {
            in: "",
            out: "",
            fn: (_a, m) => {
              onlyBluez(m);
              this.notifying = false;
              return [];
            },
          },
          ReadValue: { in: "a{sv}", out: "ay", fn: notPermitted },
        },
      },
    });
    this.bus.export(this.advertPath, {
      [ADVERTISEMENT]: {
        properties: () => {
          const a = this.advert;
          const data = a ? advertServiceData(a.state, a.id) : new Uint8Array(0);
          return {
            Type: new Variant("s", "peripheral"),
            ServiceUUIDs: new Variant("as", [BOX_CLAIM_BLE_SERVICE_UUID]),
            ScanResponseServiceData: new Variant("a{sv}", new Map([[BOX_CLAIM_BLE_SERVICE_UUID, new Variant("ay", data)]])),
            Discoverable: new Variant("b", true),
            Includes: new Variant("as", []),
            Timeout: new Variant("q", Math.min(65535, Math.ceil((this.o.advertTimeoutMs ?? BOX_CLAIM_ADVERTISE_MS) / 1000))),
          };
        },
        methods: {
          Release: {
            in: "",
            out: "",
            fn: (_a, m) => {
              onlyBluez(m);
              this.advertRegistered = false;
              return [];
            },
          },
        },
      },
    });
  }

  private onWrite(value: Uint8Array, options: Map<string, Variant> | undefined): void {
    const device = String(options?.get("device")?.value ?? "");
    const mtu = options?.get("mtu")?.value;
    if (!device) throw new DbusError("org.bluez.Error.NotPermitted", "a claim write must name its device");
    let link = this.link;
    if (!link) {
      if (!this.accepting) throw new DbusError("org.bluez.Error.NotPermitted", "this box is not taking a claim now");
      if (!(value[0]! & 0x80)) throw new DbusError("org.bluez.Error.NotPermitted", "a claim starts with a first frame");
      link = new BluezLink(`ble-${++this.seq}`, device, (frames) => this.notify(frames), (l) => this.onLinkClosed(l));
      this.link = link;
      this.log(`[retail] bluetooth link ${link.id} opened`);
      this.linkCb?.(link);
    } else if (link.device !== device) {
      throw new DbusError("org.bluez.Error.InProgress", "another phone is setting up this box");
    }
    if (typeof mtu === "number") link.mtu = mtu;
    link.frame(value);
  }

  private notify(frames: Uint8Array[]): void {
    for (const f of frames) {
      this.queued.push(f);
      this.queuedBytes += f.length;
    }
    if (!this.notifying) {
      if (this.queuedBytes > MAX_QUEUED_BYTES) this.link?.close();
      return;
    }
    this.flush();
  }

  private flush(): void {
    if (!this.notifying || !this.link) return;
    const q = this.queued;
    this.queued = [];
    this.queuedBytes = 0;
    for (const f of q) {
      this.outboxValue = f;
      this.bus.emitSignal(this.outboxPath, PROPS, "PropertiesChanged", "sa{sv}as", [GATT_CHRC, new Map([["Value", new Variant("ay", f)]]), []]);
    }
  }

  private onLinkClosed(l: BluezLink): void {
    if (this.link !== l) return;
    this.link = null;
    this.queued = [];
    this.queuedBytes = 0;
    this.log(`[retail] bluetooth link ${l.id} closed`);
    if (this.bluezOwner) {
      void this.bus.call({ destination: BLUEZ, path: l.device, interface: DEVICE, member: "Disconnect", timeoutMs: 5_000 }).catch(() => {});
    }
    if (!this.accepting) void this.serial(() => this.unregisterApp());
  }

  private onSignal(m: DbusMessage): void {
    if (m.interface === "org.freedesktop.DBus" && m.member === "NameOwnerChanged") {
      if (m.body[0] !== BLUEZ) return;
      if (m.sender !== undefined && m.sender !== "org.freedesktop.DBus") return;
      this.bluezOwner = String(m.body[2] ?? "") || null;
      this.appRegistered = false;
      this.advertRegistered = false;
      this.link?.close();
      if (this.bluezOwner && this.accepting && this.advert) {
        const adv = this.advert;
        this.log("[retail] bluetoothd restarted: registering the claim service again");
        void this.advertise(adv).catch((e) => this.log(`[retail] re-register failed: ${(e as Error).message}`));
      }
      return;
    }
    if (!this.fromBluez(m) || !this.link) return;
    const dev = this.link.device;
    if (m.interface === PROPS && m.member === "PropertiesChanged" && m.path === dev && m.body[0] === DEVICE) {
      const changed = m.body[1] as Map<string, Variant>;
      if (changed.get("Connected")?.value === false) this.link.close();
      return;
    }
    if (m.interface === OM && m.member === "InterfacesRemoved" && m.body[0] === dev) {
      if ((m.body[1] as string[]).includes(DEVICE)) this.link.close();
    }
  }

  private async registerApp(): Promise<void> {
    if (this.appRegistered) return;
    await this.bus.call({ destination: BLUEZ, path: this.adapter!, interface: GATT_MANAGER, member: "RegisterApplication", signature: "oa{sv}", body: [this.appPath, new Map()] });
    this.appRegistered = true;
  }

  private async unregisterApp(): Promise<void> {
    if (!this.appRegistered) return;
    this.appRegistered = false;
    await this.bus
      .call({ destination: BLUEZ, path: this.adapter!, interface: GATT_MANAGER, member: "UnregisterApplication", signature: "o", body: [this.appPath] })
      .catch((e) => this.log(`[retail] unregister GATT application: ${(e as Error).message}`));
  }

  private async registerAdvert(): Promise<void> {
    await this.bus.call({ destination: BLUEZ, path: this.adapter!, interface: ADV_MANAGER, member: "RegisterAdvertisement", signature: "oa{sv}", body: [this.advertPath, new Map()] });
    this.advertRegistered = true;
  }

  private async unregisterAdvert(): Promise<void> {
    if (!this.advertRegistered) return;
    this.advertRegistered = false;
    await this.bus
      .call({ destination: BLUEZ, path: this.adapter!, interface: ADV_MANAGER, member: "UnregisterAdvertisement", signature: "o", body: [this.advertPath] })
      .catch((e) => this.log(`[retail] unregister advertisement: ${(e as Error).message}`));
  }
}
