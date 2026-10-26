#!/usr/bin/env node
// The PQ release key ceremony, as one guided script (docs/runbooks/pq-release-key.md, final-deploy 2c).
//
//   node scripts/pq-ceremony.mjs            run it (or resume where it stopped)
//   node scripts/pq-ceremony.mjs --status   what is done, checked against the disk
//   node scripts/pq-ceremony.mjs --restart  forget the progress file and start over (never touches keys)
//
// You need: both YubiKeys, paper and a pen, a private room, `age` and `age-plugin-yubikey`
// (brew install age age-plugin-yubikey). It wraps scripts/pq-release-key.mjs and checks the result of every
// step against the disk before the next one starts, so a mistake stops here, not at the signing step.
// Progress is kept in ~/.flagship-release/pq-ceremony.json (no secrets: recipients, the key id, step flags).
//
// Steps: 1 preflight  2 one age identity per YubiKey  3 make the key (paper backup prints once)
//        4 prove it: paper id, each YubiKey, the paper itself  5 pin it  6 tests  7 commit.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO = path.resolve(HERE, "..");
const HOME_DIR = path.join(os.homedir(), ".flagship-release");

// ── parsers (what the tools print) ──────────────────────────────────────────────────────────────

export const RECIPIENT_RE = /age1yubikey1[a-z0-9]{20,}/;
export const STUB_RE = /AGE-PLUGIN-YUBIKEY-[A-Z0-9]+/;

/** `age-plugin-yubikey --generate` / `--identity` output → the recipient and the identity stub. */
export function parseGenerate(out) {
  const recipient = RECIPIENT_RE.exec(out)?.[0] ?? null;
  const stub = STUB_RE.exec(out)?.[0] ?? null;
  return { recipient, stub };
}
export const parseKeyId = (out) => /Release key id: ([0-9a-f]{64})/.exec(out)?.[1] ?? null;
export const parseVerifyOk = (out) => /OK: the inserted YubiKey opens the release key ([0-9a-f]{16})/.exec(out)?.[1] ?? null;
export const parseRestored = (out) => /Restored release key ([0-9a-f]{16})/.exec(out)?.[1] ?? null;
export function parseShowPub(out) {
  const m = /key id:\s+([0-9a-f]{64})\s+\(([^)]*)\)/.exec(out);
  return m ? { keyId: m[1], pinned: !/NOT pinned/i.test(m[2]) } : null;
}
export const modeIsPrivate = (file) => (fs.statSync(file).mode & 0o077) === 0;

/** Is anything pinned already? (releasePqPin.ts, caLeasePq.ts, box-artifact-trust.json) */
export function pinnedKeyIds(repo) {
  const ids = new Set();
  for (const f of ["packages/protocol/src/releasePqPin.ts", "packages/protocol/src/caLeasePq.ts"]) {
    const src = fs.existsSync(path.join(repo, f)) ? fs.readFileSync(path.join(repo, f), "utf8") : "";
    for (const m of src.matchAll(/keyIds: Object\.freeze\(\[([^\]]*)\]\)/g)) for (const id of m[1].match(/[0-9a-f]{64}/g) ?? []) ids.add(id);
  }
  const t = path.join(repo, "release/box-artifact-trust.json");
  if (fs.existsSync(t)) for (const id of JSON.parse(fs.readFileSync(t, "utf8")).pq?.keyIds ?? []) ids.add(id);
  return [...ids];
}

// ── state ───────────────────────────────────────────────────────────────────────────────────────

export const STEPS = ["preflight", "identities", "init", "prove", "pin", "tests", "commit"];
export function loadState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    if (s?.version === 1) return s;
  } catch {
    /* none yet */
  }
  return { version: 1, done: {}, recipients: [], keyId: null };
}
export function saveState(file, s) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
}

// ── terminal ────────────────────────────────────────────────────────────────────────────────────

