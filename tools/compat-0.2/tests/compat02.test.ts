/**
 * 0.2 app compat: the 0.2 store apps (iOS 1.1 build 5, Android versionCode 9) keep working against a 0.3 box and
 * the 0.3 `.com` through the store review (owner decision 2026-11-03: the review demo server is updated to 0.3;
 * RELEASE-0.3-JOURNAL.md F9). The requests are the 0.2 apps' own, recorded in fixtures/requests-0.2.json from their
 * sources at e9155777e. A failure here means a 0.2 app on a phone breaks: fix 0.3, never the fixture.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { WebSocket } from "ws";
import {
  canonicalDaemonStatusReport,
  canonicalLanHint,
  deriveIRK,
  deriveSWK,
  ed,
  parseAppAccessGrant,
  parseAppRankOrder,
  parseArchiveDownloadApproval,
  parseServiceAccessModeV2,
  parseServiceAllowRemoveV2,
  parseServiceEnvChange,
  verifyAppAccessGrant,
  verifyAppRank,
  verifyArchiveDownloadApproval,
  verifyCreateServiceInvite,
  verifyKnockAuthorization,
  verifyLlmPromoIssue,
  verifyPhoneOrder,
  verifyRevokeServiceInvite,
  verifyServiceAccessModeV2,
  verifyServiceAllowRemoveV2,
  verifyServiceEnvChange,
  verifyUpdateOrder,
  type DaemonStatusReport,
  type LanHint,
  type PhoneOrder,
} from "@flagship/protocol";
import { buildJournalHttp } from "../../../packages/server-daemon/src/journalHttp.js";
import { buildLegacyClientRoutes } from "../../../packages/server-daemon/src/legacyClientRoutes.js";
import { buildScreensHttp, type ScreensHttpDeps } from "../../../packages/server-daemon/src/screens/screensHttp.js";
import { buildScreensUpgradeHandler } from "../../../packages/server-daemon/src/screens/screensWs.js";
import { ScreensEventBus } from "../../../packages/server-daemon/src/screens/screensEvents.js";
import { UpgradeTicketStore } from "../../../packages/server-daemon/src/screens/upgradeTickets.js";
import { FilePairedSessionStore } from "../../../packages/server-daemon/src/pairedSessionStore.js";
import { AppMembership } from "../../../packages/server-daemon/src/membership.js";
import type { InstalledService } from "../../../packages/server-daemon/src/servicePlatform.js";
import type { HttpRequest, UpgradeRequest } from "../../../packages/server-daemon/src/runtime.js";
import { swkOps } from "../../../packages/server-daemon/tests/helpers/keyCustody.js";
import { SAYS_UPDATE, shownBy02Phone } from "../phone02.js";

interface SignedFixture { name: string; kind: string; wire: Record<string, unknown>; canonical: string }
const F = JSON.parse(readFileSync(new URL("../fixtures/requests-0.2.json", import.meta.url), "utf8")) as {
  issuedAt: number;
  signed: SignedFixture[];
  verifiedByPhone: SignedFixture[];
  decodedByPhone: Record<string, string[]>;
};

const fromHex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const key = ed.utils.randomPrivateKey();
const pub = ed.getPublicKey(key);
/** Sign the 0.2 canonical string exactly as the 0.2 app does (Ed25519 over its UTF-8). */
const sign02 = (canonical: string) => ed.sign(new TextEncoder().encode(canonical), key);

/** The 0.3 verifier (and, where the box parses the wire object, its parser) for each 0.2 signed request. */
const VERIFY_03: Record<string, (w: Record<string, unknown>, sig: Uint8Array) => boolean> = {
  "service-env-change": (w, s) => { const c = parseServiceEnvChange(w); return !!c && verifyServiceEnvChange(c, s, pub); },
  "app-rank": (w, s) => { const o = parseAppRankOrder(w); return !!o && verifyAppRank(o, s, pub); },
  "service-access-mode-v2": (w, s) => { const o = parseServiceAccessModeV2(w); return !!o && verifyServiceAccessModeV2(o, s, pub); },
  "service-allow-remove-v2": (w, s) => { const o = parseServiceAllowRemoveV2(w); return !!o && verifyServiceAllowRemoveV2(o, s, pub); },
  "app-access": (w, s) => { const g = parseAppAccessGrant(w); return !!g && verifyAppAccessGrant(g, s, pub); },
  "archive-download": (w, s) => { const a = parseArchiveDownloadApproval(w); return !!a && verifyArchiveDownloadApproval(a, s, pub); },
  "server-update": (w, s) => verifyUpdateOrder(w as never, s, pub),
  "llm-promo-issue": (w, s) => verifyLlmPromoIssue(w as never, s, pub),
  "service-invite-create": (w, s) => {
    const { authorAIDHex, ...rest } = w;
    return verifyCreateServiceInvite({ ...(rest as never), authorAID: fromHex(authorAIDHex as string) }, s, pub);
  },
  "service-invite-revoke": (w, s) => verifyRevokeServiceInvite(w as never, s, pub),
  "service-knock": (w, s) => {
    const { visitorAIDHex, ...rest } = w;
    return verifyKnockAuthorization({ ...(rest as never), visitorAID: fromHex(visitorAIDHex as string) }, s, pub);
  },
  "add-paired-session": (w, s) => verifyPhoneOrder(w as unknown as PhoneOrder, s, pub),
};

