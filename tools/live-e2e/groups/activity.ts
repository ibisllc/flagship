// The server's activity log (all three apps' Activity tabs read it): after
// the earlier phases, home's log holds what happened on it, newest first,
// with who did it and without any secret.
import { pair } from "../lib/fleet.js";
import { assert, http, short } from "../lib/harness.js";
import type { Group } from "./types.js";

export const activity: Group = {
  name: "activity",
  title: "home's activity log: installs, API keys, DB write, remote, share, backup — in order, no secrets",
  needs: ["A1"],
  phase: 4,
  async run({ A, rec, box, groupOk }) {
    const b = box("A1");
    const session = await pair(A, b);
    const r = await http(`https://${b.fqdn}/api/screens/activity?limit=500`, { headers: { "x-flagship-session": session } });
    const entries = (r.json?.entries ?? []) as Array<{ seq: number; ts: number; actor: { kind: string }; action: string; kind?: string; target?: string; ok: boolean }>;
    await rec.check("the log answers newest first, each entry with an actor and a time", () => {
      assert(r.status === 200 && entries.length > 0, `activity ${r.status}: ${short(r.text)}`);
      for (let i = 1; i < entries.length; i++) assert(entries[i - 1]!.seq > entries[i]!.seq, `out of order at ${i}`);
      assert(entries.every((e) => e.actor?.kind && Number.isFinite(e.ts)), "an entry without actor or time");
      return `${entries.length} entries`;
    });
    const has = (pred: (e: (typeof entries)[number]) => boolean) => entries.some(pred);
    // [what, the group that does it, how to find it]
    const expected: Array<[string, string, (e: (typeof entries)[number]) => boolean]> = [
      ["app.installed (python app)", "runtimes", (e) => e.kind === "app.installed" && String(e.target ?? "").endsWith("--pyapp")],
      ["API key created", "api-keys", (e) => e.action === "post services/:id/api-keys" && e.ok],
      ["API key revoked", "api-keys", (e) => e.action === "delete services/:id/api-keys/:id" && e.ok],
      ["signed DB write", "api-keys", (e) => e.action === "db.write" && e.ok],
      ["remote ticket minted", "remote", (e) => e.action === "post companion/mint-ticket" && e.ok],
      ["a companion's refused write (ok=false)", "remote", (e) => e.ok === false && /companion|app-backup|vibe-code|services/.test(e.action)],
      ["share granted", "share", (e) => e.action === "share.granted" || e.action === "share.changed"],
      ["share left", "share", (e) => e.action === "share.left"],
      ["backup created", "archive", (e) => e.kind === "server.backup.created"],
    ];
    for (const [label, source, pred] of expected) {
      if (!groupOk(source)) {
        rec.skip(`it records: ${label}`, `the ${source} group didn't pass, so it may not have done it`);
        continue;
      }
      await rec.check(`it records: ${label}`, () => {
        assert(has(pred), `not in: ${short([...new Set(entries.map((e) => e.kind ?? e.action))], 400)}`);
        return "";
      });
    }
    await rec.check("no secret in it (API keys, session tokens, ticket secrets)", () => {
      const text = JSON.stringify(entries);
      assert(!/fsk_[0-9a-f]{16}_/.test(text), "an API key");
      assert(!/[0-9a-f]{64}/.test(text), "a 32-byte hex value (token or key)");
      return `${text.length} B checked`;
    });
  },
};
