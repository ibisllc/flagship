#!/usr/bin/env node
// abuse-cases — the operator's queue for reports of voi.ci links and Flagship apps, notices to an account and
// suspensions (docs/abuse-handling.md). Talks to /api/admin/abuse/* on .com (apps/com/src/abuseCases.ts). The
// voi.ci message and page reports stay in `npm run voici-abuse`.
//
//   npm run abuse -- list [--all]                  open reports (or every report), oldest first
//   npm run abuse -- show <report-id>              one report: what was reported, who owns it, the note, the contact
//   npm run abuse -- dismiss <report-id>
//   npm run abuse -- notice <account> --category <c> --action modify|take-down --hours <n>
//                         [--report <report-id>] [--subject <host or voi.ci/x>] [--kind app|page|link|box]
//                         [--service <serviceId>] [--detail "..."]
//                                                  sends the account's admins the notice and a content-free push;
//                                                  with --report, the subject comes from the report
//   npm run abuse -- notices [<account>]           open notices (or one account's), with "done" and the admin's note
//   npm run abuse -- withdraw <notice-id>          closes a notice (the account stops seeing it)
//   npm run abuse -- suspend <account> --category <c> --reason "..." [--notice <notice-id>] [--urgent]
//                                                  refused before a notice's deadline unless --urgent with
//                                                  csam | active-phishing | malware
//   npm run abuse -- unsuspend <account>
//   npm run abuse -- stats
//
// <c>: spam | phishing | active-phishing | malware | csam | harassment | impersonation | copyright | illegal | other.
// Env: FLAGSHIP_ADMIN_SECRET (required), FLAGSHIP_BASE_URL (default https://flagshipserver.com).
// Never paste a report or a notice into an AI tool (AGENTS.md "An AI never learns who or where the owner is").

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const CATEGORIES = ["spam", "phishing", "active-phishing", "malware", "csam", "harassment", "impersonation", "copyright", "illegal", "other"];
const KINDS = ["app", "page", "link", "box"];
const VALUE_FLAGS = new Set(["--category", "--action", "--hours", "--report", "--subject", "--kind", "--service", "--detail", "--reason", "--notice"]);

export function parseArgs(argv) {
  const o = { args: [], flags: {}, all: false, urgent: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") o.all = true;
    else if (a === "--urgent") o.urgent = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else if (VALUE_FLAGS.has(a)) {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      o.flags[a.slice(2)] = argv[++i];
    } else if (a.startsWith("--")) throw new Error(`unknown argument: ${a}`);
    else o.args.push(a);
  }
  o.verb = o.args.shift();
  if (o.help) return o;
  const need = { list: [0], show: [1], dismiss: [1], notice: [1], notices: [0, 1], withdraw: [1], suspend: [1], unsuspend: [1], stats: [0] }[o.verb];
  if (!need) throw new Error("first argument: list | show | dismiss | notice | notices | withdraw | suspend | unsuspend | stats");
  if (!need.includes(o.args.length)) throw new Error(`${o.verb} takes ${need.join(" or ")} argument(s)`);
  if (o.verb === "notice" || o.verb === "suspend") {
    if (!CATEGORIES.includes(o.flags.category)) throw new Error(`--category must be one of: ${CATEGORIES.join(", ")}`);
  }
  if (o.verb === "notice") {
    if (!["modify", "take-down"].includes(o.flags.action)) throw new Error("--action must be modify or take-down");
    const h = Number(o.flags.hours);
    if (!Number.isInteger(h) || h < 1 || h > 720) throw new Error("--hours must be a whole number from 1 to 720");
    if (!o.flags.report && !o.flags.subject) throw new Error("give --report <id> or --subject <host or voi.ci/x>");
    if (o.flags.kind && !KINDS.includes(o.flags.kind)) throw new Error(`--kind must be one of: ${KINDS.join(", ")}`);
  }
  if (o.verb === "suspend" && !o.flags.reason) throw new Error('--reason "..." is required (the account sees it)');
  return o;
}

