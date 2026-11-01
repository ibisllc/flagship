#!/usr/bin/env node
// Inventory of every certificate the CT logs show under the services apex, for closing what boxes could get before
// `.com`'s issuance service existed (docs/runbooks/issuance-migration.md, plan H1/H9).
//
//   node scripts/issuance-inventory.mjs [--apex flagship.services] [--before 2026-11-15] [--json] [--revoke]
//
// Flags each unexpired certificate:
//   bare-account   names a bare `<user>.<apex>` (the admin phone's name). Before --before (the day boxes moved to the
//                  service) only a box writing its own challenge records could have got one: revoke it.
//   combined       a box name together with wildcards (the old one-certificate layout): ages out, never renewed.
//   foreign-issuer not issued by Let's Encrypt: the apex CAA should have prevented it; investigate.
// --revoke asks `.com` (POST /api/certificates/admin/revoke, FLAGSHIP_ADMIN_SECRET) to revoke every bare-account
// certificate issued before --before. The service authorizes the names itself, then revokes (RFC 8555 §7.6).
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const APEX = opt("apex", "flagship.services").toLowerCase();
const BEFORE = opt("before") ? Date.parse(opt("before")) : Number.POSITIVE_INFINITY;
const COM = opt("com", "https://flagshipserver.com");
const asJson = args.includes("--json");
const revoke = args.includes("--revoke");

async function ct(q) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(`https://crt.sh/?q=${encodeURIComponent(q)}&output=json&exclude=expired`, { signal: AbortSignal.timeout(120_000) }).catch((e) => e);
    if (r instanceof Response && r.ok) return r.json();
    await new Promise((res) => setTimeout(res, 5000 * (attempt + 1)));
  }
  throw new Error(`crt.sh did not answer for ${q}`);
}

const rows = [...(await ct(`%.${APEX}`))];
const bySerial = new Map();
for (const r of rows) if (!bySerial.has(r.serial_number)) bySerial.set(r.serial_number, r);
const now = Date.now();
const labelsUnder = (n) => n.replace(/^\*\./, "").slice(0, -(APEX.length + 1)).split(".").filter(Boolean).length;
const out = [];
for (const r of bySerial.values()) {
  const notAfter = Date.parse(`${r.not_after}Z`);
  const notBefore = Date.parse(`${r.not_before}Z`);
  if (!(notAfter > now)) continue;
  const names = [...new Set(String(r.name_value).toLowerCase().split("\n").filter((n) => n.endsWith(`.${APEX}`)))].sort();
  const flags = [];
  if (names.some((n) => !n.startsWith("*.") && labelsUnder(n) === 1)) flags.push("bare-account");
  if (names.some((n) => !n.startsWith("*.")) && names.some((n) => n.startsWith("*."))) flags.push("combined");
  if (!/Let's Encrypt|\(STAGING\)/i.test(String(r.issuer_name))) flags.push("foreign-issuer");
  out.push({ id: r.id, serial: r.serial_number, issuer: r.issuer_name, notBefore: new Date(notBefore).toISOString(), notAfter: new Date(notAfter).toISOString(), names, flags, beforeSwitch: notBefore < BEFORE });
}
out.sort((a, b) => a.notBefore.localeCompare(b.notBefore));

const toRevoke = out.filter((c) => c.flags.includes("bare-account") && c.beforeSwitch);
if (asJson) console.log(JSON.stringify({ apex: APEX, unexpired: out.length, toRevoke: toRevoke.map((c) => c.id), certificates: out }, null, 2));
else {
  const count = (f) => out.filter((c) => c.flags.includes(f)).length;
  console.log(`${out.length} unexpired certificates under ${APEX}: ${count("bare-account")} bare-account, ${count("combined")} combined, ${count("foreign-issuer")} foreign-issuer`);
  for (const c of out.filter((x) => x.flags.length > 0)) console.log(`  crt.sh ${c.id}  ${c.notBefore.slice(0, 10)}..${c.notAfter.slice(0, 10)}  [${c.flags.join(",")}]  ${c.names.join(" ")}`);
  if (toRevoke.length) console.log(`\n${toRevoke.length} bare-account certificate(s) from before the switch: run again with --revoke (needs FLAGSHIP_ADMIN_SECRET).`);
}

if (revoke) {
  const secret = process.env.FLAGSHIP_ADMIN_SECRET;
  if (!secret) throw new Error("FLAGSHIP_ADMIN_SECRET is required for --revoke");
  for (const c of toRevoke) {
    const pem = await (await fetch(`https://crt.sh/?d=${c.id}`, { signal: AbortSignal.timeout(60_000) })).text();
    const r = await fetch(`${COM}/api/certificates/admin/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-secret": secret },
      body: JSON.stringify({ certificatePem: pem, reason: 1 }),
      signal: AbortSignal.timeout(120_000),
    });
    console.log(`revoke crt.sh ${c.id}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
}
process.exitCode = toRevoke.length > 0 && !revoke ? 1 : 0;
