import { mkdtempSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DbusConnection,
  DbusError,
  MSG_CALL,
  MSG_ERROR,
  MSG_RETURN,
  MSG_SIGNAL,
  ObjectTable,
  Variant,
  decodeMessage,
  encodeMessage,
  marshalBody,
  messageLength,
  splitSignature,
  systemBusPath,
  unmarshalBody,
  type DbusMessage,
} from "../../src/retailClaim/dbus.js";

describe("D-Bus marshalling", () => {
  it("splits signatures into complete types", () => {
    expect(splitSignature("oa{sv}")).toEqual(["o", "a{sv}"]);
    expect(splitSignature("a{oa{sa{sv}}}")).toEqual(["a{oa{sa{sv}}}"]);
    expect(splitSignature("(yv)as")).toEqual(["(yv)", "as"]);
    expect(() => splitSignature("a{vs}")).toThrow();
    expect(() => splitSignature("(")).toThrow();
  });

  it("matches the specification's bytes for a Hello call", () => {
    const raw = encodeMessage({ type: MSG_CALL, flags: 0, serial: 1, destination: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus", member: "Hello", signature: "", body: [] });
    expect(raw.subarray(0, 12).toString("hex")).toBe("6c01000100000000" + "01000000");
    expect(raw.length % 8).toBe(0);
    expect(messageLength(raw)).toBe(raw.length);
    const m = decodeMessage(raw);
    expect(m).toMatchObject({ type: MSG_CALL, serial: 1, member: "Hello", path: "/org/freedesktop/DBus", destination: "org.freedesktop.DBus" });
  });

  it("aligns and pads the way the wire format says", () => {
    expect(marshalBody("yu", [7, 1]).toString("hex")).toBe("0700000001000000");
    expect(marshalBody("s", ["ab"]).toString("hex")).toBe("020000006162" + "00");
    expect(marshalBody("ay", [Uint8Array.of(1, 2)]).toString("hex")).toBe("020000000102");
    expect(marshalBody("at", [[1n]]).toString("hex")).toBe("08000000" + "00000000" + "0100000000000000");
    expect(marshalBody("a{sv}", [new Map()]).toString("hex")).toBe("00000000" + "00000000");
  });

  it("round-trips what BlueZ sends and asks for", () => {
    const sig = "a{oa{sa{sv}}}";
    const value = new Map([
      [
        "/org/bluez/hci0",
        new Map([
          ["org.bluez.Adapter1", new Map<string, Variant>([["Powered", new Variant("b", true)], ["Address", new Variant("s", "00:11:22:33:44:55")]])],
          ["org.bluez.GattManager1", new Map()],
        ]),
      ],
    ]);
    const body = marshalBody(sig, [value]);
    const [back] = unmarshalBody(sig, body);
    const adapter = (back as Map<string, Map<string, Map<string, Variant>>>).get("/org/bluez/hci0")!;
    expect(adapter.get("org.bluez.Adapter1")!.get("Powered")!.value).toBe(true);
    expect([...adapter.keys()]).toEqual(["org.bluez.Adapter1", "org.bluez.GattManager1"]);

    const write = marshalBody("aya{sv}", [Uint8Array.of(0xc0, 1, 2), { device: new Variant("o", "/org/bluez/hci0/dev_X"), mtu: new Variant("q", 185) }]);
    const [v, opts] = unmarshalBody("aya{sv}", write);
    expect(Buffer.from(v as Uint8Array).toString("hex")).toBe("c00102");
    expect((opts as Map<string, Variant>).get("mtu")!.value).toBe(185);

    const mixed = marshalBody("(ysx)dnbg", [[1, "x", -5n], 1.5, -2, false, "a{sv}"]);
    expect(unmarshalBody("(ysx)dnbg", mixed)).toEqual([[1, "x", -5n], 1.5, -2, false, "a{sv}"]);
  });

  it("refuses an unknown byte order", () => {
    const le = encodeMessage({ type: MSG_SIGNAL, flags: 1, serial: 9, path: "/a", interface: "x.Y", member: "Z", signature: "su", body: ["hi", 3] });
    expect(decodeMessage(le).body).toEqual(["hi", 3]);
    expect(() => decodeMessage(Buffer.concat([Buffer.from([0x41]), le.subarray(1)]))).toThrow();
  });

  it("refuses truncated or trailing bodies", () => {
    const b = marshalBody("su", ["abc", 4]);
    expect(() => unmarshalBody("su", b.subarray(0, b.length - 1))).toThrow();
    expect(() => unmarshalBody("s", b)).toThrow();
  });

  it("reads the system bus address", () => {
    expect(systemBusPath({})).toBe("/run/dbus/system_bus_socket");
    expect(systemBusPath({ DBUS_SYSTEM_BUS_ADDRESS: "unix:path=/tmp/x%20y" })).toBe("/tmp/x y");
    expect(systemBusPath({ DBUS_SYSTEM_BUS_ADDRESS: "tcp:host=a;unix:guid=1,path=/b" })).toBe("/b");
  });
});

describe("exported objects", () => {
  const table = new ObjectTable();
  table.objects.set("/app", {});
  table.objects.set("/app/s", { "x.Service": { properties: () => ({ UUID: new Variant("s", "u") }) } });
  table.objects.set("/app/s/c", {
    "x.Chrc": {
      properties: () => ({ Flags: new Variant("as", ["notify"]) }),
      methods: { Ping: { in: "s", out: "s", fn: (a) => [`pong ${a[0]}`] } },
    },
  });
  table.objects.set("/other", { "x.Other": {} });
  const call = (o: Partial<DbusMessage>): DbusMessage => ({ type: MSG_CALL, flags: 0, serial: 1, signature: "", body: [], ...o });

  it("lists the objects under a root for GetManagedObjects", async () => {
    const r = await table.dispatch(call({ path: "/app", interface: "org.freedesktop.DBus.ObjectManager", member: "GetManagedObjects" }));
    const objs = r.body[0] as Map<string, Map<string, Map<string, Variant>>>;
    expect([...objs.keys()]).toEqual(["/app", "/app/s", "/app/s/c"]);
    expect(objs.get("/app/s")!.get("x.Service")!.get("UUID")!.value).toBe("u");
    expect(() => marshalBody(r.signature, r.body)).not.toThrow();
  });

  it("answers Properties, Introspect and methods, and refuses wrong arguments", async () => {
    const all = await table.dispatch(call({ path: "/app/s", interface: "org.freedesktop.DBus.Properties", member: "GetAll", signature: "s", body: ["x.Service"] }));
    expect((all.body[0] as Map<string, Variant>).get("UUID")!.value).toBe("u");
    const xml = await table.dispatch(call({ path: "/app", interface: "org.freedesktop.DBus.Introspectable", member: "Introspect" }));
    expect(xml.body[0]).toContain('<node name="s"/>');
    const pong = await table.dispatch(call({ path: "/app/s/c", interface: "x.Chrc", member: "Ping", signature: "s", body: ["a"] }));
    expect(pong.body).toEqual(["pong a"]);
    await expect(table.dispatch(call({ path: "/app/s/c", interface: "x.Chrc", member: "Ping" }))).rejects.toBeInstanceOf(DbusError);
    await expect(table.dispatch(call({ path: "/nope", interface: "x.Chrc", member: "Ping" }))).rejects.toThrow(/no object/);
  });
});

/** A bus daemon in miniature: EXTERNAL auth, Hello, one service method, a call back into the client. */
function miniBus(dir: string) {
  const path = join(dir, "bus.sock");
  const clients: Socket[] = [];
  const got: DbusMessage[] = [];
  let serial = 100;
  let sendToClient: (m: Omit<DbusMessage, "serial">) => void = () => {};
  const server = createServer((sock) => {
    clients.push(sock);
    let phase: "auth" | "begin" | "messages" = "auth";
    let buf = Buffer.alloc(0);
    sendToClient = (m) => sock.write(encodeMessage({ ...m, serial: ++serial }));
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (phase === "auth") {
        const s = buf.toString("latin1");
        const i = s.indexOf("\r\n");
        if (i < 0) return;
        if (!s.slice(0, i).startsWith("\0AUTH EXTERNAL ")) return sock.destroy();
        sock.write("OK 0123456789abcdef0123456789abcdef\r\n");
        buf = buf.subarray(i + 2);
        phase = "begin";
      }
      if (phase === "begin") {
        const s = buf.toString("latin1");
        const i = s.indexOf("BEGIN\r\n");
        if (i < 0) return;
        buf = buf.subarray(i + 7);
        phase = "messages";
      }
      for (;;) {
        const len = messageLength(buf);
        if (len === null || buf.length < len) return;
        const m = decodeMessage(buf.subarray(0, len));
        buf = buf.subarray(len);
        got.push(m);
        if (m.type !== MSG_CALL) continue;
        if (m.member === "Hello") sendToClient({ type: MSG_RETURN, flags: 0, replySerial: m.serial, signature: "s", body: [":1.42"] });
        else if (m.member === "Echo") sendToClient({ type: MSG_RETURN, flags: 0, replySerial: m.serial, signature: m.signature, body: m.body });
        else if (m.member === "Hang") continue;
        else if (m.member === "AddMatch") sendToClient({ type: MSG_RETURN, flags: 0, replySerial: m.serial, signature: "", body: [] });
        else sendToClient({ type: MSG_ERROR, flags: 0, replySerial: m.serial, errorName: "org.bluez.Error.Failed", signature: "s", body: ["no"] });
      }
    });
  });
  return { path, server, got, send: (m: Omit<DbusMessage, "serial">) => sendToClient(m), clients };
}

