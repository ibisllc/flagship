/**
 * `flagship-build pair` transport glue.
 *
 * Drives `runPair` through a fake duplex transport (no real socket): the full
 * relay handshake (builder-hello → phone-hello → SAS → confirm → deliver), then
 * asserts the recipe is written + signature-verified. The `--debug` path is
 * exercised end-to-end: the builder requests consent, the "phone" returns an
 * owner-IRK-signed debug-access grant, and the saved recipe carries it as the
 * `debugGrant` sibling that the box-side gate (server-daemon) consumes.
 *
 * The phone/relay are simulated: the builder sends BARE app frames; the relay
 * wraps a peer's frame as {kind:"peer", frame}; we feed the phone's replies
 * back that way. Crypto is the real cross-platform @flagship/protocol pairing.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  newBuilderKeypair,
  newCodeBytes,
  deriveSessionMaterial,
  sealDelivered,
  base64UrlEncode,
  signInstallBlob,
  signDebugAccessGrant,
  ed,
  type InstallBlob,
  type AuthCode,
  type DebugAccessGrant,
} from "@flagship/protocol";
import { runPair, type PairTransport } from "../src/pair.js";

const tick = () => new Promise((r) => setTimeout(r, 0));
const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const keypair = (seed: number) => {
  const sk = new Uint8Array(32).fill(seed);
  return { privateKey: sk, publicKey: ed.getPublicKey(sk) };
};

/** A signed v2 recipe (owner IRK = seed 7) as the website/phone produces. */
function buildSignedRecipe(): { json: string; ownerIrk: { privateKey: Uint8Array; publicKey: Uint8Array } } {
  const irk = keypair(7);
  const delegate = keypair(8);
  const rck = keypair(9);
  const expiresAt = Date.now() + 6 * 60 * 60_000;
  const authCode: AuthCode = {
    version: 1,
    serial: "01PAIRTEST00",
    username: "harry",
    serverName: "home",
    serverDomain: "home.harry.flagship.services",
    delegatedPubKey: delegate.publicKey,
    userPubKey: irk.publicKey,
    issuedAt: expiresAt - 60 * 60_000,
    expiresAt,
  };
  const blob: InstallBlob = {
    version: 2,
    serverDomain: authCode.serverDomain,
    username: authCode.username,
    serverName: authCode.serverName,
    phoneDelegatedPubKey: delegate.publicKey,
    registrationUrl: "https://flagship.services/api/server/register",
    authCode,
    authCodeUserSignature: new Uint8Array(64),
    installerGitRef: "main",
    rckPubKey: rck.publicKey,
  };
  const sig = signInstallBlob(blob, irk);
  const json = JSON.stringify({
    version: 2,
    serverDomain: blob.serverDomain,
    username: blob.username,
    serverName: blob.serverName,
    phoneDelegatedPubKey: hex(blob.phoneDelegatedPubKey),
    registrationUrl: blob.registrationUrl,
    authCode: {
      version: 1,
      serial: authCode.serial,
      username: authCode.username,
      serverName: authCode.serverName,
      serverDomain: authCode.serverDomain,
      delegatedPubKey: hex(authCode.delegatedPubKey),
      userPubKey: hex(authCode.userPubKey),
      issuedAt: authCode.issuedAt,
      expiresAt: authCode.expiresAt,
    },
    authCodeUserSignature: hex(blob.authCodeUserSignature),
    installerGitRef: blob.installerGitRef,
    rckPubKey: hex(blob.rckPubKey),
    blobSignatureHex: hex(sig),
  });
  return { json, ownerIrk: irk };
}

