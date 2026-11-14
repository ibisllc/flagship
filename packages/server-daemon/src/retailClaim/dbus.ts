// A small D-Bus client for the claim peripheral (docs/retail-box-setup.md §11.1): enough of the
// wire protocol to talk to BlueZ on the system bus and export the GATT application and the
// advertisement it asks for. Written here instead of taking an npm D-Bus library: the one that
// can export objects (dbus-next) has had no release since 2021, this process runs with the box's
// authority, and the subset BlueZ needs (EXTERNAL auth, calls, replies, errors, signals, the
// Properties/ObjectManager/Introspectable interfaces on exported objects) is small and testable.
//
// Values: `ay` is a Uint8Array, `a{..}` a Map (a plain object is accepted when marshalling),
// structs are arrays, `x`/`t` bigints, `v` a `Variant`. Little-endian out; both byte orders in.

import { createConnection, type Socket } from "node:net";

export class Variant {
  constructor(
    readonly sig: string,
    readonly value: unknown,
  ) {}
}

export class DbusError extends Error {
  constructor(
    override readonly name: string,
    message: string,
  ) {
    super(message);
  }
}

export const MSG_CALL = 1;
export const MSG_RETURN = 2;
export const MSG_ERROR = 3;
export const MSG_SIGNAL = 4;
const FLAG_NO_REPLY = 0x1;

const F_PATH = 1;
const F_INTERFACE = 2;
const F_MEMBER = 3;
const F_ERROR_NAME = 4;
const F_REPLY_SERIAL = 5;
const F_DESTINATION = 6;
const F_SENDER = 7;
const F_SIGNATURE = 8;

export interface DbusMessage {
  type: number;
  flags: number;
  serial: number;
  path?: string;
  interface?: string;
  member?: string;
  errorName?: string;
  replySerial?: number;
  destination?: string;
  sender?: string;
  signature: string;
  body: unknown[];
}

const MAX_MESSAGE = 128 * 1024 * 1024;

// ── signatures ─────────────────────────────────────────────────────────

const BASIC = "ybnqiuxtdsogh";

/** Index just past the one complete type starting at `i`. */
function typeEnd(sig: string, i: number, depth = 0): number {
  if (depth > 32) throw new Error("signature nests too deep");
  const c = sig[i];
  if (c === undefined) throw new Error(`bad signature ${sig}`);
  if (BASIC.includes(c) || c === "v") return i + 1;
  if (c === "a") return typeEnd(sig, i + 1, depth + 1);
  if (c === "(") {
    let j = i + 1;
    if (sig[j] === ")") throw new Error("empty struct");
    while (sig[j] !== ")") j = typeEnd(sig, j, depth + 1);
    return j + 1;
  }
  if (c === "{") {
    const k = sig[i + 1];
    if (k === undefined || !BASIC.includes(k)) throw new Error("dict key must be basic");
    const j = typeEnd(sig, i + 2, depth + 1);
    if (sig[j] !== "}") throw new Error(`bad dict entry in ${sig}`);
    return j + 1;
  }
  throw new Error(`bad signature ${sig}`);
}

export function splitSignature(sig: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < sig.length; ) {
    const e = typeEnd(sig, i);
    out.push(sig.slice(i, e));
    i = e;
  }
  return out;
}

function alignOf(t: string): number {
  switch (t[0]) {
    case "y":
    case "g":
    case "v":
      return 1;
    case "n":
    case "q":
      return 2;
    case "b":
    case "i":
    case "u":
    case "h":
    case "s":
    case "o":
    case "a":
      return 4;
    default:
      return 8;
  }
}

// ── marshalling ─────────────────────────────────────────────────────────

