#!/usr/bin/env node
// voici-abuse — the owner's review of voi.ci reports (docs/voici-and-messages.md §9.3, §9.6, §9.7). Talks to
// /api/admin/voici/* on .com (apps/com/src/voiciAbuse.ts). Apple expects a report to be acted on within 24 h:
// `npm run ops -- voici` warns when one is older.
//
//   npm run voici-abuse -- list [--all]                 open reports (or every report), oldest first
//   npm run voici-abuse -- show <report-id>             one report: reason, note, the envelope's attestation
//   npm run voici-abuse -- open-tag <report-id>         LOCAL: unwraps that quarter's abuse key with a YubiKey
//                                                       (age-plugin-yubikey: PIN + touch) and prints the account
//                                                       that sent the message, and its text if the owner attached it
//   npm run voici-abuse -- ban <username> <report-id> <reason>
//   npm run voici-abuse -- unban <username>
//   npm run voici-abuse -- dismiss <report-id>
//   npm run voici-abuse -- takedown <username> <reason>  repeats until the page's pieces are all deleted and purged
//   npm run voici-abuse -- restore <username>
//
// <reason>: spam | harassment | impersonation | illegal | other.
// Env: FLAGSHIP_ADMIN_SECRET (required), FLAGSHIP_BASE_URL (default https://flagshipserver.com).
// open-tag: --path <dir> (default .maintainers; reads abuse-keys/<epoch>.age), --identity <stub> (repeatable,
// default ~/.flagship-release/yubikey-identities.txt), --fake-yubikey <dir> (TEST MODE).
// Nothing opened here is sent anywhere or written to disk.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { b64Decode, openVoiciAbuseTag, openVoiciReportText } from "@flagship/protocol";
import { ageVault, DEFAULT_IDENTITIES, fakeVault, withSeed } from "./pq-release-key.mjs";

const REASONS = ["spam", "harassment", "impersonation", "illegal", "other"];

export function parseArgs(argv) {
  const o = { args: [], identities: [], path: ".maintainers", all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") o.all = true;
    else if (a === "--path") o.path = argv[++i];
    else if (a === "--identity") o.identities.push(argv[++i]);
    else if (a === "--fake-yubikey") o.fakeYubikey = argv[++i];
    else if (a === "-h" || a === "--help") o.help = true;
    else if (a.startsWith("--")) throw new Error(`unknown argument: ${a}`);
    else o.args.push(a);
  }
  o.verb = o.args.shift();
  const need = { list: 0, show: 1, "open-tag": 1, ban: 3, unban: 1, dismiss: 1, takedown: 2, restore: 1 }[o.verb];
  if (o.help) return o;
  if (need === undefined) throw new Error("first argument: list | show | open-tag | ban | unban | dismiss | takedown | restore");
  if (o.args.length !== need) throw new Error(`${o.verb} takes ${need} argument(s)`);
  if ((o.verb === "ban" && !REASONS.includes(o.args[2])) || (o.verb === "takedown" && !REASONS.includes(o.args[1]))) {
    throw new Error(`reason must be one of: ${REASONS.join(", ")}`);
  }
  return o;
}

