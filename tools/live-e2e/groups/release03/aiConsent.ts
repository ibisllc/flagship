// Per-run AI consent (N12, 0.3): an adapt that would spend the owner's key answers 428 with an honest
// estimate (token range, provider, who pays) until the owner signs `flagship/ai-repair-consent/v1` for
// exactly that; a stranger's signature is refused; a consented run starts; and a key sent with a request
// whose consent is refused is rolled back to the one before. The key is fake, so the run that starts fails
// at the provider: no model is called successfully and nothing costs anything.
import { bytesToHex } from "@noble/hashes/utils";
import { ed, signAiRepairConsent } from "@flagship/protocol";
import { pair } from "../../lib/fleet.js";
import { assert, postJson, short } from "../../lib/harness.js";
import type { Group } from "../types.js";

export const aiConsent: Group = {
  name: "ai-consent",
  title: "an AI run that spends the owner's key needs their signed consent to the estimate",
  needs: ["A1"],
  phase: 2,
  async run({ A, rec, box }) {
    const b = box("A1");
    const s = { "x-flagship-session": await pair(A, b) };
    let buildId = "";
    const made = await rec.check("import a repo the AI would have to adapt, with an (unusable) OpenAI key", async () => {
      const r = await postJson(`https://${b.fqdn}/api/build/git`, { gitUrl: "https://github.com/octocat/Hello-World", ref: "master", credential: { provider: "openai", apiKey: "sk-gym-not-a-real-key" } }, s, 120_000);
      assert(r.status === 200 && r.json?.fit === false, `import ${r.status}: ${short(r.text)}`);
      buildId = r.json.buildId;
      return buildId;
    });
    if (!made) return;
    const adapt = (body: Record<string, unknown>) => postJson(`https://${b.fqdn}/api/build/sessions/${buildId}/adapt`, { background: true, ...body }, s, 60_000);
    let est: { provider: string; source: "byok" | "promo"; highTokens: number; lowTokens: number } | null = null;
    await rec.check("without consent: 428 with the provider, who pays and a token range", async () => {
      const r = await adapt({});
      assert(r.status === 428 && r.json?.code === "ai-consent", `got ${r.status}: ${short(r.text)}`);
      est = r.json.estimate;
      assert(est && est.provider === "openai" && est.source === "byok" && est.highTokens >= est.lowTokens, `estimate ${short(est)}`);
      return `${est.lowTokens}–${est.highTokens} tokens, ${est.provider}, ${est.source}`;
    });
    if (!est) return;
    const e = est as { provider: string; source: "byok" | "promo"; highTokens: number };
    const consent = (key: Uint8Array) => {
      const issuedAt = Date.now();
      const sig = signAiRepairConsent({ serverDomain: b.fqdn, buildId, operation: "adapt", provider: e.provider, source: e.source, highTokens: e.highTokens, issuedAt }, (m) => ed.sign(m, key));
      return { issuedAt, provider: e.provider, source: e.source, highTokens: e.highTokens, signature: bytesToHex(sig) };
    };
    await rec.check("a key sent with a refused request is rolled back: the next estimate names the earlier provider", async () => {
      const swapped = await adapt({ credential: { provider: "anthropic", apiKey: "sk-ant-gym-not-real" } });
      assert(swapped.status === 428 && swapped.json?.estimate?.provider === "anthropic", `swap ${swapped.status}: ${short(swapped.text)}`);
      const again = await adapt({});
      assert(again.status === 428 && again.json?.estimate?.provider === "openai", `after the refusal the provider is ${again.json?.estimate?.provider}`);
      return "openai again";
    });
    await rec.check("a consent signed by someone else is refused (403)", async () => {
      const r = await adapt({ consent: consent(new Uint8Array(32).fill(7)) });
      assert(r.status === 403, `got ${r.status}: ${short(r.text)}`);
      return "403";
    });
    await rec.check("the owner's signed consent starts the run (202)", async () => {
      const r = await adapt({ consent: consent(A.keys.adminRoot.privateKey) });
      assert(r.status === 202 && r.json?.started === true, `got ${r.status}: ${short(r.text)}`);
      return "started (it fails at the provider: the key is fake)";
    });
    await postJson(`https://${b.fqdn}/api/build/sessions/${buildId}/discard`, {}, s).catch(() => null);
  },
};
