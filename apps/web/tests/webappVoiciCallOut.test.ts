// Calls from the webapp to pages this account knows (apps/web/public/webapp/lib/voiciCallOut.js; docs/voici-calls.md
// "Calling from the app"): the handoff it builds passes the voi.ci tab's own check, the pipe delivery waits for the
// tab, the history merges placed and missed calls newest first, and calling a visitor back is only a hook.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as Ho from "../public/webapp/lib/voiciCallHandoff.js";
import { buildHandoff, callHistory, callVisitor, deliverHandoff, isCallablePeer, recordCall } from "../public/webapp/lib/voiciCallOut.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const M: any = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "packages", "protocol", "test-vectors", "messages", "vectors.json"), "utf8"));
const D = M.derivations;
const NOW = M.t0 + 30_000;
const hexToBytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

function memStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

describe("webapp calls to known pages", () => {
  it("builds a handoff the voi.ci tab accepts, for this account's pseudonym on that page", async () => {
    const session = { umk: hexToBytes(D.visitorUmk), username: "visitor" };
    const h = await buildHandoff({ pageId: D.pageId, username: "alice" }, "audio,video", { session, now: () => NOW, origin: "https://voi.ci", getAttestation: async () => M.attestation.signed });
    const r = Ho.checkVoiciCallHandoff(JSON.parse(JSON.stringify(h)), { origin: "https://voi.ci", caKeys: [M.keys.caPub], now: NOW + 1000, username: "alice" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(h.signIn.pseudonymPub).toBe(D.pseudonymPub);
    expect(h.signIn.delegation.expiresAt - h.signIn.delegation.issuedAt).toBeLessThanOrEqual(Ho.VOICI_CALL_HANDOFF_SESSION_MS);
  });

  it("delivers once the tab listens (peer-missing first, then ack and delivered)", async () => {
    const sent: unknown[] = [];
    let n = 0;
    class FakeWs {
      handlers: Record<string, ((e: { data?: string }) => void)[]> = {};
      constructor() {
        const first = n++ === 0;
        queueMicrotask(() => this.emit("open", {}));
        this.send = (t: string) => {
          const m = JSON.parse(t);
          sent.push(m.kind);
          if (m.kind === "hello") queueMicrotask(() => this.emit("message", { data: JSON.stringify({ kind: first ? "peer-missing" : "ack" }) }));
          if (m.kind === "deliver") queueMicrotask(() => this.emit("message", { data: JSON.stringify({ kind: "delivered" }) }));
        };
      }
      send: (t: string) => void;
      addEventListener(k: string, f: (e: { data?: string }) => void) {
        (this.handlers[k] ??= []).push(f);
      }
      emit(k: string, e: { data?: string }) {
        for (const f of this.handlers[k] ?? []) f(e);
      }
      close() {}
    }
    await deliverHandoff("sid", { phonePk: "p", nonce: "n", ciphertext: "c" }, { WebSocket: FakeWs, host: "x", retryMs: 1 });
    expect(sent).toEqual(["hello", "hello", "deliver"]);
  });

  it("history: placed and missed calls newest first; only pages are callable; a visitor call-back is a hook", () => {
    const storage = memStorage();
    const session = { username: "visitor" };
    recordCall({ id: "a", at: 100, direction: "out", outcome: "browser", video: false, peer: { kind: "page", username: "alice", pageId: D.pageId } }, { storage, session });
    recordCall({ id: "b", at: 300, direction: "out", outcome: "browser", video: true, peer: { kind: "page", username: "bob", pageId: "ab".repeat(16) } }, { storage, session });
    const rows = callHistory([{ callId: "c1", conv: D.conv, pseudonymPub: D.pseudonymPub, ringingAt: 200, video: false }], { storage, session });
    expect(rows.map((r) => r.id)).toEqual(["b", "missed:c1", "a"]);
    expect(rows.map((r) => isCallablePeer(r.peer))).toEqual([true, false, true]);
    expect(callVisitor(D.conv)).toEqual({ ok: false, code: "pending-owner-decision" });
  });
});
