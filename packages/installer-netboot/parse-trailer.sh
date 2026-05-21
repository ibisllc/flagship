#!/bin/bash
# Flagship netboot trailer parser — W12.
#
# Reads the FLAGSHIP-END trailer from the last ~64 KB of $1 (typically
# /dev/sda) and emits parsed environment-variable assignments on
# stdout. Same trailer format as packages/iso-personalizer/src/trailer.ts:
#
#   MAGIC_HEADER ("FLAGSHIP-BOOT\0\0\0", 16 bytes)
#   FORMAT_VERSION (0x01, 1 byte)
#   JSON_LEN (u32 LE, 4 bytes)
#   JSON  (UTF-8 InstallBlob serialized as InstallBlobJson)
#   SIG   (64-byte Ed25519 signature over canonical-bytes)
#   MAGIC_FOOTER ("\0\0\0FLAGSHIP-END\0", 16 bytes)
#   TOTAL_SIZE (u32 LE, 4 bytes — total trailer size incl this field)
#
# Verifies the Ed25519 signature over the InstallBlob canonical-bytes
# against the blob's embedded userPubKey, then emits the fields the
# late-command.sh needs. Exits 0 on valid; 1 on missing/malformed/
# invalid signature.
#
# Why bash + dd + xxd + openssl + python (not node + @noble/ed25519
# like the apkovl bootstrap): d-i's installer environment + the freshly
# installed Debian rootfs both ship openssl 3 + python3-minimal. They
# do NOT ship node or @noble/* deps. The W12 install needs to verify
# the trailer BEFORE the rootfs has gone through `npm ci`, so we cannot
# depend on the npm-only path.
#
# Ed25519 verify: openssl 3.0's `pkeyutl -verify -rawin` works for
# Ed25519 raw pubkeys, but openssl expects an SPKI-wrapped DER key, not
# the raw 32 bytes. We wrap the raw pubkey with the constant Ed25519
# SubjectPublicKeyInfo prefix (`30 2a 30 05 06 03 2b 65 70 03 21 00`)
# and feed that to openssl. Inline-python falls back if openssl is
# missing.
#
# Usage:
#   eval "$(/root/parse-trailer.sh /dev/sda)"
# Sets:
#   FLAGSHIP_USERNAME=...
#   FLAGSHIP_SERVER_DOMAIN=...
#   FLAGSHIP_SERVER_NAME=...
#   FLAGSHIP_PHONE_DELEGATED_PUBKEY=hex
#   FLAGSHIP_AUTH_CODE_SERIAL=...
#   FLAGSHIP_INSTALLER_GIT_REF=...
#   FLAGSHIP_RCK_PUBKEY=hex
#   FLAGSHIP_REGISTRATION_URL=...
#   FLAGSHIP_BLOB_JSON_BASE64=base64-of-the-full-blob
set -euo pipefail

DEV="${1:?usage: parse-trailer.sh <device>}"
[[ -b "$DEV" || -f "$DEV" ]] || { echo "error: $DEV is not a block device or file" >&2; exit 1; }

# blockdev --getsize64 works on block devices; stat -c %s works on
# regular files. Try the former first.
DISK_SIZE=$(blockdev --getsize64 "$DEV" 2>/dev/null || stat -c %s "$DEV")
if [[ -z "$DISK_SIZE" || "$DISK_SIZE" -le 0 ]]; then
    echo "error: could not determine size of $DEV" >&2
    exit 1
fi

# Read the trailer's TOTAL_SIZE field (last 4 bytes, u32 LE).
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT
TOTAL_BUF="$TMP_DIR/total.bin"
dd if="$DEV" of="$TOTAL_BUF" bs=1 count=4 skip=$((DISK_SIZE - 4)) 2>/dev/null

