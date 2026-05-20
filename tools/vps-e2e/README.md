# `vps-e2e` — real-VPS end-to-end harness

Drives + asserts the WHOLE Flagship chain on a real cloud VPS:

1.  Mint a build code on `.com` (IRK-signed).
2.  Personalize the base Alpine ISO with that `.com`-signed install
    blob + signature (so the trailer matches the live ticket).
3.  Upload the personalized ISO to R2 + mint a 1-hour presigned URL.
4.  Hetzner rescue-mode boot:
    `POST /servers (ubuntu-22.04 + ssh_keys)` →
    `enable_rescue` →
    `reset` →
    poll TCP 22 →
    `ssh root@<ip> "wget <presigned> | dd of=/dev/sda && reboot"`.
5.  The Flagship Alpine + apkovl + `install.sh` take over;
    the harness asserts the rest of the chain on `.com` + the live
    `<server>.<user>.flagship.services` (green padlock, free
    account/server, vibecode env-var injection).
6.  Teardown ALWAYS runs (finally): `DELETE /v1/servers/{id}` +
    `wrangler r2 object delete <bucket>/<key>` — both idempotent.

The chain has 9 stages plus the always-on `teardown` and the one
`known-gated` CA-endorsement assertion.

## Prerequisites

- **`HCLOUD_TOKEN`** env var with read+write access to the operator's
  Hetzner Cloud project. The harness fails fast if absent — it never
  guesses.
- **`wrangler` CLI**, logged into the Cloudflare account hosting the
  R2 bucket (`npx wrangler whoami` should show you logged in).
- **`ssh` + `ssh-keygen`** (OpenSSH client, default on macOS/Linux).
  We shell out via `child_process`; no `node-ssh` runtime dep.
- **A base Flagship Alpine ISO on disk.** Download it once:
  ```sh
  curl -L -o /tmp/flagship-base.iso \
    https://flagshipserver.com/build/iso/flagship-base-alpine-3.21.0-x86_64.iso
  ```
- **An R2 bucket for temp objects** (default name `flagship-iso-temp`).
  Create it once if it doesn't exist:
  ```sh
  npx wrangler r2 bucket create flagship-iso-temp
  ```

## Usage

```sh
npx tsx tools/vps-e2e/src/cli.ts \
  --iso /tmp/flagship-base.iso \
  --upload-via r2 \
  --r2-bucket flagship-iso-temp \
  --username e2e-$(date +%s) \
  --server-name home \
  --region fsn1 \
  --size cx22
```

The harness:
- generates `.demo-ssh-key` in the cwd if it doesn't exist
  (override with `--ssh-key-path <path>`),
- uploads the public half to Hetzner as named SSH key
  `flagship-vps-e2e` (idempotent — no-op if it already exists),
- personalizes the base ISO inline with the freshly-minted install
  blob (so the trailer's auth-code matches what `.com` recorded),
- uploads the resulting personalized ISO to R2 + mints a 1h presigned URL,
- runs the rescue+dd dance,
- asserts the rest of the chain,
- ALWAYS tears down (server destroy + R2 object delete) in finally.

### `--plan`

Prints the full ordered chain (including the one KNOWN-GATED stage
and its `gatedReason`) and exits without any I/O or credentials. Use
this to sanity-check the harness from any machine.

```sh
npx tsx tools/vps-e2e/src/cli.ts --plan
```

### Cost note

A CX22 in `fsn1` is €0.006/h; a successful 20-min run is ≈ €0.005.
Teardown runs in `finally`, but if it somehow fails (Hetzner API
outage), you'll see a `[FAIL] teardown — manual cleanup required …`
line and you should delete the server by hand via the Hetzner Cloud
console.

## Why rescue+dd

Hetzner Cloud has no public custom-ISO upload API. ISOs come from
Hetzner's catalogue or your own snapshots, full stop. The rescue+dd
path is the only realistic way to boot our personalized Alpine + apkovl
ISO on a CX22 today:

1. Create the server from a placeholder image (`ubuntu-22.04`).
2. Enable rescue mode (`linux64` netboot served by Hetzner).
3. Reset — server boots into rescue.
4. SSH in + `wget <presigned-r2-url> | dd of=/dev/sda`.
5. Reboot — server boots from disk into the freshly-written Flagship
   ISO; apkovl + `install.sh` take over.

The R2 object lives for ~1h then either expires from the presign TTL
or is explicitly deleted by the harness's `finally` block.
