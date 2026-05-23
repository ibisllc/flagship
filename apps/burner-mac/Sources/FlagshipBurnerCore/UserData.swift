import Foundation

/// cloud-init autoinstall user-data generator (pure-Swift port of
/// packages/flagship-burner userdata.ts). The verified recipe JSON is
/// embedded base64 verbatim (no re-serialization, so it can't drop fields),
/// and a first-boot bootstrap clones the daemon and registers the server.

public enum UserDataError: LocalizedError, Equatable {
    case unsafeGitRef(String)
    case badRepo(String)

    public var errorDescription: String? {
        switch self {
        case .unsafeGitRef(let r): return "Refusing to embed unsafe git ref: \(r)"
        case .badRepo(let r): return "Repo URL must be https://, got: \(r)"
        }
    }
}

public enum UserData {
    public static let defaultRepoURL = "https://github.com/ibisllc/flagship.git"

    /// Build the autoinstall user-data. `recipeJSON` is the raw, already-
    /// verified recipe bytes (embedded as the install-blob the daemon reads).
    ///
    /// `encryptRoot` is the locked DEFAULT (true). Every burn produces a
    /// LUKS-encrypted, phone-gated box — EXPERIMENTAL, needs live validation
    /// (brick risk on first boot). encryptRoot:false is an INTERNAL debug
    /// escape only (not exposed in the GUI): it reproduces the proven
    /// unencrypted path byte-for-byte. Mirrors packages/flagship-burner
    /// userdata.ts buildAutoinstallUserData.
    public static func autoinstallYAML(recipeJSON: Data,
                                       installerGitRef: String,
                                       repoURL: String = defaultRepoURL,
                                       encryptRoot: Bool = true) throws -> String {
        let trimmed = installerGitRef.trimmingCharacters(in: .whitespacesAndNewlines)
        let ref = trimmed.isEmpty ? "main" : trimmed
        guard ref.range(of: "^[A-Za-z0-9._/-]+$", options: .regularExpression) != nil else {
            throw UserDataError.unsafeGitRef(ref)
        }
        guard repoURL.hasPrefix("https://") else { throw UserDataError.badRepo(repoURL) }

        let blobB64 = recipeJSON.base64EncodedString()
        let bootstrapB64 = Data(bootstrapScript(ref: ref, repoURL: repoURL, encryptRoot: encryptRoot).utf8)
            .base64EncodedString()
        // Emitted only when encryptRoot is on; "" keeps the default path
        // byte-identical (subiquity falls back to its whole-disk layout).
        let storageBlock = encryptRoot ? luksStorageBlock() : ""

        return """
        #cloud-config
        # Flagship Assembler — autoinstall user-data
        # Generated at burn time. Don't edit by hand.
        autoinstall:
          version: 1
          identity:
            hostname: flagship-pod
            username: flagship
            password: "$6$saltsaltsaltsaltsalt$Fz2j0/yjeyqQsRGfQ2DGRrXyMz9.6CljgPwQ3UlqOPLqo4kVZk.zhztOQS9rdshOMu7w5WL9.bjvKR7vCs71y0"
          ssh:
            install-server: true
            allow-pw: false
          packages:
            - git
            - curl
            - jq
            - ca-certificates
            - xxd
            - cryptsetup
            - lvm2
            - gnupg
        \(storageBlock)  late-commands:
            - curtin in-target --target=/target -- bash -c 'mkdir -p /var/flagship && echo "\(blobB64)" | base64 -d > /var/flagship/install-blob.json && chmod 600 /var/flagship/install-blob.json'
            - curtin in-target --target=/target -- bash -c 'echo "\(bootstrapB64)" | base64 -d > /usr/local/sbin/flagship-bootstrap.sh && chmod +x /usr/local/sbin/flagship-bootstrap.sh'
            - curtin in-target --target=/target -- /usr/local/sbin/flagship-bootstrap.sh

        """
    }

