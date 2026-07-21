#!/usr/bin/env -S npx tsx
// Dump a live vibe-code session's authored files + status to stdout as JSON.
// Usage: npx tsx tools/live-e2e/capture-vibe-files.ts <sessionId>
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { deriveIRK, signPhoneOrder, type PhoneOrder } from "@flagship/protocol";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

async function http(url: string, opts: RequestInit = {}) {
  const r = await fetch(url, opts);
  const t = await r.text();
  let j: any = null;
  try { j = JSON.parse(t); } catch { /* */ }
  return { status: r.status, text: t, json: j };
}

async function main() {
  const id = process.argv[2];
  if (!id) throw new Error("usage: capture-vibe-files.ts <sessionId>");
  const box = JSON.parse(readFileSync(join("gym-results", "feature-screenshots", "box.json"), "utf8"));
  const irk = deriveIRK({ seed: hexToBytes(box.umkSeedHex) });
  const token = bytesToHex(randomBytes(24));
  const order: PhoneOrder = { type: "add-paired-session", serverId: box.fqdn, token, issuedAt: Date.now() };
  const sig = bytesToHex(signPhoneOrder(order, irk));
  await http(`https://${box.fqdn}/api/orders-from-user`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request: order, signature: sig }),
  });
  const r = await http(`https://${box.fqdn}/api/screens/vibe-code/${encodeURIComponent(id)}`, {
    headers: { "content-type": "application/json", "x-flagship-session": token },
  });
  process.stdout.write(JSON.stringify({ status: r.json?.status, deployedUrl: r.json?.deployedUrl, files: r.json?.files }, null, 2) + "\n");
}
main().catch((e) => { process.stderr.write(String(e instanceof Error ? e.message : e) + "\n"); process.exit(1); });
