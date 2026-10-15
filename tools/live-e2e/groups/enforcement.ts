// The five enforcement controls (tools/gym/src/enforcement) on a real box of
// an admin-pinned account: restricted mode on every request path, the admin
// gate, invite revocation reaching the box, and the deterministic debug-access
// and transfer re-home authority proofs.
import { randomBytes } from "node:crypto";
import { ed, deriveAccountId, deriveHouseholdKey, deriveIRK, type Keypair } from "@flagship/protocol";
import { runEnforcementChecks, rollup, renderReport, type EnforcementKeys, type HttpFn, type RawFn, type WireResponse } from "../../gym/src/enforcement/index.js";
import { CONTROL, SERVICES, http, rawTlsGet, writeJson } from "../lib/harness.js";
import { installWhoami, setMode, waitServing } from "./gating.js";
import type { Group } from "./types.js";

const httpFn: HttpFn = async (url, init) => {
  const r = await http(url, init ?? {}, 20_000);
  return { status: r.status, text: r.text, json: r.json, setCookies: r.setCookies } as WireResponse;
};

const rawFn: RawFn = async ({ sni, host, path }) => {
  const r = rawTlsGet(sni, host, path);
  if (!r.status) throw new Error(`raw TLS request produced no HTTP response (sni=${sni})`);
  return { status: r.status, text: r.text, json: null, setCookies: [] };
};

export const enforcement: Group = {
  name: "enforcement",
  title: "the five enforcement controls under the admin-root model",
  needs: ["B1"],
  phase: 1,
  async run({ B, rec, box, dir }) {
    const acct = B!;
    const b = box("B1");
    const slug = "egate";
    const serviceRef = `${acct.username}--${slug}`;
    const ready = await rec.check("setup: install a members-only app (no public routes) to gate", async () => {
      await installWhoami(acct, b, slug, { enabled: true });
      await waitServing(`https://${slug}.${b.fqdn}/`);
      await setMode(acct, b, serviceRef, "restricted");
      return serviceRef;
    });
    const attackerSeed = randomBytes(32);
    const keys: EnforcementKeys = {
      ownerIrk: acct.keys.irk,
      adminRoot: acct.keys.adminRoot,
      attacker: { privateKey: attackerSeed, publicKey: ed.getPublicKey(attackerSeed) } as Keypair,
      friendAid: deriveAccountId({ seed: new Uint8Array(32).fill(0xf2) }),
      author: {
        aid: acct.keys.aid,
        device: acct.keys.primaryDevice,
        householdKey: deriveHouseholdKey({ seed: acct.keys.umk }),
      },
      acquirerIrk: deriveIRK({ seed: new Uint8Array(32).fill(0xac) }),
    };
    const routed: HttpFn = ready
      ? httpFn
      : (url, init) => (url.includes("/api/deadman/") ? httpFn(url, init) : Promise.reject(new Error("precondition: app not installed/restricted")));
    const outcomes = await runEnforcementChecks({
      http: routed,
      raw: rawFn,
      now: () => Date.now(),
      target: { control: CONTROL, servicesApex: SERVICES, user: acct.username, fqdn: b.fqdn, serviceSlug: slug, serviceRef },
      keys,
    });
    const report = rollup(outcomes);
    writeJson(dir, "enforcement-report.json", report);
    rec.log("\n" + renderReport(report));
    for (const o of outcomes) {
      const name = `${o.control} — ${o.status}`;
      if (o.status === "enforced") rec.results.push({ name, ok: true, detail: o.assertions.map((a) => a.label).join("; "), ms: 0 });
      else if (o.status === "skipped") rec.skip(name, o.skipReason ?? "skipped");
      else rec.results.push({ name, ok: false, detail: o.assertions.filter((a) => !a.ok).map((a) => `${a.label}: ${a.detail}`).join("; "), ms: 0 });
    }
  },
};
