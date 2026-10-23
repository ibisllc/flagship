#!/usr/bin/env node
// Sign the bytes on stdin with the owner's YubiKey (PIV slot, Ed25519) and print `<pubkeyhex> <signaturehex>`:
// the `--signer-cmd` contract of `tools/box-artifact/build.ts sign`. The PIN is read from the terminal
// (/dev/tty), never from argv or the environment.
//
//   node scripts/yubikey-sign.mjs [yubikey-piv:slot=9c] < bytes
//
// Needs the maintainers clone at ./maintainers (scripts/release.sh links it into its worktree).
const cli = (p) => new URL(`../maintainers/packages/cli/dist/lib/${p}`, import.meta.url).pathname;
const { loadSigner } = await import(cli("keysource.js"));
const { pivPinFromTty } = await import(cli("piv-pin.js"));

const source = process.argv[2] ?? "yubikey-piv:slot=9c";
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const message = new Uint8Array(Buffer.concat(chunks));
if (message.length === 0) {
  console.error("nothing to sign on stdin");
  process.exit(2);
}
// stdin carries the bytes, so the prompt goes to the controlling terminal.
const signer = await loadSigner(source, { pivPin: pivPinFromTty({ interactive: true }) });
const sig = await signer.sign(message);
process.stdout.write(`${signer.pubKey} ${sig}\n`);