export function createIo({ input = process.stdin, output = process.stdout, color = output.isTTY } = {}) {
  const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const rl = readline.createInterface({ input, terminal: false });
  const lines = [];
  const waiters = [];
  let ended = false;
  rl.on("line", (l) => (waiters.length ? waiters.shift().resolve(l) : lines.push(l)));
  rl.on("close", () => {
    ended = true;
    while (waiters.length) waiters.shift().reject(new Error("input ended"));
  });
  const io = {
    say: (s = "") => output.write(s + "\n"),
    head: (s) => output.write(`\n${c("1;36", "━━ " + s)}\n`),
    ok: (s) => output.write(`  ${c("32", "✔")} ${s}\n`),
    warn: (s) => output.write(`  ${c("33", "!")} ${s}\n`),
    fail: (s) => output.write(`  ${c("31", "✘")} ${s}\n`),
    note: (s) => output.write(`    ${c("2", s)}\n`),
    ask: (q) => {
      output.write(`${c("1", "? " + q)} `);
      if (lines.length) return Promise.resolve(lines.shift().trim());
      if (ended) return Promise.reject(new Error("input ended"));
      return new Promise((resolve, reject) => waiters.push({ resolve: (l) => resolve(l.trim()), reject }));
    },
    pause: (q = "Press Enter when ready") => io.ask(q).then(() => undefined),
    close: () => rl.close(),
    // The child tools read the terminal themselves (paper rows, PINs); we must not eat their keystrokes.
    suspend: () => {
      if (ended) return;
      rl.pause();
      input.pause?.();
    },
    resume: () => {
      if (ended) return;
      input.resume?.();
      rl.resume();
    },
  };
  io.confirm = async (q) => /^y(es)?$/i.test(await io.ask(`${q} [y/N]`));
  io.typed = async (q, word) => {
    for (let i = 0; i < 3; i++) if ((await io.ask(`${q} (type ${word})`)).toLowerCase() === word) return true;
    return false;
  };
  return io;
}

// ── running tools ───────────────────────────────────────────────────────────────────────────────

/** Real runner: the child talks to the terminal (PIN, touch, paper), we keep a copy of its stdout. */
export function realExec(cmd, args, { cwd, env, stdin, quiet } = {}) {
  const show = !quiet && (cmd === "node" || cmd === "npx" || args.includes("--generate") || args.includes("--identity"));
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: [stdin === undefined ? "inherit" : "pipe", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (d) => {
      stdout += d;
      if (show) process.stdout.write(d);
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    child.on("error", (e) => resolve({ code: 127, stdout: stdout + String(e.message) }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
  });
}

// ── preflight ───────────────────────────────────────────────────────────────────────────────────

export function maintainersDir(repo, env = process.env) {
  const common = (() => {
    try {
      const g = fs.readFileSync(path.join(repo, ".git"), "utf8").match(/gitdir: (.*)/)?.[1];
      return g ? path.resolve(g, "..", "..", "..") : repo; // <main>/.git/worktrees/<name> → <main>
    } catch {
      return repo;
    }
  })();
  return [env.FLAGSHIP_MAINTAINERS_DIR, path.join(repo, "maintainers"), path.join(common, "maintainers"), path.join(repo, "..", "maintainers")]
    .filter(Boolean)
    .find((d) => fs.existsSync(path.join(d, "packages", "cli", "dist", "index.js"))) ?? null;
}

export async function preflight(ctx) {
  const { repo, io, exec, opts } = ctx;
  const results = [];
  const check = (name, ok, fix, level = "fail") => {
    results.push({ name, ok, fix, level });
    (ok ? io.ok : level === "warn" ? io.warn : io.fail)(ok ? name : `${name}  →  ${fix}`);
  };
  check(`Node ${process.versions.node}`, Number(process.versions.node.split(".")[0]) >= 20, "install Node 20 or newer");
  if (!opts.fake) {
    for (const tool of ["age", "age-plugin-yubikey"]) {
      const r = await exec("sh", ["-c", `command -v ${tool}`], { cwd: repo, quiet: true });
      check(`${tool} is installed`, r.code === 0, "brew install age age-plugin-yubikey");
    }
    const md = maintainersDir(repo, ctx.env);
    check("the maintainers CLI is found and built", !!md, "clone it next to the repo and build it, or set FLAGSHIP_MAINTAINERS_DIR");
    if (md) ctx.env.FLAGSHIP_MAINTAINERS_DIR = md;
  }
  if (opts.fake) check("test mode names its own --key-file (never the real default)", !!opts.keyFile, "pass --key-file <scratch file>");
  if (!opts.fake && fs.existsSync(ctx.keyFile) && fs.readFileSync(ctx.keyFile, "utf8").startsWith('{"format":"flagship-fake-yubikey')) {
    check(`${ctx.keyFile} is a TEST key file from a drill, not a real key`, false, "delete it, then run the script again");
  }
  check("scripts/pq-release-key.mjs is here", fs.existsSync(path.join(opts.scriptsDir ?? path.join(repo, "scripts"), "pq-release-key.mjs")), "run this from a checkout of the repo");
  check("the protocol package is built", fs.existsSync(path.join(repo, "packages/protocol/dist")), "run: npx tsc -b packages/protocol");
  const pinned = pinnedKeyIds(repo);
  check(
    pinned.length ? `a PQ key is already pinned (${pinned[0].slice(0, 16)}…)` : "nothing is pinned yet",
    !pinned.length || ctx.state.done.pin === true,
    "the ceremony already happened here; use: node scripts/pq-release-key.mjs show-pub",
  );
  if (!ctx.state.done.init) {
    check(`no key file at ${ctx.keyFile} yet (it would be overwritten)`, !fs.existsSync(ctx.keyFile), "move it away first, or use --restart only if you are sure it is a failed attempt", "fail");
  }
  const git = await exec("git", ["status", "--porcelain", "--", ".maintainers/release-pq", "packages/protocol/src/releasePqPin.ts", "packages/protocol/src/caLeasePq.ts", "release/box-artifact-trust.json"], { cwd: repo, quiet: true });
  check("the files this ceremony writes are clean in git", git.code === 0 && git.stdout.trim() === "", "commit or stash those files first", "warn");
  const branch = (await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, quiet: true })).stdout.trim();
  io.note(`branch: ${branch || "?"}   repo: ${repo}`);
  return results.every((r) => r.ok || r.level === "warn");
}

