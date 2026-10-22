// The /status/ page's private-relay warning (docs/outbound-proxy.md §OHTTP).
// No DOM in the repo's tests: run the page's render branch against a tiny
// element stub instead.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RELAY_DOWN_MESSAGE } from "@flagship/control-plane";

const html = readFileSync(resolve(__dirname, "../public/status/index.html"), "utf8");

function relayBranch(): (probe: { privateRelay?: { state: string; message?: string } }) => { hidden: boolean; textContent: string } {
  const start = html.indexOf("const relay = probe.privateRelay;");
  const end = html.indexOf("const cls = classify(probe);");
  const body = html.slice(start, end);
  return (probe) => {
    const el = { hidden: true, textContent: "" };
    new Function("probe", "$", body)(probe, () => el);
    return el;
  };
}

describe("/status/ private relay warning", () => {
  it("has a hidden warning slot", () => {
    expect(html).toContain('id="relayWarning" role="status" hidden');
  });

  it("shows the message only when the relay is down", () => {
    const run = relayBranch();
    expect(run({ privateRelay: { state: "down", message: RELAY_DOWN_MESSAGE } })).toEqual({ hidden: false, textContent: RELAY_DOWN_MESSAGE });
    expect(run({ privateRelay: { state: "down" } }).textContent).toBe(RELAY_DOWN_MESSAGE);
    expect(run({ privateRelay: { state: "ok" } }).hidden).toBe(true);
    expect(run({ privateRelay: { state: "unconfigured" } }).hidden).toBe(true);
    expect(run({}).hidden).toBe(true);
  });
});