export function client({ base, secret, fetchFn = fetch }) {
  return async (method, sub, body) => {
    const res = await fetchFn(`${base}/api/admin/abuse/${sub}`, {
      method,
      headers: { "x-admin-secret": secret, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${sub}: HTTP ${res.status} ${json.code ?? ""} ${json.error ?? ""}`.trim());
    return json;
  };
}

const ago = (ms, now) => {
  const h = Math.floor((now - ms) / 3_600_000);
  return h < 48 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`;
};

export function formatReports(reports, now = Date.now()) {
  if (reports.length === 0) return ["No reports."];
  return reports.map(
    (r) => `${r.id}  ${r.kind.padEnd(4)} ${r.reason.padEnd(13)} ${r.subject}  -> ${r.account ?? "?"} (${r.targetKind ?? "?"})  ${ago(r.createdAt, now)}  [${r.status}]`,
  );
}

export function formatNotices(notices, now = Date.now()) {
  if (notices.length === 0) return ["No notices."];
  return notices.map((n) => {
    const state = n.withdrawnAt ? "withdrawn" : n.doneAt ? `done ${ago(n.doneAt, now)}` : n.deadlineAt < now ? "DEADLINE PASSED" : `due in ${Math.ceil((n.deadlineAt - now) / 3_600_000)} h`;
    const lines = [`${n.id}  ${n.account}  ${n.category}  ${n.action}  ${n.subjectKind} ${n.subject}  [${state}]`];
    if (n.doneNote) lines.push(`    admin's note: ${n.doneNote}`);
    return lines.join("\n");
  });
}

/** The notice body for `notice`, from the flags and (with --report) the report. */
export function noticeBody(account, flags, report) {
  const kindOf = { page: "page", link: "link", app: "app", box: "box", account: "app" };
  return {
    account,
    ...(report ? { reportId: report.id } : {}),
    subjectKind: flags.kind ?? (report ? kindOf[report.targetKind] ?? "app" : "app"),
    subject: flags.subject ?? report.subject,
    ...(flags.service ?? report?.serviceId ? { serviceId: flags.service ?? report.serviceId } : {}),
    category: flags.category,
    action: flags.action,
    deadlineHours: Number(flags.hours),
    ...(flags.detail ? { detail: flags.detail } : {}),
  };
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
  const [a] = o.args;
  if (o.verb === "list") out(formatReports((await call("GET", `reports${o.all ? "?status=all" : ""}`)).reports));
  else if (o.verb === "show") {
    const r = (await call("GET", `reports/${a}`)).report;
    out(formatReports([r]));
    out(`Target: ${r.target ?? "-"}${r.serviceId ? `  app ${r.serviceId}` : ""}${r.serverDomain ? `  server ${r.serverDomain}` : ""}`);
    if (r.note) out(`Note: ${r.note}`);
    out(`Contact: ${r.contact ?? "(none)"}`);
  } else if (o.verb === "dismiss") out(JSON.stringify(await call("POST", "dismiss", { reportId: a })));
  else if (o.verb === "notice") {
    const report = o.flags.report ? (await call("GET", `reports/${o.flags.report}`)).report : null;
    const r = await call("POST", "notice", noticeBody(a, o.flags, report));
    out(`Notice ${r.noticeId}, deadline ${new Date(r.deadlineAt).toISOString()}, pushed to ${r.pushed} device(s).`);
  } else if (o.verb === "notices") out(formatNotices((await call("GET", `notices${a ? `?account=${encodeURIComponent(a)}` : ""}`)).notices));
  else if (o.verb === "withdraw") out(JSON.stringify(await call("POST", "notice-withdraw", { noticeId: a })));
  else if (o.verb === "suspend") {
    const r = await call("POST", "suspend", {
      account: a,
      category: o.flags.category,
      reason: o.flags.reason,
      ...(o.flags.notice ? { noticeId: o.flags.notice } : {}),
      ...(o.urgent ? { urgent: true } : {}),
    });
    out(`Suspended ${a}: ${r.serversRevoked.length} server(s) revoked${r.pageTakenDown ? ", voi.ci page taken down" : ""}.`);
    if (r.pageTakenDown && !r.pagePurgeDone) out(`The page's files are not all deleted yet: npm run voici-abuse -- takedown ${a} illegal`);
  } else if (o.verb === "unsuspend") {
    const r = await call("POST", "unsuspend", { account: a });
    out(`Un-suspended ${a}: ${r.serversRestored.length} server(s) restored${r.pageRestored ? ", voi.ci page restored" : ""}.`);
  } else if (o.verb === "stats") out(JSON.stringify(await call("GET", "stats"), null, 2));
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
