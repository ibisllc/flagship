import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as C from "./pq-ceremony.mjs";
import * as K from "./pq-release-key.mjs";

const REPO = path.resolve(import.meta.dirname, "..");
const V = JSON.parse(fs.readFileSync(path.join(REPO, "packages/protocol/test-vectors/release-endorsement-v2/vectors.json"), "utf8")) as {
  keys: Record<string, { edSeedHex: string }>;
  endorsements: Record<string, Record<string, unknown>>;
};
const rowsOf = (stdout: string) => stdout.split("\n").filter((l) => /^ {4}[0-9A-Z]{5}( [0-9A-Z]{5}){3} {2}[0-9A-Z]{2}$/.test(l)).map((l) => l.trim());

describe("parsers", () => {
  const recipient = "age1yubikey1" + "q".repeat(50);
  const stub = "AGE-PLUGIN-YUBIKEY-1ABCDEF0123456789";
  it("reads the recipient and the stub from age-plugin-yubikey output", () => {
    expect(C.parseGenerate(`#    Recipient: ${recipient}\n${stub}\n`)).toEqual({ recipient, stub });
    expect(C.parseGenerate("nothing here")).toEqual({ recipient: null, stub: null });
  });
  it("reads the key id, the verify line, the restore line and show-pub", () => {
    const id = "ab".repeat(32);
    expect(C.parseKeyId(`\nRelease key id: ${id}\nNext:`)).toBe(id);
    expect(C.parseKeyId("Release key id: abc")).toBeNull();
    expect(C.parseVerifyOk(`OK: the inserted YubiKey opens the release key ${id.slice(0, 16)}; nothing was written.`)).toBe(id.slice(0, 16));
    expect(C.parseRestored(`Restored release key ${id.slice(0, 16)}, encrypted to 2 YubiKeys at /x.`)).toBe(id.slice(0, 16));
    expect(C.parseShowPub(`key id:         ${id}  (NOT pinned)`)).toEqual({ keyId: id, pinned: false });
    expect(C.parseShowPub(`key id:         ${id}  (pinned)`)).toEqual({ keyId: id, pinned: true });
  });
  it("reads a YubiKey's firmware and judges it", () => {
    expect(C.parseFirmware("Device type: YubiKey 5C NFC\nFirmware version: 5.7.2\n")).toEqual([5, 7, 2]);
    expect(C.parseFirmware("nothing")).toBeNull();
    expect([[5, 7, 2], [5, 2, 0], [4, 3, 7]].every(C.firmwareOk)).toBe(true);
    expect([[3, 3, 0], [5, 1, 9], null].some(C.firmwareOk as never)).toBe(false);
  });
  it("tells a private file from a readable one", () => {
    const f = path.join(os.tmpdir(), `pqc-mode-${process.pid}`);
    fs.writeFileSync(f, "x", { mode: 0o600 });
    expect(C.modeIsPrivate(f)).toBe(true);
    fs.chmodSync(f, 0o644);
    expect(C.modeIsPrivate(f)).toBe(false);
    fs.rmSync(f);
  });
  it("finds a pin in any of the three places", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "pqc-pin-"));
    fs.mkdirSync(path.join(d, "packages/protocol/src"), { recursive: true });
    fs.mkdirSync(path.join(d, "release"), { recursive: true });
    expect(C.pinnedKeyIds(d)).toEqual([]);
    const id = "cd".repeat(32);
    fs.writeFileSync(path.join(d, "release/box-artifact-trust.json"), JSON.stringify({ pq: { keyIds: [id] } }));
    fs.writeFileSync(path.join(d, "packages/protocol/src/releasePqPin.ts"), `keyIds: Object.freeze(["${id}"]) as readonly string[],`);
    expect(C.pinnedKeyIds(d)).toEqual([id]);
    fs.rmSync(d, { recursive: true });
  });
  it("keeps progress in a private file and ignores a damaged one", () => {
    const f = path.join(os.tmpdir(), `pqc-state-${process.pid}.json`);
    C.saveState(f, { version: 1, done: { preflight: true }, recipients: ["a"], keyId: null });
    expect(C.loadState(f).done.preflight).toBe(true);
    expect(fs.statSync(f).mode & 0o077).toBe(0);
    fs.writeFileSync(f, "{not json");
    expect(C.loadState(f)).toEqual({ version: 1, done: {}, recipients: [], keyId: null });
    fs.rmSync(f);
  });
  it("parses its command line and refuses unknown flags", () => {
    expect(C.parseCli(["--status", "--legacy-manifest", "a", "--legacy-manifest", "b"])).toMatchObject({ status: true, legacyManifests: ["a", "b"] });
    expect(() => C.parseCli(["--nope"])).toThrow(/unknown argument/);
  });
});

