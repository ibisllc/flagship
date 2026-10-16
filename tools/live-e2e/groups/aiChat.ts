// A build chat with REAL models (docs/build-modes.md "Continuing a chat"):
// account B's box builds a one-page app with a DeepInfra model through the
// owner's own key, the chat is continued with a message that switches the
// provider and the model, runs again on its files, and deploys. Needs the
// DeepInfra key at $DEEPINFRA_KEY_FILE (default ~/.config/flagship/deepinfra-eval.key);
// without it the group skips. Every run's token use goes to ai-usage.json.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils";
import { signUninstallService, type UninstallServiceRequest } from "@flagship/protocol";
import { pair } from "../lib/fleet.js";
import { assert, http, postJson, short, sleep, tryHttp, writeJson } from "../lib/harness.js";
import type { Group } from "./types.js";

const KEY_FILE = process.env.DEEPINFRA_KEY_FILE || join(homedir(), ".config/flagship/deepinfra-eval.key");
const BASE = "https://api.deepinfra.com";
export const FIRST_MODEL = process.env.GYM_AI_MODEL_1 || "zai-org/GLM-5.3-Flash";
export const SECOND_MODEL = process.env.GYM_AI_MODEL_2 || "deepseek-ai/DeepSeek-V4-Flash";
const NAME = `chat${Date.now().toString(36).slice(-5)}`;

