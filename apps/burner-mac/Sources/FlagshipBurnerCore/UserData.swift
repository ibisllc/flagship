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

        # Register with .com.
        NOW=$(date +%s%3N)
        npx tsx scripts/install-helper.ts sign-server-register \\
            --priv-hex "$SERVER_IDENTITY_PRIV_HEX" \\
            --auth-code-blob /var/flagship/install-blob.json \\
            > /run/register-payload.json
        curl -fsS -X POST -H "content-type: application/json" \\
            --data @/run/register-payload.json \\
            "$REGISTRATION_URL"
        date > /var/flagship/registered.flag
        echo "[flagship-bootstrap] done"

        """
    }
}