// ── the whole ceremony, with fake YubiKeys, against a scratch repo ──────────────────────────────

let tmp = "";
let repo = "";
const out: string[] = [];

type Handler = (q: string) => string | undefined;
function makeIo(handlers: Handler[]) {
  const mute = (s = "") => void out.push(s);
  return {
    say: mute, head: mute, ok: (s: string) => mute(`ok ${s}`), warn: (s: string) => mute(`warn ${s}`), fail: (s: string) => mute(`FAIL ${s}`), note: mute,
    ask: async (q: string) => {
      out.push(`? ${q}`);
      for (const h of handlers) {
        const a = h(q);
        if (a !== undefined) return a;
      }
      throw new Error(`no scripted answer for: ${q}`);
    },
    pause: async () => {},
    confirm: async (q: string) => {
      for (const h of handlers) {
        const a = h(q);
        if (a !== undefined) return /^y/i.test(a);
      }
      return false;
    },
    typed: async (_q: string, word: string) => word !== "never",
    suspend: () => {}, resume: () => {}, close: () => {},
  };
}

function setup(over: { failVerify?: boolean } = {}) {
  const opts: Record<string, unknown> = {
    fake: path.join(tmp, "yk"),
    signingKeyFile: path.join(tmp, "ed.hex"),
    keyFile: path.join(tmp, "key.age"),
    maintainersPath: ".maintainers",
    scriptsDir: path.join(REPO, "scripts"),
    legacyManifests: [],
    skipTests: true,
    noCommit: true,
  };
  const state = C.loadState(path.join(tmp, "state.json"));
  let paper: string[] = [];
  let pinned = false;
  const calls: string[] = [];
  const exec = async (cmd: string, args: string[], o: { cwd?: string; env?: Record<string, string>; stdin?: string } = {}) => {
    calls.push(`${cmd} ${args.map((a) => path.basename(a)).join(" ")}`);
    if (cmd === "git") return { code: 0, stdout: args[0] === "rev-parse" ? "test-branch\n" : args[0] === "grep" ? "packages/protocol/src/releasePqPin.ts\n" : "" };
    if (cmd === "npx" || (cmd === "node" && args[0]?.endsWith("gen-box-release.mjs"))) return { code: 0, stdout: "" };
    const verb = args[1];
    if (cmd === "node" && verb === "pin") {
      pinned = true;
      const id = args[args.indexOf("--key-id") + 1]!;
      fs.writeFileSync(path.join(repo, "packages/protocol/src/releasePqPin.ts"), `keyIds: Object.freeze(["${id}"]) as readonly string[],`);
      fs.writeFileSync(path.join(repo, "packages/protocol/src/caLeasePq.ts"), `keyIds: Object.freeze(["${id}"]) as readonly string[],`);
      fs.writeFileSync(path.join(repo, "release/box-artifact-trust.json"), JSON.stringify({ pq: { keyIds: [id] } }));
      return { code: 0, stdout: "pinned\n" };
    }
    if (cmd === "node" && verb === "show-pub" && pinned) {
      const real = spawnSync("node", args, { cwd: repo, encoding: "utf8", env: { ...process.env, ...o.env } });
      return { code: real.status ?? 1, stdout: real.stdout.replace("NOT pinned", "pinned") };
    }
    const env = { ...process.env, FLAGSHIP_PQ_FAKE_PIN: over.failVerify && verb === "verify-yubikey" ? "000000" : "123456", ...o.env };
    const r = spawnSync(cmd, args, { cwd: repo, encoding: "utf8", env, input: o.stdin ?? "" });
    if (verb === "init") {
      paper = rowsOf(r.stdout);
      opts.paperStdin = paper.join("\n") + "\n";
    }
    return { code: r.status ?? 1, stdout: r.stdout + (r.stderr ?? "") };
  };
  const ctx: Record<string, unknown> = {
    repo, exec, opts, env: {}, state,
    stateFile: path.join(tmp, "state.json"),
    identityFile: path.join(tmp, "ids.txt"),
    keyFile: path.join(tmp, "key.age"),
    save: () => {},
  };
  return { ctx, calls, state, getPaper: () => paper };
}
const answerKeyId = (ctx: { state: { keyId: string | null } }): Handler => (q) => (/Key id from the paper/.test(q) ? (ctx.state.keyId ?? "").slice(0, 16).toUpperCase() : undefined);

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pq-ceremony-"));
  K.createFakeYubikeys(path.join(tmp, "yk"));
  fs.writeFileSync(path.join(tmp, "ed.hex"), V.keys.release!.edSeedHex + "\n");
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => {
  out.length = 0;
  repo = path.join(tmp, "repo");
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(path.join(tmp, "state.json"), { force: true });
  fs.rmSync(path.join(tmp, "key.age"), { force: true });
  fs.mkdirSync(path.join(repo, "packages/protocol/src"), { recursive: true });
  fs.mkdirSync(path.join(repo, "packages/protocol/dist"), { recursive: true });
  fs.mkdirSync(path.join(repo, "release"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".maintainers/endorsements"), { recursive: true });
  fs.writeFileSync(path.join(repo, "packages/protocol/src/releasePqPin.ts"), "keyIds: Object.freeze([]) as readonly string[],");
  fs.writeFileSync(path.join(repo, "packages/protocol/src/caLeasePq.ts"), "keyIds: Object.freeze([]) as readonly string[],");
  fs.writeFileSync(path.join(repo, "release/box-artifact-trust.json"), JSON.stringify({ pq: { keyIds: [], legacyManifests: [] } }));
  for (const n of ["A", "B", "C", "D"]) fs.writeFileSync(path.join(repo, ".maintainers/endorsements", `${n}.json`), JSON.stringify(V.endorsements[n]));
});