// ── steps ───────────────────────────────────────────────────────────────────────────────────────

function identitiesHas(file, stub) {
  return fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(stub);
}

async function stepIdentities(ctx) {
  const { io, exec, repo, state } = ctx;
  io.head("Step 2 of 7 · One age identity on each YubiKey");
  io.say("Each YubiKey gets its own age key (in a spare PIV slot; your slot 9c release key is not touched).");
  io.say("The seed of the new PQ key will be encrypted to BOTH, so either one can open it later.");
  if (ctx.opts.fake) {
    state.recipients = ["fake-yubikey:yk-a", "fake-yubikey:yk-b"];
    io.ok("test mode: fake YubiKeys yk-a and yk-b");
    return true;
  }
  fs.mkdirSync(path.dirname(ctx.identityFile), { recursive: true, mode: 0o700 });
  for (let i = 0; i < 2; i++) {
    io.say(`\nYubiKey ${i + 1} of 2`);
    const known = state.recipients[i];
    if (known && fs.existsSync(ctx.identityFile)) {
      io.ok(`already done: ${known.slice(0, 24)}…`);
      continue;
    }
    await io.pause(`Plug in YubiKey ${i + 1} and UNPLUG every other YubiKey. Press Enter`);
    let got = null;
    const listed = await exec("age-plugin-yubikey", ["--identity"], { cwd: repo, quiet: true });
    if (listed.code === 0 && parseGenerate(listed.stdout).recipient) {
      const g = parseGenerate(listed.stdout);
      io.say(`This YubiKey already has an age identity: ${g.recipient.slice(0, 24)}…`);
      if (await io.confirm("Use it (answer n to make a new one)?")) got = g;
    }
    if (!got) {
      io.say("Now creating the age key. It may ask for the PIV management key (the default is fine), then your PIN, then a touch.");
      const gen = await exec("age-plugin-yubikey", ["--generate", "--name", "flagship-release", "--pin-policy", "always", "--touch-policy", "always"], { cwd: repo });
      got = parseGenerate(gen.stdout);
      if (gen.code !== 0 || !got.recipient || !got.stub) {
        io.fail("age-plugin-yubikey did not produce a recipient and an identity. Is exactly one YubiKey plugged in? Run the script again to retry this YubiKey.");
        return false;
      }
    }
    if (!got.stub) {
      const idOut = parseGenerate((await exec("age-plugin-yubikey", ["--identity"], { cwd: repo, quiet: true })).stdout);
      got.stub = idOut.stub;
    }
    if (!got.recipient || !got.stub) {
      io.fail("could not read both the recipient and the identity stub from the YubiKey.");
      return false;
    }
    if (state.recipients.includes(got.recipient)) {
      io.fail("this is the SAME YubiKey as the first one. Plug in the other one and run the script again.");
      return false;
    }
    fs.appendFileSync(ctx.identityFile, `# YubiKey ${i + 1} ${got.recipient}\n${got.stub}\n`, { mode: 0o600 });
    fs.chmodSync(ctx.identityFile, 0o600);
    state.recipients[i] = got.recipient;
    ctx.save();
    io.ok(`YubiKey ${i + 1}: ${got.recipient}`);
  }
  return true;
}

