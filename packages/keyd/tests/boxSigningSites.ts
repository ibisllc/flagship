/**
 * Finds, by reading the source, every message tag the daemon signs with the box identity key
 * (STK). A sink is a call that signs with the box key: `signAsBox(m)`, `ed.sign(m, <box key>)`,
 * a protocol `signX(..., <box keypair>)` helper, or a `sign`/`sig` callback the daemon wires to
 * the box key. The tag of a sink is resolved from its message argument: tag literals, tag
 * constants, the canonical-bytes builders it calls (in the protocol package or the daemon), and
 * local variables it names, a few levels deep.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface SigningSite {
  file: string;
  line: number;
  sink: string;
  tags: string[];
}

const TAG_LITERAL = /["'`]((?:flagship\/[a-z0-9][a-z0-9._/-]*\/v\d+(?:\/[a-z]+)?)|pb-put|pb-resp|pb\/request-peers\/v1)(?=[|"'`])/g;
const CONST_DEF = /\b(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::\s*string\s*)?=\s*["'`]([^"'`]+)["'`]/g;
const FN_DEF = /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/g;
/** Whether an argument names the box key (a keypair, its private half, or a box-sign callback). */
function isBoxKey(expr: string): boolean {
  const e = expr.trim().replace(/\.privateKey$/, "").replace(/!$/, "");
  if (/psk|pik|lease|\brun\b|seed/i.test(e)) return false;
  const last = e.split(/[.#]/).pop() ?? "";
  return /^(?:identity\w*|my?stk\w*|stk\w*|keypair|boxKeypair|sign|signer|signAsBox)$/i.test(last);
}

/** Box-signer methods that build their message with a protocol helper. */
const SIGNER_METHODS: Record<string, string> = {
  signSecretRequest: "signSecretRequest",
  signInstallService: "signInstallService",
  signBootAuthHeader: "signBootAuthWith",
  signBootSuspension: "signBootSuspension",
};

/** Blank out comments (keeping newlines), so an apostrophe in a comment never reads as a quote. */
export function stripComments(src: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      out += c;
      if (c === "\\") out += src[++i] ?? "";
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop - 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    out += c;
  }
  return out;
}

const read = (f: string): string => stripComments(readFileSync(f, "utf8"));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/** The text between the parenthesis at `open` and its match. */
function balanced(src: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open + 1);
}

function topLevelArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let from = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(args.slice(from, i).trim());
      from = i + 1;
    }
  }
  const last = args.slice(from).trim();
  if (last) out.push(last);
  return out;
}

/** The body of the function whose name ends at `at` (from its `{` to the matching `}`). */
function bodyAfter(src: string, paramsOpen: number): string {
  const params = balanced(src, paramsOpen);
  let i = paramsOpen + params.length + 2;
  while (i < src.length && src[i] !== "{" && src[i] !== ";") i++;
  if (src[i] !== "{") return "";
  return balanced(src, i);
}

interface Index {
  fnBodies: Map<string, string[]>;
  consts: Map<string, string>;
}

function indexSources(files: string[]): Index {
  const fnBodies = new Map<string, string[]>();
  const consts = new Map<string, string>();
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(CONST_DEF)) if (!consts.has(m[1]!)) consts.set(m[1]!, m[2]!);
    for (const m of src.matchAll(FN_DEF)) {
      const body = bodyAfter(src, m.index! + m[0].length - 1);
      const list = fnBodies.get(m[1]!) ?? [];
      list.push(body);
      fnBodies.set(m[1]!, list);
    }
  }
  return { fnBodies, consts };
}

function tagsOfText(text: string, idx: Index, local: string, depth: number, seen: Set<string>): Set<string> {
  const tags = new Set<string>();
  for (const m of text.matchAll(TAG_LITERAL)) tags.add(m[1]!);
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) {
    const v = idx.consts.get(m[1]!);
    if (v) for (const t of `"${v}"`.matchAll(TAG_LITERAL)) tags.add(t[1]!);
  }
  if (depth <= 0) return tags;
  for (const m of text.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
    const name = m[1]!;
    if (seen.has(name)) continue;
    const bodies = idx.fnBodies.get(name);
    if (!bodies) continue;
    seen.add(name);
    for (const b of bodies) for (const t of tagsOfText(b, idx, b, depth - 1, seen)) tags.add(t);
  }
  // A local variable named in the message: follow its nearest definition in the same scope text.
  for (const m of text.matchAll(/(?<![\w.$])([a-z_]\w*)(?![\w(])/g)) {
    const name = m[1]!;
    const key = `var:${name}:${local.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const def = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=\\s*`, "g");
    let last: RegExpExecArray | null = null;
    for (let d = def.exec(local); d; d = def.exec(local)) last = d;
    if (!last) continue;
    let end = last.index + last[0].length;
    let depthP = 0;
    for (; end < local.length; end++) {
      const c = local[end]!;
      if (c === "(" || c === "[" || c === "{") depthP++;
      else if (c === ")" || c === "]" || c === "}") depthP--;
      else if (c === ";" && depthP <= 0) break;
    }
    const expr = local.slice(last.index + last[0].length, end);
    for (const t of tagsOfText(expr, idx, local, depth - 1, seen)) tags.add(t);
  }
  return tags;
}