describe("0.2 app compat: signed requests verify on 0.3 (same canonical bytes)", () => {
  for (const f of F.signed) {
    it(f.name, () => {
      const verify = VERIFY_03[f.kind];
      expect(verify, `no 0.3 verifier wired for ${f.kind}`).toBeDefined();
      expect(verify!(f.wire, sign02(f.canonical))).toBe(true);
      // And only those bytes: one changed character is refused.
      expect(verify!(f.wire, sign02(`${f.canonical}0`))).toBe(false);
    });
  }
});

describe("0.2 app compat: what a 0.3 box signs still verifies on a 0.2 phone", () => {
  it("daemon-status (the certificate pin on /pods)", () => {
    const f = F.verifiedByPhone.find((x) => x.kind === "daemon-status")!;
    expect(new TextDecoder().decode(canonicalDaemonStatusReport(f.wire as unknown as DaemonStatusReport))).toBe(f.canonical);
  });
  it("lan-hint (LAN-direct)", () => {
    const f = F.verifiedByPhone.find((x) => x.kind === "lan-hint")!;
    expect(new TextDecoder().decode(canonicalLanHint(f.wire as unknown as LanHint))).toBe(f.canonical);
  });
});

// ---- the box's BFF, in process ----

const SERVER = "home.demo02.flagship.services";
const TOKEN = "8888888888888888888888888888888888888888888888888888888888888888";
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

async function sessions(): Promise<FilePairedSessionStore> {
  const d = mkdtempSync(join(tmpdir(), "compat02-"));
  dirs.push(d);
  const s = new FilePairedSessionStore(join(d, "paired-sessions.json"));
  await s.add(TOKEN, 100);
  return s;
}

function app(): InstalledService {
  const umk = { seed: new Uint8Array(32).fill(7) };
  const membership = new AppMembership("notes", "demo02", deriveIRK(umk).publicKey, swkOps(deriveSWK(umk, SERVER)));
  return {
    creator: "demo02", slug: "notes", serviceId: "demo02--notes", urlLabel: "notes", membership, containerPort: 8080, data: null, installedAt: 1_000,
    manifest: { schema_version: 1, name: "notes", description: "Notes", version: "0.1.0", runtime: { image: "img:1", port: 8080 }, data: {}, network: { subdomain: "notes" }, access: { enabled: true, default_role: "member" }, migration: { verification: "standard" } } as never,
  } as InstalledService;
}

/** A request exactly as the 0.2 apps send it to the box: the session in `x-flagship-session`. */
const req02 = (path: string, method = "GET", body?: unknown): HttpRequest => ({
  method, path, headers: { "x-flagship-session": TOKEN, "content-type": "application/json" },
  body: body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)),
});

async function bff() {
  const s = await sessions();
  const apps = [app()];
  const deps: ScreensHttpDeps = {
    gate: s, pairedSessions: s, serverFqdn: SERVER, username: "demo02", daemonVersion: "0.3.0", startedAt: 1_000, now: () => 5_000,
    servicePlatform: { list: () => apps, byServiceId: (id: string) => apps.find((a) => a.serviceId === id), byLabel: (l: string) => apps.find((a) => a.urlLabel === l) } as never,
  };
  return buildScreensHttp(deps);
}

const missing = (o: Record<string, unknown>, fields: string[]) => fields.filter((k) => o[k] === undefined || o[k] === null);

describe("0.2 app compat: the screens the 0.2 apps decode keep every field they require", () => {
  it("server-detail", async () => {
    const r = await (await bff())(req02("/api/screens/server-detail"));
    expect(r?.status).toBe(200);
    expect(missing(JSON.parse(r!.body as string), F.decodedByPhone["server-detail"]!)).toEqual([]);
  });
  it("apps-list", async () => {
    const r = await (await bff())(req02("/api/screens/apps-list"));
    const apps = JSON.parse(r!.body as string).apps as Array<Record<string, unknown>>;
    expect(apps).toHaveLength(1);
    expect(missing(apps[0]!, F.decodedByPhone.appSummary!)).toEqual([]);
  });
  it("app-detail", async () => {
    const r = await (await bff())(req02("/api/screens/app-detail/demo02--notes"));
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string);
    expect(missing(body, F.decodedByPhone["app-detail"]!)).toEqual([]);
    expect(missing(body.app, F.decodedByPhone.appSummary!)).toEqual([]);
    for (const m of body.members as Array<Record<string, unknown>>) expect(missing(m, F.decodedByPhone.member!)).toEqual([]);
  });
  it("Settings: paired sessions list and remove (iOS decodes the DELETE answer as a JSON object)", async () => {
    const handle = await bff();
    const list = JSON.parse((await handle(req02("/api/screens/paired-sessions/list")))!.body as string).sessions as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(missing(list[0]!, F.decodedByPhone["paired-session"]!)).toEqual([]);
    const del = await handle(req02(`/api/screens/paired-sessions/${list[0]!.tokenPrefix as string}`, "DELETE"));
    expect(del?.status).toBe(200);
    expect(typeof JSON.parse(del!.body as string)).toBe("object");
  });
});

