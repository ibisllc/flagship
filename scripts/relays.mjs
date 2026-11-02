#!/usr/bin/env node
/**
 * relays — admit, change and retire the relays of the mesh, and manage the feed's mesh key
 * (docs/architecture-v2/relay-mesh.md §3.1, §4.5.1). Calls POST /api/admin/relays
 * (apps/com/src/relayDirectory.ts).
 *
 *   npm run relays -- list
 *   npm run relays -- add <relayId> <relayKey> <full|entry> <region> [--ipv4 a,b] [--ipv6 a,b]
 *   npm run relays -- update <relayId> [--kind full|entry] [--region r] [--ipv4 a,b] [--ipv6 a,b]
 *   npm run relays -- retire <relayId>                 relay-revoke entry, new mesh-key epoch, new directory
 *   npm run relays -- stage-key <relayId> <nextKey> [--deadline <ISO time>]
 *                                                    the relay's next key: its first blessing request under it
 *                                                    promotes it; --deadline also stops renewing the current key then
 *   npm run relays -- key-deadline <relayId> <ISO time | none>
 *                                                    force a key rotation: after the deadline the current key's
 *                                                    blessing is no longer renewed (it ends at most 30 days later)
 *   npm run relays -- rotate-mesh-key [reason...]    a new epoch, sealed to every active relay
 *   npm run relays -- mint-directory                 re-mint now
 *   npm run relays -- backfill                       append the existing accounts, servers, policies and
 *                                                    revocations to the relay log (idempotent; also
 *                                                    scripts/relay-log-backfill.ts)
 *   npm run relays -- republish                      rewrite every page (after replacing RELAY_MESH_KEY_SEED)
 *   add --json to print the raw answer.
 *
 * Env: FLAGSHIP_ADMIN_SECRET (required), FLAGSHIP_BASE_URL (default https://flagshipserver.com; the gym:
 * https://gym.flagshipserver.com).
 */
import { fileURLToPath } from "node:url";

const SIMPLE = new Set(["list", "rotate-mesh-key", "mint-directory", "backfill", "republish"]);

function list(v) {
  return v === undefined || v === "" || v === "-" ? [] : v.split(",").map((s) => s.trim()).filter(Boolean);
}

function when(v, flag) {
  if (v === "none" || v === "null") return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new Error(`${flag} takes an ISO time (e.g. 2026-12-01T00:00:00Z) or none`);
  return t;
}

/** Turn the command line into the admin route's body. */
export function parseArgs(argv) {
  const flags = {};
  const pos = [];
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "-h" || a === "--help") return { help: true };
    else if (["--ipv4", "--ipv6", "--kind", "--region", "--deadline"].includes(a)) {
      if (argv[i + 1] === undefined) throw new Error(`${a} needs a value`);
      flags[a.slice(2)] = argv[++i];
    } else if (a.startsWith("--")) throw new Error(`unknown argument: ${a}`);
    else pos.push(a);
  }
  const [op, ...rest] = pos;
  if (!op) return { help: true };
  let body;
  if (SIMPLE.has(op)) {
    body = { op };
    if (op === "rotate-mesh-key" && rest.length > 0) body.reason = rest.join(" ");
  } else if (op === "add") {
    const [relayId, relayKey, kind, region] = rest;
    if (!relayId || !relayKey || !kind || !region) throw new Error("expected: add <relayId> <relayKey> <full|entry> <region> [--ipv4 a,b] [--ipv6 a,b]");
    body = { op, relayId, relayKey, kind, region, ipv4: list(flags.ipv4), ipv6: list(flags.ipv6) };
  } else if (op === "update") {
    const [relayId] = rest;
    if (!relayId) throw new Error("expected: update <relayId> [--kind ..] [--region ..] [--ipv4 ..] [--ipv6 ..]");
    body = { op, relayId };
    if (flags.kind !== undefined) body.kind = flags.kind;
    if (flags.region !== undefined) body.region = flags.region;
    if (flags.ipv4 !== undefined) body.ipv4 = list(flags.ipv4);
    if (flags.ipv6 !== undefined) body.ipv6 = list(flags.ipv6);
  } else if (op === "retire") {
    if (!rest[0]) throw new Error("expected: retire <relayId>");
    body = { op, relayId: rest[0] };
  } else if (op === "stage-key") {
    const [relayId, nextKey] = rest;
    if (!relayId || !nextKey) throw new Error("expected: stage-key <relayId> <nextKey> [--deadline <ISO time>]");
    body = { op, relayId, nextKey };
    if (flags.deadline !== undefined) body.deadline = when(flags.deadline, "--deadline");
  } else if (op === "key-deadline") {
    const [relayId, t] = rest;
    if (!relayId || !t) throw new Error("expected: key-deadline <relayId> <ISO time | none>");
    body = { op, relayId, deadline: when(t, "key-deadline") };
  } else {
    throw new Error(`unknown command: ${op}`);
  }
  return { body, json };
}

const iso = (t) => (typeof t === "number" ? new Date(t).toISOString() : "-");

export function formatList(a) {
  const lines = [
    `Mesh ${a.mesh ? "on" : "off"} · directory v${a.directoryVersion} (${iso(a.directoryIssuedAt)}) · mesh-key epoch ${a.meshEpoch} · log sequence ${a.logSequence}`,
    "",
  ];
  if (a.relays.length === 0) {
    lines.push("No relays admitted yet.");
    return lines.join("\n");
  }
  for (const r of a.relays) {
    const state = r.retiredAt ? `retired ${iso(r.retiredAt)}` : "active";
    lines.push(`${r.relayId}  ${r.relayKind}  ${r.region}  ${state}`);
    lines.push(`  key ${r.relayKey}${r.nextRelayKey ? `  next ${r.nextRelayKey}` : ""}${r.keyDeadline ? `  key deadline ${iso(r.keyDeadline)}` : ""}`);
    lines.push(`  ${r.tunnelHost}  v4 ${r.ipv4.join(",") || "-"}  v6 ${r.ipv6.join(",") || "-"}`);
    lines.push(`  blessed ${iso(r.blessedAt)}, until ${iso(r.blessingExpiresAt)}`);
  }
  return lines.join("\n");
}

const USAGE = `usage: npm run relays -- <list | add | update | retire | stage-key | key-deadline | rotate-mesh-key | mint-directory | backfill | republish> ...
(see the header of scripts/relays.mjs)`;

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    console.error(USAGE);
    process.exit(2);
  }
  if (parsed.help) {
    console.log(USAGE);
    return;
  }
  const secret = process.env.FLAGSHIP_ADMIN_SECRET;
  if (!secret) {
    console.error("FLAGSHIP_ADMIN_SECRET is not set.");
    process.exit(2);
  }
  const base = (process.env.FLAGSHIP_BASE_URL ?? "https://flagshipserver.com").replace(/\/+$/, "");
  const res = await fetch(`${base}/api/admin/relays`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-secret": secret },
    body: JSON.stringify(parsed.body),
  });
  const answer = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) {
    console.error(`Refused (${res.status}): ${answer.error ?? JSON.stringify(answer)}`);
    process.exit(1);
  }
  if (parsed.json || parsed.body.op !== "list") console.log(JSON.stringify(answer, null, 2));
  else console.log(formatList(answer));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}
