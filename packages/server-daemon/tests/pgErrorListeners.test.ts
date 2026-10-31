/**
 * Every Postgres client the daemon makes listens for 'error'. A connection the server drops mid-query rejects that
 * query, and the client also emits 'error': with no listener Node throws it and the whole daemon exits (gym 14: an app
 * filling its own database took the box down for every app until systemd restarted it).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "../src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("Postgres clients in the daemon", () => {
  it("each one registers an 'error' listener right after it is made", () => {
    const made: string[] = [];
    const missing: string[] = [];
    for (const f of files(SRC)) {
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((l, i) => {
        if (!/new (?:Client|PgClient|pg\.Client|pg\.Pool|Pool)\(/.test(l) || l.trimStart().startsWith("//")) return;
        // App code the AI writes lives in prompt strings: it is not daemon code.
        if (f.endsWith("systemPrompt.ts")) return;
        const where = `${f.slice(SRC.length + 1)}:${i + 1}`;
        made.push(where);
        if (!lines.slice(i, i + 12).some((x) => /\.on\("error"/.test(x))) missing.push(where);
      });
    }
    expect(made.length).toBeGreaterThanOrEqual(4);
    expect(missing).toEqual([]);
  });
});
