#!/usr/bin/env -S npx tsx
/**
 * Verifies an org's signed audit export offline (docs/enterprise-accounts.md §11). An org admin
 * signs the export on a phone (`flagship/org-audit-export/v1` over the log head and the authority
 * record); the auditor needs only that file and the org's genesis hash, which they got from the org
 * out of band (it is also on every org server's recipe). Nothing here talks to a network.
 *
 *   npx tsx tools/org-audit/verify.ts <export.json> --genesis <64-hex> [--now <unix ms>] [--json]
 *
 * Exit 0: the authority chain, the log chain up to the signed head, every seat object, key-ring
 * version and server code, each server's own signed log head (under the key it registered with),
 * and the admin's signature all verify. Objects the log never named are listed (exit 0, but flag
 * them); so are servers that sent no head. Exit 1: something does not verify; the reason is printed.
 */
import { readFileSync } from "node:fs";
import { OrgAuthorityError, verifyOrgAuditExport, type OrgAuditExport } from "../../packages/protocol/src/index.js";

function usage(msg?: string): never {
  if (msg) console.error(msg);
  console.error("usage: npx tsx tools/org-audit/verify.ts <export.json> --genesis <64-hex> [--now <unix ms>] [--json]");
  process.exit(2);
}

export function runOrgAuditVerify(argv: string[], out: (s: string) => void = console.log): number {
  const args = [...argv];
  const file = args.find((a, i) => !a.startsWith("--") && !["--genesis", "--now"].includes(args[i - 1] ?? ""));
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const genesisHash = opt("--genesis");
  if (!file) usage("an export file is required");
  if (!genesisHash || !/^[0-9a-f]{64}$/.test(genesisHash)) usage("--genesis must be the org's 64-hex genesis hash");
  const now = opt("--now") ? Number(opt("--now")) : Date.now();
  if (!Number.isSafeInteger(now)) usage("--now must be unix milliseconds");
  let x: OrgAuditExport;
  try {
    x = JSON.parse(readFileSync(file!, "utf8")) as OrgAuditExport;
  } catch (e) {
    out(`FAIL: cannot read ${file}: ${(e as Error).message}`);
    return 1;
  }
  try {
    const v = verifyOrgAuditExport(x, { genesisHash: genesisHash!, now });
    const seats = [...v.book.seats.keys()].filter((s) => !v.book.revoked.has(s));
    const summary = {
      ok: true,
      orgId: x.orgId,
      authorityVersion: v.state.current.version,
      admins: v.state.current.admins.filter((a) => a.kind === "admin").map((a) => a.seatId),
      liveSeats: seats,
      revokedSeats: [...v.book.revoked],
      keyRingVersions: x.keyRings.length,
      serverCodes: x.serverCodes.length,
      logEntries: v.logEntries,
      logHead: x.statement.logHeadHash,
      signedBy: v.signedBy,
      signedAt: new Date(x.statement.issuedAt).toISOString(),
      unlogged: v.unlogged,
      servers: (x.servers ?? []).map((s) => s.serverDomain),
      boxLogHeads: v.boxLogHeads.map((h) => ({ serverDomain: h.serverDomain, seq: h.seq, headHash: h.headHash, signedAt: new Date(h.issuedAt).toISOString() })),
      serversWithoutHead: (x.servers ?? []).map((s) => s.serverDomain).filter((d) => !v.boxLogHeads.some((h) => h.serverDomain === d)),
    };
    if (args.includes("--json")) out(JSON.stringify(summary, null, 2));
    else {
      out(`OK  org ${summary.orgId}, authority record v${summary.authorityVersion}`);
      out(`    signed by seat ${summary.signedBy} at ${summary.signedAt}`);
      out(`    log: ${summary.logEntries} entries up to ${summary.logHead}`);
      out(`    org admins: ${summary.admins.length}; live seats: ${summary.liveSeats.length}; revoked seats: ${summary.revokedSeats.length}`);
      out(`    key-ring versions: ${summary.keyRingVersions}; server codes: ${summary.serverCodes}`);
      out(`    servers: ${summary.servers.length}; signed box log heads: ${summary.boxLogHeads.length}`);
      for (const h of summary.boxLogHeads) out(`    ${h.serverDomain}: its log up to entry ${h.seq} is ${h.headHash} (signed ${h.signedAt})`);
      if (summary.serversWithoutHead.length) {
        out(`WARN ${summary.serversWithoutHead.length} server(s) sent no signed log head:`);
        for (const d of summary.serversWithoutHead) out(`    ${d}`);
      }
      if (summary.unlogged.length) {
        out(`WARN ${summary.unlogged.length} object(s) the log never named:`);
        for (const u of summary.unlogged) out(`    ${u}`);
      }
    }
    return 0;
  } catch (e) {
    out(`FAIL: ${e instanceof OrgAuthorityError ? e.message : (e as Error).message}`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(runOrgAuditVerify(process.argv.slice(2)));