async function checkIdentities(ctx) {
  const { io, state } = ctx;
  const r = state.recipients;
  const problems = [];
  if (r.length !== 2 || new Set(r).size !== 2) problems.push("two different recipients are needed");
  if (!ctx.opts.fake) {
    for (const x of r) if (!RECIPIENT_RE.test(x ?? "")) problems.push(`not an age1yubikey1 recipient: ${x}`);
    if (!fs.existsSync(ctx.identityFile)) problems.push(`missing ${ctx.identityFile}`);
    else {
      if (!modeIsPrivate(ctx.identityFile)) problems.push(`${ctx.identityFile} must be mode 0600 (run: chmod 600 ${ctx.identityFile})`);
      const stubs = (fs.readFileSync(ctx.identityFile, "utf8").match(new RegExp(STUB_RE, "g")) ?? []).length;
      if (stubs < 2) problems.push(`${ctx.identityFile} holds ${stubs} identity stub(s); two are needed`);
    }
  }
  for (const p of problems) io.fail(p);
  if (!problems.length) io.ok("check: two distinct recipients, identity file private and complete");
  return problems.length === 0;
}

function pqArgs(ctx, extra) {
  const a = [path.join(ctx.opts.scriptsDir ?? path.join(ctx.repo, "scripts"), "pq-release-key.mjs"), ...extra];
  if (ctx.opts.fake) a.push("--fake-yubikey", ctx.opts.fake);
  return a;
}
const pathArgs = (ctx) => (ctx.opts.maintainersPath ? ["--path", ctx.opts.maintainersPath] : []);
const keyArgs = (ctx) => (ctx.opts.keyFile ? ["--key-file", ctx.opts.keyFile] : []);
const idArgs = (ctx) => (ctx.opts.fake ? [] : ["--identity", ctx.identityFile]);

async function stepInit(ctx) {
  const { io, exec, repo, state } = ctx;
  io.head("Step 3 of 7 · Make the PQ release key");
  io.say("What happens now:");
  io.say("  • your slot-9c YubiKey signs the key's binding: you type its PIV PIN, then touch it;");
  io.say("  • the new key's seed is encrypted to both YubiKeys and saved on this Mac;");
  io.say("  • the PAPER BACKUP prints on the screen ONCE: three rows of letters and digits.");
  io.say("    Write all three rows on paper, check every character, then press Enter and the screen clears.");
  io.say("    The paper must be kept somewhere apart from both YubiKeys. Nothing else can recover the key.");
  io.say("Have paper and a pen ready, and no camera pointed at the screen.");
  if (!(await io.typed("Ready to make the key?", "ready"))) return false;
  await io.pause("Plug in the YubiKey that holds your release key in slot 9c. Press Enter");
  const args = pqArgs(ctx, [
    "init", "--recipient", state.recipients[0], "--recipient", state.recipients[1],
    ...(ctx.opts.fake ? ["--signing-key", `file:${ctx.opts.signingKeyFile}`] : ["--signing-key", "yubikey-piv:slot=9c"]),
    ...pathArgs(ctx), ...(ctx.opts.keyFile ? ["--out", ctx.opts.keyFile] : []), ...(ctx.opts.fake ? [] : ["--identity", ctx.identityFile]),
  ]);
  const r = await exec("node", args, { cwd: repo, env: ctx.env });
  const id = parseKeyId(r.stdout);
  if (r.code !== 0 || !id) {
    io.fail("the key was not made (see the message above). Nothing was pinned. Fix the cause and run the script again.");
    return false;
  }
  state.keyId = id;
  ctx.save();
  return true;
}

