//! Where an outbound stream may go: the TypeScript hub's destination policy (`outboundRelay.ts` `vetOutboundHost` and
//! `isPublicUnicast`), checked on shared vectors (`packages/tunnel-protocol/test-vectors/outbound-policy.json`). A box asks for
//! `host:443`; the relay refuses anything that is not a public DNS name and, after resolving, any address that is not public
//! unicast (no SSRF into the machine, its private network or a cloud metadata service).

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

const FORBIDDEN_SUFFIXES: [&str; 7] = [
    ".localhost",
    ".local",
    ".internal",
    ".flycast",
    ".lan",
    ".home.arpa",
    ".localdomain",
];

fn label_ok(l: &str) -> bool {
    !l.is_empty()
        && l.len() <= 63
        && !l.starts_with('-')
        && !l.ends_with('-')
        && l.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// A destination must be a public DNS name: no IP literal in any spelling a resolver would accept, no single-label name, no
/// name reserved for local use. Returns the lowercased name, or `None`.
#[must_use]
pub fn vet_outbound_host(raw: &str) -> Option<String> {
    let lowered = raw.trim().to_lowercase();
    let host = lowered.strip_suffix('.').unwrap_or(&lowered);
    if host.is_empty() || host.len() > 253 {
        return None;
    }
    if host.parse::<IpAddr>().is_ok() || host.contains(':') || host.contains('[') {
        return None;
    }
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() < 2 || !labels.iter().all(|l| label_ok(l)) {
        return None;
    }
    // An all-numeric last label is an IPv4 shorthand (127.1, 2130706433.x).
    if labels
        .last()
        .is_some_and(|l| l.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    if host == "localhost" || FORBIDDEN_SUFFIXES.iter().any(|s| host.ends_with(s)) {
        return None;
    }
    Some(host.to_owned())
}

fn in_v4(a: Ipv4Addr, net: [u8; 4], bits: u32) -> bool {
    let (a, n) = (u32::from(a), u32::from(Ipv4Addr::from(net)));
    let mask = if bits == 0 {
        0
    } else {
        u32::MAX << (32 - bits)
    };
    a & mask == n & mask
}

const V4_FORBIDDEN: [([u8; 4], u32); 15] = [
    ([0, 0, 0, 0], 8),
    ([10, 0, 0, 0], 8),
    ([100, 64, 0, 0], 10),
    ([127, 0, 0, 0], 8),
    ([169, 254, 0, 0], 16),
    ([172, 16, 0, 0], 12),
    ([192, 0, 0, 0], 24),
    ([192, 0, 2, 0], 24),
    ([192, 88, 99, 0], 24),
    ([192, 168, 0, 0], 16),
    ([198, 18, 0, 0], 15),
    ([198, 51, 100, 0], 24),
    ([203, 0, 113, 0], 24),
    ([224, 0, 0, 0], 4),
    ([240, 0, 0, 0], 4),
];

fn in_v6(a: Ipv6Addr, net: Ipv6Addr, bits: u32) -> bool {
    let (a, n) = (u128::from(a), u128::from(net));
    let mask = if bits == 0 {
        0
    } else {
        u128::MAX << (128 - bits)
    };
    a & mask == n & mask
}

/// True when `address` is a public unicast address the relay may connect to. IPv6 must be global unicast (`2000::/3`), which by
/// construction excludes loopback, link-local, unique-local (so Fly's `fdaa::/16` private network), multicast and every
/// IPv4-mapped or NAT64 form. A zone identifier (`%eth0`) is refused: a resolver never answers with one.
#[must_use]
pub fn is_public_unicast(address: &str) -> bool {
    match address.parse::<IpAddr>() {
        Ok(IpAddr::V4(a)) => !V4_FORBIDDEN.iter().any(|(n, b)| in_v4(a, *n, *b)),
        Ok(IpAddr::V6(a)) => {
            let global = in_v6(a, Ipv6Addr::new(0x2000, 0, 0, 0, 0, 0, 0, 0), 3);
            let forbidden = [
                (Ipv6Addr::new(0x2001, 0, 0, 0, 0, 0, 0, 0), 23),
                (Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 0), 32),
                (Ipv6Addr::new(0x2002, 0, 0, 0, 0, 0, 0, 0), 16),
                (Ipv6Addr::new(0x3fff, 0, 0, 0, 0, 0, 0, 0), 20),
            ];
            global && !forbidden.iter().any(|(n, b)| in_v6(a, *n, *b))
        }
        Err(_) => false,
    }
}