class Writer {
  buf = Buffer.alloc(256);
  pos = 0;
  constructor(private readonly base = 0) {}
  private room(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    const next = Buffer.alloc(Math.max(this.buf.length * 2, this.pos + n));
    this.buf.copy(next, 0, 0, this.pos);
    this.buf = next;
  }
  align(n: number): void {
    const pad = (n - ((this.base + this.pos) % n)) % n;
    this.room(pad);
    this.buf.fill(0, this.pos, this.pos + pad);
    this.pos += pad;
  }
  u8(v: number): void {
    this.room(1);
    this.buf.writeUInt8(v, this.pos);
    this.pos += 1;
  }
  bytes(b: Uint8Array): void {
    this.room(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }
  num(t: string, v: unknown): void {
    const size = alignOf(t);
    this.align(size);
    this.room(size);
    const n = v;
    switch (t) {
      case "n":
        this.buf.writeInt16LE(Number(n), this.pos);
        break;
      case "q":
        this.buf.writeUInt16LE(Number(n), this.pos);
        break;
      case "i":
        this.buf.writeInt32LE(Number(n), this.pos);
        break;
      case "u":
      case "h":
        this.buf.writeUInt32LE(Number(n), this.pos);
        break;
      case "b":
        this.buf.writeUInt32LE(n ? 1 : 0, this.pos);
        break;
      case "x":
        this.buf.writeBigInt64LE(BigInt(n as number | bigint), this.pos);
        break;
      case "t":
        this.buf.writeBigUInt64LE(BigInt(n as number | bigint), this.pos);
        break;
      case "d":
        this.buf.writeDoubleLE(Number(n), this.pos);
        break;
    }
    this.pos += size;
  }
  patchU32(at: number, v: number): void {
    this.buf.writeUInt32LE(v, at);
  }
  done(): Buffer {
    return this.buf.subarray(0, this.pos);
  }
}

function entriesOf(v: unknown): Array<[unknown, unknown]> {
  if (v instanceof Map) return [...v.entries()];
  if (v && typeof v === "object") return Object.entries(v as Record<string, unknown>);
  throw new Error("expected a dict");
}

function write(w: Writer, t: string, v: unknown): void {
  const c = t[0]!;
  switch (c) {
    case "y":
      w.u8(Number(v));
      return;
    case "s":
    case "o": {
      if (typeof v !== "string") throw new Error(`expected a string for ${t}`);
      const b = Buffer.from(v, "utf8");
      w.num("u", b.length);
      w.bytes(b);
      w.u8(0);
      return;
    }
    case "g": {
      const b = Buffer.from(String(v), "ascii");
      if (b.length > 255) throw new Error("signature too long");
      w.u8(b.length);
      w.bytes(b);
      w.u8(0);
      return;
    }
    case "v": {
      if (!(v instanceof Variant)) throw new Error("expected a Variant");
      if (splitSignature(v.sig).length !== 1) throw new Error("a variant holds one type");
      write(w, "g", v.sig);
      write(w, v.sig, v.value);
      return;
    }
    case "a": {
      const elem = t.slice(1);
      w.align(4);
      const lenAt = w.pos;
      w.num("u", 0);
      w.align(alignOf(elem));
      const start = w.pos;
      if (elem === "y") {
        if (!(v instanceof Uint8Array)) throw new Error("expected bytes for ay");
        w.bytes(v);
      } else if (elem[0] === "{") {
        const [kt, vt] = splitSignature(elem.slice(1, -1)) as [string, string];
        for (const [k, x] of entriesOf(v)) {
          w.align(8);
          write(w, kt, k);
          write(w, vt, x);
        }
      } else {
        if (!Array.isArray(v)) throw new Error(`expected an array for ${t}`);
        for (const x of v) write(w, elem, x);
      }
      const len = w.pos - start;
      if (len > 64 * 1024 * 1024) throw new Error("array too long");
      w.patchU32(lenAt, len);
      return;
    }
    case "(": {
      if (!Array.isArray(v)) throw new Error("expected an array for a struct");
      const fields = splitSignature(t.slice(1, -1));
      if (fields.length !== v.length) throw new Error("struct field count");
      w.align(8);
      fields.forEach((f, i) => write(w, f, v[i]));
      return;
    }
    default:
      w.num(c, v);
  }
}

class Reader {
  pos = 0;
  constructor(
    readonly buf: Buffer,
    readonly le: boolean,
    private readonly base = 0,
  ) {}
  align(n: number): void {
    this.pos += (n - ((this.base + this.pos) % n)) % n;
  }
  need(n: number): void {
    if (this.pos + n > this.buf.length) throw new Error("message truncated");
  }
  u8(): number {
    this.need(1);
    return this.buf.readUInt8(this.pos++);
  }
  num(t: string): number | bigint | boolean {
    const size = alignOf(t);
    this.align(size);
    this.need(size);
    const b = this.buf;
    const p = this.pos;
    this.pos += size;
    const le = this.le;
    switch (t) {
      case "n":
        return le ? b.readInt16LE(p) : b.readInt16BE(p);
      case "q":
        return le ? b.readUInt16LE(p) : b.readUInt16BE(p);
      case "i":
        return le ? b.readInt32LE(p) : b.readInt32BE(p);
      case "u":
      case "h":
        return le ? b.readUInt32LE(p) : b.readUInt32BE(p);
      case "b":
        return (le ? b.readUInt32LE(p) : b.readUInt32BE(p)) !== 0;
      case "x":
        return le ? b.readBigInt64LE(p) : b.readBigInt64BE(p);
      case "t":
        return le ? b.readBigUInt64LE(p) : b.readBigUInt64BE(p);
      case "d":
        return le ? b.readDoubleLE(p) : b.readDoubleBE(p);
    }
    throw new Error(`bad type ${t}`);
  }
}

function read(r: Reader, t: string, depth = 0): unknown {
  if (depth > 64) throw new Error("value nests too deep");
  const c = t[0]!;
  switch (c) {
    case "y":
      return r.u8();
    case "s":
    case "o": {
      const n = r.num("u") as number;
      r.need(n + 1);
      const s = r.buf.toString("utf8", r.pos, r.pos + n);
      r.pos += n + 1;
      return s;
    }
    case "g": {
      const n = r.u8();
      r.need(n + 1);
      const s = r.buf.toString("ascii", r.pos, r.pos + n);
      r.pos += n + 1;
      return s;
    }
    case "v": {
      const sig = read(r, "g") as string;
      if (splitSignature(sig).length !== 1) throw new Error("bad variant signature");
      return new Variant(sig, read(r, sig, depth + 1));
    }
    case "a": {
      const elem = t.slice(1);
      const n = r.num("u") as number;
      if (n > 64 * 1024 * 1024) throw new Error("array too long");
      r.align(alignOf(elem));
      r.need(n);
      const end = r.pos + n;
      if (elem === "y") {
        const out = Uint8Array.from(r.buf.subarray(r.pos, end));
        r.pos = end;
        return out;
      }
      if (elem[0] === "{") {
        const [kt, vt] = splitSignature(elem.slice(1, -1)) as [string, string];
        const m = new Map<unknown, unknown>();
        while (r.pos < end) {
          r.align(8);
          const k = read(r, kt, depth + 1);
          m.set(k, read(r, vt, depth + 1));
        }
        return m;
      }
      const out: unknown[] = [];
      while (r.pos < end) out.push(read(r, elem, depth + 1));
      if (r.pos !== end) throw new Error("array length mismatch");
      return out;
    }
    case "(": {
      r.align(8);
      return splitSignature(t.slice(1, -1)).map((f) => read(r, f, depth + 1));
    }
    default:
      return r.num(c);
  }
}

/** Marshals `values` under `signature` as a body starting at an 8-aligned offset. */
export function marshalBody(signature: string, values: readonly unknown[]): Buffer {
  const types = splitSignature(signature);
  if (types.length !== values.length) throw new Error(`body wants ${types.length} values, got ${values.length}`);
  const w = new Writer();
  types.forEach((t, i) => write(w, t, values[i]));
  return w.done();
}

export function unmarshalBody(signature: string, body: Buffer, le = true): unknown[] {
  const r = new Reader(body, le);
  const out = splitSignature(signature).map((t) => read(r, t));
  if (r.pos !== body.length) throw new Error("trailing bytes in the body");
  return out;
}

export function encodeMessage(m: DbusMessage): Buffer {
  const body = marshalBody(m.signature, m.body);
  const fields: Array<[number, Variant]> = [];
  if (m.path !== undefined) fields.push([F_PATH, new Variant("o", m.path)]);
  if (m.interface !== undefined) fields.push([F_INTERFACE, new Variant("s", m.interface)]);
  if (m.member !== undefined) fields.push([F_MEMBER, new Variant("s", m.member)]);
  if (m.errorName !== undefined) fields.push([F_ERROR_NAME, new Variant("s", m.errorName)]);
  if (m.replySerial !== undefined) fields.push([F_REPLY_SERIAL, new Variant("u", m.replySerial)]);
  if (m.destination !== undefined) fields.push([F_DESTINATION, new Variant("s", m.destination)]);
  if (m.sender !== undefined) fields.push([F_SENDER, new Variant("s", m.sender)]);
  if (m.signature) fields.push([F_SIGNATURE, new Variant("g", m.signature)]);
  const w = new Writer();
  w.u8(0x6c);
  w.u8(m.type);
  w.u8(m.flags);
  w.u8(1);
  w.num("u", body.length);
  w.num("u", m.serial);
  write(w, "a(yv)", fields);
  w.align(8);
  w.bytes(body);
  return Buffer.from(w.done());
}

/** Bytes a whole message needs, once its first 16 bytes are in; null before that. */
export function messageLength(head: Buffer): number | null {
  if (head.length < 16) return null;
  const le = head[0] === 0x6c;
  if (!le && head[0] !== 0x42) throw new Error("bad byte order");
  const bodyLen = le ? head.readUInt32LE(4) : head.readUInt32BE(4);
  const fieldsLen = le ? head.readUInt32LE(12) : head.readUInt32BE(12);
  const headerLen = 16 + fieldsLen + ((8 - ((16 + fieldsLen) % 8)) % 8);
  const total = headerLen + bodyLen;
  if (total > MAX_MESSAGE) throw new Error("message too large");
  return total;
}

export function decodeMessage(buf: Buffer): DbusMessage {
  const le = buf[0] === 0x6c;
  if (!le && buf[0] !== 0x42) throw new Error("bad byte order");
  if (buf[3] !== 1) throw new Error("unsupported protocol version");
  const r = new Reader(buf, le);
  r.pos = 4;
  const bodyLen = r.num("u") as number;
  const serial = r.num("u") as number;
  const fields = read(r, "a(yv)") as Array<[number, Variant]>;
  r.align(8);
  const m: DbusMessage = { type: buf[1]!, flags: buf[2]!, serial, signature: "", body: [] };
  for (const [code, v] of fields) {
    const val = v.value;
    switch (code) {
      case F_PATH:
        m.path = String(val);
        break;
      case F_INTERFACE:
        m.interface = String(val);
        break;
      case F_MEMBER:
        m.member = String(val);
        break;
      case F_ERROR_NAME:
        m.errorName = String(val);
        break;
      case F_REPLY_SERIAL:
        m.replySerial = Number(val);
        break;
      case F_DESTINATION:
        m.destination = String(val);
        break;
      case F_SENDER:
        m.sender = String(val);
        break;
      case F_SIGNATURE:
        m.signature = String(val);
        break;
    }
  }
  const body = buf.subarray(r.pos, r.pos + bodyLen);
  if (body.length !== bodyLen) throw new Error("message truncated");
  m.body = m.signature ? unmarshalBody(m.signature, body, le) : [];
  return m;
}

// ── exported objects ───────────────────────────────────────────────────

export interface ExportedMethod {
  in: string;
  out: string;
  /** Returns the out values; throw a `DbusError` to answer with an error. */
  fn: (args: unknown[], msg: DbusMessage) => unknown[] | Promise<unknown[]>;
}

export interface ExportedInterface {
  properties?: () => Record<string, Variant>;
  methods?: Record<string, ExportedMethod>;
}

export type ExportedObject = Record<string, ExportedInterface>;

export interface CallSpec {
  destination: string;
  path: string;
  interface: string;
  member: string;
  signature?: string;
  body?: unknown[];
  timeoutMs?: number;
}

/** What BluezPeripheral needs from a bus: the real connection and the test fake both provide it. */
export interface DbusBus {
  readonly uniqueName: string;
  call(c: CallSpec): Promise<unknown[]>;
  emitSignal(path: string, iface: string, member: string, signature: string, body: unknown[]): void;
  export(path: string, obj: ExportedObject): void;
  unexport(path: string): void;
  onSignal(cb: (m: DbusMessage) => void): () => void;
  addMatch(rule: string): Promise<void>;
  close(): void;
}

const PROPS = "org.freedesktop.DBus.Properties";
const INTROSPECT = "org.freedesktop.DBus.Introspectable";
const OBJECT_MANAGER = "org.freedesktop.DBus.ObjectManager";

/** The object table and the standard interfaces on it, shared by the connection and the fake. */
export class ObjectTable {
  readonly objects = new Map<string, ExportedObject>();

