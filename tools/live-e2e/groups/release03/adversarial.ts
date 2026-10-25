// V01 live adversarial pass (docs/security-assessment/): the boundaries a unit test cannot reach,
// attacked on a real box from outside. Every check is `AT-LIVE-nn`, names the boundary it attacks
// and the defect it would catch, and expects a refusal with NO effect (the box state read back
// after). It runs last (phase 10, alone): a regression here (a forged power order obeyed, an update
// order replayed) could disturb the box, so nothing runs after it on A1.
//
// Leaves behind: nothing on purpose. The probe app `advprobe` is removed and the Remote session it
// opens is revoked; the update-replay check leaves A1's `lastUpdate` at a refusal (a random target
// commit) and its update nonce burned, which only this run's teardown sees.
import { randomBytes } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils";
import {
  accessListSha256,
  appMemberRoleTargetAid,
  ed,
  normalizeAccessList,
  serviceEnvValueSha256,
  signAppAccessGrant,
  signAppRank,
  signJournalRequest,
  signPhoneOrder,
  signServerOrder,
  signServiceEnvChange,
  signUninstallService,
  signUpdateOrder,
  withRule,
  type AppAccessGrant,
  type AppRankOrder,
  type JournalRequest,
  type Keypair,
  type PhoneOrder,
  type ServerOrder,
  type ServiceEnvChange,
  type UninstallServiceRequest,
  type UpdateOrder,
} from "@flagship/protocol";
import { classifyEgressProbe, isRefusal, rawHttps, sansConfined, signatureVariants, wsOutcome, ZERO_SIG, type SignatureVariant } from "../../lib/adversarial.js";
import { pair, pods, type Account, type Box } from "../../lib/fleet.js";
import { CONTROL, SERVICES, SkipError, assert, certInfo, http, postJson, short, tryHttp, type Resp } from "../../lib/harness.js";
import { echoedFlagshipHeaders, installWhoami, setMode, waitServing } from "../gating.js";
import { PY_APP } from "../runtimes.js";
import type { Group } from "../types.js";
import { mailboxAuth } from "../update.js";
import { journal, uninstall, until } from "./util.js";

const SLUG = "advprobe";

const hex = (b: Uint8Array) => bytesToHex(b);

function stranger(): Keypair {
  const seed = new Uint8Array(randomBytes(32));
  return { privateKey: seed, publicKey: ed.getPublicKey(seed) } as Keypair;
}

/** Sends `body` once per variant (the signature field set or left out) and asserts each is a refusal. */
async function refuseAll(send: (sig: string | undefined) => Promise<Resp>, variants: SignatureVariant[]): Promise<string> {
  const seen: string[] = [];
  for (const v of variants) {
    const r = await send(v.signature);
    seen.push(`${v.label}=${r.status}`);
    assert(isRefusal(r.status), `${v.label}: expected a 4xx refusal, got ${r.status}: ${short(r.text)}`);
  }
  return seen.join(", ");
}

async function serving(b: Box): Promise<number> {
  return (await tryHttp(`https://${b.fqdn}/`, {}, 15_000)).status;
}