    /// curtin custom-storage layout for the OPT-IN LUKS path. EXPERIMENTAL —
    /// needs live validation (brick risk). Byte-identical to userdata.ts
    /// luksStorageBlock(). 2-space indent so it nests under `autoinstall:`.
    static func luksStorageBlock() -> String {
        return """
          # EXPERIMENTAL LUKS-on-root (opt-in; default OFF). Needs live validation.
          storage:
            config:
              - {id: disk0, type: disk, ptable: gpt, match: {size: largest}, wipe: superblock-recursive, grub_device: true, preserve: false}
              - {id: bios_grub, type: partition, device: disk0, size: 1M, flag: bios_grub, preserve: false}
              - {id: boot_part, type: partition, device: disk0, size: 512M, preserve: false}
              - {id: root_part, type: partition, device: disk0, size: -1, preserve: false}
              - {id: boot_fs, type: format, fstype: ext4, volume: boot_part, label: FLAGSHIP_BOOT, preserve: false}
              - {id: root_crypt, type: dm_crypt, volume: root_part, dm_name: flagship_root, key: "\(burnPassphrase)", preserve: false}
              - {id: root_fs, type: format, fstype: ext4, volume: root_crypt, label: FLAGSHIP_ROOT, preserve: false}
              - {id: root_mount, type: mount, device: root_fs, path: /}
              - {id: boot_mount, type: mount, device: boot_fs, path: /boot}

        """
    }

    /// Fixed burn-time LUKS passphrase used ONLY between curtin's luksFormat and
    /// the bootstrap's re-key step; destroyed before first boot. Identical to
    /// userdata.ts BURN_PASSPHRASE.
    static let burnPassphrase = "flagship-burn-time-luks-rekey-me-immediately"

    /// First-boot bootstrap — clones flagship, generates the server identity,
    /// and registers with .com. Mirrors userdata.ts buildBootstrapScript.
    /// Bash line-continuations are written as `\\` (literal backslash); bash
    /// `$VAR` / `$(...)` / `${...}` pass through unchanged. `encryptRoot` opt-in
    /// (default OFF) splices the LUKS unlock-hook block before `installed.flag`.
    static func bootstrapScript(ref: String, repoURL: String, encryptRoot: Bool = true) -> String {
        let plain = bootstrapScriptPlain(ref: ref, repoURL: repoURL)
        guard encryptRoot else { return plain }
        // Splice the LUKS block in just before the plain script's final two
        // lines (installed.flag + "done") so the shared body stays verbatim.
        let tail = """
        date > /var/flagship/installed.flag
        echo "[flagship-bootstrap] done"

        """
        precondition(plain.hasSuffix(tail), "plain bootstrap tail drifted; encrypted splice would be wrong")
        return String(plain.dropLast(tail.count)) + luksBootstrapBlock() + tail
    }