# Read u32 LE → decimal via xxd + arithmetic.
TOTAL_HEX=$(xxd -p "$TOTAL_BUF")
# Bytes in disk order, little-endian: b0 b1 b2 b3 → value = b0 | b1<<8 | b2<<16 | b3<<24
B0=$((0x${TOTAL_HEX:0:2}))
B1=$((0x${TOTAL_HEX:2:2}))
B2=$((0x${TOTAL_HEX:4:2}))
B3=$((0x${TOTAL_HEX:6:2}))
TOTAL=$((B0 | (B1 << 8) | (B2 << 16) | (B3 << 24)))

if (( TOTAL < 100 || TOTAL > 65536 || TOTAL > DISK_SIZE )); then
    echo "error: trailer total-size out of range ($TOTAL)" >&2
    exit 1
fi

# Read the full trailer block.
TRAILER="$TMP_DIR/trailer.bin"
dd if="$DEV" of="$TRAILER" bs=1 count=$TOTAL skip=$((DISK_SIZE - TOTAL)) 2>/dev/null

# Verify header + footer magic.
HEADER_HEX=$(dd if="$TRAILER" bs=1 count=16 2>/dev/null | xxd -p)
EXPECTED_HEADER="464c4147534849502d424f4f54000000"   # "FLAGSHIP-BOOT\0\0\0"
if [[ "$HEADER_HEX" != "$EXPECTED_HEADER" ]]; then
    echo "error: trailer header magic missing (got $HEADER_HEX)" >&2
    exit 1
fi

# Version byte at offset 16 must be 0x01.
VERSION_HEX=$(dd if="$TRAILER" bs=1 count=1 skip=16 2>/dev/null | xxd -p)
if [[ "$VERSION_HEX" != "01" ]]; then
    echo "error: unsupported trailer version (got 0x$VERSION_HEX)" >&2
    exit 1
fi

# JSON length (u32 LE) at offset 17..20.
JSONLEN_HEX=$(dd if="$TRAILER" bs=1 count=4 skip=17 2>/dev/null | xxd -p)
LB0=$((0x${JSONLEN_HEX:0:2}))
LB1=$((0x${JSONLEN_HEX:2:2}))
LB2=$((0x${JSONLEN_HEX:4:2}))
LB3=$((0x${JSONLEN_HEX:6:2}))
JSON_LEN=$((LB0 | (LB1 << 8) | (LB2 << 16) | (LB3 << 24)))

JSON_OFF=21
SIG_OFF=$((JSON_OFF + JSON_LEN))
FOOTER_OFF=$((SIG_OFF + 64))

JSON_FILE="$TMP_DIR/blob.json"
dd if="$TRAILER" of="$JSON_FILE" bs=1 count=$JSON_LEN skip=$JSON_OFF 2>/dev/null
SIG_FILE="$TMP_DIR/sig.bin"
dd if="$TRAILER" of="$SIG_FILE" bs=1 count=64 skip=$SIG_OFF 2>/dev/null

FOOTER_HEX=$(dd if="$TRAILER" bs=1 count=16 skip=$FOOTER_OFF 2>/dev/null | xxd -p)
EXPECTED_FOOTER="000000464c4147534849502d454e4400"   # "\0\0\0FLAGSHIP-END\0"
if [[ "$FOOTER_HEX" != "$EXPECTED_FOOTER" ]]; then
    echo "error: trailer footer magic missing (got $FOOTER_HEX)" >&2
    exit 1
fi

# Extract the fields we need + reconstruct canonical-bytes for Ed25519
# verification. jq is in pkgsel/include so present on the installed
# rootfs.
USERNAME=$(jq -r .username "$JSON_FILE")
SERVER_DOMAIN=$(jq -r .serverDomain "$JSON_FILE")
SERVER_NAME=$(jq -r .serverName "$JSON_FILE")
PHONE_DELEGATED=$(jq -r .phoneDelegatedPubKey "$JSON_FILE")
REG_URL=$(jq -r .registrationUrl "$JSON_FILE")
SERIAL=$(jq -r .authCode.serial "$JSON_FILE")
USER_PUBKEY=$(jq -r .authCode.userPubKey "$JSON_FILE")
AUTHCODE_USER_SIG=$(jq -r .authCodeUserSignature "$JSON_FILE")
ISSUED_AT=$(jq -r .issuedAt "$JSON_FILE")
EXPIRES_AT=$(jq -r .expiresAt "$JSON_FILE")
INSTALLER_REF=$(jq -r .installerGitRef "$JSON_FILE")
RCK_PUBKEY=$(jq -r .rckPubKey "$JSON_FILE")