async function checkInit(ctx) {
  const { io, exec, repo, state } = ctx;
  const problems = [];
  if (!/^[0-9a-f]{64}$/.test(state.keyId ?? "")) problems.push("no key id recorded");
  const keyFile = ctx.opts.keyFile ?? path.join(HOME_DIR, "pq-release-key.age");
  if (!fs.existsSync(keyFile) || fs.statSync(keyFile).size === 0) problems.push(`the encrypted key file ${keyFile} is missing or empty`);
  else if (!modeIsPrivate(keyFile)) problems.push(`${keyFile} must be mode 0600`);
  const root = path.resolve(repo, ctx.opts.maintainersPath ?? ".maintainers");
  const bindings = path.join(root, "release-pq", "bindings");
  const file = state.keyId ? path.join(bindings, `${state.keyId.slice(0, 16)}.json`) : "";
  if (!file || !fs.existsSync(file)) problems.push(`the binding file ${file || "(unknown)"} was not written`);
  else {
    const b = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!JSON.stringify(b).includes("mldsaPubHex")) problems.push("the binding file has no ML-DSA public key");
  }
  const show = await exec("node", pqArgs(ctx, ["show-pub", ...pathArgs(ctx)]), { cwd: repo, env: ctx.env, quiet: true });
  const sp = parseShowPub(show.stdout);
  if (!sp || sp.keyId !== state.keyId) problems.push("show-pub does not list the key that was just made");
  for (const p of problems) io.fail(p);
  if (!problems.length) io.ok(`check: key ${state.keyId.slice(0, 16)}… exists, is private to you, has its binding, and show-pub agrees`);
  return problems.length === 0;
}

async function stepProve(ctx) {
  const { io, exec, repo, state } = ctx;
  io.head("Step 4 of 7 · Prove you can get the key back");
  const want = state.keyId.slice(0, 16);
  io.say("A. The paper. Its last line says: release key id: <16 characters>. Type those 16 characters from the PAPER.");
  let paperOk = false;
  for (let i = 0; i < 3 && !paperOk; i++) {
    const typed = (await io.ask("Key id from the paper")).toLowerCase().replace(/[^0-9a-f]/g, "");
    paperOk = typed === want;
    if (!paperOk) io.fail(`that is not ${want.slice(0, 4)}…: copy the paper again, character by character`);
  }
  if (!paperOk) return false;
  io.ok("the paper carries the right key id");

  io.say("\nB. Each YubiKey must open the key file (PIN + touch). One at a time.");
  for (let i = 0; i < 2; i++) {
    let done = false;
    for (let attempt = 0; attempt < 3 && !done; attempt++) {
      await io.pause(`Plug in YubiKey ${i + 1} and unplug the other. Press Enter`);
      const r = await exec("node", pqArgs(ctx, ["verify-yubikey", ...keyArgs(ctx), ...idArgs(ctx)]), {
        cwd: repo,
        env: { ...ctx.env, ...(ctx.opts.fake ? { FLAGSHIP_PQ_FAKE_INSERTED: i === 0 ? "yk-a" : "yk-b" } : {}) },
      });
      done = r.code === 0 && parseVerifyOk(r.stdout) === want;
      if (!done) io.fail("that YubiKey did not open the key file (wrong PIN, no touch, or the wrong YubiKey). Try again.");
    }
    if (!done) return false;
    io.ok(`YubiKey ${i + 1} opens the key`);
  }

  io.say("\nC. The paper itself. Type the three rows from the paper; the script rebuilds the key from them in a throwaway file");
  io.say("   and checks it is the same key. (Nothing is kept: the file is deleted straight after.)");
  if (ctx.opts.skipPaperTest) {
    io.warn("skipped by --skip-paper-test: you have NOT proven the paper works");
  } else {
    const tmp = path.join(os.tmpdir(), `pq-paper-check-${process.pid}.age`);
    const r = await exec("node", pqArgs(ctx, ["restore-from-paper", "--recipient", state.recipients[0], "--recipient", state.recipients[1], "--out", tmp, ...(ctx.opts.fake ? [] : ["--identity", ctx.identityFile]), ...pathArgs(ctx)]), { cwd: repo, env: ctx.env, stdin: ctx.opts.paperStdin });
    fs.rmSync(tmp, { force: true });
    if (r.code !== 0 || parseRestored(r.stdout) !== want) {
      io.fail("the paper did not rebuild the same key. Correct the paper (compare with the screen you cleared? you cannot): if a row is wrong, make a NEW key with --restart and start again.");
      return false;
    }
    if (fs.existsSync(tmp)) {
      io.fail(`the throwaway file ${tmp} is still there; delete it`);
      return false;
    }
    io.ok("the paper rebuilds the same key; the throwaway file is deleted");
  }
  return true;
}