export const aiChat: Group = {
  name: "ai-chat",
  title: "real-model build chat: build → ready → continue with another provider + model → runs again → deploy",
  needs: ["B1"],
  phase: 2,
  async run({ B, rec, box, dir }) {
    if (!existsSync(KEY_FILE)) {
      rec.skip("real-model build chat", `no DeepInfra key at ${KEY_FILE}`);
      return;
    }
    const apiKey = readFileSync(KEY_FILE, "utf8").trim();
    const acct = B!;
    const b = box("B1");
    const session = await pair(acct, b);
    const s = { "x-flagship-session": session };
    const usage: Record<string, unknown> = { models: [FIRST_MODEL, SECOND_MODEL] };
    const state = async (id: string) => (await tryHttp(`https://${b.fqdn}/api/screens/llm/sessions/${encodeURIComponent(id)}`, { headers: s })).json ?? {};
    let maxTokens = 0;
    /** Waits for `want`; answers the model's questions with a fixed sentence on the way. */
    const waitFor = async (id: string, want: RegExp, minutes: number): Promise<any> => {
      const deadline = Date.now() + minutes * 60_000;
      let last: any = {};
      let answered = 0;
      let retried = 0;
      while (Date.now() < deadline) {
        last = await state(id);
        maxTokens = Math.max(maxTokens, Number(last.conversationTokens ?? 0));
        if (want.test(String(last.status))) return last;
        const why = String(last.failureReason ?? last.errorReason ?? "");
        // A provider that is briefly overloaded fails the turn; a failed chat
        // takes a new message and runs again (docs/build-modes.md
        // "Continuing a chat"), which is what an owner would do.
        if (last.status === "failed" && last.canContinue && retried < 2 && /busy|overload|rate.?limit|429|503|timed? ?out|temporar/i.test(why)) {
          retried++;
          usage.retries = (Number(usage.retries) || 0) + 1;
          rec.log(`the provider failed the turn (${short(why, 120)}); continuing the chat`);
          await sleep(20_000);
          const again = await postJson(`https://${b.fqdn}/api/screens/llm/sessions/${encodeURIComponent(id)}/reply`, { text: "That failed on the provider's side. Please carry on where you stopped." }, s, 60_000);
          assert(again.status === 200, `continue after failure ${again.status}: ${short(again.text)}`);
          continue;
        }
        if (/failed|cancelled/.test(String(last.status)) && !want.test(String(last.status))) throw new Error(`${last.status}: ${short(why, 300)}`);
        if (last.status === "awaiting-tool-response" && last.pendingRequest?.kind === "talkToUser" && answered < 3) {
          answered++;
          await postJson(`https://${b.fqdn}/api/screens/llm/sessions/${encodeURIComponent(id)}/reply`, { text: "Use your best judgement and keep it to one static page." }, s, 60_000);
        }
        await sleep(10_000);
      }
      throw new Error(`timed out waiting for ${want} (last ${last.status} ${short(last.failureReason ?? "", 200)})`);
    };
    let id = "";
    try {
      const started = await rec.check(`B starts a build chat on ${FIRST_MODEL} with an own DeepInfra key (OpenAI-compatible)`, async () => {
        const r = await postJson(`https://${b.fqdn}/api/screens/vibe-code/start`, {
          prompt: `Make a single static web page (index.html only, no JavaScript) whose heading says "gym-chat-one". Use the static runtime. Name it ${NAME}. Don't ask me questions.`,
          name: NAME,
          model: FIRST_MODEL,
          credential: { provider: "openai", apiKey, baseUrl: BASE },
        }, s, 60_000);
        assert(r.status === 200 && r.json?.sessionId && !r.json?.needsCredential, `${r.status}: ${short(r.text)}`);
        id = r.json.sessionId;
        return id;
      });
      if (!started) return;
      const ready = await rec.check("the chat reaches ready-to-deploy and can be continued (canContinue, provider, conversationTokens)", async () => {
        const st = await waitFor(id, /^ready-to-deploy$/, 15);
        assert(st.canContinue === true, `canContinue=${st.canContinue}`);
        assert(st.provider === "openai", `provider=${st.provider}`);
        assert(Number(st.conversationTokens) > 0, `conversationTokens=${st.conversationTokens}`);
        assert(!JSON.stringify(st).includes(apiKey), "the state leaks the key");
        usage.firstTokens = st.conversationTokens;
        return `${st.conversationTokens} tokens, model=${st.model ?? "?"}`;
      });
      if (!ready) return;
      const continued = await rec.check(`a reply switches the provider and the model (${SECOND_MODEL}) and the chat runs again on its files`, async () => {
        const before = await state(id);
        const r = await postJson(`https://${b.fqdn}/api/screens/llm/sessions/${encodeURIComponent(id)}/reply`, {
          text: 'Change the heading to say "gym-chat-two". Keep everything else.',
          model: SECOND_MODEL,
          credential: { provider: "openrouter", apiKey, baseUrl: BASE },
        }, s, 60_000);
        assert(r.status === 200 && r.json?.ok, `reply ${r.status}: ${short(r.text)}`);
        const deadline = Date.now() + 2 * 60_000;
        let moved = false;
        while (Date.now() < deadline && !moved) {
          const st = await state(id);
          moved = st.status !== "ready-to-deploy" || Number(st.conversationTokens) !== Number(before.conversationTokens);
          if (!moved) await sleep(3000);
        }
        assert(moved, "the chat didn't run again");
        const st = await waitFor(id, /^ready-to-deploy$/, 15);
        assert(st.provider === "openrouter", `provider=${st.provider}`);
        assert(st.model === SECOND_MODEL, `model=${st.model}`);
        assert(Number(st.conversationTokens) > Number(before.conversationTokens), `tokens ${before.conversationTokens} → ${st.conversationTokens}`);
        usage.secondTokens = st.conversationTokens;
        return `provider=${st.provider} model=${st.model} tokens ${before.conversationTokens} → ${st.conversationTokens}`;
      });
      if (!continued) return;
      const deployed = await rec.check("deploy: staging copy → live, and the chat now refuses new messages (deployed)", async () => {
        const d = await postJson(`https://${b.fqdn}/api/llm/sessions/${encodeURIComponent(id)}/deploy`, { background: true }, s, 120_000);
        assert(d.status === 200 || d.status === 202, `deploy ${d.status}: ${short(d.text)}`);
        const st = await waitFor(id, /^deployed$/, 20);
        assert(st.canContinue === false, `canContinue=${st.canContinue}`);
        const again = await postJson(`https://${b.fqdn}/api/screens/llm/sessions/${encodeURIComponent(id)}/reply`, { text: "one more" }, s);
        assert(again.status === 409 && /deployed/.test(again.text), `reply after deploy ${again.status}: ${short(again.text)}`);
        return "deployed; reply 409";
      });
      if (!deployed) return;
      await rec.check("the app serves its page live", async () => {
        const url = `https://${NAME}.${b.fqdn}/`;
        for (let i = 0; i < 24; i++) {
          const g = await tryHttp(url);
          if (g.status === 200) return `${g.text.length} B${/gym-chat-two/.test(g.text) ? ", shows gym-chat-two" : /gym-chat-one/.test(g.text) ? ", shows gym-chat-one" : ""}`;
          await sleep(5000);
        }
        throw new Error(`${url} not serving`);
      });
    } finally {
      usage.conversationTokensMax = maxTokens;
      writeJson(dir, "ai-usage.json", usage);
      rec.log(`DeepInfra use this run: ~${maxTokens} conversation tokens (${short(usage)})`);
      const list = await http(`https://${b.fqdn}/api/services`).catch(() => null);
      if (list?.text.includes(`${acct.username}--${NAME}`)) {
        const req: UninstallServiceRequest = { serverId: b.fqdn, creator: acct.username, slug: NAME, issuedAt: Date.now() };
        await http(`https://${b.fqdn}/api/services/${encodeURIComponent(`${acct.username}--${NAME}`)}`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ request: req, signature: bytesToHex(signUninstallService(req, acct.keys.adminRoot)) }),
        }, 120_000).catch(() => null);
      }
    }
  },
};