for k in USERNAME SERVER_DOMAIN USER_PUBKEY PHONE_DELEGATED INSTALLER_REF; do
    v="${!k}"
    if [[ -z "$v" || "$v" == "null" ]]; then
        echo "error: trailer missing field $k" >&2
        exit 1
    fi
done

# Reconstruct the canonical-bytes the signature commits to. MUST match
# packages/protocol/src/canonicalBytes.ts → canonicalInstallBlob exactly.
# (Mirrors the apkovl-bootstrap's flagship-trailer-validate field order.)
CANONICAL="flagship/install-blob/v1|1|${SERVER_DOMAIN}|${USERNAME}|${SERVER_NAME}|${PHONE_DELEGATED}|${REG_URL}|${SERIAL}|${USER_PUBKEY}|${AUTHCODE_USER_SIG}|${ISSUED_AT}|${EXPIRES_AT}"
MSG_FILE="$TMP_DIR/canonical.bin"
printf '%s' "$CANONICAL" > "$MSG_FILE"

# Ed25519 verify. Strategy: wrap the raw 32-byte userPubKey in an SPKI
# DER (constant 12-byte prefix for Ed25519: 302a300506032b6570032100) +
# write as PEM, then `openssl pkeyutl -verify -rawin -pubin`. Fall back
# to inline-python if openssl rejects.
SPKI_PREFIX="302a300506032b6570032100"
PUB_FILE="$TMP_DIR/pub.der"
printf '%s%s' "$SPKI_PREFIX" "$USER_PUBKEY" | xxd -r -p > "$PUB_FILE"
PUB_PEM="$TMP_DIR/pub.pem"
{
    echo "-----BEGIN PUBLIC KEY-----"
    base64 < "$PUB_FILE" | fold -w 64
    echo "-----END PUBLIC KEY-----"
} > "$PUB_PEM"

VERIFIED=0
if command -v openssl >/dev/null 2>&1; then
    if openssl pkeyutl -verify -rawin -pubin -inkey "$PUB_PEM" \
            -sigfile "$SIG_FILE" -in "$MSG_FILE" >/dev/null 2>&1; then
        VERIFIED=1
    fi
fi
if [[ "$VERIFIED" != "1" ]] && command -v python3 >/dev/null 2>&1; then
    # Inline python verifier — pure-stdlib (cryptography is too heavy
    # for d-i; nacl isn't pre-installed). We implement Ed25519 verify
    # directly via the (small) RFC 8032 reference. Python 3.11+ has
    # `cryptography` on most setups but we can't rely on it here.
    if python3 - "$PUB_FILE" "$SIG_FILE" "$MSG_FILE" <<'PYEOF'
import sys, hashlib
pub_der = open(sys.argv[1], 'rb').read()
# Strip the SPKI prefix; raw pubkey is the last 32 bytes.
A = pub_der[-32:]
sig = open(sys.argv[2], 'rb').read()
msg = open(sys.argv[3], 'rb').read()
assert len(sig) == 64
assert len(A) == 32
# RFC 8032 Ed25519 reference verify.
p = 2**255 - 19
def modp_inv(x):
    return pow(x, p-2, p)
d = -121665 * modp_inv(121666) % p
q = 2**252 + 27742317777372353535851937790883648493
def sha512(b):
    return hashlib.sha512(b).digest()
def sha512_modq(b):
    return int.from_bytes(sha512(b), 'little') % q
