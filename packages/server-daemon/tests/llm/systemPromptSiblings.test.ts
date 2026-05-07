import { describe, expect, it } from "vitest";
import {
  buildUserContext,
  REPLICATION_PATTERNS_CHAPTER,
} from "../../src/llm/systemPrompt.js";

const BASE = {
  username: "alice",
  hostname: "home",
  tier: "hobby" as const,
  availableProviders: ["anthropic"],
  existingApps: [],
};

describe("buildUserContext — replication-patterns chapter (N0k)", () => {
  it("OMITS the chapter when siblingsEnabled is false", () => {
    const out = buildUserContext({ ...BASE, siblingsEnabled: false });
    expect(out).not.toContain("Multi-pod (sibling) replication");
    expect(out).not.toContain(REPLICATION_PATTERNS_CHAPTER);
  });

  it("OMITS the chapter by default (undefined)", () => {
    const out = buildUserContext(BASE);
    expect(out).not.toContain("Multi-pod (sibling) replication");
  });

  it("INCLUDES the chapter when siblingsEnabled is true", () => {
    const out = buildUserContext({ ...BASE, siblingsEnabled: true });
    expect(out).toContain("Multi-pod (sibling) replication");
    expect(out).toContain("/api/live_siblings/list");
    expect(out).toContain("/api/url/claim");
    expect(out).toContain("Pattern 1");
    expect(out).toContain("Pattern 2");
    expect(out).toContain("Pattern 3");
    expect(out).toContain("Toggle-on workflow");
  });
});
