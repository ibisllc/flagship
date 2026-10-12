/** The sign-in rule the AI builders get (docs/app-apis.md §5), in every place it is stated. */
import { describe, expect, it } from "vitest";
import { BUILD_CONTRACT_RULES, renderContractMarkdown } from "../src/buildmodes/contract.js";
import { BUILD_AGENT_SYSTEM_PROMPT } from "../src/buildmodes/buildAgent.js";
import { SYSTEM_PROMPT_V1 } from "../src/llm/systemPrompt.js";

describe("sign-in rule", () => {
  const contract = renderContractMarkdown();

  it("no longer forbids the app's own sign-in outright", () => {
    expect(BUILD_CONTRACT_RULES.find((r) => r.id === "no-auth")).toBeUndefined();
    for (const text of [contract, SYSTEM_PROMPT_V1, BUILD_AGENT_SYSTEM_PROMPT]) {
      expect(text).not.toMatch(/do not write authentication/i);
      expect(text).toMatch(/prefer Flagship identity, and suggest it to the owner/i);
      expect(text).toMatch(/only when the owner asks/i);
    }
  });

  it("states every requirement for an app's own sign-in", () => {
    for (const text of [contract, SYSTEM_PROMPT_V1]) {
      expect(text).toContain("crypt(pw, gen_salt('bf'))");
      expect(text).toMatch(/bcrypt, argon2 or scrypt/);
      expect(text).toMatch(/never in plaintext or reversibly/);
      expect(text).toMatch(/request_env_var \(value-free\) and tell the owner where to get them/);
      expect(text).toMatch(/login, signup and OAuth callback paths in access\.public_routes/);
      expect(text).toMatch(/sessions in Postgres/);
      expect(text).toContain("Secure; HttpOnly; SameSite=Lax");
      expect(text).toMatch(/CSRF/);
      expect(text).toMatch(/rate-limit login attempts/);
    }
    expect(BUILD_AGENT_SYSTEM_PROMPT).toMatch(/CSRF protection, rate-limited logins/);
  });

  it("mentions live connections, API keys and prefix routes", () => {
    for (const text of [contract, SYSTEM_PROMPT_V1]) {
      expect(text).toMatch(/WebSockets and Server-Sent Events work/);
      expect(text).toMatch(/Bearer fsk_/);
      expect(text).toMatch(/X-Flagship-Api-Scope: read\|write/);
      expect(text).toMatch(/"\/api\/public\/\*"/);
    }
    expect(BUILD_AGENT_SYSTEM_PROMPT).toMatch(/WebSockets and Server-Sent Events pass through/);
    expect(BUILD_AGENT_SYSTEM_PROMPT).toMatch(/apikey:<keyId>/);
  });
});