describe("the ceremony end to end (fake YubiKeys)", () => {
  it("runs every step in order, checks the disk between them, and ends pinned", async () => {
    const { ctx, calls, state } = setup();
    ctx.io = makeIo([answerKeyId(ctx as never)]);
    const code = await C.runCeremony(ctx as never);
    expect(out.filter((l) => l.startsWith("FAIL"))).toEqual([]);
    expect(code).toBe(0);
    expect(Object.keys(state.done)).toEqual(C.STEPS);
    expect(state.keyId).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.statSync(path.join(tmp, "key.age")).mode & 0o077).toBe(0);
    // order: init before verify before restore-from-paper before pin
    const order = ["init", "verify-yubikey", "verify-yubikey", "restore-from-paper", "pin"].map((v) => calls.findIndex((c) => c.includes(` ${v}`)));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order]).toEqual([...order].sort((a, b) => a - b));
    // the throwaway paper-check file is gone and the seed never reached the progress file
    expect(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith(`pq-paper-check-${process.pid}`))).toEqual([]);
    expect(fs.readFileSync(path.join(tmp, "state.json"), "utf8")).not.toMatch(/seed/i);
  });

  it("stops when the key id typed from the paper is wrong, and writes nothing to pin", async () => {
    const { ctx, state } = setup();
    ctx.io = makeIo([(q) => (/Key id from the paper/.test(q) ? "0000000000000000" : undefined), (q) => (/again/.test(q) ? "n" : undefined)]);
    expect(await C.runCeremony(ctx as never)).toBe(1);
    expect(state.done.init).toBe(true);
    expect(state.done.prove).toBeUndefined();
    expect(C.pinnedKeyIds(repo)).toEqual([]);
  });

  it("stops when a YubiKey cannot open the key file, then resumes at that step", async () => {
    const first = setup({ failVerify: true });
    first.ctx.io = makeIo([answerKeyId(first.ctx as never), (q) => (/again/.test(q) ? "n" : undefined)]);
    expect(await C.runCeremony(first.ctx as never)).toBe(1);
    expect(first.state.done.init).toBe(true);
    expect(first.state.done.prove).toBeUndefined();
    // run again with the right PIN: init is NOT repeated (it would refuse to overwrite), the rest completes
    const second = setup();
    second.ctx.state = C.loadState(path.join(tmp, "state.json"));
    second.ctx.save = () => C.saveState(path.join(tmp, "state.json"), second.ctx.state as never);
    (second.ctx as { opts: Record<string, unknown> }).opts.paperStdin = first.getPaper().join("\n") + "\n";
    second.ctx.io = makeIo([answerKeyId(second.ctx as never)]);
    out.length = 0;
    expect(await C.runCeremony(second.ctx as never)).toBe(0);
    expect(second.calls.some((c) => c.includes(" init"))).toBe(false);
  });

  it("refuses to start over an existing key file", async () => {
    fs.writeFileSync(path.join(tmp, "key.age"), "something");
    const { ctx } = setup();
    ctx.io = makeIo([]);
    expect(await C.runCeremony(ctx as never)).toBe(1);
    expect(out.join("\n")).toMatch(/would be overwritten/);
  });

  it("refuses when a PQ key is already pinned", async () => {
    fs.writeFileSync(path.join(repo, "release/box-artifact-trust.json"), JSON.stringify({ pq: { keyIds: ["ee".repeat(32)] } }));
    const { ctx } = setup();
    ctx.io = makeIo([]);
    expect(await C.runCeremony(ctx as never)).toBe(1);
    expect(out.join("\n")).toMatch(/already pinned/);
  });

  it("notices when the progress file says init is done but the binding is gone", async () => {
    const { ctx, state } = setup();
    ctx.io = makeIo([answerKeyId(ctx as never), (q) => (/again/.test(q) ? "n" : undefined)]);
    ctx.opts = { ...(ctx.opts as object), skipPaperTest: true };
    await C.runCeremony(ctx as never);
    expect(state.done.init).toBe(true);
    fs.rmSync(path.join(repo, ".maintainers/release-pq"), { recursive: true, force: true });
    const again = setup();
    again.ctx.state = C.loadState(path.join(tmp, "state.json"));
    again.ctx.io = makeIo([(q) => (/again/.test(q) ? "n" : undefined)]);
    out.length = 0;
    await C.runCeremony(again.ctx as never);
    expect(out.join("\n")).toMatch(/the disk disagrees/);
  });
});

