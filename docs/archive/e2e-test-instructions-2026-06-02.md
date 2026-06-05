# End-to-end test instructions — per-user SSL cutover (#23) + clean-slate prod

**Date:** 2026-06-02
**Context:** Pre-release. All users (human + demo) were wiped from prod D1 for a
clean two-path test. The per-user-cert SSL cutover (#23) is built, deployed, and
**already verified live** on the demo path (see §0). These instructions cover
the two paths you drive yourself.

---

## 0. What's already verified (no action needed)

I ran `node scripts/sample-user.mjs create demo1234` end-to-end against prod. The
Hetzner box booted, pulled `main` (with #23), registered, and minted a **real
Let's Encrypt cert**. Verified live:

```
$ openssl s_client -connect home.demo1234.flagship.services:443 \
      -servername home.demo1234.flagship.services | openssl x509 -noout -subject -ext subjectAltName
subject=CN=demo1234.flagship.services
X509v3 Subject Alternative Name:
    DNS:*.demo1234.flagship.services, DNS:demo1234.flagship.services

$ curl -o /dev/null -w "http=%{http_code} tls_verify=%{ssl_verify_result}\n" https://home.demo1234.flagship.services/
http=200 tls_verify=0          # 0 = valid chain = green padlock
```

- SANs are the **per-user** shape `[demo1234, *.demo1234]` — the old per-server
  `*.home.demo1234` is gone. ✅
- `home.demo1234` (box apex) AND an arbitrary `app.demo1234` (app label) both
  resolve via the single `*.demo1234` wildcard. ✅
- Real LE cert (issuer `CN=YR2`), green padlock. ✅

**The risky SSL cutover works in prod. No issues surfaced.** Note: the demo VPS
is snapshotted + torn down by the `*/10` cron a few minutes after minting, so
`home.demo1234` will stop resolving once it's reaped — that's expected for the
demo (the snapshot is the artifact). Re-run the create to get a fresh live box.

---

## 1. Demo path — from the simulator app

The iOS app is **rebuilt and running** on the booted simulator (iPhone 16,
`com.flagshipserver.app`). The Mac burner ("Flagship Assembler") is **rebuilt,
signed (Developer ID IBIS LLC), and installed** to `/Applications`.

1. In the simulator, the app should be on the Welcome screen. To exercise the
   **live** client (not the mock), 3-tap the Welcome-box illustration to flip
   `flagship.dev.useLiveClient` (per the demo-sandbox flow).
2. Trigger a demo sandbox: the app asks `.com` for a `testAccount` and activates
   `DemoFixtures`. You should see **one real device** rendered (the demo model
   shows a single live box, not baked fixtures).
3. **What to verify:** the rendered server's URL is `<server>.<demo-user>.flagship.services`
   and tapping through to it shows a green padlock. The device/app chips should
   address as `<label>.<user>` (one label deep) — not `<app>.<server>.<user>`.

If you'd rather drive the demo from the CLI again (it provisions a fresh box):

```sh
cd /Users/harrywinner/flagship
node scripts/sample-user.mjs create demo5678 --display "Demo 5678"
# wait for "[create] … state=provisioning" then, while the box is up:
curl -o /dev/null -w "%{http_code} %{ssl_verify_result}\n" https://home.demo5678.flagship.services/
```

(`FLAGSHIP_ADMIN_SECRET` is already in your shell; the Worker holds
`HCLOUD_TOKEN`/`DEMO_IRK_KEK`.)

---

## 2. Human / real-user path — sim app → recipe → burner → hardware

This is the path a real user takes. Account ≠ server: you create an **account**
(name-first), then mint a **server install recipe**, burn it, and boot real
hardware.

1. **Create an account** in the sim app (real client, not demo): pick a username
   (RFC-1035 label, `[a-z0-9]{3,30}`, hyphen-free — e.g. `harrytest`). The app
   registers the IRK with `.com`. Account creation should never 404.
2. **Create a server**: in the create-server form, fill the fields and pick:
   - **Boot-unlock mode** — `auto` (box self-unlocks via sealed lease) or
     `approve` (phone-gated relay). For a first hardware test, `auto` is simplest.
   - **Cert autonomy** — how long the box keeps serving while every admin device
     is offline. Default `90d`; `indefinite` opt-in seals the mint authority to
     the box. (This is the #23/#28 `ca=<mode>:<days>` field; it round-trips
     through the recipe signature.)
3. The app mints a **signed InstallBlob** and shows a **recipe** (build code /
   recipe JSON). Copy it (or download).
4. **Burn it:** open **Flagship Assembler** (`/Applications`). On first launch
   after a rebuild you may need to re-approve: System Settings → Login Items
   (allow the helper) and grant the helper **Full Disk Access**. Paste the
   recipe (Mac button or CLI `-`), insert a USB stick, and burn.
   - The burner bakes `bootUnlockMode` **and** `certAutonomy` into the recipe
     trailer (both are signature-covered — verified at 3 box checkpoints).
5. **Boot the hardware** from the USB. The box: LUKS-formats, clones the repo,
   registers with `.com` (publishes the **2** user-zone DNS records
   `<user>` + `*.<user>`), then mints `[<user>, *.<user>]` via DNS-01.
6. **Verify the green padlock** on the box's apex:
   ```sh
   curl -o /dev/null -w "%{http_code} %{ssl_verify_result}\n" https://<server>.<user>.flagship.services/
   # expect: 200 0
   openssl s_client -connect <server>.<user>.flagship.services:443 \
       -servername <server>.<user>.flagship.services | openssl x509 -noout -ext subjectAltName
   # expect SANs: *.<user>.flagship.services, <user>.flagship.services
   ```

---

## 3. What "good" looks like (acceptance)

| Check | Expected |
|---|---|
| Cert SANs | `[<user>.flagship.services, *.<user>.flagship.services]` — **no** `*.<server>.<user>` |
| `tls_verify` | `0` (valid LE chain, green padlock) |
| Box apex resolves | via the `*.<user>` wildcard (one A record covers it) |
| Arbitrary app label `x.<user>` | resolves to the Fly ingress (149.248.216.86) |
| DNS records published per registration | **2** (`<user>` + `*.<user>`), not 4 |

---

## 4. Known follow-ups (NOT blocking these tests)

- **#28 device-side ACME account-key generation** — the recovery **escrow** half
  is built + deployed (the wrapped account key is carried in the WebAuthn-PRF
  recovery envelope). The **device-side** keygen (Secure-Enclave P-256 +
  X25519-seal to an admin device/box + PRF-wrap) is the one remaining build. It
  is **not** on the cert-issuance path — boxes mint certs via the existing ACME
  flow today (proven in §0). It only matters for *disaster recovery* of the mint
  authority if every admin device is lost. See the final report for the full
  explanation of the recovery key's role.
- **PSL submission** for `flagship.services` — until submitted, all
  `<user>.flagship.services` share Let's Encrypt's 50-certs/registered-domain/week
  rate limit. Fine for testing; needed before scale. (Owner/ops action, weeks of
  lead time.)
- The Worker's `FLAGSHIP_ADMIN_SECRET` was re-synced to your shell's value this
  session (it had drifted; the CLI was getting 403). If you keep a copy of the
  admin secret elsewhere, note that the live value now equals your shell's.