    static func bootstrapScriptPlain(ref: String, repoURL: String) -> String {
        return """
        #!/bin/bash
        # Flagship first-boot bootstrap.
        # Runs once at first boot under curtin's in-target chroot. Idempotent.
        set -uo pipefail
        exec >>/var/log/flagship-bootstrap.log 2>&1
        date
        echo "[flagship-bootstrap] starting"

        REPO_URL="${FLAGSHIP_REPO_URL:-\(repoURL)}"
        GIT_REF="\(ref)"

        # Install Node 20 (Ubuntu 22.04 default nodejs is 12; protocol needs 20+).
        export DEBIAN_FRONTEND=noninteractive
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
        apt-get install -y --no-install-recommends nodejs

        # Read the install-blob fields the daemon needs.
        BLOB_JSON=/var/flagship/install-blob.json
        SERVER_DOMAIN="$(jq -r .serverDomain "$BLOB_JSON")"
        USERNAME="$(jq -r .username "$BLOB_JSON")"
        SERVER_NAME="$(jq -r .serverName "$BLOB_JSON")"
        REGISTRATION_URL="$(jq -r .registrationUrl "$BLOB_JSON")"
        PHONE_DELEGATED_PUBKEY="$(jq -r .phoneDelegatedPubKey "$BLOB_JSON")"
        AUTH_CODE_SERIAL="$(jq -r .authCode.serial "$BLOB_JSON")"
        echo "[flagship-bootstrap] domain=$SERVER_DOMAIN user=$USERNAME ref=$GIT_REF"

        # Persist install-time facts the daemon reads on every boot.
        mkdir -p /var/flagship /boot/flagship
        echo "$SERVER_DOMAIN"          > /var/flagship/server-domain
        echo "$USERNAME"               > /var/flagship/username
        echo "$SERVER_NAME"            > /var/flagship/server-name
        echo "$PHONE_DELEGATED_PUBKEY" > /var/flagship/phone-delegated.pub
        echo "$AUTH_CODE_SERIAL"       > /var/flagship/auth-code-serial
        cp "$BLOB_JSON" /boot/install-blob.json

        # Clone flagship + build daemon.
        rm -rf /opt/flagship
        git clone --depth 50 --branch "$GIT_REF" "$REPO_URL" /opt/flagship || \\
            (git clone --depth 50 "$REPO_URL" /opt/flagship && \\
             git -C /opt/flagship fetch --depth 50 origin "$GIT_REF" && \\
             git -C /opt/flagship checkout "$GIT_REF")
        cd /opt/flagship
        npm install --no-audit --no-fund --workspaces --include-workspace-root \\
            | tee /var/log/flagship-npm.log
        if [ ! -e /opt/flagship/node_modules/@flagship/protocol/package.json ]; then
            echo "[flagship-bootstrap] WARN: workspace not symlinked; manual linking"
            mkdir -p /opt/flagship/node_modules/@flagship
            for pkg in /opt/flagship/packages/*/; do
                name=$(jq -r .name "$pkg/package.json" 2>/dev/null || echo "")
                [ -n "$name" ] && ln -sfn "$pkg" "/opt/flagship/node_modules/$name"
            done
        fi
        npx tsc -b 2>&1 | tee /var/log/flagship-tsc.log || true

        # Generate server identity.
        mkdir -p /var/flagship/identity
        chmod 700 /var/flagship/identity
        npx tsx scripts/install-helper.ts gen-identity \\
            --out-priv /var/flagship/identity/identity.priv.hex \\
            --out-pub  /var/flagship/identity/identity.pub.hex \\
            --out-pem  /boot/identity.pem
        chmod 600 /var/flagship/identity/identity.priv.hex /boot/identity.pem
        SERVER_IDENTITY_PRIV_HEX="$(tr -d '\\n' < /var/flagship/identity/identity.priv.hex)"
        SERVER_IDENTITY_PUB_HEX="$(tr -d '\\n' < /var/flagship/identity/identity.pub.hex)"

        # Mint the entitlement bundle the daemon hard-requires on every tunnel
        # HELLO. The RootEntitlement binds this box's STK (the identity pubkey
        # just generated) to its canonical FQDN.
        #
        # INTERIM SELF-SIGN — read this before touching it. The demo path signs
        # the RootEntitlement with the deterministic demo *User IRK*. The real
        # (Burner) path has NO user IRK on the box — the phone holds it — so we
        # SELF-SIGN with the box's own identity key (pass the identity priv as
        # the signer; --pod-pub is that same identity pubkey). This is SAFE today
        # ONLY because the production tunnel hub does NOT verify the RootEntitle-
        # ment's IRK signature: apps/web/src/server.ts wires startTunnelHub with
        # authLookup but no irkLookup, and tunnelHub.ts skips the signature check
        # when irkLookup is absent.
        #
        # FOLLOW-UP REQUIRED before irkLookup is enabled in production: replace
        # this self-signed bundle with a phone-signed one. The proper flow is
        # that after first boot the phone signs an EntitlementBundle for THIS
        # box's STK (identity pubkey) with the user's real IRK and delivers it to
        # /var/flagship/entitlements.json (process restart picks it up). Until
        # then a self-signed bundle would be rejected the moment irkLookup goes
        # live, so this MUST be cut over first.
        npx tsx scripts/install-helper.ts mint-entitlements \\
            --irk-priv "$SERVER_IDENTITY_PRIV_HEX" \\
            --pod-pub "$SERVER_IDENTITY_PUB_HEX" \\
            --username "$USERNAME" \\
            --pod-canonical "$SERVER_DOMAIN" \\
            --out /var/flagship/entitlements.json \\
            || echo "[flagship-bootstrap] WARNING: mint-entitlements failed; daemon will not serve"
        chmod 600 /var/flagship/entitlements.json 2>/dev/null || true

        # Daemon environment. server-daemon reads its two REQUIRED inputs
        # (FLAGSHIP_SUBDOMAIN + FLAGSHIP_IDENTITY_PRIV_HEX) from the process env
        # only; systemd loads this via EnvironmentFile= in the unit below.
        mkdir -p /etc/flagship
        cat > /etc/flagship/daemon.env <<ENVEOF
        FLAGSHIP_SUBDOMAIN=$SERVER_DOMAIN
        FLAGSHIP_IDENTITY_PRIV_HEX=$SERVER_IDENTITY_PRIV_HEX
        ENVEOF
        chmod 600 /etc/flagship/daemon.env

        # Write systemd units. We run inside curtin's in-target chroot where
        # systemd is NOT running, so we ENABLE (drops the symlink, takes effect
        # on first real boot) and never rely on `systemctl start`. Two units:
        #   flagship-first-boot-register — oneshot, POSTs /api/server/register
        #   flagship-daemon              — the long-running server-daemon
        cat > /etc/systemd/system/flagship-daemon.service <<'UNIT'
        [Unit]
        Description=Flagship server daemon
        After=network-online.target flagship-first-boot-register.service
        Wants=network-online.target

        [Service]
        Type=simple
        WorkingDirectory=/opt/flagship
        EnvironmentFile=/etc/flagship/daemon.env
        ExecStart=/usr/bin/npm run start --workspace=@flagship/server-daemon
        Restart=on-failure
        RestartSec=5
        StandardOutput=journal
        StandardError=journal

        [Install]
        WantedBy=multi-user.target
        UNIT

        cat > /etc/systemd/system/flagship-first-boot-register.service <<UNIT
        [Unit]
        Description=Flagship first-boot registration with .com
        After=network-online.target
        Wants=network-online.target
        ConditionPathExists=!/var/flagship/registered.flag

        [Service]
        Type=oneshot
        WorkingDirectory=/opt/flagship
        ExecStart=/usr/local/sbin/flagship-first-boot-register.sh

        [Install]
        WantedBy=multi-user.target
        UNIT

        # The register wrapper as a real script — easier to debug than a
        # multi-line ExecStart with systemd quoting. It signs + POSTs the
        # server-register payload on the first real boot (we deliberately do NOT
        # register inline in the chroot: no guaranteed network during install).
        cat > /usr/local/sbin/flagship-first-boot-register.sh <<'WRAPPER'
        #!/bin/bash
        set -uo pipefail
        exec >>/var/log/flagship-first-boot-register.log 2>&1
        date
        echo "[register] starting"
        cd /opt/flagship
        . /etc/flagship-bootstrap.env
        npx tsx scripts/install-helper.ts sign-server-register \\
            --priv-hex "$SERVER_IDENTITY_PRIV_HEX" \\
            --auth-code-blob /var/flagship/install-blob.json \\
            > /run/register-payload.json
        echo "[register] POST $REGISTRATION_URL"
        curl -fsS -X POST -H "content-type: application/json" \\
            --data @/run/register-payload.json \\
            "$REGISTRATION_URL"
        date > /var/flagship/registered.flag
        echo "[register] done"
        WRAPPER
        chmod +x /usr/local/sbin/flagship-first-boot-register.sh

        # Stash the variables the wrapper needs (the bootstrap has them in scope;
        # systemd's ExecStart sees only the unit's environment).
        cat > /etc/flagship-bootstrap.env <<ENV
        SERVER_DOMAIN=$SERVER_DOMAIN
        USERNAME=$USERNAME
        SERVER_NAME=$SERVER_NAME
        REGISTRATION_URL=$REGISTRATION_URL
        SERVER_IDENTITY_PRIV_HEX=$SERVER_IDENTITY_PRIV_HEX
        ENV
        chmod 600 /etc/flagship-bootstrap.env

        # daemon-reload is a no-op (and may warn) in the install chroot; the
        # enable symlinks are what matter and they persist into the booted
        # system. Do NOT `systemctl start` — systemd isn't the init here.
        systemctl daemon-reload 2>/dev/null || true
        systemctl enable flagship-daemon.service flagship-first-boot-register.service || \\
            echo "[flagship-bootstrap] WARNING: systemctl enable failed (will retry would be needed on real boot)"
        echo "[flagship-bootstrap] systemd units installed + enabled (start deferred to first real boot)"

        date > /var/flagship/installed.flag
        echo "[flagship-bootstrap] done"

        """
    }

