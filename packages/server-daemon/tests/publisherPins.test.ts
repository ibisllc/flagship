import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ed, signPublisherTrust, type PublisherPin } from "@flagship/protocol";
import { keyFingerprint, PublisherPins } from "../src/publisherPins.js";

const pin = (key = "a".repeat(64)): PublisherPin => ({ appId: "alice--chess", identityGeneration: 1, keyHex: key, keyEpoch: 0, firstVerifiedAt: 1 });
const owner = (() => { const privateKey = new Uint8Array(32).fill(5); return { privateKey, publicKey: ed.getPublicKey(privateKey) }; })();

describe("publisher pins", () => {
  it("pins the first key once and survives a restart", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "pp-")), "p.json");
    const a = new PublisherPins(path);
    await a.load();
    expect(await a.pin("svc", pin())).toBe(true);
    expect(await a.pin("svc", pin("b".repeat(64)))).toBe(false); // never replaced here
    const b = new PublisherPins(path);
    await b.load();
    expect(b.get("svc")?.keyHex).toBe("a".repeat(64));
  });

  it("only the owner's signature for exactly this service and change moves the pin", async () => {
    const p = new PublisherPins(join(await mkdtemp(join(tmpdir(), "pp-")), "p.json"));
    await p.load();
    await p.pin("svc", pin());
    const release = { appId: "alice--chess", identityGeneration: 1, version: "2", packageDigestHex: "d".repeat(40), capabilityDigestHex: "c".repeat(64), keyEpoch: 1, issuedAt: 2 };
    await p.setPending({ serviceId: "svc", continuity: "none", from: pin(), toKeyHex: "b".repeat(64), toEpoch: 1, release, seenAt: 3 });
    const trust = { serviceId: "svc", appId: "alice--chess", identityGeneration: 1, oldKeyHex: "a".repeat(64), newKeyHex: "b".repeat(64), newEpoch: 1, issuedAt: 4 };
    expect(await p.approve({ ...trust, serviceId: "other" }, signPublisherTrust({ ...trust, serviceId: "other" }, owner), owner.publicKey)).toMatchObject({ ok: false });
    expect(await p.approve({ ...trust, newKeyHex: "c".repeat(64) }, signPublisherTrust({ ...trust, newKeyHex: "c".repeat(64) }, owner), owner.publicKey)).toMatchObject({ ok: false });
    expect(await p.approve(trust, "00".repeat(64), owner.publicKey)).toMatchObject({ ok: false });
    expect(p.get("svc")?.keyHex).toBe("a".repeat(64));
    expect(await p.approve(trust, signPublisherTrust(trust, owner), owner.publicKey)).toEqual({ ok: true });
    expect(p.get("svc")).toMatchObject({ keyHex: "b".repeat(64), keyEpoch: 1 });
    expect(p.pendingFor("svc")).toBeNull();
  });

  it("a rejected candidate stays rejected until chosen again", async () => {
    const p = new PublisherPins(join(await mkdtemp(join(tmpdir(), "pp-")), "p.json"));
    await p.load();
    await p.pin("svc", pin());
    const release = { appId: "alice--chess", identityGeneration: 1, version: "2", packageDigestHex: "d".repeat(40), capabilityDigestHex: "c".repeat(64), keyEpoch: 1, issuedAt: 2 };
    await p.setPending({ serviceId: "svc", continuity: "none", from: pin(), toKeyHex: "b".repeat(64), toEpoch: 1, release, seenAt: 3 });
    expect(await p.reject("svc", 9)).toBe(true);
    await p.setPending({ serviceId: "svc", continuity: "none", from: pin(), toKeyHex: "b".repeat(64), toEpoch: 1, release, seenAt: 10 });
    expect(p.pendingFor("svc")?.rejectedAt).toBe(9);
  });

  it("a damaged file leaves no pin and refuses new ones, so updates stop rather than trust again", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "pp-")), "p.json");
    await writeFile(path, "{{");
    const p = new PublisherPins(path);
    await p.load();
    expect(p.unavailable).toBe(true);
    expect(p.get("svc")).toBeNull();
    expect(await p.pin("svc", pin())).toBe(false);
  });

  it("fingerprints are short and readable", () => {
    expect(keyFingerprint("0123456789abcdef".repeat(4))).toBe("0123 4567 89ab cdef");
  });
});