describe("0.2 app compat: what 0.3 retired answers with an update sentence the 0.2 apps show", () => {
  it("server log (journal-read/v1, no nonce)", async () => {
    const handle = buildJournalHttp({
      serverId: SERVER, ownerIrkPub: pub, reader: { read: async () => [] }, now: () => F.issuedAt,
      usedNonces: { has: async () => false, mark: async () => {} } as never,
    });
    const request = { serverId: SERVER, unit: "flagship-daemon", lines: 200, issuedAt: F.issuedAt };
    const canonical = `flagship/journal-read/v1|${SERVER}|flagship-daemon|200|${F.issuedAt}`;
    const r = await handle({ method: "POST", path: "/api/journal", headers: {}, body: Buffer.from(JSON.stringify({ request, signature: Buffer.from(sign02(canonical)).toString("hex") })) });
    expect(r?.status).toBe(400);
    expect(shownBy02Phone(JSON.parse(r!.body as string))).toMatch(SAYS_UPDATE);
  });
  it("dead-man switch (/api/deadman/policy and /affirm)", async () => {
    const handle = buildLegacyClientRoutes();
    for (const path of ["/api/deadman/policy", "/api/deadman/affirm"]) {
      const r = await handle({ method: "POST", path, headers: {}, body: Buffer.from("{}") });
      expect(r?.status, path).toBe(410);
      expect(shownBy02Phone(JSON.parse(r!.body as string))).toMatch(SAYS_UPDATE);
    }
    expect(await handle({ method: "POST", path: "/api/power", headers: {}, body: Buffer.from("{}") })).toBeNull();
  });
});

// ---- streams: the 0.2 apps put the session in the URL ----

async function wsServer(handler: (a: UpgradeRequest) => boolean): Promise<{ port: number; close(): void }> {
  const server: Server = createServer((sock: Socket) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const sep = buf.indexOf("\r\n\r\n");
      if (sep === -1) return;
      const lines = buf.subarray(0, sep).toString("utf8").split(/\r\n/);
      const [method = "", path = "/"] = lines[0]!.split(" ");
      const headers: Record<string, string> = {};
      for (const l of lines.slice(1)) {
        const i = l.indexOf(":");
        if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
      }
      sock.off("data", onData);
      if (!handler({ socket: sock as never, method, path, headers, headBuffer: buf.subarray(sep + 4) })) sock.end("HTTP/1.1 501 Not Implemented\r\nContent-Length: 0\r\n\r\n");
    };
    sock.on("data", onData);
    sock.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as { port: number };
  return { port: addr.port, close: () => server.close() };
}

const statusOf = (ws: WebSocket) =>
  new Promise<number>((resolve) => {
    ws.once("open", () => { resolve(101); ws.close(); });
    ws.once("unexpected-response", (_r, res) => { resolve(res.statusCode ?? -1); res.resume(); });
    ws.once("error", () => resolve(-2));
  });

describe("0.2 app compat: the event stream with the session in the URL", () => {
  // Owner decision 2026-11-03: N06 stays strict. A 0.2 app's stream (token in the URL) is refused; the 0.2 apps close
  // it silently and lose only live in-app events, every screen still loads. 0.3 clients send the header (or a ticket).
  it("a token in the URL is refused with or without the header; the header alone connects", async () => {
    const s = await sessions();
    const handler = buildScreensUpgradeHandler({ gate: s, events: new ScreensEventBus(), tickets: new UpgradeTicketStore() });
    const srv = await wsServer(handler);
    try {
      const url = `ws://127.0.0.1:${srv.port}/api/screens/events?sessionToken=${TOKEN}`;
      expect(await statusOf(new WebSocket(url, { headers: { "x-flagship-session": TOKEN } }))).toBe(400);
      expect(await statusOf(new WebSocket(url))).toBe(400);
      expect(await statusOf(new WebSocket(`ws://127.0.0.1:${srv.port}/api/screens/events`, { headers: { "x-flagship-session": TOKEN } }))).toBe(101);
    } finally {
      srv.close();
    }
  });
});
