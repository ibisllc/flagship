#!/usr/bin/env node
/**
 * Does the TypeScript SNI router cope with post-quantum ClientHellos?
 *
 * Runs `parseClientHelloSni` (packages/tunnel-protocol/src/sni.ts) on the real rustls hellos in
 * packages/tunnel-protocol/test-vectors/sni-pq-hellos.json the way `sniRouter.ts` does: after
 * every arriving byte (so every TCP segmentation is covered, since the parse is a function of
 * the buffered prefix), under the router's 16 KiB peek cap. Prints one line per hello.
 *
 * Exit 1 if a single-record hello (what browsers send today) is not routed: that would make the
 * TS relay drop PQ clients. Multi-record hellos are reported, not failed: sni.ts is known not
 * to reassemble them (docs/architecture-v2/relay-transport.md).
 *
 * Run: node tools/sni-pq-check.mjs
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const root = resolve(import.meta.dirname, "..");
const { parseClientHelloSni } = await tsImport(pathToFileURL(resolve(root, "packages/tunnel-protocol/src/sni.ts")).href, import.meta.url);
const doc = JSON.parse(await readFile(resolve(root, "packages/tunnel-protocol/test-vectors/sni-pq-hellos.json"), "utf8"));
const MAX_PEEK = 16 * 1024; // sniRouter.ts DEFAULT_MAX_PEEK_BYTES

let failed = false;
for (const c of doc.cases) {
  const raw = Buffer.from(c.hex, "hex");
  let outcome = null;
  let earlyReject = null;
  for (let k = 1; k <= raw.length && outcome === null; k++) {
    if (k > MAX_PEEK) {
      outcome = { kind: "dropped", reason: "peek buffer exceeded" };
      break;
    }
    const r = parseClientHelloSni(raw.subarray(0, k));
    if (r.kind === "incomplete") continue;
    if (k < raw.length && r.kind === "error") earlyReject = k;
    outcome = r.kind === "ok" ? { kind: "ok", sni: r.sni, atByte: k } : { kind: "error", reason: r.reason, atByte: k };
  }
  const ok = outcome?.kind === "ok" && outcome.sni === c.sni && outcome.atByte === raw.length;
  const status = ok ? "ROUTED " : "DROPPED";
  const why = ok ? "" : ` (${outcome?.reason ?? "no verdict"}${earlyReject ? ` after ${earlyReject} bytes` : ""})`;
  console.log(`${status} ${c.name}: ${c.bytes} bytes, ${c.records} record(s)${why}`);
  if (!ok && c.records === 1 && c.bytes <= MAX_PEEK) failed = true;
}
process.exit(failed ? 1 : 0);
