// Remote, QR first (remote.flagshipserver.com): the harness plays the browser
// (an X25519 key in the QR, `wss://<control>/qr-pipe/<sid>?role=browser`) and
// the phone (hello, the same 6-digit code, a one-use companion ticket minted
// on the box, sealed `flagship/remote-ticket/v1` delivered over the pipe).
// The browser redeems the ticket on the box; the companion session reads but
// can't write; a ticket works once; the owner sees it as a `remote` session
// and revoking it ends it.
import { randomBytes } from "node:crypto";
import {
  base64UrlEncode,
  deriveSessionMaterial,
  newBuilderKeypair,
  openDelivered,
  sealDelivered,
} from "@flagship/protocol";
import { pair } from "../lib/fleet.js";
import { CONTROL, SERVICES, assert, http, postJson, short } from "../lib/harness.js";
import type { Group } from "./types.js";

interface Frame {
  kind: string;
  [k: string]: unknown;
}

/** A WebSocket whose frames queue up until `next()` takes them. */
class Pipe {
  private queue: Frame[] = [];
  private waiters: Array<(f: Frame) => void> = [];
  readonly ws: WebSocket;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (m) => {
      const f = JSON.parse(String(m.data)) as Frame;
      const w = this.waiters.shift();
      if (w) w(f);
      else this.queue.push(f);
    };
  }
  open(): Promise<void> {
    return new Promise((res, rej) => {
      if (this.ws.readyState === WebSocket.OPEN) return res();
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error("websocket error"));
    });
  }
  next(ms = 15_000): Promise<Frame> {
    const f = this.queue.shift();
    if (f) return Promise.resolve(f);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("no frame in time")), ms);
      this.waiters.push((x) => {
        clearTimeout(t);
        res(x);
      });
    });
  }
  send(f: Frame): void {
    this.ws.send(JSON.stringify(f));
  }
  close(): void {
    try {
      this.ws.close();
    } catch {
      /* closed */
    }
  }
}