export function findBoxSigningSites(repoRoot: string): SigningSite[] {
  const daemonDir = join(repoRoot, "packages/server-daemon/src");
  const protocolFiles = [...walk(join(repoRoot, "packages/protocol/src")), ...walk(join(repoRoot, "packages/tunnel-protocol/src"))];
  // install-helper signs the box's register and sealed-key requests through keyd after first boot.
  const daemonFiles = [...walk(daemonDir), join(repoRoot, "scripts/install-helper.ts")];
  const idx = indexSources([...protocolFiles, ...daemonFiles]);
  const protocolSigners = new Set([...indexSources(protocolFiles).fnBodies.keys()].filter((n) => /^sign[A-Z]/.test(n)));
  const sites: SigningSite[] = [];
  for (const f of daemonFiles) {
    if (/\/(keyCustodian|keydCustodian)\.ts$/.test(f)) continue;
    const src = read(f);
    const lineOf = (i: number) => src.slice(0, i).split("\n").length;
    const add = (at: number, sink: string, msg: string) => {
      // Locals are looked up only in the code just before the sink, so a far-away variable of
      // the same name is never taken for the message.
      const tags = [...tagsOfText(msg, idx, src.slice(Math.max(0, at - 4000), at), 4, new Set())].sort();
      sites.push({ file: relative(repoRoot, f), line: lineOf(at), sink, tags });
    };
    for (const m of src.matchAll(/(?<![\w])(?:[\w.#!]+\.)?(signAsBox|ed\.sign|sign|sig|signer)\s*\(/g)) {
      const full = m[0];
      const open = m.index! + full.length - 1;
      const args = topLevelArgs(balanced(src, open));
      const callee = full.slice(0, -1).trim();
      if (args.length === 0) continue;
      if (callee.endsWith("ed.sign")) {
        if (args.length >= 2 && isBoxKey(args[1]!)) add(m.index!, callee, args[0]!);
        continue;
      }
      // Not the box key: ACME account JWS through keyd, the phone-session key, other curves.
      if (/^(?:p256|crypto|jws|jwt|hmac|psk)\b|\bkeyd\.sign$|\.psk\.sign$/.test(callee)) continue;
      // `sign(m)` / `sig(m)` / `x.signAsBox(m)`: only callbacks; a definition `sign(msg: Bytes)` is skipped.
      if (/:\s*[A-Z]/.test(args[0]!) || /^\w+\s*:/.test(args[0]!)) continue;
      if (/\bfunction\s*$|\b(?:async\s+)?$/.test(src.slice(Math.max(0, m.index! - 12), m.index!)) && /\)\s*(?::[^{=]*)?\{/.test(src.slice(open, open + balanced(src, open).length + 40))) {
        // a method definition, not a call
        continue;
      }
      add(m.index!, callee, args[0]!);
    }
    for (const m of src.matchAll(/\.(signSecretRequest|signInstallService|signBootAuthHeader|signBootSuspension)\s*\(/g)) {
      const helper = SIGNER_METHODS[m[1]!]!;
      const tags = [...tagsOfText(idx.fnBodies.get(helper)!.join("\n"), idx, "", 3, new Set())].sort();
      sites.push({ file: relative(repoRoot, f), line: src.slice(0, m.index!).split("\n").length, sink: m[1]!, tags });
    }
    for (const m of src.matchAll(/(?<![\w.])(sign[A-Z]\w*)\s*\(/g)) {
      if (!protocolSigners.has(m[1]!)) continue;
      const open = m.index! + m[0].length - 1;
      const args = topLevelArgs(balanced(src, open));
      if (!args.slice(1).some(isBoxKey)) continue;
      const tags = [...tagsOfText(idx.fnBodies.get(m[1]!)!.join("\n"), idx, "", 3, new Set())].sort();
      sites.push({ file: relative(repoRoot, f), line: src.slice(0, m.index!).split("\n").length, sink: m[1]!, tags });
    }
  }
  return sites;
}