describe("DbusConnection over a socket", () => {
  it("authenticates, calls, gets errors, answers calls into its objects and sees signals", async () => {
    const bus = miniBus(mkdtempSync(join(tmpdir(), "dbus-")));
    await new Promise<void>((r) => bus.server.listen(bus.path, r));
    const c = await DbusConnection.connect(bus.path, 1000);
    try {
      expect(c.uniqueName).toBe(":1.42");
      const r = await c.call({ destination: "x", path: "/x", interface: "x.Y", member: "Echo", signature: "sa{sv}", body: ["hi", new Map([["k", new Variant("u", 5)]])] });
      expect(r[0]).toBe("hi");
      await expect(c.call({ destination: "x", path: "/x", interface: "x.Y", member: "Boom" })).rejects.toMatchObject({ name: "org.bluez.Error.Failed" });
      await c.addMatch("type='signal'");

      c.export("/app/c", { "x.Chrc": { methods: { WriteValue: { in: "aya{sv}", out: "", fn: () => [] } } } });
      const signals: DbusMessage[] = [];
      c.onSignal((m) => signals.push(m));
      bus.send({ type: MSG_CALL, flags: 0, sender: ":1.1", destination: ":1.42", path: "/app/c", interface: "x.Chrc", member: "WriteValue", signature: "aya{sv}", body: [Uint8Array.of(1), new Map()] });
      bus.send({ type: MSG_CALL, flags: 0, sender: ":1.1", destination: ":1.42", path: "/app/c", interface: "x.Chrc", member: "Nope", signature: "", body: [] });
      bus.send({ type: MSG_SIGNAL, flags: 1, sender: ":1.1", path: "/org/bluez/hci0/dev_1", interface: "org.freedesktop.DBus.Properties", member: "PropertiesChanged", signature: "sa{sv}as", body: ["org.bluez.Device1", new Map([["Connected", new Variant("b", false)]]), []] });
      c.emitSignal("/app/c", "org.freedesktop.DBus.Properties", "PropertiesChanged", "sa{sv}as", ["x.Chrc", new Map([["Value", new Variant("ay", Uint8Array.of(9))]]), []]);
      for (let i = 0; i < 50 && (signals.length === 0 || bus.got.filter((m) => m.replySerial !== undefined || m.type === MSG_SIGNAL).length < 3); i++) await new Promise((r) => setTimeout(r, 10));
      expect(signals[0]!.member).toBe("PropertiesChanged");
      const replies = bus.got.filter((m) => m.type === MSG_RETURN || m.type === MSG_ERROR).sort((a, b) => a.replySerial! - b.replySerial!);
      expect(replies.map((m) => m.type)).toEqual([MSG_RETURN, MSG_ERROR]);
      expect(replies[1]!.errorName).toBe("org.freedesktop.DBus.Error.UnknownMethod");
      const sent = bus.got.find((m) => m.type === MSG_SIGNAL)!;
      expect(Buffer.from(((sent.body[1] as Map<string, Variant>).get("Value")!.value as Uint8Array)).toString("hex")).toBe("09");
      const auth = bus.got[0]!;
      expect(auth.member).toBe("Hello");
    } finally {
      c.close();
      for (const s of bus.clients) s.destroy();
      bus.server.close();
    }
  });

  it("fails pending calls when the bus goes away", async () => {
    const bus = miniBus(mkdtempSync(join(tmpdir(), "dbus-")));
    await new Promise<void>((r) => bus.server.listen(bus.path, r));
    const c = await DbusConnection.connect(bus.path, 1000);
    bus.got.length = 0;
    const p = c.call({ destination: "x", path: "/x", interface: "x.Y", member: "Hang", timeoutMs: 5_000 });
    for (let i = 0; i < 50 && bus.got.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    for (const s of bus.clients) s.destroy();
    await expect(p).rejects.toThrow();
    bus.server.close();
  });
});
