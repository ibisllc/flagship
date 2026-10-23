/**
 * Every generalized VM appliance image is formatted once, so every box made
 * from it starts with the same LUKS volume key. Changing a keyslot passphrase
 * only re-wraps that key; anyone holding the image (or one box's volume key)
 * could read every other box's disk. The specializer therefore re-encrypts the
 * root under a fresh volume key before any owner data exists, and proves the
 * key changed against the fingerprint the factory recorded in the image.
 */

/** Written by the factory inside the image: fingerprints of the shared factory key. */
export const APPLIANCE_FACTORY_LUKS_RECORD = "/etc/flagship/appliance-factory-luks.json";
/** Written by the specializer once the root has its own volume key. */
export const APPLIANCE_REKEY_MARKER = "/var/flagship/appliance-rekeyed.json";
/** Pre-re-encryption header copy, on the unencrypted /boot so it is readable when the root is not. */
export const APPLIANCE_HEADER_BACKUP = "/boot/flagship-luks-factory-header.img";

/**
 * Shell helpers shared by the factory (to record the image's key) and the
 * specializer (to prove a box no longer has it). No key material is printed:
 * the volume key goes to a 0600 file on a RAM disk, is hashed and shredded.
 *
 *   flagship_luks_digest_fp <dev>                    sha256 of luksDump's Digests section
 *   flagship_luks_volume_key_fp <dev> <keyfile> <dir> sha256 of the volume key itself
 *   flagship_luks_reencrypt_pending <dev>            0 while a LUKS2 re-encryption is unfinished
 */
export const LUKS_KEY_FINGERPRINT_FNS = `flagship_luks_digest_fp() {
    local dump section
    dump="$(cryptsetup luksDump "$1" 2>/dev/null)" || return 1
    section="$(awk '/^Digests:/{f=1;next} /^[A-Za-z]/{f=0} f' <<<"$dump")"
    [ -n "$section" ] || return 1
    printf '%s\\n' "$section" | sha256sum | cut -d' ' -f1
}
flagship_luks_volume_key_fp() {
    local vk="$3/flagship-vk.$$" fp
    rm -f "$vk"
    if ! (umask 077; cryptsetup luksDump --dump-volume-key --batch-mode --key-file "$2" --volume-key-file "$vk" "$1" >/dev/null 2>&1); then
        rm -f "$vk"
        return 1
    fi
    if [ ! -s "$vk" ]; then rm -f "$vk"; return 1; fi
    fp="$(sha256sum "$vk" | cut -d' ' -f1)"
    shred -u "$vk" 2>/dev/null || rm -f "$vk"
    [[ "$fp" =~ ^[0-9a-f]{64}$ ]] || return 1
    printf '%s\\n' "$fp"
}
flagship_luks_reencrypt_pending() {
    local dump
    dump="$(cryptsetup luksDump "$1" 2>/dev/null)" || return 2
    grep -Eq '^Requirements:.*reencrypt|^[[:space:]]+[0-9]+:[[:space:]]*reencrypt' <<<"$dump"
}`;

/**
 * Factory side: record the image's shared key (run in the prepared target,
 * where /etc/flagship/appliance-build.key opens ROOT_LUKS_PART). The record is
 * public by design: the factory key is published, so this key is too.
 */
export function buildApplianceFactoryLuksRecordBlock(buildKeyFile: string): string {
  return `${LUKS_KEY_FINGERPRINT_FNS}
FACTORY_VK_FP="$(flagship_luks_volume_key_fp "$ROOT_LUKS_PART" ${buildKeyFile} /run)" || { echo "[appliance-factory] cannot fingerprint the factory volume key"; exit 1; }
FACTORY_DIGEST_FP="$(flagship_luks_digest_fp "$ROOT_LUKS_PART")" || { echo "[appliance-factory] cannot read the factory LUKS header"; exit 1; }
jq -n --arg vk "$FACTORY_VK_FP" --arg d "$FACTORY_DIGEST_FP" '{version:1,volumeKeySha256:$vk,digestSha256:$d}' > ${APPLIANCE_FACTORY_LUKS_RECORD}
chmod 644 ${APPLIANCE_FACTORY_LUKS_RECORD}
echo "[appliance-factory] factory LUKS key recorded digest=$FACTORY_DIGEST_FP"`;
}

