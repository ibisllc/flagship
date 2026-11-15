// ML-DSA-65 in WebAssembly (docs/webapp-key-custody.md, item 4): the same vendored mldsa-native
// v2.0.0 the iOS C target compiles (CFlagshipPQ), built by tools/mldsa-wasm/build.sh. The module is
// pinned by SHA-256 here, in the shell: a .wasm that does not hash to the pin is never instantiated.
// Custody stays "software": the seed is in browser memory for the one signature and wiped after.

export const MLDSA_WASM_SHA256 = "cb8245a661230af3b72765328fe379251f468a4c03b03bada26ca0f8b78cbbe3";
export const MLDSA_WASM_PATH = "/vendor/mldsa-wasm/mldsa65.wasm";

const PK = 1952;
const SIG = 3309;
const OFF_SEED = 0;
const OFF_RND = 32;
const OFF_PK = 64;
const OFF_SIG = 6048;
const OFF_CTX = 9360;
const PAGE = 65536;

let loading = null;
let bytesOverride = null;

/** Tests: hand the module's bytes in (Node has no fetch for the shell path). */
export function setMldsaWasmBytesForTests(bytes) {
  bytesOverride = bytes;
  loading = null;
}

const hexOf = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

async function fetchBytes() {
  if (bytesOverride) return bytesOverride;
  const res = await fetch(MLDSA_WASM_PATH, { cache: "no-cache" });
  if (!res.ok) throw Object.assign(new Error("mldsa wasm unavailable"), { code: "pq-wasm-missing" });
  return new Uint8Array(await res.arrayBuffer());
}

async function instantiate() {
  const bytes = await fetchBytes();
  const digest = hexOf(await crypto.subtle.digest("SHA-256", bytes));
  if (digest !== MLDSA_WASM_SHA256) throw Object.assign(new Error("mldsa wasm hash mismatch"), { code: "pq-wasm-pin" });
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const e = instance.exports;
  for (const name of ["memory", "fl_arena", "fl_wipe", "fl_pk", "fl_sign", "fl_verify", "__heap_base"]) {
    if (!(name in e)) throw Object.assign(new Error("mldsa wasm exports"), { code: "pq-wasm-pin" });
  }
  return e;
}

function module() {
  if (!loading) {
    loading = instantiate().catch((err) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

function view(e) {
  return new Uint8Array(e.memory.buffer);
}

function placeMessage(e, msg) {
  const at = typeof e.__heap_base === "object" ? e.__heap_base.value : Number(e.__heap_base);
  const need = at + msg.length;
  if (need > e.memory.buffer.byteLength) e.memory.grow(Math.ceil((need - e.memory.buffer.byteLength) / PAGE));
  view(e).set(msg, at);
  return at;
}

function wipe(e, msgAt, msgLen) {
  e.fl_wipe();
  if (msgAt !== undefined) view(e).fill(0, msgAt, msgAt + msgLen);
}

function seedOk(seed) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw Object.assign(new Error("bad-secret-key"), { code: "bad-secret-key" });
}

/** True once the pinned module loads (false on a browser without WebAssembly or a mismatched file). */
export async function mldsaAvailable() {
  try {
    await module();
    return true;
  } catch {
    return false;
  }
}

/** The ML-DSA-65 public key (1952 bytes) of a KeyGen_internal seed. */
export async function mldsaPublicKey(seed) {
  seedOk(seed);
  const e = await module();
  const a = e.fl_arena();
  try {
    view(e).set(seed, a + OFF_SEED);
    if (e.fl_pk() !== 0) throw Object.assign(new Error("bad-secret-key"), { code: "bad-secret-key" });
    return view(e).slice(a + OFF_PK, a + OFF_PK + PK);
  } finally {
    wipe(e);
  }
}

/**
 * FIPS 204 ML-DSA.Sign with a context. `deterministic` uses rnd = 0^32 (vectors); otherwise 32
 * fresh random bytes (hedged), as the native ports do. The seed is copied in, used once and wiped.
 */
export async function mldsaSign(seed, msg, ctx, { deterministic = false } = {}) {
  seedOk(seed);
  if (!(ctx instanceof Uint8Array) || ctx.length > 255) throw Object.assign(new Error("context"), { code: "bad-purpose" });
  const e = await module();
  const a = e.fl_arena();
  let at;
  try {
    const rnd = deterministic ? new Uint8Array(32) : crypto.getRandomValues(new Uint8Array(32));
    at = placeMessage(e, msg);
    const m = view(e);
    m.set(seed, a + OFF_SEED);
    m.set(rnd, a + OFF_RND);
    m.set(ctx, a + OFF_CTX);
    if (e.fl_sign(at, msg.length, ctx.length) !== 0) throw Object.assign(new Error("bad-secret-key"), { code: "bad-secret-key" });
    return view(e).slice(a + OFF_SIG, a + OFF_SIG + SIG);
  } finally {
    wipe(e, at, msg.length);
  }
}

/** ML-DSA-65 verify with a context (the same code path the signer uses). */
export async function mldsaVerify(pk, msg, ctx, sig) {
  if (!(pk instanceof Uint8Array) || pk.length !== PK || !(sig instanceof Uint8Array) || sig.length !== SIG || ctx.length > 255) return false;
  const e = await module();
  const a = e.fl_arena();
  let at;
  try {
    at = placeMessage(e, msg);
    const m = view(e);
    m.set(pk, a + OFF_PK);
    m.set(sig, a + OFF_SIG);
    m.set(ctx, a + OFF_CTX);
    return e.fl_verify(at, msg.length, ctx.length) === 0;
  } finally {
    wipe(e, at, msg.length);
  }
}
