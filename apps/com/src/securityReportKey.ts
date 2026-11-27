/**
 * The security key reports are encrypted to: the same public key as
 * apps/web/public/.well-known/pgp-key.txt (a test holds them equal). Its private
 * half lives only on the owner's YubiKeys. The fingerprints are pinned so a key
 * swapped into this file without them is refused, not used.
 */
export const SECURITY_KEY_ARMORED = `-----BEGIN PGP PUBLIC KEY BLOCK-----

mDMEasbzQBYJKwYBBAHaRw8BAQdAjMReWOhNBh+R+QNzviV5rVuab+RfD5ZmI4io
K72DWP+0L0ZsYWdzaGlwIFNlY3VyaXR5IDxzZWN1cml0eUBmbGFnc2hpcHNlcnZl
ci5jb20+iLUEExYKAF0WIQTZbWddsD4/O7yIcDAjCJNtIVSW0AUCasbzQBsUgAAA
AAAEAA5tYW51MiwyLjUrMS4xMiwwLDMCGwMFCQPCZwAFCwkIBwICIgIGFQoJCAsC
BBYCAwECHgcCF4AACgkQIwiTbSFUltB/XwD8CsFGB2wI6Yds2Q6LhrRXFTPkWVg8
vUVH7w3Av+nfcLEA/0SMF775fCmPSppBpbo+Q1ihFIe+hkqmhtm6gHHif/YMuDgE
asbzQBIKKwYBBAGXVQEFAQEHQEdNiLwTRcEwR4eOyujinSpEZFFw9j807Nq977Ub
tUh4AwEIB4iUBBgWCgA8FiEE2W1nXbA+Pzu8iHAwIwiTbSFUltAFAmrG80AbFIAA
AAAABAAObWFudTIsMi41KzEuMTIsMCwzAhsMAAoJECMIk20hVJbQ/pYBAKBKpgKv
Y0pgbzmQ9rueS7vwQ9XdVF1O4nhC7qCCJdvpAQDyIvQbVQGEk/tJDrXQLqaJs3tb
kd9vLNLYKoWezsvXDw==
=f5TH
-----END PGP PUBLIC KEY BLOCK-----
`;

/** The primary key (ed25519, sign + certify). */
export const SECURITY_KEY_FINGERPRINT = "d96d675db03e3f3bbc8870302308936d215496d0";
/** Its encryption subkey (cv25519), the one every report is encrypted to. */
export const SECURITY_KEY_ENCRYPTION_SUBKEY_FINGERPRINT = "936512c6a2194d85ac14ffd593e72bb8872a57d9";
