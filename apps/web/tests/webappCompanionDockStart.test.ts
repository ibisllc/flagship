import { describe, expect, it } from "vitest";

import {
  REMOTE_TICKET_KIND,
  openRemoteRequest,
  parseRemoteTicket,
} from "../public/webapp/lib/companionDockStart.js";
import { deriveMaterial, freshKeypair } from "../public/webapp/lib/pairingRelay.js";

const APEX = "flagship.services";
const TICKET = {
  kind: REMOTE_TICKET_KIND,
  ticketId: "ab".repeat(16),
  ticketSecret: "cd".repeat(32),
  podBaseUrl: "https://home.alice.flagship.services",
  username: "alice",
};

class FakeSocket {
  static last: FakeSocket | null = null;
  url: string;
  closed = false;
  private listeners: Record<string, ((ev: any) => void)[]> = {};
  constructor(url: string) {
    this.url = url;
    FakeSocket.last = this;
  }
  addEventListener(kind: string, fn: (ev: any) => void) {
    (this.listeners[kind] ??= []).push(fn);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", {});
  }
  emit(kind: string, ev: any) {
    for (const fn of this.listeners[kind] ?? []) fn(ev);
  }
  async frame(obj: unknown) {
    this.emit("message", { data: JSON.stringify(obj) });
    await new Promise((r) => setTimeout(r, 20));
  }
}

const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

async function phoneSeal(browserPk: string, plaintext: unknown) {
  const phone = await freshKeypair();
  const mat = await deriveMaterial(phone.sk, browserPk);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encKey = await deriveEncryptKey(phone.sk, browserPk);
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    encKey,
    new TextEncoder().encode(JSON.stringify(plaintext)),
  ));
  return { phonePk: phone.pkB64u, sas: mat.sas, ciphertext: b64u(ct), nonce: b64u(nonce) };
}

async function deriveEncryptKey(sk: CryptoKey, peerPkB64u: string) {
  const peer = await crypto.subtle.importKey("raw", Buffer.from(peerPkB64u, "base64url"), { name: "X25519" }, false, []);
  const bits = await crypto.subtle.deriveBits({ name: "X25519", public: peer }, sk, 256);
  const base = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveBits"]);
  const k = await crypto.subtle.deriveBits({
    name: "HKDF",
    hash: "SHA-256",
    salt: new TextEncoder().encode("flagship/qr/v1"),
    info: new TextEncoder().encode("flagship/qr/enc/v1"),
  }, base, 256);
  return crypto.subtle.importKey("raw", k, "AES-GCM", false, ["encrypt"]);
}

async function open() {
  const codes: string[] = [];
  const request = await openRemoteRequest({
    onCode: (c: string) => codes.push(c),
    WebSocketImpl: FakeSocket as never,
    relayHost: "flagshipserver.com",
    secure: true,
    apex: APEX,
  });
  const ws = FakeSocket.last!;
  const params = new URL(request.approvalUrl.replace("flagship://", "https://x/")).searchParams;
  return { request, ws, codes, sid: params.get("s")!, pk: params.get("k")! };
}

describe("remote: QR first", () => {
  it("shows a QR naming only a relay session and a browser key", async () => {
    const { request, ws, sid, pk } = await open();
    expect(request.approvalUrl).toMatch(/^flagship:\/\/remote\?s=[\w-]+&k=[\w-]+$/);
    expect(ws.url).toBe(`wss://flagshipserver.com/qr-pipe/${sid}?role=browser`);
    expect(Buffer.from(pk, "base64url")).toHaveLength(32);
    request.close();
    await request.delivered.catch(() => {});
  });

  it("shows the phone's code and opens the sealed ticket", async () => {
    const { request, ws, codes, pk } = await open();
    await ws.frame({ kind: "accepted" });
    const sealed = await phoneSeal(pk, TICKET);
    await ws.frame({ kind: "peer-hello", phonePk: sealed.phonePk });
    expect(codes).toEqual([sealed.sas]);
    await ws.frame({ kind: "peer-deliver", ciphertext: sealed.ciphertext, nonce: sealed.nonce });
    await expect(request.delivered).resolves.toEqual({
      ticketId: TICKET.ticketId,
      ticketSecret: TICKET.ticketSecret,
      podBaseUrl: TICKET.podBaseUrl,
      username: "alice",
    });
  });

  it("asks for a fresh QR when the session runs out", async () => {
    const { request, ws } = await open();
    await ws.frame({ kind: "accepted" });
    await ws.frame({ kind: "expired" });
    await expect(request.delivered).rejects.toMatchObject({ restart: true });
  });

  it("reports an unreachable relay instead of looping", async () => {
    const { request, ws } = await open();
    ws.close();
    await expect(request.delivered).rejects.not.toHaveProperty("restart");
  });
});

describe("remote: ticket validation", () => {
  const parse = (obj: unknown) => parseRemoteTicket(JSON.stringify(obj), { apex: APEX });

  it("accepts a ticket for a server on the data apex", () => {
    expect(parse(TICKET).podBaseUrl).toBe("https://home.alice.flagship.services");
  });

  it.each([
    ["another kind", { ...TICKET, kind: "flagship/recipe/v1" }],
    ["a server off the data apex", { ...TICKET, podBaseUrl: "https://evil.example" }],
    ["a look-alike apex", { ...TICKET, podBaseUrl: "https://home.alice.evilflagship.services" }],
    ["plain http", { ...TICKET, podBaseUrl: "http://home.alice.flagship.services" }],
    ["a path", { ...TICKET, podBaseUrl: "https://home.alice.flagship.services/x" }],
    ["a short secret", { ...TICKET, ticketSecret: "cd" }],
  ])("refuses %s", (_label, obj) => {
    expect(() => parse(obj)).toThrow();
  });
});