async function stepPin(ctx) {
  const { io, exec, repo, state } = ctx;
  io.head("Step 5 of 7 · Pin the key (boxes, .com and the apps will require it)");
  io.say("This writes the key id into the code that decides which releases, CA leases and box artifacts are accepted.");
  io.say("From the first release that contains this pin, a release needs BOTH the YubiKey signature and the PQ companion.");
  io.say("Box artifacts already published and still installable must be listed, or boxes that require PQ will refuse them.");
  const legacy = [...(ctx.opts.legacyManifests ?? [])];
  const dir = ctx.opts.artifactsDir ?? path.join(os.homedir(), "flagship-release-artifacts");
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir, { recursive: true })) if (/flagship-box-.*\.manifest\.json$/.test(String(f))) legacy.push(path.join(dir, String(f)));
  }
  if (legacy.length) io.say(`Published manifests found (${legacy.length}):\n    ${legacy.join("\n    ")}`);
  else io.warn("no published box manifests were found. If boxes were installed from published artifacts, give them with --legacy-manifest <file>.");
  if (!(await io.typed("Pin the key now?", "pin"))) return false;
  const args = pqArgs(ctx, ["pin", "--key-id", state.keyId, "--require-pq-after", "auto", ...(ctx.opts.noExtraPins ? [] : ["--ca-lease", "--box-artifact"]), ...legacy.flatMap((f) => ["--legacy-manifest", f]), ...pathArgs(ctx)]);
  const r = await exec("node", args, { cwd: repo, env: ctx.env });
  if (r.code !== 0) {
    io.fail("pin failed; nothing is committed. Read the message above.");
    return false;
  }
  for (const [cmd, a] of [["node", ["scripts/gen-box-release.mjs", "--write"]], ["npx", ["tsc", "-b"]]]) {
    io.say(`running: ${cmd} ${a.join(" ")}`);
    const g = await exec(cmd, a, { cwd: repo, env: ctx.env });
    if (g.code !== 0) {
      io.fail(`${cmd} ${a.join(" ")} failed; fix it and run the script again (the pin is written, this step is repeatable).`);
      return false;
    }
  }
  return true;
}

async function checkPin(ctx) {
  const { io, exec, repo, state } = ctx;
  const problems = [];
  const where = [];
  const have = pinnedKeyIds(repo).includes(state.keyId);
  if (!have) problems.push("the key id is not in releasePqPin.ts, caLeasePq.ts or box-artifact-trust.json");
  for (const f of ["packages/protocol/src/releasePqPin.ts", "packages/protocol/src/caLeasePq.ts", "release/box-artifact-trust.json"]) {
    const ok = fs.existsSync(path.join(repo, f)) && fs.readFileSync(path.join(repo, f), "utf8").includes(state.keyId);
    (ok ? where : problems).push(ok ? f : `${f} does not name the key`);
  }
  const grep = await exec("git", ["grep", "-l", state.keyId], { cwd: repo, quiet: true });
  const sp = parseShowPub((await exec("node", pqArgs(ctx, ["show-pub", ...pathArgs(ctx)]), { cwd: repo, env: ctx.env, quiet: true })).stdout);
  if (!sp?.pinned) problems.push("show-pub does not say the key is pinned");
  for (const p of problems) io.fail(p);
  if (!problems.length) {
    io.ok(`check: pinned in ${where.length} places and show-pub says pinned; the id also appears in: ${grep.stdout.split("\n").filter(Boolean).filter((f) => !where.includes(f)).join(", ") || "(nothing else)"}`);
  }
  return problems.length === 0;
}

