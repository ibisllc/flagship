#!/usr/bin/env node
// name-grant — set one account name aside for a friend (docs/naming-recovery-and-name-change.md "Giving a friend a
// name"). Calls POST /api/admin/name-grant on .com (packages/control-plane/src/nameGrant.ts) and prints the link to
// send. The link lifts the .com dibs hold on exactly that name until it expires; with --free it also pays for the name.
//
//   node scripts/name-grant.mjs <name> [--free] [--hours 72]
//
// Env: FLAGSHIP_ADMIN_SECRET (required), FLAGSHIP_BASE_URL (default https://flagshipserver.com).
// Nothing is written to disk: the code exists only in the printed link (and as a hash on .com until it is used).

import { pathToFileURL } from "node:url";

export function parseArgs(argv) {
  const o = { free: false, hours: 72, name: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--free") o.free = true;
    else if (a === "--hours") o.hours = Number(argv[++i]);
    else if (a === "-h" || a === "--help") o.help = true;
    else if (a.startsWith("--")) throw new Error(`unknown argument: ${a}`);
    else if (o.name === null) o.name = a.trim().toLowerCase();
    else throw new Error("one name at a time");
  }
  if (o.help) return o;
  if (!o.name) throw new Error("usage: node scripts/name-grant.mjs <name> [--free] [--hours 72]");
  if (!Number.isInteger(o.hours) || o.hours < 1) throw new Error("--hours takes a whole number of hours");
  return o;
}

/** The app link (an https app link; the grant rides in the fragment, which browsers never send). */
export function grantLink(base, { name, code, expiresAt, free }) {
  const f = new URLSearchParams({ n: name, g: code, e: String(expiresAt) });
  if (free) f.set("f", "1");
  return `${base.replace(/\/+$/, "")}/app/choose-name#${f.toString()}`;
}

export async function main(argv = process.argv.slice(2), env = process.env, fetchFn = fetch, out = console) {
  const o = parseArgs(argv);
  if (o.help) {
    out.log("usage: node scripts/name-grant.mjs <name> [--free] [--hours 72]");
    return 0;
  }
  const secret = env.FLAGSHIP_ADMIN_SECRET;
  if (!secret) throw new Error("FLAGSHIP_ADMIN_SECRET is not set");
  const base = env.FLAGSHIP_BASE_URL || "https://flagshipserver.com";
  const res = await fetchFn(`${base.replace(/\/+$/, "")}/api/admin/name-grant`, {
    method: "POST",
    headers: { "x-admin-secret": secret, "content-type": "application/json" },
    body: JSON.stringify({ name: o.name, free: o.free, hours: o.hours }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`refused (${res.status}): ${body?.error ?? "unknown"}`);
  out.log(`${body.name} is set aside until ${new Date(body.expiresAt).toISOString()}${body.free ? ", already paid for" : ""}.`);
  out.log("Send this link (it works once, for this name only):");
  out.log(grantLink(base, body));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(String(e?.message ?? e));
      process.exit(1);
    },
  );
}