    static func luksBootstrapBlock() -> String {
        return """

        # ── EXPERIMENTAL: LUKS-on-root, phone-gated unlock (encryptRoot) ─────────
        # Needs live validation; brick risk. This whole block is absent on the
        # default unencrypted path. docs/security-phone-as-unlock-endpoint.md.
        echo "[flagship-bootstrap] encryptRoot ON — configuring phone-gated LUKS unlock"

        # A. RE-KEY the LUKS root: curtin formatted it with the fixed burn-time
        #    passphrase; replace that with a fresh random key (install.sh's
        #    head -c 64 /dev/urandom pattern), then remove the burn-time slot so the
        #    only key that survives to first boot is the one we seal for the phone.
        LUKS_BURN_PASSPHRASE='\(burnPassphrase)'
        LUKS_KEY=/run/flagship-luks.key
        head -c 64 /dev/urandom > "$LUKS_KEY"
        chmod 600 "$LUKS_KEY"
        # The encrypted root partition (curtin labelled the filesystem FLAGSHIP_ROOT;
        # the underlying LUKS container is its parent block device).
        ROOT_LUKS_PART="$(blkid -t TYPE=crypto_LUKS -o device | head -n1)"
        if [ -z "$ROOT_LUKS_PART" ]; then
            echo "[flagship-bootstrap] FATAL: no crypto_LUKS partition found; cannot re-key"
            exit 1
        fi
        echo "[flagship-bootstrap] re-keying LUKS root on $ROOT_LUKS_PART"
        printf '%s' "$LUKS_BURN_PASSPHRASE" | \\
            cryptsetup luksAddKey "$ROOT_LUKS_PART" "$LUKS_KEY" --key-file=-
        printf '%s' "$LUKS_BURN_PASSPHRASE" | \\
            cryptsetup luksRemoveKey "$ROOT_LUKS_PART" --key-file=-
        echo "[flagship-bootstrap] LUKS re-keyed; burn-time passphrase removed"

        # B. SEAL the random key for the phone + upload the sealed blob to .com. The
        #    phone (and only the phone) can unseal it; .com stores ciphertext only.
        #    Same seal-for-bak construction install.sh uses.
        SEALED_LUKS_KEY_HEX="$(npx tsx scripts/install-helper.ts seal-for-bak \\
            --bak-ed25519-pub "$PHONE_DELEGATED_PUBKEY" \\
            --in "$LUKS_KEY" | tr -d '\\n')"
        NOW_MS=$(date +%s%3N)
        npx tsx scripts/install-helper.ts sign-sealed-key \\
            --priv "$SERVER_IDENTITY_PRIV_HEX" \\
            --server-id "$SERVER_DOMAIN" \\
            --sealed-hex "$SEALED_LUKS_KEY_HEX" \\
            --issued-at "$NOW_MS" \\
            > /run/sealed-key-payload.json
        CONTROL_PLANE_BASE="$(echo "$REGISTRATION_URL" | sed 's|/api/server/register$||')"
        curl -fsS -X POST -H 'content-type: application/json' \\
            --data @/run/sealed-key-payload.json \\
            "${CONTROL_PLANE_BASE}/api/server/${SERVER_DOMAIN}/sealed-luks-key" \\
            || echo "[flagship-bootstrap] WARNING: sealed-key upload failed; phone will need OOB"
        # Shred the plaintext key — it now exists only sealed-for-phone at .com.
        shred -u "$LUKS_KEY" 2>/dev/null || rm -f "$LUKS_KEY"

        # /boot facts the initramfs unlock hook reads on every boot (mirrors the
        # files boot-stage.sh expects: server-domain, identity.pem, control plane).
        echo "$SERVER_DOMAIN" > /boot/server-domain
        echo "$CONTROL_PLANE_BASE" > /boot/control-plane-url
        # The identity PKCS8 PEM is already at /boot/identity.pem (gen-identity --out-pem).

        # C1. BAKE the unseal helper to /boot/flagship-unseal. Build-at-install from
        #     the cloned source (auditable; no committed binary). golang-go from the
        #     Ubuntu archive can build the CGO-free static helper (one dep, pinned).
        echo "[flagship-bootstrap] building flagship-unseal from source"
        apt-get install -y --no-install-recommends golang-go
        ( cd /opt/flagship/installer/unseal-helper && \\
          CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \\
            go build -trimpath -buildvcs=false -ldflags '-s -w' -o /boot/flagship-unseal . )
        chmod 755 /boot/flagship-unseal
        echo "[flagship-bootstrap] /boot/flagship-unseal baked ($(ls -l /boot/flagship-unseal))"

        # C2. INITRAMFS HOOK. The hook copies the tools + helper into the initramfs;
        #     the premount script runs unlock_via_relay() (lifted verbatim from
        #     boot-stage.sh) before the root is mounted, then luksOpen's it.
        mkdir -p /etc/initramfs-tools/hooks /etc/initramfs-tools/scripts/local-top
        cat > /etc/initramfs-tools/hooks/flagship-unlock <<'HOOK'
        #!/bin/sh
        # Flagship initramfs hook: stage the unseal helper + identity + the crypto
        # tools unlock_via_relay() needs (openssl curl xxd sed cryptsetup) into the
        # initramfs, so the root can be unlocked pre-pivot with no encrypted-root deps.
        set -e
        PREREQ=""
        prereqs() { echo "$PREREQ"; }
        case "$1" in prereqs) prereqs; exit 0;; esac
        . /usr/share/initramfs-tools/hook-functions
        copy_exec /boot/flagship-unseal /bin/flagship-unseal
        copy_exec /usr/bin/openssl /bin/openssl
        copy_exec /usr/bin/curl /bin/curl
        copy_exec /usr/bin/xxd /bin/xxd
        copy_exec /bin/sed /bin/sed 2>/dev/null || copy_exec /usr/bin/sed /bin/sed
        copy_exec /sbin/cryptsetup /sbin/cryptsetup 2>/dev/null || copy_exec /usr/sbin/cryptsetup /sbin/cryptsetup
        # Identity + boot facts the premount script signs/reads with.
        mkdir -p "${DESTDIR}/boot"
        cp /boot/identity.pem "${DESTDIR}/boot/identity.pem"
        cp /boot/server-domain "${DESTDIR}/boot/server-domain"
        cp /boot/control-plane-url "${DESTDIR}/boot/control-plane-url" 2>/dev/null || true
        HOOK
        chmod +x /etc/initramfs-tools/hooks/flagship-unlock

        # The premount script. unlock_via_relay() below is LIFTED VERBATIM from
        # installer/boot-stage.sh (wave 3b owns its logic); only the surrounding
        # scaffolding (paths, the luksOpen target, the fallback poll) is adapted to
        # the initramfs. Keep the function body in sync with boot-stage.sh.
        cat > /etc/initramfs-tools/scripts/local-top/flagship-unlock <<'PREMOUNT'
        #!/bin/sh
        PREREQ=""
        prereqs() { echo "$PREREQ"; }
        case "$1" in prereqs) prereqs; exit 0;; esac

        set -eu
        SERVER_DOMAIN="$(cat /boot/server-domain)"
        CONTROL_PLANE="$(cat /boot/control-plane-url 2>/dev/null || echo https://flagshipserver.com)"
        IDENTITY_KEY=/boot/identity.pem
        UNSEAL_HELPER=/bin/flagship-unseal
        RELAY_WINDOW_SECS="${FLAGSHIP_RELAY_WINDOW_SECS:-180}"
        OUT_UNLOCK=/run/unlock-key

        [ -f "$IDENTITY_KEY" ] || { echo "flagship: missing $IDENTITY_KEY"; exit 0; }

        sign_canonical() {
            canonical="$1"
            msgfile="/run/flagship-sign-msg.bin"
            printf '%s' "$canonical" > "$msgfile"
            openssl pkeyutl -sign -rawin -inkey "$IDENTITY_KEY" -in "$msgfile" 2>/dev/null \\
                | xxd -p -c 256 | tr -d '\\n'
            rm -f "$msgfile"
        }
        identity_seed_hex() {
            openssl pkey -in "$IDENTITY_KEY" -outform DER 2>/dev/null \\
                | xxd -p -c 256 | tr -d '\\n' | tail -c 64
        }
        identity_pub_hex() {
            openssl pkey -in "$IDENTITY_KEY" -pubout -outform DER 2>/dev/null \\
                | xxd -p -c 256 | tr -d '\\n' | tail -c 64
        }

        # ── unlock_via_relay() — LIFTED VERBATIM from installer/boot-stage.sh ──────
        unlock_via_relay() {
            if [ ! -x "$UNSEAL_HELPER" ]; then
                echo "flagship: relay unavailable — $UNSEAL_HELPER missing/not executable"
                return 1
            fi

            SEED_HEX="$(identity_seed_hex)"
            PUB_HEX="$(identity_pub_hex)"
            if [ "${#SEED_HEX}" != 64 ] || [ "${#PUB_HEX}" != 64 ]; then
                echo "flagship: relay aborted — could not derive 32-byte seed/pub from $IDENTITY_KEY"
                return 1
            fi

            NONCE=$(head -c 32 /dev/urandom | xxd -p -c 256 | tr -d '\\n')
            NOW_MS=$(date +%s%3N)
            CANONICAL="flagship/secret-request/v1|${SERVER_DOMAIN}|${PUB_HEX}|unlock-key|${NONCE}|${NOW_MS}"
            SIG="$(sign_canonical "$CANONICAL")"

            REQ_URL="${CONTROL_PLANE}/api/server/${SERVER_DOMAIN}/secret-request"
            REQ_BODY=$(printf '{"request":{"serverDomain":"%s","stkPub":"%s","purpose":"unlock-key","nonce":"%s","issuedAt":%s},"signature":"%s"}' \\
                "$SERVER_DOMAIN" "$PUB_HEX" "$NONCE" "$NOW_MS" "$SIG")

            POST_RESP=/run/flagship-secret-request-resp.json
            POST_CODE=$(curl -sS -o "$POST_RESP" -w "%{http_code}" \\
                -X POST -H 'content-type: application/json' \\
                --max-time 30 -d "$REQ_BODY" "$REQ_URL" || echo "000")
            if [ "$POST_CODE" != "200" ]; then
                echo "flagship: relay secret-request HTTP $POST_CODE; body: $(head -c 200 "$POST_RESP" 2>/dev/null)"
                return 1
            fi
            echo "flagship: posted unlock-key secret-request; waiting up to ${RELAY_WINDOW_SECS}s for the phone"

            POLL_URL="${CONTROL_PLANE}/api/server/${SERVER_DOMAIN}/secret-response?nonce=${NONCE}"
            DEADLINE=$(( $(date +%s) + RELAY_WINDOW_SECS ))
            ATTEMPT=0
            while [ "$(date +%s)" -lt "$DEADLINE" ]; do
                ATTEMPT=$((ATTEMPT + 1))
                RESP=/run/flagship-secret-response.json
                CODE=$(curl -sS -o "$RESP" -w "%{http_code}" \\
                    --max-time 30 "$POLL_URL" || echo "000")

                if [ "$CODE" = "200" ]; then
                    SEALED=$(sed -n 's/.*"sealed":"\\([0-9a-fA-F]*\\)".*/\\1/p' "$RESP")
                    if [ -z "$SEALED" ]; then
                        echo "flagship: relay 200 but no sealed payload: $(head -c 200 "$RESP")"
                        return 1
                    fi
                    HELPER_JSON=/run/flagship-unseal-input.json
                    printf '{"serverDomain":"%s","requestNonceHex":"%s","purpose":"unlock-key","sealedHex":"%s","issuedAt":0}' \\
                        "$SERVER_DOMAIN" "$NONCE" "$SEALED" > "$HELPER_JSON"

                    if "$UNSEAL_HELPER" --identity-priv-hex "$SEED_HEX" --response-json "$HELPER_JSON" \\
                        > "$OUT_UNLOCK.hex" 2>/run/flagship-unseal.err; then
                        tr -d '\\n' < "$OUT_UNLOCK.hex" > "$OUT_UNLOCK"
                        chmod 600 "$OUT_UNLOCK"
                        rm -f "$OUT_UNLOCK.hex" "$HELPER_JSON"
                        echo "flagship: relay unsealed the unlock key (attempt $ATTEMPT)"
                        return 0
                    fi
                    echo "flagship: $UNSEAL_HELPER failed: $(head -c 200 /run/flagship-unseal.err 2>/dev/null)"
                    rm -f "$OUT_UNLOCK.hex" "$HELPER_JSON"
                    return 1
                elif [ "$CODE" = "404" ]; then
                    : # no reply yet — expected; keep polling
                else
                    echo "flagship: relay secret-response HTTP $CODE; body: $(head -c 200 "$RESP" 2>/dev/null)"
                    return 1
                fi

                BACKOFF=$((ATTEMPT < 6 ? ATTEMPT * 3 : 15))
                echo "flagship: no phone reply yet (attempt $ATTEMPT); sleeping $BACKOFF"
                sleep "$BACKOFF"
            done

            echo "flagship: relay window (${RELAY_WINDOW_SECS}s) elapsed with no phone reply"
            return 1
        }

        # ── Path 2: legacy plaintext consume (fallback) — from boot-stage.sh ───────
        unlock_via_plaintext_consume() {
            CONSUME_URL="${CONTROL_PLANE}/api/server/${SERVER_DOMAIN}/unlock-key/consume"
            echo "flagship: falling back to plaintext consume at ${CONSUME_URL}"
            ATTEMPT=0
            while :; do
                ATTEMPT=$((ATTEMPT + 1))
                NONCE=$(head -c 32 /dev/urandom | xxd -p -c 256 | tr -d '\\n')
                NOW_MS=$(date +%s%3N)
                CANONICAL="flagship/consume-unlock-key/v1|${SERVER_DOMAIN}|${NONCE}|${NOW_MS}"
                SIG="$(sign_canonical "$CANONICAL")"
                BODY=$(printf '{"request":{"serverId":"%s","nonce":"%s","issuedAt":%s},"signature":"%s"}' \\
                    "$SERVER_DOMAIN" "$NONCE" "$NOW_MS" "$SIG")
                HTTP_BODY=/run/flagship-consume-resp.json
                HTTP_CODE=$(curl -sS -o "$HTTP_BODY" -w "%{http_code}" \\
                    -X POST -H 'content-type: application/json' \\
                    --max-time 30 -d "$BODY" "$CONSUME_URL" || echo "000")
                if [ "$HTTP_CODE" = "200" ]; then
                    UNLOCK_HEX=$(sed -n 's/.*"unlockKey":"\\([0-9a-f]*\\)".*/\\1/p' "$HTTP_BODY")
                    if [ -n "$UNLOCK_HEX" ]; then
                        echo "flagship: got unlock key via consume (attempt $ATTEMPT)"
                        printf '%s' "$UNLOCK_HEX" > "$OUT_UNLOCK"
                        chmod 600 "$OUT_UNLOCK"
                        return 0
                    fi
                elif [ "$HTTP_CODE" = "404" ]; then
                    :
                else
                    echo "flagship: HTTP $HTTP_CODE on consume; body: $(head -c 200 "$HTTP_BODY")"
                fi
                BACKOFF=$((ATTEMPT < 6 ? ATTEMPT * 5 : 30))
                echo "flagship: no unlock key yet (attempt $ATTEMPT); sleeping $BACKOFF"
                sleep "$BACKOFF"
            done
        }

        if ! unlock_via_relay; then
            unlock_via_plaintext_consume
        fi

        ROOT_PART=/dev/disk/by-label/FLAGSHIP_ROOT
        xxd -r -p "$OUT_UNLOCK" | cryptsetup luksOpen --key-file - "$ROOT_PART" flagship_root
        shred -u "$OUT_UNLOCK" 2>/dev/null || rm -f "$OUT_UNLOCK"
        PREMOUNT
        chmod +x /etc/initramfs-tools/scripts/local-top/flagship-unlock

        # Rebuild the initramfs so the hook + premount script land in /boot's initrd.
        update-initramfs -u 2>&1 | tee /var/log/flagship-initramfs.log || \\
            echo "[flagship-bootstrap] WARNING: update-initramfs failed; unlock hook not embedded"
        echo "[flagship-bootstrap] LUKS unlock hook installed; initramfs rebuilt"


        """
    }
}