async function stepTests(ctx) {
  const { io, exec, repo } = ctx;
  io.head("Step 6 of 7 · Tests");
  const suites = [
    ["scripts/pq-release-key.test.ts", "scripts/gen-box-release.test.ts", "scripts/pq-ceremony.test.ts"],
    ["packages/protocol", "tools/adversarial", "packages/control-plane"],
  ];
  if (ctx.opts.skipTests) {
    io.warn("skipped by --skip-tests");
    return true;
  }
  for (const s of suites) {
    io.say(`running: npx vitest run ${s.join(" ")}`);
    const r = await exec("npx", ["vitest", "run", ...s], { cwd: repo, env: ctx.env });
    if (r.code !== 0) {
      io.fail("tests failed. The pin may have exposed a test that still assumes no PQ key; do NOT commit. Send the output above to the release manager.");
      return false;
    }
  }
  io.ok("tests pass with the key pinned");
  return true;
}

async function stepCommit(ctx) {
  const { io, exec, repo } = ctx;
  io.head("Step 7 of 7 · Commit");
  const st = (await exec("git", ["status", "--porcelain"], { cwd: repo, quiet: true })).stdout.split("\n").filter(Boolean);
  const files = st.map((l) => l.slice(3));
  const expected = (f) => /^(\.maintainers\/release-pq\/|packages\/protocol\/src\/(releasePqPin|caLeasePq)\.ts|release\/box-artifact-trust\.json|release\/box-release\.json|packages\/.*\/src\/.*[gG]enerated|apps\/web\/public\/webapp\/lib\/releasePqPin\.js)/.test(f) || /PqPin|box-release|boxRelease/.test(f);
  const odd = files.filter((f) => !expected(f));
  io.say("Changed files:");
  for (const f of files) io.say(`    ${expected(f) ? " " : "?"} ${f}`);
  if (odd.length) io.warn(`${odd.length} file(s) marked ? were not expected from a pin; only commit them if you know why.`);
  if (files.some((f) => f.startsWith("apps/web/public/webapp/"))) io.warn("a webapp file changed: the webapp shell version must be bumped (service-worker SHELL_VERSION, buildInfo WEB_BUILD, release/compatibility.json, test pins). The release manager does this next.");
  if (ctx.opts.noCommit || !files.length) return true;
  if (!(await io.confirm("Commit the expected files (explicit paths) on this branch?"))) {
    io.say("Not committed. Commit them yourself before any release step.");
    return true;
  }
  const add = await exec("git", ["add", "--", ...files.filter(expected)], { cwd: repo });
  const commit = add.code === 0 ? await exec("git", ["commit", "-m", "Pin the PQ release key for endorsements, CA leases and box artifacts"], { cwd: repo }) : add;
  if (commit.code !== 0) {
    io.fail("commit failed");
    return false;
  }
  io.ok("committed");
  if (await io.confirm("Push this branch to origin now?")) await exec("git", ["push", "origin", "HEAD"], { cwd: repo });
  return true;
}

// ── driver ──────────────────────────────────────────────────────────────────────────────────────

const AFTER = {
  identities: checkIdentities,
  init: checkInit,
  pin: checkPin,
};
const RUN = {
  identities: stepIdentities,
  init: stepInit,
  prove: stepProve,
  pin: stepPin,
  tests: stepTests,
  commit: stepCommit,
};
const INTRO = `
 PQ release key ceremony
 ───────────────────────
 You will: (2) put an age key on each YubiKey, (3) make the key and write the PAPER backup,
 (4) prove both YubiKeys and the paper work, (5) pin the key, (6) run the tests, (7) commit.
 It takes about 20 minutes. You can stop at any step (Ctrl-C) and run the script again: it resumes,
 re-checking what is done against the disk. Nothing secret is stored in the progress file.
 Every PQ claim stays "pending external review".`;

