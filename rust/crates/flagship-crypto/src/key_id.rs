//! Key ids: `SHA-512(0x15 "flagship/pq-key-id/v1" || u16be suite || u16be len || pk)[0..32]`.

use flagship_protocol::SuiteId;
use sha2::{Digest, Sha512};

const KEY_ID_TAG: &[u8] = b"flagship/pq-key-id/v1";

/// The 32-byte id of a public key under a suite.
#[must_use]
pub fn key_id(suite: SuiteId, public_key: &[u8]) -> [u8; 32] {
    let mut h = Sha512::new();
    h.update([u8::try_from(KEY_ID_TAG.len()).unwrap_or(u8::MAX)]);
    h.update(KEY_ID_TAG);
    h.update(suite.id().to_be_bytes());
    h.update(
        u16::try_from(public_key.len())
            .unwrap_or(u16::MAX)
            .to_be_bytes(),
    );
    h.update(public_key);
    let d = h.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(d.get(..32).unwrap_or(&[0u8; 32]));
    out
}