def point_add(P, Q):
    x1, y1 = P
    x2, y2 = Q
    x3 = (x1*y2 + x2*y1) * modp_inv(1 + d*x1*x2*y1*y2) % p
    y3 = (y1*y2 + x1*x2) * modp_inv(1 - d*x1*x2*y1*y2) % p
    return (x3, y3)
def point_mul(s, P):
    Q = (0, 1)
    while s > 0:
        if s & 1:
            Q = point_add(Q, P)
        P = point_add(P, P)
        s >>= 1
    return Q
def point_equal(P, Q):
    return (P[0] - Q[0]) % p == 0 and (P[1] - Q[1]) % p == 0
def point_compress(P):
    z = modp_inv(1)  # not needed — encoding uses affine
    return ((P[1] & ((1 << 255) - 1)) | ((P[0] & 1) << 255)).to_bytes(32, 'little')
def point_decompress(s):
    if len(s) != 32:
        return None
    y = int.from_bytes(s, 'little')
    sign = y >> 255
    y &= (1 << 255) - 1
    x2 = (y*y - 1) * modp_inv(d*y*y + 1) % p
    if x2 == 0:
        if sign:
            return None
        return (0, y)
    x = pow(x2, (p+3) // 8, p)
    if (x*x - x2) % p != 0:
        x = x * pow(2, (p-1) // 4, p) % p
    if (x*x - x2) % p != 0:
        return None
    if (x & 1) != sign:
        x = p - x
    return (x, y)
g_y = 4 * modp_inv(5) % p
g_x = (g_y*g_y - 1) * modp_inv(d*g_y*g_y + 1) % p
def recover_x(y, sign):
    return point_decompress(((y & ((1<<255)-1)) | (sign << 255)).to_bytes(32, 'little'))[0]
G = (15112221349535400772501151409588531511454012693041857206046113283949847762202,
     46316835694926478169428394003475163141307993866256225615783033603165251855960)
def verify(public, msg, signature):
    if len(public) != 32 or len(signature) != 64:
        return False
    A = point_decompress(public)
    if not A:
        return False
    Rs = signature[:32]
    R = point_decompress(Rs)
    if not R:
        return False
    s = int.from_bytes(signature[32:], 'little')
    if s >= q:
        return False
    h = sha512_modq(Rs + public + msg)
    sB = point_mul(s, G)
    hA = point_mul(h, A)
    return point_equal(sB, point_add(R, hA))
ok = verify(A, msg, sig)
sys.exit(0 if ok else 1)
PYEOF
    then
        VERIFIED=1
    fi
fi

if [[ "$VERIFIED" != "1" ]]; then
    echo "error: trailer Ed25519 signature does NOT verify under embedded userPubKey" >&2
    exit 1
fi

# Compute base64 of the full blob JSON for downstream consumers.
BLOB_B64=$(base64 -w0 < "$JSON_FILE" 2>/dev/null || base64 < "$JSON_FILE" | tr -d '\n')

# Emit shell-safe assignments. Use single-quoting for values that may
# contain shell metacharacters; the values themselves are constrained
# by upstream validation to a safe charset, but defense in depth.
emit() {
    local name="$1" value="$2"
    # Bash single-quote escaping: '\'' inside single quotes.
    local escaped="${value//\'/\'\\\'\'}"
    echo "${name}='${escaped}'"
}
emit FLAGSHIP_USERNAME              "$USERNAME"
emit FLAGSHIP_SERVER_DOMAIN         "$SERVER_DOMAIN"
emit FLAGSHIP_SERVER_NAME           "$SERVER_NAME"
emit FLAGSHIP_PHONE_DELEGATED_PUBKEY "$PHONE_DELEGATED"
emit FLAGSHIP_AUTH_CODE_SERIAL      "$SERIAL"
emit FLAGSHIP_INSTALLER_GIT_REF     "$INSTALLER_REF"
emit FLAGSHIP_RCK_PUBKEY            "$RCK_PUBKEY"
emit FLAGSHIP_REGISTRATION_URL      "$REG_URL"
emit FLAGSHIP_BLOB_JSON_BASE64      "$BLOB_B64"