describe("preflight guards", () => {
  it("test mode must name its own key file, and a real run refuses a key file left by a drill", async () => {
    const { ctx } = setup();
    (ctx.opts as Record<string, unknown>).keyFile = undefined;
    ctx.io = makeIo([]);
    expect(await C.preflight(ctx as never)).toBe(false);
    expect(out.join("\n")).toMatch(/names its own --key-file/);
    out.length = 0;
    const drill = path.join(tmp, "drill.age");
    fs.writeFileSync(drill, '{"format":"flagship-fake-yubikey/v1"}');
    const real = setup();
    real.ctx.opts = { scriptsDir: path.join(REPO, "scripts"), legacyManifests: [] };
    real.ctx.keyFile = drill;
    real.ctx.io = makeIo([]);
    real.ctx.exec = async () => ({ code: 0, stdout: "" });
    await C.preflight(real.ctx as never);
    expect(out.join("\n")).toMatch(/TEST key file from a drill/);
  });
});

describe("finding the maintainers CLI", () => {
  it("looks next to the main checkout when run from a git worktree, and wants it built", () => {
    const main = fs.mkdtempSync(path.join(os.tmpdir(), "pqc-main-"));
    const wt = path.join(main, "wt");
    fs.mkdirSync(path.join(main, ".git/worktrees/wt"), { recursive: true });
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(main, ".git/worktrees/wt")}\n`);
    expect(C.maintainersDir(wt, {})).toBeNull();
    fs.mkdirSync(path.join(main, "maintainers/packages/cli/dist"), { recursive: true });
    expect(C.maintainersDir(wt, {})).toBeNull(); // not built yet
    fs.writeFileSync(path.join(main, "maintainers/packages/cli/dist/index.js"), "");
    expect(C.maintainersDir(wt, {})).toBe(path.join(main, "maintainers"));
    expect(C.maintainersDir(wt, { FLAGSHIP_MAINTAINERS_DIR: "/nonexistent" })).toBe(path.join(main, "maintainers"));
    fs.rmSync(main, { recursive: true });
  });
});