export const remote: Group = {
  name: "remote",
  title: "remote QR: browser ↔ phone over /qr-pipe, sealed ticket, redeem, read-only companion, one use, revoke",
  needs: ["A1"],
  phase: 2,
  async run({ A, rec, box }) {
    const b = box("A1");
    const session = await pair(A, b);
    const s = { "x-flagship-session": session };
    const sid = base64UrlEncode(randomBytes(16));
    const browserKey = newBuilderKeypair();
    const pipeUrl = (role: string) => `wss://${CONTROL}/qr-pipe/${sid}?role=${role}`;
    let browser: Pipe | null = null;
    let phone: Pipe | null = null;
    let ticket: { ticketId: string; ticketSecret: string } | null = null;
    let companion = "";
    try {
      const paired = await rec.check("the phone and the browser meet on the pipe and show the same 6-digit code", async () => {
        browser = new Pipe(pipeUrl("browser"));
        await browser.open();
        const acc = await browser.next();
        assert(acc.kind === "accepted", `browser got ${short(acc)}`);
        phone = new Pipe(pipeUrl("phone"));
        await phone.open();
        const phoneKey = newBuilderKeypair();
        phone.send({ kind: "hello", phonePk: base64UrlEncode(phoneKey.publicKey) });
        const ack = await phone.next();
        assert(ack.kind === "ack", `phone got ${short(ack)}`);
        const hello = await browser.next();
        assert(hello.kind === "peer-hello" && typeof hello.phonePk === "string", `browser got ${short(hello)}`);
        const onPhone = deriveSessionMaterial(phoneKey.secretKey, browserKey.publicKey);
        const onBrowser = deriveSessionMaterial(browserKey.secretKey, Buffer.from(hello.phonePk as string, "base64url"));
        assert(onPhone.sasCode === onBrowser.sasCode && /^\d{6}$/.test(onPhone.sasCode), `codes ${onPhone.sasCode} / ${onBrowser.sasCode}`);

        const m = await postJson(`https://${b.fqdn}/api/screens/companion/mint-ticket`, { label: "gym remote" }, s);
        assert(m.status === 200 && /^[0-9a-f]{32}$/.test(m.json?.ticketId) && /^[0-9a-f]{64}$/.test(m.json?.ticketSecret), `mint ${m.status}: ${short(m.text)}`);
        ticket = { ticketId: m.json.ticketId, ticketSecret: m.json.ticketSecret };
        const payload = { kind: "flagship/remote-ticket/v1", ...ticket, username: A.username, podBaseUrl: `https://${b.fqdn}` };
        const sealed = sealDelivered(new TextEncoder().encode(JSON.stringify(payload)), onPhone.aeadKey);
        phone.send({ kind: "deliver", ciphertext: sealed.ciphertextB64u, nonce: sealed.nonceB64u });
        const delivered = await phone.next();
        assert(delivered.kind === "delivered", `phone got ${short(delivered)}`);
        const got = await browser.next();
        assert(got.kind === "peer-deliver", `browser got ${short(got)}`);
        const opened = JSON.parse(new TextDecoder().decode(openDelivered(got.ciphertext as string, got.nonce as string, onBrowser.aeadKey)));
        assert(opened.kind === "flagship/remote-ticket/v1" && opened.ticketId === ticket.ticketId, `opened ${short(opened)}`);
        assert(new URL(opened.podBaseUrl).hostname.endsWith(`.${SERVICES}`), `podBaseUrl ${opened.podBaseUrl}`);
        return `code ${onPhone.sasCode}`;
      });
      if (!paired || !ticket) return;
      const t = ticket as { ticketId: string; ticketSecret: string };

      await rec.check("the pipe is single-use: a second phone can't deliver on the same session", async () => {
        const again = new Pipe(pipeUrl("phone"));
        try {
          await again.open().catch(() => undefined);
          if (again.ws.readyState !== WebSocket.OPEN) return "closed at connect";
          again.send({ kind: "deliver", ciphertext: "AAAA", nonce: "AAAAAAAAAAAAAAAA" });
          const f = await again.next(8000).catch(() => ({ kind: "closed" }) as Frame);
          assert(f.kind !== "delivered", `second delivery accepted: ${short(f)}`);
          return short(f, 80);
        } finally {
          again.close();
        }
      });
      await rec.check("the browser redeems the ticket on the box: a wrong secret is 401, the right one opens a 4-hour companion session", async () => {
        const wrong = await postJson(`https://${b.fqdn}/api/companion/redeem`, { ticketId: t.ticketId, ticketSecret: "0".repeat(64) });
        assert(wrong.status === 401, `wrong secret ${wrong.status}: ${short(wrong.text)}`);
        const r = await postJson(`https://${b.fqdn}/api/companion/redeem`, t);
        assert(r.status === 200 && /^[0-9a-f]{64}$/.test(r.json?.companionSessionToken), `redeem ${r.status}: ${short(r.text)}`);
        companion = r.json.companionSessionToken;
        const hours = (r.json.expiresAt - Date.now()) / 3_600_000;
        assert(hours > 3.9 && hours <= 4.05 && r.json.username === A.username, `expires in ${hours.toFixed(2)} h, user ${r.json.username}`);
        return `${hours.toFixed(2)} h`;
      });
      if (!companion) return;
      await rec.check("the ticket works once (409 on reuse)", async () => {
        const r = await postJson(`https://${b.fqdn}/api/companion/redeem`, t);
        assert(r.status === 409, `reuse ${r.status}: ${short(r.text)}`);
        return "409";
      });
      const cs = { "x-flagship-session": companion };
      await rec.check("the companion reads the server but every write is refused (companion-write-not-allowed)", async () => {
        for (const p of ["/api/screens/server-detail", "/api/screens/apps-list", "/api/screens/activity?limit=5"]) {
          const r = await http(`https://${b.fqdn}${p}`, { headers: cs });
          assert(r.status === 200, `${p} ${r.status}: ${short(r.text)}`);
        }
        const probes: Array<[string, unknown]> = [
          ["/api/screens/companion/mint-ticket", {}],
          ["/api/screens/app-backup/start", { serviceId: `${A.username}--pyapp` }],
          ["/api/screens/vibe-code/start", { prompt: "x" }],
          ["/api/screens/services/copy", {}],
        ];
        const got: string[] = [];
        for (const [p, body] of probes) {
          const r = await postJson(`https://${b.fqdn}${p}`, body, cs);
          got.push(`${p.split("/").slice(3).join("/")}=${r.status}`);
          assert(r.status === 403 && /companion-write-not-allowed/.test(r.text), `${p} ${r.status}: ${short(r.text)}`);
        }
        return got.join(" ");
      });
      const prefix = companion.slice(0, 12);
      await rec.check("the owner lists it as a `remote` browser session (their own device session is `device`)", async () => {
        const r = await http(`https://${b.fqdn}/api/screens/paired-sessions/list`, { headers: s });
        assert(r.status === 200, `${r.status}: ${short(r.text)}`);
        const rows = (r.json?.sessions ?? []) as Array<{ tokenPrefix: string; kind: string; current: boolean }>;
        const mine = rows.find((x) => x.tokenPrefix === prefix);
        const self = rows.find((x) => x.current);
        assert(mine?.kind === "remote", `companion row ${short(mine)}`);
        assert(self?.kind === "device", `own row ${short(self)}`);
        const c = await http(`https://${b.fqdn}/api/screens/companion/list`, { headers: s });
        assert((c.json?.companions ?? []).some((x: { tokenPrefix: string }) => x.tokenPrefix === prefix), `companion list ${short(c.text)}`);
        return `${rows.length} sessions`;
      });
      await rec.check("the owner revokes the remote session and the browser is signed out (401)", async () => {
        const d = await http(`https://${b.fqdn}/api/screens/paired-sessions/${prefix}`, { method: "DELETE", headers: s });
        assert(d.status === 200, `revoke ${d.status}: ${short(d.text)}`);
        const r = await http(`https://${b.fqdn}/api/screens/server-detail`, { headers: cs });
        assert(r.status === 401, `after revoke ${r.status}: ${short(r.text)}`);
        return "401";
      });
      await rec.check("an unused ticket expires (410 after 60 s)", async () => {
        const m = await postJson(`https://${b.fqdn}/api/screens/companion/mint-ticket`, {}, s);
        assert(m.status === 200, `mint ${m.status}`);
        const deadline = Date.now() + 90_000;
        let last = 0;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 10_000));
          if (Date.now() - m.json.expiresAt < 0) continue;
          const r = await postJson(`https://${b.fqdn}/api/companion/redeem`, { ticketId: m.json.ticketId, ticketSecret: m.json.ticketSecret });
          last = r.status;
          if (r.status === 410) return "410";
        }
        throw new Error(`expired ticket answered ${last}`);
      });
    } finally {
      (browser as Pipe | null)?.close();
      (phone as Pipe | null)?.close();
    }
  },
};
