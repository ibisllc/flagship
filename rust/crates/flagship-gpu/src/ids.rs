use std::fmt;

use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::device::Vendor;

const ID_TAG: &str = "flagship/gpu-local-id/v1";

/// The box-local key that scopes device IDs. It comes from the box's key
/// service and never leaves the box; its `Debug` output is redacted.
#[derive(Clone)]
pub struct LocalIdKey([u8; 32]);

impl LocalIdKey {
    pub fn new(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }
}

impl fmt::Debug for LocalIdKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("LocalIdKey(<redacted>)")
    }
}

/// A device ID that is stable on one box and meaningless anywhere else:
/// `gpu-` + the first 16 bytes of HMAC-SHA256(box key,
/// `flagship/gpu-local-id/v1|<vendor>|<vendor stable id>`). The vendor UUID
/// (or PCI address, when a card has none) is consumed here and never stored,
/// logged or sent, so telemetry can't link a card across boxes or owners.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct LocalDeviceId(String);

impl LocalDeviceId {
    pub fn derive(key: &LocalIdKey, vendor: Vendor, stable_vendor_id: &str) -> Self {
        let mut mac = match Hmac::<Sha256>::new_from_slice(&key.0) {
            Ok(m) => m,
            Err(_) => unreachable_hmac(),
        };
        mac.update(ID_TAG.as_bytes());
        mac.update(b"|");
        mac.update(vendor.as_str().as_bytes());
        mac.update(b"|");
        mac.update(stable_vendor_id.trim().to_ascii_lowercase().as_bytes());
        let out = mac.finalize().into_bytes();
        let mut s = String::with_capacity(36);
        s.push_str("gpu-");
        for b in out.iter().take(16) {
            s.push(hex(b >> 4));
            s.push(hex(b & 0x0f));
        }
        Self(s)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Parse an ID read back from the journal.
    pub fn parse(s: &str) -> Option<Self> {
        let hexpart = s.strip_prefix("gpu-")?;
        (hexpart.len() == 32 && hexpart.bytes().all(|b| b.is_ascii_hexdigit()))
            .then(|| Self(s.to_owned()))
    }
}

impl fmt::Display for LocalDeviceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

// HMAC accepts keys of any length; a 32-byte key can't fail.
fn unreachable_hmac() -> ! {
    unreachable!("HMAC-SHA256 accepts any key length")
}

fn hex(n: u8) -> char {
    char::from_digit(u32::from(n), 16).unwrap_or('0')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scoped_per_box_and_never_contains_the_uuid() {
        let uuid = "GPU-3b5c1e2a-9f00-4d7e-8b1c-0123456789ab";
        let a = LocalDeviceId::derive(&LocalIdKey::new([1; 32]), Vendor::Nvidia, uuid);
        let a2 = LocalDeviceId::derive(&LocalIdKey::new([1; 32]), Vendor::Nvidia, uuid);
        let b = LocalDeviceId::derive(&LocalIdKey::new([2; 32]), Vendor::Nvidia, uuid);
        assert_eq!(a, a2);
        assert_ne!(a, b);
        assert!(!a.as_str().contains("3b5c1e2a"));
        assert_eq!(LocalDeviceId::parse(a.as_str()), Some(a.clone()));
        assert_eq!(LocalDeviceId::parse(uuid), None);
        assert_eq!(
            format!("{:?}", LocalIdKey::new([9; 32])),
            "LocalIdKey(<redacted>)"
        );
    }
}