export async function runCeremony(ctx) {
  const { io, state } = ctx;
  ctx.save = () => saveState(ctx.stateFile, state);
  io.say(INTRO);
  io.head("Step 1 of 7 · Checks before we start");
  if (!(await preflight(ctx))) {
    io.fail("fix the items marked ✘ and run the script again.");
    return 1;
  }
  state.done.preflight = true;
  ctx.save();
  for (const step of STEPS.slice(1)) {
    if (state.done[step]) {
      // Re-check what the disk can prove before trusting the progress file.
      if (AFTER[step] && !(await AFTER[step](ctx))) {
        io.warn(`${step} was marked done but the disk disagrees: redoing it.`);
        state.done[step] = false;
      } else {
        io.ok(`${step}: done earlier`);
        continue;
      }
    }
    for (let attempt = 0; ; attempt++) {
      const good = (await RUN[step](ctx)) && (!AFTER[step] || (await AFTER[step](ctx)));
      if (good) break;
      io.fail(`step "${step}" did not pass.`);
      if (attempt >= 2 || !(await io.confirm("Try this step again?"))) {
        ctx.save();
        io.say("Stopped. Run the script again to resume at this step.");
        return 1;
      }
    }
    state.done[step] = true;
    ctx.save();
  }
  io.head("Done");
  io.ok(`PQ release key ${state.keyId.slice(0, 16)}… is made, proven and pinned.`);
  io.say("Keep: the paper (apart from both YubiKeys), and ~/.flagship-release/pq-release-key.age (never upload it).");
  io.say("Next for the release: retro-sign the marker release (node scripts/endorse-release.mjs --pq-only <releaseId> --sign), then the");
  io.say("release script signs the release, the CA lease and the box artifacts with the companion by itself.");
  io.say("Tell the release manager; the webapp shell version and the journal need updating.");
  return 0;
}

export async function statusReport(ctx) {
  const { io, state } = ctx;
  io.say(`progress file: ${ctx.stateFile}`);
  for (const s of STEPS) io.say(`  ${state.done[s] ? "✔" : "·"} ${s}`);
  io.say(`  key id: ${state.keyId ?? "(none yet)"}   recipients: ${state.recipients.length}`);
  const pinned = pinnedKeyIds(ctx.repo);
  io.say(`  pinned in the repo: ${pinned.length ? pinned.map((x) => x.slice(0, 16)).join(", ") : "nothing"}`);
  if (state.keyId) {
    ctx.save = () => {};
    await checkInit(ctx);
    if (pinned.length) await checkPin(ctx);
  }
}

export function parseCli(argv) {
  const o = { legacyManifests: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === "--status") o.status = true;
    else if (a === "--restart") o.restart = true;
    else if (a === "--repo") o.repo = val();
    else if (a === "--state") o.stateFile = val();
    else if (a === "--identity") o.identityFile = val();
    else if (a === "--key-file") o.keyFile = val();
    else if (a === "--path") o.maintainersPath = val();
    else if (a === "--legacy-manifest") o.legacyManifests.push(val());
    else if (a === "--artifacts-dir") o.artifactsDir = val();
    else if (a === "--no-commit") o.noCommit = true;
    else if (a === "--skip-tests") o.skipTests = true;
    else if (a === "--skip-paper-test") o.skipPaperTest = true;
    else if (a === "--fake-yubikey") o.fake = val();
    else if (a === "--fake-signing-key") o.signingKeyFile = val();
    else if (a === "--no-extra-pins") o.noExtraPins = true;
    else if (a === "--scripts-dir") o.scriptsDir = val();
    else if (a === "--help" || a === "-h") o.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

async function main() {
  const opts = parseCli(process.argv.slice(2));
  if (opts.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 14).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    return 0;
  }
  const repo = path.resolve(opts.repo ?? DEFAULT_REPO);
  const stateFile = opts.stateFile ?? path.join(HOME_DIR, "pq-ceremony.json");
  if (opts.restart) fs.rmSync(stateFile, { force: true });
  const io = createIo();
  const ctx = {
    repo, io, opts,
    exec: async (c, a, o) => {
      io.suspend();
      try {
        return await realExec(c, a, o);
      } finally {
        io.resume();
      }
    }, env: {}, stateFile, state: loadState(stateFile),
    identityFile: opts.identityFile ?? path.join(HOME_DIR, "yubikey-identities.txt"),
    keyFile: opts.keyFile ?? path.join(HOME_DIR, "pq-release-key.age"),
    save: () => {},
  };
  ctx.save = () => saveState(stateFile, ctx.state);
  try {
    if (opts.status) {
      await statusReport(ctx);
      return 0;
    }
    return await runCeremony(ctx);
  } catch (e) {
    io.fail(e.message === "input ended" ? "input ended; run the script again to resume" : e.message);
    return 1;
  } finally {
    io.close();
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().then((c) => process.exit(c));
}