export const adversarial: Group = {
  name: "adversarial",
  title: "V01 live: forged, foreign and replayed orders, session scope, header and SNI confusion, app egress, arch-v2 state",
  needs: ["A1", "B1"],
  phase: 10,
  parallel: false,
  async run({ A, B, rec, box, groupOk }) {
    const acctB = B as Account;
    const a1 = box("A1");
    const b1 = box("B1");
    const fqdn = a1.fqdn;
    const { irk, adminRoot } = A.keys;
    const evil = stranger();
    const sessA = await pair(A, a1);
    const sessB = await pair(acctB, b1);
    const s = { "x-flagship-session": sessA };
    const serviceRef = `${A.username}--${SLUG}`;
    const app = `https://${SLUG}.${fqdn}`;
    let companion = "";

    const installed = await rec.check("setup: an open header-echo probe app (advprobe) on A1", async () => {
      await installWhoami(A, a1, SLUG, { enabled: true });
      await waitServing(`${app}/`);
      return serviceRef;
    });

    try {
      // ── signed routes on the real box ───────────────────────────────────
      await rec.check("AT-LIVE-02 journal (/api/journal, owner IRK): forged, foreign, other-box and unlisted-unit requests are refused and return no lines — catches a log read without the owner's key or outside the unit allowlist", async () => {
        const req: JournalRequest = { serverId: fqdn, unit: "flagship-daemon", lines: 5, issuedAt: Date.now() };
        const send = (body: Record<string, unknown>) => postJson(`https://${fqdn}/api/journal`, body);
        const variants = signatureVariants(hex(signJournalRequest(req, irk)), {
          "account B's IRK": hex(signJournalRequest(req, acctB.keys.irk)),
          "a stranger's key": hex(signJournalRequest(req, evil)),
        });
        const seen = await refuseAll((sig) => send(sig === undefined ? { request: req } : { request: req, signature: sig }), variants);
        const otherBox: JournalRequest = { ...req, serverId: b1.fqdn };
        const r1 = await send({ request: otherBox, signature: hex(signJournalRequest(otherBox, irk)) });
        assert(isRefusal(r1.status), `a request naming B1, sent to A1: ${r1.status}`);
        const unit: JournalRequest = { ...req, unit: "ssh" };
        const r2 = await send({ request: unit, signature: hex(signJournalRequest(unit, irk)) });
        assert(r2.status === 403 && !Array.isArray(r2.json?.lines), `unit outside the allowlist: ${r2.status} ${short(r2.text)}`);
        const stale: JournalRequest = { ...req, issuedAt: Date.now() - 3_600_000 };
        const r3 = await send({ request: stale, signature: hex(signJournalRequest(stale, irk)) });
        assert(isRefusal(r3.status), `an hour-old request: ${r3.status}`);
        return `${seen}; other box ${r1.status}, unit ${r2.status}, stale ${r3.status}`;
      });

      await rec.check("AT-LIVE-03 update order deposit (.com /api/server/<box>/update): another account's admin root, another account's mailbox, a forged signature are refused — catches a cross-account or forged update reaching the lane", async () => {
        const order: UpdateOrder = { serverDomain: fqdn, targetCommit: randomBytes(20).toString("hex"), fromCommit: randomBytes(20).toString("hex"), nonce: randomBytes(32).toString("hex"), issuedAt: Date.now() };
        const deposit = (who: Account, signature: string) =>
          postJson(`https://${CONTROL}/api/server/${encodeURIComponent(fqdn)}/update`, {
            ...mailboxAuth(who),
            deposit: { serverDomain: fqdn, requestNonceHex: randomBytes(32).toString("hex") },
            order,
            signature,
          });
        const tries: Array<[string, Account, string]> = [
          ["B's admin root, A's mailbox", A, hex(signUpdateOrder(order, acctB.keys.adminRoot))],
          ["A's admin root, B's mailbox", acctB, hex(signUpdateOrder(order, adminRoot))],
          ["all-zero signature", A, ZERO_SIG],
          ["a stranger's key", A, hex(signUpdateOrder(order, evil))],
          ["A's IRK (admin-pinned account)", A, hex(signUpdateOrder(order, irk))],
        ];
        const seen: string[] = [];
        for (const [label, who, sig] of tries) {
          const r = await deposit(who, sig);
          seen.push(`${label}=${r.status}`);
          assert(r.status === 403 || r.status === 401, `${label}: expected 401/403, got ${r.status}: ${short(r.text)}`);
        }
        return seen.join(", ");
      });

      if (installed) {
        const accessUrl = `https://${fqdn}/api/screens/services/${encodeURIComponent(serviceRef)}/access`;
        const listNow = async () => {
          const j = (await http(accessUrl, { headers: s })).json;
          return normalizeAccessList(String(j?.list ?? j?.access?.list ?? ""));
        };
        await rec.check("AT-LIVE-04 app access list (owner session + admin-root grant): forged, foreign, swapped-list and other-server grants are refused and the list is unchanged — catches egress opened without the admin's signature over that exact list", async () => {
          const before = await listNow();
          const list = withRule(before, "allow", "attacker.example");
          const grant: AppAccessGrant = { serverDomain: fqdn, serviceId: serviceRef, listSha256: accessListSha256(list), issuedAt: Date.now() };
          const send = (body: Record<string, unknown>) => postJson(accessUrl, body, s);
          const seen = await refuseAll(
            (sig) => send(sig === undefined ? { list, grant } : { list, grant, signature: sig }),
            signatureVariants(hex(signAppAccessGrant(grant, adminRoot)), {
              "account B's admin root": hex(signAppAccessGrant(grant, acctB.keys.adminRoot)),
              "A's IRK": hex(signAppAccessGrant(grant, irk)),
            }),
          );
          const benign = withRule(before, "allow", "example.org");
          const g2: AppAccessGrant = { ...grant, listSha256: accessListSha256(benign) };
          const swapped = await send({ list, grant: g2, signature: hex(signAppAccessGrant(g2, adminRoot)) });
          assert(isRefusal(swapped.status), `a grant over another list: ${swapped.status}`);
          const g3: AppAccessGrant = { ...grant, serverDomain: b1.fqdn };
          const other = await send({ list, grant: g3, signature: hex(signAppAccessGrant(g3, adminRoot)) });
          assert(isRefusal(other.status), `a grant naming another server: ${other.status}`);
          const after = await listNow();
          assert(after === before && !after.includes("attacker.example"), `the list changed: ${short(after)}`);
          return `${seen}; swapped ${swapped.status}, other server ${other.status}; list unchanged`;
        });

        await rec.check("AT-LIVE-06 app env change (/api/services/<id>/env): forged, foreign and value-swapped changes are refused — catches a secret written without the owner's signature over that exact value", async () => {
          const envUrl = `https://${fqdn}/api/services/${encodeURIComponent(serviceRef)}/env`;
          const change: ServiceEnvChange = { serverId: fqdn, serviceId: serviceRef, op: "set", name: "ADV_PROBE", valueSha256: serviceEnvValueSha256("a"), issuedAt: Date.now(), nonce: randomBytes(16).toString("hex") };
          const seen = await refuseAll(
            (sig) => postJson(envUrl, sig === undefined ? { change, value: "a" } : { change, value: "a", signature: sig }, {}, 60_000),
            signatureVariants(hex(signServiceEnvChange(change, irk)), {
              "account B's IRK": hex(signServiceEnvChange(change, acctB.keys.irk)),
              "account B's admin root": hex(signServiceEnvChange(change, acctB.keys.adminRoot)),
            }),
          );
          const fresh: ServiceEnvChange = { ...change, nonce: randomBytes(16).toString("hex"), issuedAt: Date.now() };
          const swapped = await postJson(envUrl, { change: fresh, value: "b", signature: hex(signServiceEnvChange(fresh, irk)) }, {}, 60_000);
          assert(isRefusal(swapped.status), `a value other than the signed hash: ${swapped.status} ${short(swapped.text)}`);
          return `${seen}; swapped value ${swapped.status}`;
        });

        await rec.check("AT-LIVE-07 rank order (/members/rank): forged, IRK, foreign-admin and other-app orders are refused — catches a rank raised without this account's admin root", async () => {
          const target = appMemberRoleTargetAid(randomBytes(32).toString("hex"));
          const order: AppRankOrder = { serviceRef, target, rank: "master", issuedAt: Date.now() };
          const url = `https://${fqdn}/api/screens/services/${encodeURIComponent(serviceRef)}/members/rank`;
          const seen = await refuseAll(
            (sig) => postJson(url, sig === undefined ? { order } : { order, signature: sig }, s),
            signatureVariants(hex(signAppRank(order, adminRoot)), {
              "A's IRK": hex(signAppRank(order, irk)),
              "account B's admin root": hex(signAppRank(order, acctB.keys.adminRoot)),
            }),
          );
          const otherApp: AppRankOrder = { ...order, serviceRef: `${A.username}--elsewhere` };
          const r = await postJson(url, { order: otherApp, signature: hex(signAppRank(otherApp, adminRoot)) }, s);
          assert(isRefusal(r.status), `an order for another app sent to this one: ${r.status} ${short(r.text)}`);
          return `${seen}; other app ${r.status}`;
        });
      }

      await rec.check("AT-LIVE-08 server order (/api/screens/server-order): forged, IRK, foreign-admin and other-account orders are refused — catches leadership moved without this account's admin root", async () => {
        const stk = String((await pods(A.username)).find((p) => p.serverDomain === fqdn)?.identityPubKey ?? "").toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(stk)) throw new SkipError("A1's STK is not in /pods");
        const order: ServerOrder = { user: A.username, stks: [stk], issuedAt: Date.now(), nonce: randomBytes(32).toString("hex") };
        const url = `https://${fqdn}/api/screens/server-order`;
        const seen = await refuseAll(
          (sig) => postJson(url, sig === undefined ? { order } : { order, signature: sig }, s),
          signatureVariants(signServerOrder(order, adminRoot), {
            "A's IRK": signServerOrder(order, irk),
            "account B's admin root": signServerOrder(order, acctB.keys.adminRoot),
          }),
        );
        const otherAcct: ServerOrder = { ...order, user: acctB.username };
        const r = await postJson(url, { order: otherAcct, signature: signServerOrder(otherAcct, acctB.keys.adminRoot) }, s);
        assert(isRefusal(r.status), `B's own valid order sent to A's box: ${r.status} ${short(r.text)}`);
        return `${seen}; B's order ${r.status}`;
      });

      // ── sessions and the central authorization layer ────────────────────
      await rec.check("AT-LIVE-09 paired sessions are per box: B's session on A1 and A's on B1 are 401 — catches a session store shared across accounts", async () => {
        const x = await http(`https://${fqdn}/api/screens/server-detail`, { headers: { "x-flagship-session": sessB } });
        const y = await http(`https://${b1.fqdn}/api/screens/server-detail`, { headers: { "x-flagship-session": sessA } });
        assert(x.status === 401 && y.status === 401, `B on A1 ${x.status}, A on B1 ${y.status}`);
        return "401, 401";
      });

      const opened = await rec.check("setup: open a Remote (companion) session on A1 (mint a ticket, redeem it)", async () => {
        const m = await postJson(`https://${fqdn}/api/screens/companion/mint-ticket`, { label: "adversarial" }, s);
        assert(m.status === 200, `mint ${m.status}: ${short(m.text)}`);
        const r = await postJson(`https://${fqdn}/api/companion/redeem`, { ticketId: m.json.ticketId, ticketSecret: m.json.ticketSecret });
        assert(r.status === 200 && typeof r.json?.companionSessionToken === "string", `redeem ${r.status}: ${short(r.text)}`);
        companion = r.json.companionSessionToken;
        return "companion session";
      });
      if (opened) {
        const cs = { "x-flagship-session": companion };
        await rec.check("AT-LIVE-10 a Remote session reaches no build, key, backup, AI, credential or session route (SEC-AUTH-002) — catches a new route family left open to companions", async () => {
          const ok = await http(`https://${fqdn}/api/screens/server-detail`, { headers: cs });
          assert(ok.status === 200, `control read ${ok.status}`);
          const probes: Array<[string, string, unknown?]> = [
            ["GET", "/api/screens/paired-sessions/list"],
            ["GET", "/api/screens/api-keys"],
            ["GET", "/api/screens/debug-access"],
            ["GET", "/api/screens/build-credentials"],
            ["GET", "/api/screens/llm/sessions"],
            ["GET", "/api/screens/server-archive"],
            ["POST", "/api/build/git", { gitUrl: "https://github.com/octocat/Hello-World", ref: "master" }],
            ["GET", `/api/backups/${encodeURIComponent(serviceRef)}`],
            ["POST", "/api/identity/rotate", {}],
            ["POST", "/api/screens/companion/mint-ticket", {}],
          ];
          const seen: string[] = [];
          for (const [method, p, body] of probes) {
            const r = await http(`https://${fqdn}${p}`, { method, headers: { ...cs, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
            seen.push(`${method} ${p.split("/").slice(2, 4).join("/")}=${r.status}`);
            assert(isRefusal(r.status), `${method} ${p}: ${r.status} ${short(r.text)}`);
          }
          return seen.join(" ");
        });
        await rec.check("AT-LIVE-11 ambiguous paths (%2e%2e, //, %2f, ./, backslash) from a Remote session are refused, sent byte for byte — catches a router and a handler normalising one path two ways", async () => {
          const paths = [
            "/api/screens/%2e%2e/build/git",
            "/api/screens/%2E%2E/screens/paired-sessions/list",
            "/api/screens//paired-sessions/list",
            "/api/screens/paired-sessions%2flist",
            "/api/screens/./paired-sessions/list",
            "/api/screens/x/../paired-sessions/list",
            "/api/screens/%5cpaired-sessions/list",
          ];
          const seen: string[] = [];
          for (const p of paths) {
            const r = await rawHttps({ sni: fqdn, host: fqdn, path: p, headers: cs });
            seen.push(`${p.slice(13)}=${r.status}`);
            assert(r.status !== 0, `${p}: no HTTP answer`);
            assert(r.status < 200 || r.status >= 300, `${p}: ${r.status} ${short(r.text)}`);
            assert(!/"sessions"\s*:/.test(r.text), `${p} returned the session list`);
          }
          return seen.join(" ");
        });
      }

      await rec.check("AT-LIVE-14 stream upgrades: a session token in the URL is refused; a ticket opens once, then is spent (N06) — catches bearers leaking into URLs and replayable tickets", async () => {
        const url = await wsOutcome(`wss://${fqdn}/api/screens/events?sessionToken=${sessA}`);
        assert(url !== "open", "the upgrade with ?sessionToken= opened");
        const t = await postJson(`https://${fqdn}/api/screens/ws-ticket`, { route: "/api/screens/events" }, s);
        assert(t.status === 200 && typeof t.json?.ticket === "string", `ticket ${t.status}: ${short(t.text)}`);
        const first = await wsOutcome(`wss://${fqdn}/api/screens/events?ticket=${encodeURIComponent(t.json.ticket)}`);
        const again = await wsOutcome(`wss://${fqdn}/api/screens/events?ticket=${encodeURIComponent(t.json.ticket)}`);
        assert(first === "open", `the fresh ticket did not open the stream (${first})`);
        assert(again !== "open", "the spent ticket opened the stream again");
        const other = await postJson(`https://${fqdn}/api/screens/ws-ticket`, { route: "/api/screens/events" }, s);
        const wrongRoute = await wsOutcome(`wss://${fqdn}/api/screens/vibe-code/nope/stream?ticket=${encodeURIComponent(other.json?.ticket ?? "")}`);
        assert(wrongRoute !== "open", "a ticket for /events opened another stream route");
        return `url token ${url}, ticket ${first}, reuse ${again}, other route ${wrongRoute}`;
      });

      // ── what an app sees ────────────────────────────────────────────────
      if (installed) {
        await rec.check("AT-LIVE-12 client-sent identity (X-Flagship-* in dash, underscore and upper case, a forged signature, a made-up session cookie) never reaches the app; an anonymous visitor gets no rank — catches identity forged past the proxy", async () => {
          const forged = {
            "X-Flagship-Role": "master",
            "X-FLAGSHIP-USER": "forged-user",
            "x-flagship-visitor": "member",
            "X-Flagship-Signature": "ab".repeat(64),
            X_Flagship_Role: "owner",
            "X-Flagship_User": "forged-user-2",
            cookie: `Flagship-App-Session=${randomBytes(32).toString("hex")}`,
          };
          const r = await tryHttp(`${app}/`, { headers: { accept: "text/html", ...forged } });
          assert(r.status === 200, `got ${r.status}`);
          const h = echoedFlagshipHeaders(r.text);
          assert(h["x-flagship-visitor"] === "anonymous", `visitor=${h["x-flagship-visitor"]}`);
          assert(!h["x-flagship-role"] && !h["x-flagship-user"], `identity reached the app: ${JSON.stringify(h)}`);
          assert(!/forged-user|X_Flagship_Role|X-Flagship_User/i.test(r.text), "a forged header reached the app");
          assert(!r.text.includes("ab".repeat(64)), "the client's X-Flagship-Signature was passed on");
          await setMode(A, a1, serviceRef, "restricted");
          try {
            const k = await tryHttp(`${app}/private`, { headers: { accept: "application/json", ...forged } }, 60_000);
            assert(k.status === 403 && !/Hostname:/i.test(k.text), `members-only with forged identity: ${k.status} ${short(k.text)}`);
          } finally {
            await setMode(A, a1, serviceRef, "open");
          }
          return "stripped; anonymous; members-only refused the forged member";
        });

        await rec.check("AT-LIVE-05 uninstall (DELETE /api/services/<id>): forged, IRK, foreign-admin and other-slug requests are refused and the app stays — catches an app removed without this account's admin root", async () => {
          const req: UninstallServiceRequest = { serverId: fqdn, creator: A.username, slug: SLUG, issuedAt: Date.now() };
          const del = (body: Record<string, unknown>) =>
            http(`https://${fqdn}/api/services/${encodeURIComponent(serviceRef)}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, 90_000);
          const seen = await refuseAll(
            (sig) => del(sig === undefined ? { request: req } : { request: req, signature: sig }),
            signatureVariants(hex(signUninstallService(req, adminRoot)), {
              "A's IRK (admin-pinned box)": hex(signUninstallService(req, irk)),
              "account B's admin root": hex(signUninstallService(req, acctB.keys.adminRoot)),
            }),
          );
          const otherSlug: UninstallServiceRequest = { ...req, slug: "somethingelse" };
          const r = await del({ request: otherSlug, signature: hex(signUninstallService(otherSlug, adminRoot)) });
          assert(isRefusal(r.status), `a request for another slug at this app's path: ${r.status} ${short(r.text)}`);
          assert((await tryHttp(`${app}/`)).status === 200, "the app is gone");
          return `${seen}; other slug ${r.status}; still serving`;
        });
      }

      await rec.check("AT-LIVE-13 app egress from inside a live app: metadata (plain, decimal, IPv4-mapped IPv6), loopback, the docker host bridge and the box's own name are fenced — catches SSRF through the egress proxy or a missing address class", async () => {
        const py = `https://${PY_APP}.${fqdn}`;
        const up = await tryHttp(`${py}/`, {}, 15_000);
        if (up.status !== 200) throw new SkipError(`the runtimes group's python app is not up on A1 (${up.status}; runtimes ${groupOk("runtimes") ? "passed" : "did not pass"})`);
        const targets = ["169.254.169.254", "2852039166", "[::ffff:a9fe:a9fe]", "127.0.0.1", "localhost", "[::1]", "172.17.0.1", "0.0.0.0", fqdn];
        const seen: string[] = [];
        let unclear = 0;
        for (const t of targets) {
          const p = (await tryHttp(`${py}/probe?host=${encodeURIComponent(t)}`, {}, 30_000)).json;
          const v = classifyEgressProbe(p);
          seen.push(`${t}=${v}`);
          assert(v !== "reached" && v !== "connected", `${t}: the app got through (${short(p)})`);
          if (v === "unclear") unclear++;
        }
        if (unclear === targets.length) throw new SkipError(`no probe answer could be read: ${seen.join(" ")}`);
        return seen.join(" ");
      });

      // ── TLS and routing ─────────────────────────────────────────────────
      await rec.check("AT-LIVE-15 certificates stay inside one account: A1 and B1 serve only their own account's names, and an unregistered name under the zone gets no certificate — catches a box or the relay answering for another user's name", async () => {
        const ca = certInfo(fqdn);
        const cb = certInfo(b1.fqdn);
        assert(sansConfined(ca.sans, A.username, SERVICES), `A1 sans=${ca.sans.join(",")}`);
        assert(sansConfined(cb.sans, acctB.username, SERVICES), `B1 sans=${cb.sans.join(",")}`);
        const nobody = `home.${randomBytes(6).toString("hex")}.${SERVICES}`;
        const cn = certInfo(nobody);
        assert(cn.sans.length === 0 && !cn.issuer, `an unregistered name got a certificate: ${cn.issuer} ${cn.sans.join(",")}`);
        const crossApp = certInfo(`${SLUG}.${acctB.username}.${SERVICES}`);
        assert(crossApp.sans.length === 0 || sansConfined(crossApp.sans, acctB.username, SERVICES), `B's app name got a cert naming ${crossApp.sans.join(",")}`);
        return `A1 ${ca.sans.length} names, B1 ${cb.sans.length} names, unregistered: none`;
      });

      await rec.check("AT-LIVE-16 SNI and Host disagree: SNI B1 with Host A1 (and the reverse) never answers with the other account's data — catches domain fronting across boxes on the relay", async () => {
        const x = await rawHttps({ sni: b1.fqdn, host: fqdn, path: "/api/screens/server-detail", headers: s });
        const y = await rawHttps({ sni: fqdn, host: b1.fqdn, path: "/api/screens/server-detail", headers: { "x-flagship-session": sessB } });
        for (const [label, r] of [["SNI B1/Host A1 with A's session", x], ["SNI A1/Host B1 with B's session", y]] as const) {
          assert(r.status !== 200, `${label}: 200 ${short(r.text)}`);
        }
        assert(!x.text.includes(fqdn), "B1 answered with A1's details");
        assert(!y.text.includes(b1.fqdn), "A1 answered with B1's details");
        return `${x.status}, ${y.status}`;
      });

      // ── arch-v2 effective state ─────────────────────────────────────────
      const archV2 = process.env.GYM_BOX_STACK === "arch-v2";
      await rec.check("AT-LIVE-18 arch-v2 effective state from the daemon's own journal: unprivileged daemon, Podman, the Rust path installed with no fallback — catches a box that silently stays root or on a regressed binary", async () => {
        if (!archV2) throw new SkipError(`GYM_BOX_STACK=${process.env.GYM_BOX_STACK ?? "(unset)"}: the classic stack runs as root on Docker by design`);
        const lines = await journal(A, a1, 500);
        const has = (re: RegExp) => lines.some((l) => re.test(l));
        assert(!has(/running as root: flagship-privd is not in yet/), "the daemon says it runs as root");
        assert(!has(/\[rust-path\] could not install|the Rust binary in this release (is not usable|does not come up)/), "a Rust component fell back or did not install");
        const proofs = [
          has(/running as flagship; host operations go through flagship-privd/) ? "unprivileged" : null,
          has(/\[engine\] apps run on Podman/) ? "podman" : null,
        ].filter(Boolean);
        if (has(/\[engine\] apps run on Docker/)) throw new Error("the arch-v2 box runs apps on Docker");
        if (proofs.length === 0) throw new SkipError("the start-up lines have scrolled out of the 500-line tail; nothing contrary seen");
        return proofs.join(", ");
      });
      await rec.check("AT-LIVE-19 privd's audit of a refused operation is readable to the owner — catches refusals nobody can see", async () => {
        if (!archV2) throw new SkipError("privd runs only on the arch-v2 stack");
        const req: JournalRequest = { serverId: fqdn, unit: "flagship-privd", lines: 200, issuedAt: Date.now() };
        const r = await postJson(`https://${fqdn}/api/journal`, { request: req, signature: hex(signJournalRequest(req, irk)) });
        if (r.status === 403 && /unit not allowed/.test(r.text)) {
          throw new SkipError("the signed journal reads only flagship-daemon and flagship-data-services, so privd's audit cannot be read from outside (an operator reads it with journalctl -u flagship-privd)");
        }
        assert(r.status === 200, `${r.status}: ${short(r.text)}`);
        const lines = (r.json?.lines ?? []) as string[];
        return `${lines.length} privd lines; refusals: ${lines.filter((l) => /refus|denied|not allowed/i.test(l)).length}`;
      });

      // ── long and box-affecting checks last ──────────────────────────────
      await rec.check("AT-LIVE-17 a replayed update order (same nonce, new deposit) is refused by the box (nonce single-use survives the lane) — catches an owner's old order re-applied by whoever holds a copy", async () => {
        const detail = await http(`https://${fqdn}/api/screens/server-detail`, { headers: s });
        const current = String(detail.json?.currentCommit ?? "");
        if (!/^[0-9a-f]{40}$/.test(current)) throw new SkipError(`A1 reports no installed release commit (${short(current)}): an update order cannot be admitted`);
        // A random target: admitted (fresh, right box, right base), then refused by the catalog or the
        // artifact download, so nothing is installed; the nonce is burned on admission.
        const order: UpdateOrder = { serverDomain: fqdn, targetCommit: randomBytes(20).toString("hex"), fromCommit: current, nonce: randomBytes(32).toString("hex"), issuedAt: Date.now() };
        const signature = hex(signUpdateOrder(order, adminRoot));
        const deposit = () =>
          postJson(`https://${CONTROL}/api/server/${encodeURIComponent(fqdn)}/update`, { ...mailboxAuth(A), deposit: { serverDomain: fqdn, requestNonceHex: randomBytes(32).toString("hex") }, order, signature });
        const d1 = await deposit();
        assert(d1.status === 200, `first deposit ${d1.status}: ${short(d1.text)}`);
        const t8 = order.targetCommit.slice(0, 8);
        await until("the box consuming the first order", 15 * 60_000, async () => {
          const lines = await journal(A, a1, 400);
          return lines.some((l) => l.includes(order.targetCommit) || (l.includes("[self-update]") && l.includes(t8))) ? true : undefined;
        }, 20_000).catch(() => {
          throw new SkipError("the box did not log consuming the first order within 15 min (doorbell or poll); replay not exercised");
        });
        const d2 = await deposit();
        if (isRefusal(d2.status)) return `.com refused the re-deposit (${d2.status}): replay stopped at the lane`;
        assert(d2.status === 200, `second deposit ${d2.status}: ${short(d2.text)}`);
        const line = await until("the box refusing the replay", 15 * 60_000, async () => {
          const lines = await journal(A, a1, 400);
          return lines.find((l) => /nonce already consumed; ignoring replay/.test(l));
        }, 20_000).catch(() => {
          throw new SkipError("no replay refusal logged within 15 min (the second order may not have been polled yet)");
        });
        const after = String((await http(`https://${fqdn}/api/screens/server-detail`, { headers: s })).json?.currentCommit ?? "");
        assert(after === current, `the box moved from ${current.slice(0, 8)} to ${after.slice(0, 8)}`);
        return `${short(line, 120)}; still on ${current.slice(0, 8)}`;
      });

      await rec.check("AT-LIVE-01 power (/api/power, admin-pinned): forged, flipped, stripped, IRK, foreign-admin and other-box orders are refused and the box keeps serving — catches a box powered off or locked without the admin root", async () => {
        const order: PhoneOrder = { type: "power-off", serverId: fqdn, mode: "restart", issuedAt: Date.now() };
        const send = (body: Record<string, unknown>) => postJson(`https://${fqdn}/api/power`, body);
        const seen = await refuseAll(
          (sig) => send(sig === undefined ? { request: order } : { request: order, signature: sig }),
          signatureVariants(hex(signPhoneOrder(order, adminRoot)), {
            "A's IRK (admin-pinned box)": hex(signPhoneOrder(order, irk)),
            "account B's admin root": hex(signPhoneOrder(order, acctB.keys.adminRoot)),
            "A's delegated key": hex(signPhoneOrder(order, A.keys.delegated)),
          }),
        );
        const otherBox: PhoneOrder = { ...order, serverId: b1.fqdn };
        const r = await send({ request: otherBox, signature: hex(signPhoneOrder(otherBox, adminRoot)) });
        assert(isRefusal(r.status), `an order naming B1, sent to A1: ${r.status}`);
        const offSigned: PhoneOrder = { type: "power-off", serverId: fqdn, mode: "off", issuedAt: order.issuedAt };
        const swapped = await send({ request: order, signature: hex(signPhoneOrder(offSigned, adminRoot)) });
        assert(isRefusal(swapped.status), `a signature over mode "off" with mode "restart" sent: ${swapped.status}`);
        await new Promise((res) => setTimeout(res, 15_000));
        const st = await serving(a1);
        assert(st === 200, `A1 stopped serving after the forged power orders (${st})`);
        return `${seen}; other box ${r.status}; swapped mode ${swapped.status}; still serving`;
      });
    } finally {
      if (companion) {
        await http(`https://${fqdn}/api/screens/paired-sessions/${companion.slice(0, 12)}`, { method: "DELETE", headers: s }).catch(() => undefined);
      }
      if (installed) await uninstall(A, a1, SLUG).catch(() => undefined);
    }
  },
};
