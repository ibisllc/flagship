import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  REMOTE_TICKET_KIND,
  openRemoteRequest,
  parseRemoteTicket,
  remoteLandingFqdn,
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

async function open(opts: { confirmTimeoutMs?: number } = {}) {
  const codes: string[] = [];
  const request = await openRemoteRequest({
    ...opts,
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
    expect(request.approvalUrl).toMatch(/^https:\/\/flagshipserver\.com\/remote\?s=[\w-]+&k=[\w-]+$/);
    expect(ws.url).toBe(`wss://flagshipserver.com/qr-pipe/${sid}?role=browser`);
    expect(Buffer.from(pk, "base64url")).toHaveLength(32);
    request.close();
    await request.delivered.catch(() => {});
  });

  it("shows the phone's code and opens the sealed ticket once the person confirms it", async () => {
    const { request, ws, codes, pk } = await open();
    await ws.frame({ kind: "accepted" });
    const sealed = await phoneSeal(pk, TICKET);
    await ws.frame({ kind: "peer-hello", phonePk: sealed.phonePk });
    expect(codes).toEqual([sealed.sas]);
    await request.confirmCode();
    await ws.frame({ kind: "peer-deliver", ciphertext: sealed.ciphertext, nonce: sealed.nonce });
    await expect(request.delivered).resolves.toEqual({
      ticketId: TICKET.ticketId,
      ticketSecret: TICKET.ticketSecret,
      podBaseUrl: TICKET.podBaseUrl,
      username: "alice",
    });
  });

  const settledState = async (p: Promise<unknown>) => {
    let state = "pending";
    p.then(() => { state = "resolved"; }, () => { state = "rejected"; });
    await new Promise((r) => setTimeout(r, 20));
    return state;
  };

  it("never opens a ticket delivered before the code is confirmed", async () => {
    const { request, ws, pk } = await open();
    await ws.frame({ kind: "accepted" });
    const sealed = await phoneSeal(pk, TICKET);
    await ws.frame({ kind: "peer-hello", phonePk: sealed.phonePk });
    await ws.frame({ kind: "peer-deliver", ciphertext: sealed.ciphertext, nonce: sealed.nonce });
    expect(await settledState(request.delivered)).toBe("pending");
    expect(ws.closed).toBe(false);
    request.close();
    await expect(request.delivered).rejects.toMatchObject({ restart: true });
  });

  it("drops a held ticket and restarts when the codes differ", async () => {
    const { request, ws, pk } = await open();
    await ws.frame({ kind: "accepted" });
    const sealed = await phoneSeal(pk, TICKET);
    await ws.frame({ kind: "peer-hello", phonePk: sealed.phonePk });
    await ws.frame({ kind: "peer-deliver", ciphertext: sealed.ciphertext, nonce: sealed.nonce });
    request.rejectCode();
    await expect(request.delivered).rejects.toMatchObject({ restart: true, declined: true });
    expect(ws.closed).toBe(true);
    await request.confirmCode();
    await expect(request.delivered).rejects.toMatchObject({ declined: true });
  });

  it("drops a held ticket and restarts when nobody confirms in time", async () => {
    const { request, ws, pk } = await open({ confirmTimeoutMs: 30 });
    await ws.frame({ kind: "accepted" });
    const sealed = await phoneSeal(pk, TICKET);
    await ws.frame({ kind: "peer-hello", phonePk: sealed.phonePk });
    await ws.frame({ kind: "peer-deliver", ciphertext: sealed.ciphertext, nonce: sealed.nonce });
    await expect(request.delivered).rejects.toMatchObject({ restart: true, unconfirmed: true });
    expect(ws.closed).toBe(true);
  });

  it("opens an early ticket exactly once when the person confirms after it arrived", async () => {
    const { request, ws, pk } = await open();
    await ws.frame({ kind: "accepted" });
    const sealed = await phoneSeal(pk, TICKET);
    await ws.frame({ kind: "peer-hello", phonePk: sealed.phonePk });
    await ws.frame({ kind: "peer-deliver", ciphertext: sealed.ciphertext, nonce: sealed.nonce });
    let resolutions = 0;
    const seen = request.delivered.then((t: unknown) => { resolutions++; return t; });
    await request.confirmCode();
    await request.confirmCode();
    await ws.frame({ kind: "peer-deliver", ciphertext: sealed.ciphertext, nonce: sealed.nonce });
    await expect(seen).resolves.toMatchObject({ ticketId: TICKET.ticketId, podBaseUrl: TICKET.podBaseUrl });
    expect(resolutions).toBe(1);
    expect(ws.closed).toBe(true);
  });

  it("asks again when a different phone key replaces the confirmed one", async () => {
    const { request, ws, codes, pk } = await open();
    await ws.frame({ kind: "accepted" });
    const first = await phoneSeal(pk, TICKET);
    await ws.frame({ kind: "peer-hello", phonePk: first.phonePk });
    await request.confirmCode();
    const second = await phoneSeal(pk, { ...TICKET, podBaseUrl: "https://home.mallory.flagship.services", username: "mallory" });
    await ws.frame({ kind: "peer-hello", phonePk: second.phonePk });
    expect(codes).toEqual([first.sas, second.sas]);
    await ws.frame({ kind: "peer-deliver", ciphertext: second.ciphertext, nonce: second.nonce });
    expect(await settledState(request.delivered)).toBe("pending");
    request.rejectCode();
    await expect(request.delivered).rejects.toMatchObject({ declined: true });
  });

  it("the page redeems only after Yes and restarts on No", () => {
    const view = readFileSync(resolve(__dirname, "..", "public", "webapp", "views", "companion-dock-start.js"), "utf8");
    expect(view).toContain('$("dock-code-yes")');
    expect(view).toMatch(/dock-code-yes[\s\S]*confirmCode\(\)/);
    expect(view).toMatch(/dock-code-no[\s\S]*rejectCode\(\)/);
    expect(view).toMatch(/error\?\.declined\) return void startRequest\(/);
    expect(view).toMatch(/error\?\.unconfirmed\) return void startRequest\(/);
    const html = readFileSync(resolve(__dirname, "..", "public", "webapp", "index.html"), "utf8");
    expect(html).toContain("Does your phone show this code?");
    expect(html).toMatch(/id="dock-code-yes"/);
    expect(html).toMatch(/id="dock-code-no"/);
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

  it("round-trips a sealed ticket into exactly the fields the redeem needs", () => {
    expect(parseRemoteTicket(JSON.stringify(TICKET), { apex: APEX })).toEqual({
      ticketId: TICKET.ticketId,
      ticketSecret: TICKET.ticketSecret,
      podBaseUrl: "https://home.alice.flagship.services",
      username: "alice",
    });
  });

  it("refuses garbage and a ticket missing its fields", () => {
    for (const text of ["", "not json at all!@#$", "null", JSON.stringify({ kind: REMOTE_TICKET_KIND, ticketId: "x" })]) {
      expect(() => parseRemoteTicket(text, { apex: APEX }), text).toThrow();
    }
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

describe("after the phone approves (W19)", () => {
  it("opens the page of the server the phone connected this browser to", () => {
    expect(remoteLandingFqdn({ podBaseUrl: "https://Home.Smoketest.flagship.services" })).toBe("home.smoketest.flagship.services");
    expect(remoteLandingFqdn({ podBaseUrl: "not a url" })).toBeNull();
    expect(remoteLandingFqdn(null)).toBeNull();
  });

  it("the shell lands on that server's page, not the keyless Home", () => {
    const app = readFileSync(resolve(__dirname, "..", "public", "webapp", "app.js"), "utf8");
    const dock = app.slice(app.indexOf("initCompanionDockStartView({"), app.indexOf("initCompanionRequestsView();"));
    expect(dock).toContain("enterServerDetail(fqdn)");
    expect(dock.indexOf("enterServerDetail(fqdn)")).toBeLessThan(dock.indexOf("enterHome()"));
  });
});