/** A controllable in-memory transport standing in for the relay socket. */
function fakeTransport() {
  const sent: string[] = [];
  const cbs: {
    open?: () => void;
    message?: (t: string) => void;
    close?: () => void;
    error?: (e: Error) => void;
  } = {};
  const transport: PairTransport = {
    send: (t) => sent.push(t),
    close: () => {},
    onOpen: (cb) => { cbs.open = cb; },
    onMessage: (cb) => { cbs.message = cb; },
    onClose: (cb) => { cbs.close = cb; },
    onError: (cb) => { cbs.error = cb; },
  };
  return {
    transport,
    sent,
    sentKinds: () => sent.map((s) => (JSON.parse(s) as { kind?: string }).kind),
    lastOf: (kind: string) =>
      [...sent].reverse().map((s) => JSON.parse(s) as Record<string, unknown>).find((o) => o.kind === kind),
    inject: (o: unknown) => cbs.message?.(JSON.stringify(o)),
    open: () => cbs.open?.(),
    peerGone: () => cbs.message?.(JSON.stringify({ kind: "peer-gone" })),
  };
}

describe("runPair transport glue", () => {
  it("completes the handshake and writes a verified recipe (no debug)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pair-"));
    const out = join(dir, "recipe.json");
    const builderKp = newBuilderKeypair();
    const phoneKp = newBuilderKeypair();
    const phoneAead = deriveSessionMaterial(phoneKp.secretKey, builderKp.publicKey).aeadKey;
    const { json: recipeJson } = buildSignedRecipe();
    const harness = fakeTransport();

    const p = runPair({
      out,
      quiet: true,
      codeBytes: newCodeBytes(),
      keypair: builderKp,
      transport: () => harness.transport,
    });

    harness.open();
    harness.inject({ kind: "accepted", role: "builder" });
    harness.inject({ kind: "peer-joined" });
    await tick();
    // The builder hands the phone its pubkey so a typed-code phone can derive the SAS.
    const hello = harness.lastOf("builder-hello");
    expect(hello?.builderPk).toBe(base64UrlEncode(builderKp.publicKey));

    harness.inject({ kind: "peer", frame: { kind: "phone-hello", phonePk: base64UrlEncode(phoneKp.publicKey) } });
    harness.inject({ kind: "peer", frame: { kind: "confirm-pairing" } });
    await tick();

    const sealed = sealDelivered(new TextEncoder().encode(recipeJson), phoneAead);
    harness.inject({ kind: "peer", frame: { kind: "deliver", ciphertext: sealed.ciphertextB64u, nonce: sealed.nonceB64u } });

    const result = await p;
    expect(result.serverDomain).toBe("home.harry.flagship.services");
    expect(result.debugGranted).toBe(false);
    expect(harness.sentKinds()).toContain("recipe-accepted");

    const written = JSON.parse(await readFile(out, "utf8")) as Record<string, unknown>;
    expect(written.serverDomain).toBe("home.harry.flagship.services");
    expect(written.debugGrant).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });

  it("ignores a deliver that arrives before pairing (no aead key yet)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pair-"));
    const out = join(dir, "recipe.json");
    const builderKp = newBuilderKeypair();
    const phoneKp = newBuilderKeypair();
    const phoneAead = deriveSessionMaterial(phoneKp.secretKey, builderKp.publicKey).aeadKey;
    const { json: recipeJson } = buildSignedRecipe();
    const harness = fakeTransport();

    const p = runPair({ out, quiet: true, keypair: builderKp, transport: () => harness.transport });
    harness.open();
    harness.inject({ kind: "peer-joined" });
    await tick();
    // deliver BEFORE phone-hello → no session key → must be ignored, not crash.
    const sealed = sealDelivered(new TextEncoder().encode(recipeJson), phoneAead);
    harness.inject({ kind: "peer", frame: { kind: "deliver", ciphertext: sealed.ciphertextB64u, nonce: sealed.nonceB64u } });
    await tick();
    // Now do it properly; it should still complete.
    harness.inject({ kind: "peer", frame: { kind: "phone-hello", phonePk: base64UrlEncode(phoneKp.publicKey) } });
    await tick();
    harness.inject({ kind: "peer", frame: { kind: "deliver", ciphertext: sealed.ciphertextB64u, nonce: sealed.nonceB64u } });
    const result = await p;
    expect(result.serverDomain).toBe("home.harry.flagship.services");
    await rm(dir, { recursive: true, force: true });
  });

  it("--debug requests consent and embeds the owner-signed debugGrant", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pair-"));
    const out = join(dir, "recipe.json");
    const builderKp = newBuilderKeypair();
    const phoneKp = newBuilderKeypair();
    const phoneAead = deriveSessionMaterial(phoneKp.secretKey, builderKp.publicKey).aeadKey;
    const { json: recipeJson, ownerIrk } = buildSignedRecipe();
    const harness = fakeTransport();

    const p = runPair({
      out,
      quiet: true,
      debug: true,
      consentTimeoutMs: 5_000,
      keypair: builderKp,
      transport: () => harness.transport,
    });

    harness.open();
    harness.inject({ kind: "peer-joined" });
    await tick();
    harness.inject({ kind: "peer", frame: { kind: "phone-hello", phonePk: base64UrlEncode(phoneKp.publicKey) } });
    harness.inject({ kind: "peer", frame: { kind: "confirm-pairing" } });
    await tick();

    const sealed = sealDelivered(new TextEncoder().encode(recipeJson), phoneAead);
    harness.inject({ kind: "peer", frame: { kind: "deliver", ciphertext: sealed.ciphertextB64u, nonce: sealed.nonceB64u } });
    await tick();

    // Builder must now ask the phone to approve debug access — NOT finalize yet.
    const req = harness.lastOf("consent-request");
    expect(req).toBeTruthy();
    expect(req?.setting).toBe("debug");
    expect(req?.serverDomain).toBe("home.harry.flagship.services");

    // Phone (behind Face ID) signs the grant under the owner IRK and replies.
    const grant: DebugAccessGrant = {
      serverDomain: "home.harry.flagship.services",
      sshAuthorizedKey: "",
      issuedAt: 1_700_000_000_000,
    };
    const sigHex = hex(signDebugAccessGrant(grant, ownerIrk));
    const carrier = JSON.stringify({ grant, signatureHex: sigHex });
    harness.inject({ kind: "peer", frame: { kind: "consent-result", setting: "debug", grant: carrier } });

    const result = await p;
    expect(result.debugGranted).toBe(true);

    const written = JSON.parse(await readFile(out, "utf8")) as { debugGrant?: string };
    expect(typeof written.debugGrant).toBe("string");
    const embedded = JSON.parse(written.debugGrant!) as { grant: DebugAccessGrant; signatureHex: string };
    expect(embedded.grant.serverDomain).toBe("home.harry.flagship.services");
    expect(embedded.signatureHex).toBe(sigHex);
    await rm(dir, { recursive: true, force: true });
  });

  it("--debug with a declined consent burns a production image (no grant)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pair-"));
    const out = join(dir, "recipe.json");
    const builderKp = newBuilderKeypair();
    const phoneKp = newBuilderKeypair();
    const phoneAead = deriveSessionMaterial(phoneKp.secretKey, builderKp.publicKey).aeadKey;
    const { json: recipeJson } = buildSignedRecipe();
    const harness = fakeTransport();

    const p = runPair({ out, quiet: true, debug: true, consentTimeoutMs: 5_000, keypair: builderKp, transport: () => harness.transport });
    harness.open();
    harness.inject({ kind: "peer-joined" });
    await tick();
    harness.inject({ kind: "peer", frame: { kind: "phone-hello", phonePk: base64UrlEncode(phoneKp.publicKey) } });
    await tick();
    const sealed = sealDelivered(new TextEncoder().encode(recipeJson), phoneAead);
    harness.inject({ kind: "peer", frame: { kind: "deliver", ciphertext: sealed.ciphertextB64u, nonce: sealed.nonceB64u } });
    await tick();
    // Phone declines (no `grant` field).
    harness.inject({ kind: "peer", frame: { kind: "consent-result", setting: "debug" } });

    const result = await p;
    expect(result.debugGranted).toBe(false);
    const written = JSON.parse(await readFile(out, "utf8")) as { debugGrant?: string };
    expect(written.debugGrant).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });

  it("emitEvents reports each milestone in order for a GUI host", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pair-"));
    const out = join(dir, "recipe.json");
    const builderKp = newBuilderKeypair();
    const phoneKp = newBuilderKeypair();
    const phoneAead = deriveSessionMaterial(phoneKp.secretKey, builderKp.publicKey).aeadKey;
    const { json: recipeJson } = buildSignedRecipe();
    const harness = fakeTransport();
    const events: Array<Record<string, unknown>> = [];

    const p = runPair({
      out,
      quiet: true,
      keypair: builderKp,
      transport: () => harness.transport,
      emitEvents: (ev) => events.push(ev as unknown as Record<string, unknown>),
    });

    // `ready` fires synchronously (before any phone traffic) so the cover can render.
    await tick();
    const ready = events.find((e) => e.event === "ready");
    expect(ready).toBeTruthy();
    expect(typeof ready?.humanCode).toBe("string");
    expect(typeof ready?.qrTerminal).toBe("string");
    expect((ready?.qrTerminal as string).length).toBeGreaterThan(0);
    expect(ready?.debugRequested).toBe(false);

    harness.open();
    harness.inject({ kind: "peer-joined" });
    await tick();
    harness.inject({ kind: "peer", frame: { kind: "phone-hello", phonePk: base64UrlEncode(phoneKp.publicKey) } });
    harness.inject({ kind: "peer", frame: { kind: "confirm-pairing" } });
    await tick();
    const sealed = sealDelivered(new TextEncoder().encode(recipeJson), phoneAead);
    harness.inject({ kind: "peer", frame: { kind: "deliver", ciphertext: sealed.ciphertextB64u, nonce: sealed.nonceB64u } });
    await p;

    const order = events.map((e) => e.event);
    expect(order).toEqual(["ready", "phone-connected", "paired", "delivered", "done"]);
    const connected = events.find((e) => e.event === "phone-connected");
    expect(typeof connected?.sas).toBe("string");
    const done = events.find((e) => e.event === "done");
    expect(done?.serverDomain).toBe("home.harry.flagship.services");
    expect(done?.debugGranted).toBe(false);
    expect(done?.recipePath).toBe(out);
    await rm(dir, { recursive: true, force: true });
  });

  it("emitEvents reports an error on session expiry", async () => {
    const builderKp = newBuilderKeypair();
    const harness = fakeTransport();
    const events: Array<Record<string, unknown>> = [];
    const p = runPair({
      out: join(tmpdir(), "never.json"),
      quiet: true,
      keypair: builderKp,
      transport: () => harness.transport,
      emitEvents: (ev) => events.push(ev as unknown as Record<string, unknown>),
    });
    harness.open();
    harness.inject({ kind: "expired" });
    await expect(p).rejects.toThrow(/timed out/);
    expect(events.some((e) => e.event === "error")).toBe(true);
  });

  it("rejects when the relay session expires before any recipe", async () => {
    const builderKp = newBuilderKeypair();
    const harness = fakeTransport();
    const p = runPair({ out: join(tmpdir(), "never.json"), quiet: true, keypair: builderKp, transport: () => harness.transport });
    harness.open();
    harness.inject({ kind: "expired" });
    await expect(p).rejects.toThrow(/timed out/);
  });

  it("finalizes with the recipe if the phone drops after delivering (no debug)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pair-"));
    const out = join(dir, "recipe.json");
    const builderKp = newBuilderKeypair();
    const phoneKp = newBuilderKeypair();
    const phoneAead = deriveSessionMaterial(phoneKp.secretKey, builderKp.publicKey).aeadKey;
    const { json: recipeJson } = buildSignedRecipe();
    const harness = fakeTransport();

    const p = runPair({ out, quiet: true, keypair: builderKp, transport: () => harness.transport });
    harness.open();
    harness.inject({ kind: "peer-joined" });
    await tick();
    harness.inject({ kind: "peer", frame: { kind: "phone-hello", phonePk: base64UrlEncode(phoneKp.publicKey) } });
    await tick();
    const sealed = sealDelivered(new TextEncoder().encode(recipeJson), phoneAead);
    harness.inject({ kind: "peer", frame: { kind: "deliver", ciphertext: sealed.ciphertextB64u, nonce: sealed.nonceB64u } });
    const result = await p; // resolves on deliver (no debug)
    expect(result.serverDomain).toBe("home.harry.flagship.services");
    await rm(dir, { recursive: true, force: true });
  });
});