  managedObjects(root: string): Map<string, Map<string, Map<string, Variant>>> {
    const out = new Map<string, Map<string, Map<string, Variant>>>();
    for (const [path, obj] of [...this.objects.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (path !== root && !path.startsWith(root === "/" ? "/" : `${root}/`)) continue;
      const ifaces = new Map<string, Map<string, Variant>>();
      for (const [name, i] of Object.entries(obj)) ifaces.set(name, new Map(Object.entries(i.properties?.() ?? {})));
      out.set(path, ifaces);
    }
    return out;
  }

  introspect(path: string): string {
    const obj = this.objects.get(path) ?? {};
    const prefix = path === "/" ? "/" : `${path}/`;
    const children = new Set<string>();
    for (const p of this.objects.keys()) if (p.startsWith(prefix) && p !== path) children.add(p.slice(prefix.length).split("/")[0]!);
    const ifaces = Object.entries(obj)
      .map(([name, i]) => {
        const methods = Object.keys(i.methods ?? {}).map((m) => `<method name="${m}"/>`);
        const props = Object.entries(i.properties?.() ?? {}).map(([p, v]) => `<property name="${p}" type="${v.sig}" access="read"/>`);
        return `<interface name="${name}">${methods.join("")}${props.join("")}</interface>`;
      })
      .join("");
    const std = `<interface name="${PROPS}"><method name="Get"/><method name="GetAll"/></interface><interface name="${INTROSPECT}"><method name="Introspect"/></interface><interface name="${OBJECT_MANAGER}"><method name="GetManagedObjects"/></interface>`;
    return `<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd"><node>${std}${ifaces}${[...children].map((c) => `<node name="${c}"/>`).join("")}</node>`;
  }

  /** Answers a call to an exported object: `{ signature, body }`, or throws a DbusError. */
  async dispatch(m: DbusMessage): Promise<{ signature: string; body: unknown[] }> {
    const path = m.path ?? "";
    const obj = this.objects.get(path);
    const iface = m.interface ?? "";
    const member = m.member ?? "";
    if (iface === INTROSPECT && member === "Introspect") return { signature: "s", body: [this.introspect(path)] };
    if (!obj) throw new DbusError("org.freedesktop.DBus.Error.UnknownObject", `no object at ${path}`);
    if (iface === OBJECT_MANAGER && member === "GetManagedObjects") return { signature: "a{oa{sa{sv}}}", body: [this.managedObjects(path)] };
    if (iface === PROPS) {
      const target = obj[String(m.body[0] ?? "")];
      if (!target) throw new DbusError("org.freedesktop.DBus.Error.UnknownInterface", "no such interface");
      const all = target.properties?.() ?? {};
      if (member === "GetAll") return { signature: "a{sv}", body: [new Map(Object.entries(all))] };
      if (member === "Get") {
        const v = all[String(m.body[1] ?? "")];
        if (!v) throw new DbusError("org.freedesktop.DBus.Error.UnknownProperty", "no such property");
        return { signature: "v", body: [v] };
      }
      throw new DbusError("org.freedesktop.DBus.Error.PropertyReadOnly", "read only");
    }
    const target = iface ? obj[iface] : Object.values(obj).find((i) => i.methods?.[member]);
    const method = target?.methods?.[member];
    if (!method) throw new DbusError("org.freedesktop.DBus.Error.UnknownMethod", `no method ${iface}.${member}`);
    if ((m.signature ?? "") !== method.in) throw new DbusError("org.freedesktop.DBus.Error.InvalidArgs", `expected (${method.in})`);
    const out = await method.fn(m.body, m);
    return { signature: method.out, body: out };
  }
}

// ── the connection ─────────────────────────────────────────────────────

export const SYSTEM_BUS_SOCKET = "/run/dbus/system_bus_socket";

/** The socket path in `DBUS_SYSTEM_BUS_ADDRESS` (`unix:path=…`), else the standard one. */
export function systemBusPath(env: NodeJS.ProcessEnv = process.env): string {
  const a = env.DBUS_SYSTEM_BUS_ADDRESS;
  if (!a) return SYSTEM_BUS_SOCKET;
  for (const part of a.split(";")) {
    const m = /^unix:(?:.*,)?path=([^,]+)/.exec(part);
    if (m) return decodeURIComponent(m[1]!);
  }
  return SYSTEM_BUS_SOCKET;
}

export class DbusConnection implements DbusBus {
  uniqueName = "";
  private serial = 0;
  private pending = new Map<number, { resolve: (b: unknown[]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private signalHandlers = new Set<(m: DbusMessage) => void>();
  private readonly table = new ObjectTable();
  private inbuf: Buffer = Buffer.alloc(0);
  private closed = false;
  private closeHandlers: Array<() => void> = [];

  private constructor(private readonly sock: Socket) {}

  static async connect(path = systemBusPath(), uid = process.getuid?.() ?? 0): Promise<DbusConnection> {
    const sock = createConnection(path);
    await new Promise<void>((res, rej) => {
      sock.once("connect", res);
      sock.once("error", rej);
    });
    const leftover = await authenticate(sock, uid);
    const c = new DbusConnection(sock);
    sock.on("data", (d) => c.onData(d));
    if (leftover.length > 0) c.onData(leftover);
    sock.on("close", () => c.shutdown(new Error("bus connection closed")));
    sock.on("error", (e) => c.shutdown(e));
    const [name] = await c.call({ destination: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus", member: "Hello" });
    c.uniqueName = String(name);
    return c;
  }

  onClose(cb: () => void): void {
    if (this.closed) cb();
    else this.closeHandlers.push(cb);
  }

  private send(m: Omit<DbusMessage, "serial">): number {
    if (this.closed) throw new Error("bus connection closed");
    const serial = ++this.serial;
    this.sock.write(encodeMessage({ ...m, serial }));
    return serial;
  }

  call(c: CallSpec): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      let serial: number;
      try {
        serial = this.send({
          type: MSG_CALL,
          flags: 0,
          destination: c.destination,
          path: c.path,
          interface: c.interface,
          member: c.member,
          signature: c.signature ?? "",
          body: c.body ?? [],
        });
      } catch (e) {
        reject(e as Error);
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(serial);
        reject(new DbusError("org.freedesktop.DBus.Error.NoReply", `${c.interface}.${c.member} timed out`));
      }, c.timeoutMs ?? 25_000);
      this.pending.set(serial, { resolve, reject, timer });
    });
  }

