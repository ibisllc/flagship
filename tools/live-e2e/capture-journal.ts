#!/usr/bin/env -S npx tsx
/**
 * Mint a paired session against the held box and dump one build's journal
 * (the AI's tool-call transcript) to stdout as JSON. Used to independently
 * save the ai-build-proof transcripts.
 *
 * Run: npx tsx tools/live-e2e/capture-journal.ts <buildId>
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { deriveIRK, signPhoneOrder, type PhoneOrder } from "@flagship/protocol";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

async function http(url: string, opts: RequestInit = {}): Promise<{ status: number; text: string; json: any }> {
  const r = await fetch(url, opts);
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, text, json };
}

async function main(): Promise<void> {
  const buildId = process.argv[2];
  if (!buildId) throw new Error("usage: capture-journal.ts <buildId>");
  const box = JSON.parse(readFileSync(join("gym-results", "feature-screenshots", "box.json"), "utf8"));
  const irk = deriveIRK({ seed: hexToBytes(box.umkSeedHex) });
  const token = bytesToHex(randomBytes(24));
  const order: PhoneOrder = { type: "add-paired-session", serverId: box.fqdn, token, issuedAt: Date.now() };
  const sig = bytesToHex(signPhoneOrder(order, irk));
  const ps = await http(`https://${box.fqdn}/api/orders-from-user`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request: order, signature: sig }),
  });
  if (ps.status !== 200 && ps.status !== 204) throw new Error(`paired session ${ps.status}: ${ps.text.slice(0, 160)}`);
  const r = await http(`https://${box.fqdn}/api/build/sessions/${encodeURIComponent(buildId)}/journal`, {
    headers: { "content-type": "application/json", "x-flagship-session": token },
  });
  if (r.status !== 200) throw new Error(`journal ${r.status}: ${r.text.slice(0, 160)}`);
  process.stdout.write(JSON.stringify(r.json, null, 2) + "\n");
}

main().catch((e) => {
  process.stderr.write("capture-journal FAILED: " + (e instanceof Error ? e.message : String(e)) + "\n");
  process.exit(1);
});