/**
 * Specializer side. Needs ROOT_LUKS_PART set, and the specializer's \`stage\`
 * and \`report\` functions. Paths are variables so the tests can run the real
 * text against a stub cryptsetup:
 *
 *   FLAGSHIP_LUKS_BUILD_KEY, FLAGSHIP_LUKS_FACTORY_RECORD, FLAGSHIP_LUKS_REKEY_MARKER,
 *   FLAGSHIP_LUKS_HEADER_BACKUP, FLAGSHIP_LUKS_TMP
 *
 * It runs before the bootstrap adds the owner's key and before the disk grows,
 * so the only keyslot is the factory one and only the image's own extent is
 * rewritten (the grown tail never held factory ciphertext). A power cut leaves
 * the LUKS2 journal in the header: the initramfs opens the disk with the same
 * factory key (cryptsetup recovers the hotzone on open), the specializer runs
 * again on the next boot, finds the re-encryption pending and resumes it. Any
 * failure ends the install with a FATAL line; it never goes on with the shared key.
 */
export const APPLIANCE_REKEY_BLOCK = `${LUKS_KEY_FINGERPRINT_FNS}
rekey_fatal() {
    echo "[appliance] FATAL: $1"
    trap - ERR
    report error "Setup failed: $1"
    exit 1
}
flagship_luks_count_slots() {
    cryptsetup luksDump "$1" 2>/dev/null | awk '/^Keyslots:/{f=1;next} /^[A-Za-z]/{f=0} f && /^[[:space:]]+[0-9]+:[[:space:]]*luks2/{n++} END{print n+0}'
}
flagship_luks_run_reencrypt() {
    local args=(reencrypt "$1" --batch-mode --key-file "$2" --progress-frequency 10)
    if [ "$3" = resume ]; then args+=(--resume-only); else args+=(--resilience journal); fi
    local line pct bucket last=-1 rc=1
    while IFS= read -r line; do
        line="\${line//$'\\r'/}"
        case "$line" in
            FLAGSHIP_REENCRYPT_RC=*) rc="\${line#FLAGSHIP_REENCRYPT_RC=}"; continue ;;
        esac
        echo "[appliance] cryptsetup: $line"
        if [[ "$line" =~ ([0-9]{1,3})(\\.[0-9]+)?% ]]; then
            pct="\${BASH_REMATCH[1]}"
            bucket=$((pct / 10 * 10))
            if [ "$bucket" -gt "$last" ]; then
                last="$bucket"
                report installing "Giving this server its own disk encryption key ($bucket%)"
            fi
        fi
    done < <({ _rc=0; cryptsetup "\${args[@]}" 2>&1 || _rc=$?; echo "FLAGSHIP_REENCRYPT_RC=$_rc"; })
    return "$rc"
}

FACTORY_RECORD="\${FLAGSHIP_LUKS_FACTORY_RECORD:-${APPLIANCE_FACTORY_LUKS_RECORD}}"
REKEY_BUILD_KEY="\${FLAGSHIP_LUKS_BUILD_KEY:?}"
REKEY_MARKER="\${FLAGSHIP_LUKS_REKEY_MARKER:-${APPLIANCE_REKEY_MARKER}}"
HEADER_BACKUP="\${FLAGSHIP_LUKS_HEADER_BACKUP:-${APPLIANCE_HEADER_BACKUP}}"
REKEY_TMP="\${FLAGSHIP_LUKS_TMP:-/run/flagship-appliance}"
[ -s "$FACTORY_RECORD" ] || rekey_fatal "the image has no record of its factory disk key"
FACTORY_VK_FP="$(jq -r '.volumeKeySha256 // empty' "$FACTORY_RECORD" 2>/dev/null || true)"
FACTORY_DIGEST_FP="$(jq -r '.digestSha256 // empty' "$FACTORY_RECORD" 2>/dev/null || true)"
[[ "$FACTORY_VK_FP" =~ ^[0-9a-f]{64}$ ]] && [[ "$FACTORY_DIGEST_FP" =~ ^[0-9a-f]{64}$ ]] || rekey_fatal "the factory disk key record is malformed"

PENDING_RC=0
flagship_luks_reencrypt_pending "$ROOT_LUKS_PART" || PENDING_RC=$?
[ "$PENDING_RC" -le 1 ] || rekey_fatal "cannot read the disk's LUKS header"
if [ "$PENDING_RC" -eq 0 ]; then
    stage "Resuming this server's own disk encryption key"
    flagship_luks_run_reencrypt "$ROOT_LUKS_PART" "$REKEY_BUILD_KEY" resume || rekey_fatal "could not finish giving the disk its own encryption key"
else
    CURRENT_VK_FP="$(flagship_luks_volume_key_fp "$ROOT_LUKS_PART" "$REKEY_BUILD_KEY" "$REKEY_TMP")" || rekey_fatal "cannot fingerprint the disk's encryption key"
    if [ "$CURRENT_VK_FP" = "$FACTORY_VK_FP" ]; then
        [ "$(flagship_luks_count_slots "$ROOT_LUKS_PART")" = "1" ] || rekey_fatal "the factory disk has more than one key slot; refusing to re-encrypt"
        if [ ! -s "$HEADER_BACKUP" ]; then
            rm -f "$HEADER_BACKUP.tmp"
            cryptsetup luksHeaderBackup "$ROOT_LUKS_PART" --header-backup-file "$HEADER_BACKUP.tmp" || rekey_fatal "could not back up the disk header"
            sync
            mv "$HEADER_BACKUP.tmp" "$HEADER_BACKUP"
            sync
        fi
        stage "Giving this server its own disk encryption key"
        flagship_luks_run_reencrypt "$ROOT_LUKS_PART" "$REKEY_BUILD_KEY" fresh || rekey_fatal "could not give the disk its own encryption key"
    else
        echo "[appliance] the disk already has its own encryption key"
    fi
fi

PENDING_RC=0
flagship_luks_reencrypt_pending "$ROOT_LUKS_PART" || PENDING_RC=$?
[ "$PENDING_RC" -eq 1 ] || rekey_fatal "the disk re-encryption did not finish"
NEW_VK_FP="$(flagship_luks_volume_key_fp "$ROOT_LUKS_PART" "$REKEY_BUILD_KEY" "$REKEY_TMP")" || rekey_fatal "cannot fingerprint the new disk encryption key"
[ "$NEW_VK_FP" != "$FACTORY_VK_FP" ] || rekey_fatal "the disk still has the shared factory encryption key"
NEW_DIGEST_FP="$(flagship_luks_digest_fp "$ROOT_LUKS_PART")" || rekey_fatal "cannot read the disk's LUKS header"
[ "$NEW_DIGEST_FP" != "$FACTORY_DIGEST_FP" ] || rekey_fatal "the disk header still describes the shared factory key"
[ "$(flagship_luks_count_slots "$ROOT_LUKS_PART")" = "1" ] || rekey_fatal "the re-encrypted disk does not have exactly one key slot"
unset NEW_VK_FP CURRENT_VK_FP
mkdir -p "$(dirname "$REKEY_MARKER")"
jq -n --arg f "$FACTORY_DIGEST_FP" --arg d "$NEW_DIGEST_FP" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \\
    '{version:1,factoryDigestSha256:$f,digestSha256:$d,rekeyedAt:$at}' > "$REKEY_MARKER.tmp"
mv "$REKEY_MARKER.tmp" "$REKEY_MARKER"
rm -f "$HEADER_BACKUP" "$HEADER_BACKUP.tmp"
sync
echo "[appliance] disk re-encrypted under its own key digest=$NEW_DIGEST_FP"`;