  emitSignal(path: string, iface: string, member: string, signature: string, body: unknown[]): void {
    this.send({ type: MSG_SIGNAL, flags: FLAG_NO_REPLY, path, interface: iface, member, signature, body });
  }

  export(path: string, obj: ExportedObject): void {
    this.table.objects.set(path, obj);
  }

  unexport(path: string): void {
    this.table.objects.delete(path);
  }

  onSignal(cb: (m: DbusMessage) => void): () => void {
    this.signalHandlers.add(cb);
    return () => this.signalHandlers.delete(cb);
  }

  async addMatch(rule: string): Promise<void> {
    await this.call({ destination: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus", member: "AddMatch", signature: "s", body: [rule] });
  }

  close(): void {
    this.sock.end();
    this.shutdown(new Error("bus connection closed"));
  }

  private shutdown(e: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
    for (const c of this.closeHandlers) c();
    this.sock.destroy();
  }

  private onData(d: Buffer): void {
    this.inbuf = this.inbuf.length ? Buffer.concat([this.inbuf, d]) : d;
    for (;;) {
      let len: number | null;
      try {
        len = messageLength(this.inbuf);
      } catch (e) {
        this.shutdown(e as Error);
        return;
      }
      if (len === null || this.inbuf.length < len) return;
      const raw = this.inbuf.subarray(0, len);
      this.inbuf = this.inbuf.subarray(len);
      let m: DbusMessage;
      try {
        m = decodeMessage(Buffer.from(raw));
      } catch (e) {
        this.shutdown(e as Error);
        return;
      }
      this.handle(m);
    }
  }

  private handle(m: DbusMessage): void {
    if (m.type === MSG_RETURN || m.type === MSG_ERROR) {
      const p = m.replySerial !== undefined ? this.pending.get(m.replySerial) : undefined;
      if (!p) return;
      this.pending.delete(m.replySerial!);
      clearTimeout(p.timer);
      if (m.type === MSG_RETURN) p.resolve(m.body);
      else p.reject(new DbusError(m.errorName ?? "org.freedesktop.DBus.Error.Failed", String(m.body[0] ?? m.errorName ?? "error")));
      return;
    }
    if (m.type === MSG_SIGNAL) {
      for (const h of this.signalHandlers) {
        try {
          h(m);
        } catch {
          // one handler's failure never stops the others
        }
      }
      return;
    }
    if (m.type === MSG_CALL) void this.answer(m);
  }

  private async answer(m: DbusMessage): Promise<void> {
    const noReply = (m.flags & FLAG_NO_REPLY) !== 0;
    try {
      const r = await this.table.dispatch(m);
      if (!noReply && !this.closed) this.send({ type: MSG_RETURN, flags: FLAG_NO_REPLY, replySerial: m.serial, ...(m.sender ? { destination: m.sender } : {}), signature: r.signature, body: r.body });
    } catch (e) {
      if (noReply || this.closed) return;
      const name = e instanceof DbusError ? e.name : "org.freedesktop.DBus.Error.Failed";
      this.send({ type: MSG_ERROR, flags: FLAG_NO_REPLY, errorName: name, replySerial: m.serial, ...(m.sender ? { destination: m.sender } : {}), signature: "s", body: [(e as Error).message] });
    }
  }
}

async function authenticate(sock: Socket, uid: number): Promise<Buffer> {
  const lines: string[] = [];
  let partial = "";
  let wake: (() => void) | null = null;
  const onData = (d: Buffer) => {
    partial += d.toString("latin1");
    let i: number;
    while ((i = partial.indexOf("\r\n")) >= 0) {
      lines.push(partial.slice(0, i));
      partial = partial.slice(i + 2);
    }
    if (partial.length > 4096) sock.destroy(new Error("auth line too long"));
    wake?.();
  };
  sock.on("data", onData);
  const nextLine = async (): Promise<string> => {
    const deadline = Date.now() + 10_000;
    while (lines.length === 0) {
      if (sock.destroyed || Date.now() > deadline) throw new Error("D-Bus authentication failed");
      await new Promise<void>((r) => {
        wake = r;
        setTimeout(r, 200);
      });
      wake = null;
    }
    return lines.shift()!;
  };
  try {
    sock.write(Buffer.from([0]));
    sock.write(`AUTH EXTERNAL ${Buffer.from(String(uid), "ascii").toString("hex")}\r\n`);
    const reply = await nextLine();
    if (!reply.startsWith("OK ")) throw new Error(`D-Bus refused authentication: ${reply.slice(0, 80)}`);
    sock.write("BEGIN\r\n");
  } finally {
    sock.off("data", onData);
  }
  return Buffer.from(partial, "latin1");
}
