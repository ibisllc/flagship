import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PqSessionError,
  acceptPqSession,
  completePqSession,
  finishPqSession,
  hybridSign,
  pqSessionOpenRecord,
  pqSessionSealRecord,
  startPqSession,
  verifyPqKeyBinding,
  type PqSessionIdentity,
  type PqSessionInitiatorRole,
  type VerifiedPqKeyBinding,
} from "../src/index.js";

const V = JSON.parse(readFileSync(new URL("../test-vectors/pq-session/vectors.json", import.meta.url), "utf8"));
const unhex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const NOW: number = V.now;

interface P {
  name: string;
  role: string;
  subject: string;
  binding: VerifiedPqKeyBinding;
  identity: PqSessionIdentity;
}
const parties = new Map<string, P>();
for (const p of V.parties) {
  const binding = verifyPqKeyBinding(p.binding, { role: p.role, subjectId: p.subject, ed25519PubHex: p.binding.ed25519PubHex, now: NOW });
  const secret = new Uint8Array([...unhex(p.edSeedHex), ...unhex(p.mldsaSeedHex)]);
  parties.set(p.name, { ...p, binding, identity: { binding, sign: (purpose, payload) => hybridSign(secret, purpose, payload, { deterministic: true }) } });
}
const box = parties.get(V.responder)!;
const trusted = (V.responderTrusts as string[]).map((n) => parties.get(n)!);
const lookup = (role: PqSessionInitiatorRole, subject: string, keyIdHex: string) =>
  trusted.find((p) => p.role === role && p.subject === subject && p.binding.keyIdHex === keyIdHex)?.binding ?? null;
const R = V.randomness;
const rand = { ephemeralSeed: unhex(R.ephemeralSeedHex), helloNonce: unhex(R.helloNonceHex), encapsulation: unhex(R.encapsulationHex), acceptNonce: unhex(R.acceptNonceHex) };

async function code(f: () => unknown): Promise<string> {
  try {
    await f();
  } catch (e) {
    if (e instanceof PqSessionError) return e.code;
    throw e;
  }
  return "ok";
}

const start = (t: { initiator: string }) => {
  const ini = parties.get(t.initiator)!;
  return startPqSession({ responder: box.subject, responderBinding: box.binding, initiatorRole: ini.role as PqSessionInitiatorRole, identity: ini.identity, now: NOW, randomness: rand });
};

describe("pq-session vectors", () => {
  for (const t of V.transcripts) {
    it(`${t.name}: reproduces every message and key byte for byte`, async () => {
      const st = start(t);
      expect(st.hello).toEqual(t.hello);
      expect(hex(st.helloBytes)).toBe(t.helloBytesHex);
      const { accept, pending } = await acceptPqSession({ hello: t.hello, identity: box.identity, lookupInitiator: lookup, now: NOW + 100, randomness: rand });
      expect(accept).toEqual(t.accept);
      const { finish, session } = await finishPqSession(st, t.accept, NOW + 200);
      expect(finish).toEqual(t.finish);
      const res = completePqSession(pending, t.finish, NOW + 300);
      expect(session.sessionIdHex).toBe(t.keys.sessionIdHex);
      expect(res.sessionIdHex).toBe(t.keys.sessionIdHex);
      for (const r of t.records) {
        const key = unhex(r.dir === 1 ? t.keys.initiatorToResponderHex : t.keys.responderToInitiatorHex);
        expect(hex(pqSessionSealRecord(key, unhex(t.keys.sessionIdHex), r.dir, r.seq, unhex(r.plaintextHex)))).toBe(r.recordHex);
        const o = pqSessionOpenRecord(key, unhex(t.keys.sessionIdHex), r.dir, unhex(r.recordHex));
        expect(o.seq).toBe(r.seq);
        expect(hex(o.plaintext)).toBe(r.plaintextHex);
      }
      // Out of order inside the window, then the response under the request's number.
      expect(hex(res.openRequest(unhex(t.records[1].recordHex), NOW + 400).plaintext)).toBe(t.records[1].plaintextHex);
      expect(hex(res.openRequest(unhex(t.records[0].recordHex), NOW + 400).plaintext)).toBe(t.records[0].plaintextHex);
      expect(hex(session.openResponse(1, unhex(t.records[2].recordHex)))).toBe(t.records[2].plaintextHex);
    });
  }

  const t0 = V.transcripts[0];
  for (const c of V.invalid.hello) {
    it(`hello ${c.name} → ${c.expect}`, async () => {
      expect(await code(() => acceptPqSession({ hello: c.hello, identity: box.identity, lookupInitiator: lookup, now: NOW + 100, randomness: rand }))).toBe(c.expect);
    });
  }
  for (const c of V.invalid.accept) {
    it(`accept ${c.name} → ${c.expect}`, async () => {
      expect(await code(() => finishPqSession(start(t0), c.accept, NOW + 200))).toBe(c.expect);
    });
  }
  for (const c of V.invalid.finish) {
    it(`finish ${c.name} → ${c.expect}`, async () => {
      const { pending } = await acceptPqSession({ hello: t0.hello, identity: box.identity, lookupInitiator: lookup, now: NOW + 100, randomness: rand });
      expect(await code(() => completePqSession(pending, c.finish, NOW + 300))).toBe(c.expect);
    });
  }
  for (const c of V.invalid.records) {
    it(`record ${c.name} → ${c.expect}`, async () => {
      const st = start(t0);
      const { pending } = await acceptPqSession({ hello: t0.hello, identity: box.identity, lookupInitiator: lookup, now: NOW + 100, randomness: rand });
      const { session } = await finishPqSession(st, t0.accept, NOW + 200);
      const res = completePqSession(pending, t0.finish, NOW + 300);
      if (c.side === "responder") {
        expect(
          await code(() => {
            for (const r of c.sequence) res.openRequest(unhex(r), NOW + 400);
          }),
        ).toBe(c.expect);
      } else {
        expect(await code(() => session.openResponse(c.expectSeq, unhex(c.record)))).toBe(c.expect);
      }
    });
  }

  it("a finish is single use, and an accept cannot be answered twice", async () => {
    const st = start(t0);
    const { pending } = await acceptPqSession({ hello: t0.hello, identity: box.identity, lookupInitiator: lookup, now: NOW + 100, randomness: rand });
    await finishPqSession(st, t0.accept, NOW + 200);
    expect(await code(() => finishPqSession(st, t0.accept, NOW + 200))).toBe("session-expired");
    completePqSession(pending, t0.finish, NOW + 300);
    expect(await code(() => completePqSession(pending, t0.finish, NOW + 300))).toBe("session-expired");
  });

  it("a session expires when idle and refuses records after close", async () => {
    const st = start(t0);
    const { pending } = await acceptPqSession({ hello: t0.hello, identity: box.identity, lookupInitiator: lookup, now: NOW + 100, randomness: rand });
    await finishPqSession(st, t0.accept, NOW + 200);
    const res = completePqSession(pending, t0.finish, NOW + 300);
    expect(await code(() => res.openRequest(unhex(t0.records[0].recordHex), NOW + 300 + 16 * 60_000))).toBe("session-expired");
  });

  it("an initiator refuses a responder binding for another box", () => {
    const sib = parties.get("sibling")!;
    expect(() => startPqSession({ responder: box.subject, responderBinding: sib.binding, initiatorRole: "device", identity: parties.get("phone")!.identity, now: NOW })).toThrow(/responder-mismatch/);
  });
});
