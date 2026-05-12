import { describe, expect, it } from "vitest";
import { generateKeypair } from "@maintainers/protocol";
import { CliError } from "../src/lib/args.js";
import { loadPrivKey, loadPubKey, loadPubKeyList } from "../src/lib/keysource.js";

function keypair(seedByte: number) {
  const seed = new Uint8Array(32);
  seed[0] = seedByte;
  return generateKeypair(seed);
}

function fakeFs(files: Record<string, string>) {
  return {
    readFileSync(path: string): string {
      const v = files[path];
      if (v === undefined) {
        const err = new Error(`ENOENT: no such file or directory, open '${path}'`);
        throw err;
      }
      return v;
    },
  };
}

describe("loadPubKey", () => {
  it("loads a pubkey from file: source", () => {
    const a = keypair(1);
    const io = fakeFs({ "./alice.pub": a.pubKey });
    const loaded = loadPubKey("file:./alice.pub", io);
    expect(loaded.pubKey).toBe(a.pubKey);
  });

  it("tolerates 0x prefix and surrounding whitespace", () => {
    const a = keypair(2);
    const io = fakeFs({ "/k": `  0x${a.pubKey}\n` });
    expect(loadPubKey("file:/k", io).pubKey).toBe(a.pubKey);
  });

  it("rejects non-hex content", () => {
    const io = fakeFs({ "/k": "not-a-key" });
    expect(() => loadPubKey("file:/k", io)).toThrow(CliError);
  });

  it("yubikey: source raises a clear staging error", () => {
    const io = fakeFs({});
    expect(() => loadPubKey("yubikey:slot=9c", io)).toThrow(/yubikey/);
  });

  it("rejects unsupported scheme", () => {
    const io = fakeFs({});
    expect(() => loadPubKey("http://example.com/key", io)).toThrow(CliError);
  });
});

describe("loadPrivKey", () => {
  it("loads a privkey and derives its pubkey", () => {
    const a = keypair(3);
    const io = fakeFs({ "/p": a.privKey });
    const loaded = loadPrivKey("file:/p", io);
    expect(loaded.privKey).toBe(a.privKey);
    expect(loaded.pubKey).toBe(a.pubKey);
  });

  it("yubikey: privkey is staged-not-implemented", () => {
    const io = fakeFs({});
    expect(() => loadPrivKey("yubikey:slot=9a", io)).toThrow(/yubikey/);
  });
});

describe("loadPubKeyList", () => {
  it("parses comma-separated file: sources", () => {
    const a = keypair(1);
    const b = keypair(2);
    const io = fakeFs({ "/a": a.pubKey, "/b": b.pubKey });
    const list = loadPubKeyList("file:/a,file:/b", io);
    expect(list.map((k) => k.pubKey)).toEqual([a.pubKey, b.pubKey]);
  });

  it("empty input -> empty list", () => {
    const io = fakeFs({});
    expect(loadPubKeyList("", io)).toEqual([]);
  });
});
