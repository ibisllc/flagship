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
    public static func autoinstallYAML(recipeJSON: Data,
                                       installerGitRef: String,
                                       repoURL: String = defaultRepoURL) throws -> String {
        let trimmed = installerGitRef.trimmingCharacters(in: .whitespacesAndNewlines)
        let ref = trimmed.isEmpty ? "main" : trimmed
        guard ref.range(of: "^[A-Za-z0-9._/-]+$", options: .regularExpression) != nil else {
            throw UserDataError.unsafeGitRef(ref)
        }
        guard repoURL.hasPrefix("https://") else { throw UserDataError.badRepo(repoURL) }

        let blobB64 = recipeJSON.base64EncodedString()
        let bootstrapB64 = Data(bootstrapScript(ref: ref, repoURL: repoURL).utf8).base64EncodedString()

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
          late-commands:
            - curtin in-target --target=/target -- bash -c 'mkdir -p /var/flagship && echo "\(blobB64)" | base64 -d > /var/flagship/install-blob.json && chmod 600 /var/flagship/install-blob.json'
            - curtin in-target --target=/target -- bash -c 'echo "\(bootstrapB64)" | base64 -d > /usr/local/sbin/flagship-bootstrap.sh && chmod +x /usr/local/sbin/flagship-bootstrap.sh'
            - curtin in-target --target=/target -- /usr/local/sbin/flagship-bootstrap.sh

        """
    }

    /// First-boot bootstrap — clones flagship, generates the server identity,
    /// and registers with .com. Mirrors userdata.ts buildBootstrapScript.
    /// Bash line-continuations are written as `\\` (literal backslash); bash
    /// `$VAR` / `$(...)` / `${...}` pass through unchanged.
    static func bootstrapScript(ref: String, repoURL: String) -> String {
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
}