export function client({ base, secret, fetchFn = fetch }) {
  return async (method, sub, body) => {
    const res = await fetchFn(`${base}/api/admin/voici/${sub}`, {
      method,
      headers: { "x-admin-secret": secret, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 404 && json.code !== "not-found") throw new Error("voi.ci is off on this .com (VOICI_ENABLED), or the route is not deployed");
    if (!res.ok) throw new Error(`${method} ${sub}: HTTP ${res.status} ${json.code ?? ""} ${json.error ?? ""}`.trim());
    return json;
  };
}

const ago = (ms, now) => {
  const h = Math.floor((now - ms) / 3_600_000);
  return h < 48 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`;
};

export function formatList(reports, now = Date.now()) {
  if (reports.length === 0) return ["No reports."];
  return reports.map(
    (r) =>
      `${r.id}  ${r.kind.padEnd(7)} ${r.reason.padEnd(13)} voi.ci/${r.username}  ${ago(r.createdAt, now)}` +
      `${r.kind === "message" ? `  epoch ${r.abuseEpoch ?? "?"}${r.hasText ? ", text attached" : ""}` : r.signed ? "  signed in" : "  anonymous"}  [${r.status}]`,
  );
}

/** Opens the report's abuse tag (and attached text) with the epoch's seed; returns what to print. */
export function openReport(report, seed) {
  const att = report.envelope?.cred?.attestation;
  if (report.kind !== "message" || !att) throw new Error("only message reports carry an abuse tag");
  const tag = openVoiciAbuseTag(seed, report.envelope.from, b64Decode(att.abuseTag));
  const lines = [
    `Sender account: ${tag.username}`,
    `Account created: ${new Date(tag.accountCreatedAt).toISOString()}`,
    `Attestation issued: ${new Date(tag.issuedAt).toISOString()}`,
  ];
  if (report.attached) {
    const t = openVoiciReportText(seed, { conv: report.envelope.conv, msgId: report.envelope.msgId }, b64Decode(report.attached));
    lines.push("Message text (attached by the page owner):", ...t.text.split("\n").map((l) => `  ${l}`));
  } else lines.push("The owner did not attach the message text.");
  lines.push(`To ban: npm run voici-abuse -- ban ${tag.username} ${report.id} ${report.reason}`);
  return lines;
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 2;
  }
  if (o.help) {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n");
    process.stdout.write(src.slice(1, src.findIndex((l, i) => i > 2 && !l.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n") + "\n");
    return 0;
  }
  const secret = process.env.FLAGSHIP_ADMIN_SECRET;
  if (!secret) {
    process.stderr.write("error: FLAGSHIP_ADMIN_SECRET is not set\n");
    return 2;
  }
  const call = client({ base: (process.env.FLAGSHIP_BASE_URL ?? "https://flagshipserver.com").replace(/\/$/, ""), secret });
  const out = (l) => process.stdout.write((Array.isArray(l) ? l.join("\n") : l) + "\n");
  const [a, b, c] = o.args;
  if (o.verb === "list") out(formatList((await call("GET", `reports${o.all ? "?status=all" : ""}`)).reports));
  else if (o.verb === "show") {
    const r = (await call("GET", `reports/${a}`)).report;
    out(formatList([r]));
    if (r.note) out(`Note: ${r.note}`);
    if (r.envelope) out(`Pseudonym: ${r.envelope.from}\nSent: ${new Date(r.envelope.sentAt).toISOString()}\nAbuse epoch: ${r.envelope.cred?.attestation?.abuseEpoch}`);
  } else if (o.verb === "open-tag") {
    const r = (await call("GET", `reports/${a}`)).report;
    const epoch = r.envelope?.cred?.attestation?.abuseEpoch;
    const keyFile = path.join(o.path, "abuse-keys", `${epoch}.age`);
    const vault = o.fakeYubikey ? fakeVault({ dir: o.fakeYubikey }) : ageVault({ identities: o.identities.length ? o.identities : [DEFAULT_IDENTITIES] });
    out(`Unwrapping abuse key epoch ${epoch} (${keyFile}): PIN and touch on a YubiKey.`);
    out(await withSeed(vault, keyFile, (seed) => openReport(r, seed)));
  } else if (o.verb === "ban") out(JSON.stringify(await call("POST", "ban", { username: a, reportId: b, reason: c })));
  else if (o.verb === "unban") out(JSON.stringify(await call("POST", "unban", { username: a })));
  else if (o.verb === "dismiss") out(JSON.stringify(await call("POST", "dismiss", { reportId: a })));
  else if (o.verb === "restore") out(JSON.stringify(await call("POST", "restore", { username: a })));
  else if (o.verb === "takedown") {
    for (let i = 0; i < 100; i++) {
      const r = await call("POST", "takedown", { username: a, reason: b });
      out(`deleted ${r.deleted} object(s)${r.purged ? "" : " (cache purge NOT done: set CLOUDFLARE_PURGE_TOKEN and VOICI_FILES_ZONE_ID)"}`);
      if (r.done) {
        out(`voi.ci/${a} is taken down.`);
        return 0;
      }
    }
    throw new Error("still not done after 100 rounds; run takedown again");
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`error: ${e.message}\n`);
      process.exit(1);
    },
  );
}
